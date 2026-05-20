require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const { stmts, initDB, createUser, verifyPassword, executeTrade, getLeaderboard } = require('./db');
const SimulationEngine = require('./simulation');
const { analyzeHeadline, generateNewsSuggestions, logAIStatus } = require('./ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Trust proxy for production (Render, Railway, etc.)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// ─── Session Setup ─────────────────────────────────────────────
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'default-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Share session with Socket.IO
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// ─── Initialize Simulation Engine ──────────────────────────────
const simulation = new SimulationEngine(io);

// ─── Auth Middleware ────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

async function requireParticipant(req, res, next) {
  if (!req.session.userId || req.session.role !== 'participant') {
    return res.status(403).json({ error: 'Participant access required' });
  }
  const user = await stmts.getUserById(req.session.userId);
  if (!user || user.status !== 'approved') {
    return res.status(403).json({ error: 'Account not approved yet' });
  }
  next();
}

// ─── Auth Routes ───────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, name, email, password } = req.body;
    if (!username || !name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (await stmts.getUserByUsername(username)) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    if (await stmts.getUserByEmail(email)) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    await createUser(username, name, email, password, 'participant');
    res.json({ success: true, message: 'Registration submitted — awaiting admin approval' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await stmts.getUserByUsername(username);

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.role === 'participant' && user.status === 'pending') {
      return res.status(403).json({ error: 'Your registration is still pending approval' });
    }

    if (user.role === 'participant' && user.status === 'rejected') {
      return res.status(403).json({ error: 'Your registration has been rejected' });
    }

    if (user.role === 'participant' && user.status === 'deactivated') {
      return res.status(403).json({ error: 'Your account has been deactivated. Please contact the administrator.' });
    }

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.username = user.username;

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = await stmts.getUserById(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  res.json({
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status
  });
});

// ─── Admin Routes ──────────────────────────────────────────────

// === Simulation Management ===
app.get('/api/admin/simulations', requireAdmin, async (req, res) => {
  const sims = await stmts.getAllSimulations();
  res.json(sims);
});

app.post('/api/admin/simulations', requireAdmin, async (req, res) => {
  try {
    const { name, totalDays, startingCash } = req.body;
    if (!name || !totalDays || !startingCash) {
      return res.status(400).json({ error: 'Name, totalDays, and startingCash are required' });
    }

    const result = await stmts.createSimulation({
      name,
      total_days: parseInt(totalDays),
      starting_cash: parseFloat(startingCash)
    });

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/simulations/:id', requireAdmin, async (req, res) => {
  const sim = await stmts.getSimulation(parseInt(req.params.id));
  if (!sim) return res.status(404).json({ error: 'Simulation not found' });
  res.json(sim);
});

// Simulation controls
app.post('/api/admin/simulation/:id/start', requireAdmin, async (req, res) => {
  const result = await simulation.start(parseInt(req.params.id));
  res.json(result);
});

app.post('/api/admin/simulation/:id/pause', requireAdmin, async (req, res) => {
  const result = await simulation.pause(parseInt(req.params.id));
  res.json(result);
});

app.post('/api/admin/simulation/:id/resume', requireAdmin, async (req, res) => {
  const result = await simulation.resume(parseInt(req.params.id));
  res.json(result);
});

app.post('/api/admin/simulation/:id/stop', requireAdmin, async (req, res) => {
  const result = await simulation.stop(parseInt(req.params.id));
  res.json(result);
});

app.get('/api/admin/simulation/state', requireAdmin, async (req, res) => {
  const state = await simulation.getState();
  res.json(state || { status: 'not_started' });
});

// === Report Release ===
app.post('/api/admin/simulation/:id/release-report', requireAdmin, async (req, res) => {
  try {
    const simId = parseInt(req.params.id);
    const sim = await stmts.getSimulation(simId);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });
    if (sim.status !== 'stopped') return res.status(400).json({ error: 'Simulation must be stopped to release report' });

    const { targetUserIds } = req.body;

    if (targetUserIds && Array.isArray(targetUserIds)) {
      for (const uid of targetUserIds) {
        await stmts.setParticipantReportVisible(1, simId, uid);
      }
    } else {
      await stmts.setAllParticipantsReportVisible(simId);
    }

    await stmts.releaseReport(new Date().toISOString(), simId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Stock Management (per simulation) ===
app.get('/api/admin/simulations/:simId/stocks', requireAdmin, async (req, res) => {
  const stocks = await stmts.getSimStocks(parseInt(req.params.simId));
  res.json(stocks);
});

app.post('/api/admin/simulations/:simId/stocks', requireAdmin, async (req, res) => {
  try {
    const simId = parseInt(req.params.simId);
    const { name, ticker, industry, description, startingPrice, volatility } = req.body;
    if (!name || !ticker || !industry || !startingPrice) {
      return res.status(400).json({ error: 'All stock fields are required' });
    }

    const sim = await stmts.getSimulation(simId);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });
    if (sim.status === 'running') {
      return res.status(400).json({ error: 'Cannot add stocks while simulation is running' });
    }
    if (sim.status === 'stopped') {
      return res.status(400).json({ error: 'Cannot modify archived simulation' });
    }

    const countRow = await stmts.getStockCount(simId);
    const count = countRow ? countRow.count : 0;

    const result = await stmts.createStock({
      simulation_id: simId,
      name,
      ticker: ticker.toUpperCase(),
      industry,
      description: description || '',
      starting_price: parseFloat(startingPrice),
      current_price: parseFloat(startingPrice),
      volatility: volatility || 'medium',
      color_index: count
    });

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    if (error.message && error.message.includes('unique')) {
      return res.status(400).json({ error: 'Ticker symbol already exists in this simulation' });
    }
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/stocks/:id', requireAdmin, async (req, res) => {
  try {
    await stmts.deleteStock(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === News Publisher (per simulation) ===
app.post('/api/admin/simulations/:simId/news/analyze', requireAdmin, async (req, res) => {
  try {
    const { headline, intendedStrength } = req.body;
    if (!headline) {
      return res.status(400).json({ error: 'Headline is required' });
    }

    const stocks = await stmts.getSimStocks(parseInt(req.params.simId));
    const industries = [...new Set(stocks.map(s => s.industry))];
    const stockContext = stocks.map(s => ({
      ticker: s.ticker,
      name: s.name,
      industry: s.industry,
      description: s.description || ''
    }));

    const analysis = await analyzeHeadline(headline, industries, stockContext, intendedStrength || null);
    res.json(analysis);
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze headline' });
  }
});

app.post('/api/admin/simulations/:simId/news/suggest', requireAdmin, async (req, res) => {
  try {
    const { stockIds, sentiment, strength } = req.body;
    if (!stockIds || !stockIds.length) {
      return res.status(400).json({ error: 'Select at least one stock' });
    }

    const allStocks = await stmts.getSimStocks(parseInt(req.params.simId));
    const selected = allStocks.filter(s => stockIds.includes(s.id));
    if (selected.length === 0) {
      return res.status(400).json({ error: 'No matching stocks found' });
    }

    const result = await generateNewsSuggestions(selected, sentiment || 'negative', strength || 'moderate');
    res.json(result);
  } catch (error) {
    console.error('Suggestion error:', error);
    res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

app.post('/api/admin/simulations/:simId/news/publish', requireAdmin, async (req, res) => {
  try {
    const simId = parseInt(req.params.simId);
    const { headline, impacts, summary, reasoning, smartInvestorAction } = req.body;
    const state = await simulation.getState(simId);

    if (!state || state.status !== 'running') {
      return res.status(400).json({ error: 'Simulation must be running to publish news' });
    }

    const simDay = state.simDay;

    const fullReasoning = JSON.stringify({
      summary: summary || '',
      smartInvestorAction: smartInvestorAction || '',
      impactDetails: impacts || []
    });

    await stmts.addNews(
      simId,
      headline,
      JSON.stringify({ impacts, summary }),
      fullReasoning,
      simDay
    );

    if (impacts && impacts.length > 0) {
      await simulation.applyNewsImpact(impacts, simId);
    }

    const broadcastItem = {
      headline,
      sim_day: Math.round(simDay * 100) / 100,
      timestamp: new Date().toISOString()
    };

    io.emit('news:published', broadcastItem);
    res.json({ success: true, newsItem: { ...broadcastItem, impacts, summary } });
  } catch (error) {
    console.error('Publish error:', error);
    res.status(500).json({ error: 'Failed to publish news' });
  }
});

app.post('/api/admin/simulations/:simId/news/schedule', requireAdmin, async (req, res) => {
  try {
    const simId = parseInt(req.params.simId);
    const { headline, impacts, summary, reasoning, smartInvestorAction, scheduledDay } = req.body;

    if (!headline || !impacts) {
      return res.status(400).json({ error: 'Headline and impacts are required' });
    }

    if (scheduledDay === undefined || scheduledDay === null || scheduledDay < 1) {
      return res.status(400).json({ error: 'A valid scheduled day is required (>= 1)' });
    }

    const fullReasoning = JSON.stringify({
      summary: summary || '',
      smartInvestorAction: smartInvestorAction || '',
      impactDetails: impacts || []
    });

    await stmts.addScheduledNews(
      simId,
      headline,
      JSON.stringify({ impacts, summary }),
      fullReasoning,
      parseFloat(scheduledDay),
      'scheduled'
    );

    res.json({ success: true, message: `News scheduled for Day ${parseFloat(scheduledDay).toFixed(2)}` });
  } catch (error) {
    console.error('Schedule error:', error);
    res.status(500).json({ error: 'Failed to schedule news' });
  }
});

app.get('/api/admin/simulations/:simId/news/scheduled', requireAdmin, async (req, res) => {
  try {
    const scheduled = await stmts.getScheduledSimNews(parseInt(req.params.simId));
    res.json(scheduled.map(n => ({
      ...n,
      impacts: JSON.parse(n.impacts)
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to load scheduled news' });
  }
});

app.get('/api/admin/simulations/:simId/news', requireAdmin, async (req, res) => {
  try {
    const news = await stmts.getSimNews(parseInt(req.params.simId));
    res.json(news.map(n => ({
      ...n,
      impacts: JSON.parse(n.impacts)
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to load news' });
  }
});

app.delete('/api/admin/news/scheduled/:id', requireAdmin, async (req, res) => {
  try {
    const result = await stmts.deleteScheduledNews(parseInt(req.params.id));
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Scheduled news item not found or already published' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete scheduled news' });
  }
});

// === Registration Management ===
app.get('/api/admin/registrations', requireAdmin, async (req, res) => {
  const pending = await stmts.getPendingUsers();
  const approved = await stmts.getApprovedUsers();
  const all = await stmts.getAllParticipants();
  res.json({ pending, approved, all });
});

app.post('/api/admin/registrations/:id/approve', requireAdmin, async (req, res) => {
  await stmts.approveUser(parseInt(req.params.id));
  io.emit('registration:approved', { userId: parseInt(req.params.id) });
  res.json({ success: true });
});

app.post('/api/admin/registrations/:id/reject', requireAdmin, async (req, res) => {
  await stmts.rejectUser(parseInt(req.params.id));
  res.json({ success: true });
});

app.post('/api/admin/registrations/:id/deactivate', requireAdmin, async (req, res) => {
  await stmts.deactivateUser(parseInt(req.params.id));
  res.json({ success: true });
});

app.post('/api/admin/registrations/:id/reactivate', requireAdmin, async (req, res) => {
  await stmts.reactivateUser(parseInt(req.params.id));
  res.json({ success: true });
});

// === Leaderboard (per simulation) ===
app.get('/api/admin/simulations/:simId/leaderboard', requireAdmin, async (req, res) => {
  res.json(await getLeaderboard(parseInt(req.params.simId)));
});

// === Archive: simulation report data ===
app.get('/api/admin/simulations/:simId/report', requireAdmin, async (req, res) => {
  try {
    const simId = parseInt(req.params.simId);
    const sim = await stmts.getSimulation(simId);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });

    const allNews = await stmts.getAllSimNews(simId);
    const stocks = await stmts.getSimStocks(simId);
    const leaderboard = await getLeaderboard(simId);

    res.json({
      simulation: sim,
      news: allNews.map(n => ({
        ...n,
        impacts: JSON.parse(n.impacts),
        reasoning: n.reasoning ? JSON.parse(n.reasoning) : null
      })),
      stocks,
      leaderboard,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Participant Routes ────────────────────────────────────────

app.get('/api/participant/simulation', requireParticipant, async (req, res) => {
  const state = await simulation.getState();
  if (!state) return res.json({ status: 'not_started' });

  const sp = await stmts.getParticipant(state.id, req.session.userId);
  res.json({
    ...state,
    participantCash: sp ? sp.cash : 0,
    isParticipant: !!sp
  });
});

app.get('/api/participant/portfolio', requireParticipant, async (req, res) => {
  const state = await simulation.getState();
  if (!state || !state.id) return res.json({ cash: 0, holdings: [], trades: [], totalValue: 0 });

  const sp = await stmts.getParticipant(state.id, req.session.userId);
  if (!sp) return res.json({ cash: 0, holdings: [], trades: [], totalValue: 0 });

  const holdings = await stmts.getUserSimHoldings(req.session.userId, state.id);
  const trades = await stmts.getUserSimTrades(req.session.userId, state.id);

  let holdingsValue = 0;
  holdings.forEach(h => { holdingsValue += h.quantity * h.current_price; });

  res.json({
    cash: sp.cash,
    holdings,
    trades: trades.slice(0, 50),
    totalValue: sp.cash + holdingsValue
  });
});

app.get('/api/participant/stocks', requireParticipant, async (req, res) => {
  const state = await simulation.getState();
  if (!state || !state.id) return res.json({ stocks: [], simState: { status: 'not_started' } });

  const stocks = await stmts.getSimStocks(state.id);
  res.json({ stocks, simState: state });
});

app.get('/api/participant/stocks/:id/history', requireParticipant, async (req, res) => {
  const history = await stmts.getPriceHistory(parseInt(req.params.id));
  res.json(history);
});

app.post('/api/participant/trade', requireParticipant, async (req, res) => {
  try {
    const { stockId, type, quantity } = req.body;
    const state = await simulation.getState();

    if (!state || state.status !== 'running') {
      return res.status(400).json({ error: 'Trading is only available while simulation is running' });
    }

    if (!stockId || !type || !quantity) {
      return res.status(400).json({ error: 'stockId, type, and quantity are required' });
    }

    const result = await executeTrade(
      req.session.userId,
      parseInt(stockId),
      state.id,
      type,
      parseInt(quantity),
      state.simDay
    );

    io.to(`user_${req.session.userId}`).emit('trade:executed', result);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/participant/news', requireParticipant, async (req, res) => {
  const state = await simulation.getState();
  if (!state || !state.id) return res.json([]);

  const news = await stmts.getSimNews(state.id);
  res.json(news.map(n => ({
    id: n.id,
    headline: n.headline,
    sim_day: n.sim_day,
    created_at: n.created_at
  })));
});

app.get('/api/participant/leaderboard', requireParticipant, async (req, res) => {
  const state = await simulation.getState();
  if (!state || !state.id) return res.json([]);
  res.json(await getLeaderboard(state.id));
});

// === Participant Archive ===
app.get('/api/participant/archives', requireParticipant, async (req, res) => {
  try {
    const archivedSims = await stmts.getArchivedSimulations();
    const userSims = [];
    for (const sim of archivedSims) {
      const sp = await stmts.getParticipant(sim.id, req.session.userId);
      if (sp) {
        userSims.push({
          ...sim,
          reportVisible: sp.report_visible
        });
      }
    }
    res.json(userSims);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/participant/archives/:simId/report', requireParticipant, async (req, res) => {
  try {
    const simId = parseInt(req.params.simId);
    const sim = await stmts.getSimulation(simId);
    if (!sim || sim.status !== 'stopped') return res.status(404).json({ error: 'Archive not found' });

    const sp = await stmts.getParticipant(simId, req.session.userId);
    if (!sp) return res.status(403).json({ error: 'You were not part of this simulation' });
    if (!sp.report_visible) return res.status(403).json({ error: 'Report not yet released by admin' });

    const allNews = await stmts.getAllSimNews(simId);
    const stocks = await stmts.getSimStocks(simId);
    const leaderboard = await getLeaderboard(simId);

    res.json({
      simulation: sim,
      news: allNews.map(n => ({
        ...n,
        impacts: JSON.parse(n.impacts),
        reasoning: n.reasoning ? JSON.parse(n.reasoning) : null
      })),
      stocks,
      leaderboard,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/participant/archives/:simId/leaderboard', requireParticipant, async (req, res) => {
  try {
    const simId = parseInt(req.params.simId);
    const sp = await stmts.getParticipant(simId, req.session.userId);
    if (!sp) return res.status(403).json({ error: 'Not part of this simulation' });
    res.json(await getLeaderboard(simId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Socket.IO Connections ─────────────────────────────────────
io.on('connection', async (socket) => {
  const session = socket.request.session;

  if (session && session.userId) {
    socket.join(`user_${session.userId}`);
    if (session.role === 'admin') {
      socket.join('admins');
    } else {
      socket.join('participants');
    }
  }

  // Send current state on connect
  const state = await simulation.getState();
  socket.emit('simulation:state', state || { status: 'not_started' });

  // Send current stock prices if active sim
  if (state && state.id) {
    const stocks = await stmts.getSimStocks(state.id);
    socket.emit('prices:update', stocks.map(s => ({
      id: s.id,
      ticker: s.ticker,
      name: s.name,
      price: Math.round(s.current_price * 100) / 100,
      startingPrice: s.starting_price,
      percentChange: Math.round(((s.current_price - s.starting_price) / s.starting_price) * 100 * 100) / 100,
      industry: s.industry,
      colorIndex: s.color_index
    })));
  }

  socket.on('disconnect', () => {
    // Cleanup if needed
  });
});

// ─── SPA-style route handling ──────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('/participant', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'participant.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
});

// ─── Start Server ──────────────────────────────────────────────
async function startServer() {
  // Initialize database tables
  await initDB();

  // Ensure admin user exists
  try {
    const admin = await stmts.getUserByUsername(process.env.ADMIN_USERNAME || 'admin');
    if (!admin) {
      await createUser(
        process.env.ADMIN_USERNAME || 'admin',
        'Administrator',
        'admin@simulator.local',
        process.env.ADMIN_PASSWORD || 'admin123',
        'admin'
      );
      console.log('✅ Admin user created');
    }
  } catch (e) {
    console.error('Admin init error:', e.message);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`
  ╔══════════════════════════════════════════════╗
  ║     📈 Stock Market Simulator Running       ║
  ║                                              ║
  ║  🌐 http://localhost:${PORT}                    ║
  ║  👤 Admin: ${(process.env.ADMIN_USERNAME || 'admin').padEnd(30)}║
  ║  🔑 Password: ${(process.env.ADMIN_PASSWORD || 'admin123').padEnd(27)}║
  ╚══════════════════════════════════════════════╝
    `);

    // Log which AI engine is active
    logAIStatus();

    // Recover simulation state if needed
    simulation.recover();
  });
}

startServer().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
