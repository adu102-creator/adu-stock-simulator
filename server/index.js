require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { stmts, initDB, createUser, verifyPassword, executeTrade, getLeaderboard, syncAdminCredentials } = require('./db');
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

// ─── Security Headers ──────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled to allow CDN scripts

// ─── Rate Limiting ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again after 15 minutes.' }
});

const tradeLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trading too fast. Please slow down.' }
});

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' }
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/participant/trade', tradeLimiter);
app.use('/api/', globalLimiter);

// ─── Session Setup ─────────────────────────────────────────────
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'default-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
});

app.use(sessionMiddleware);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Share session with Socket.IO
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Reject unauthenticated socket connections
io.use((socket, next) => {
  const session = socket.request.session;
  if (!session || !session.userId) {
    return next(new Error('Authentication required'));
  }
  next();
});

// ─── Initialize Simulation Engine ──────────────────────────────
const simulation = new SimulationEngine(io);

// ─── Utility: Strict integer parser ────────────────────────────
function parseId(val) {
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0) return NaN;
  return n;
}

// ─── Failed Login Tracker ──────────────────────────────────────
const failedLogins = new Map(); // username -> { count, lockedUntil }
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// === Generate Access Code ===
async function generateAccessCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let isUnique = false;
  let code = '';
  let attempts = 0;
  while (!isUnique && attempts < 100) {
    attempts++;
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const existing = await stmts.getSimulationByAccessCode(code);
    if (!existing) {
      isUnique = true;
    }
  }
  return code;
}

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
  next();
}

// ─── Auth Routes ───────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, name, email, password } = req.body;
    if (!username || !name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Input type and length validation
    if (typeof username !== 'string' || typeof name !== 'string' ||
        typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid input types' });
    }
    if (username.length > 30 || name.length > 60 || email.length > 100 || password.length > 128) {
      return res.status(400).json({ error: 'Input exceeds maximum length' });
    }
    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, dots, hyphens, and underscores' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
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
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (username.length > 30 || password.length > 128) {
      return res.status(400).json({ error: 'Invalid input length' });
    }

    // Check account lockout
    const lockRecord = failedLogins.get(username);
    if (lockRecord && lockRecord.lockedUntil > Date.now()) {
      const mins = Math.ceil((lockRecord.lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `Account locked. Try again in ${mins} minutes.` });
    }

    const user = await stmts.getUserByUsername(username);

    if (!user || !verifyPassword(password, user.password_hash)) {
      // Track failed attempt
      const current = failedLogins.get(username) || { count: 0, lockedUntil: 0 };
      current.count += 1;
      if (current.count >= MAX_FAILED_LOGINS) {
        current.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
        current.count = 0;
      }
      failedLogins.set(username, current);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Clear failed attempts on success
    failedLogins.delete(username);

    if (user.role === 'participant' && user.status === 'pending') {
      return res.status(403).json({ error: 'Your registration is still pending approval' });
    }

    if (user.role === 'participant' && user.status === 'rejected') {
      return res.status(403).json({ error: 'Your registration has been rejected' });
    }

    if (user.role === 'participant' && user.status === 'deactivated') {
      return res.status(403).json({ error: 'Your account has been deactivated. Please contact the administrator.' });
    }

    // Regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regeneration error:', err);
        return res.status(500).json({ error: 'Login failed' });
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

    const accessCode = await generateAccessCode();

    const result = await stmts.createSimulation({
      name,
      total_days: parseInt(totalDays),
      starting_cash: parseFloat(startingCash),
      access_code: accessCode
    });

    res.json({ success: true, id: result.lastInsertRowid, accessCode });
  } catch (error) {
    console.error('Simulation create error:', error);
    res.status(500).json({ error: 'Failed to create simulation' });
  }
});

app.get('/api/admin/simulations/:id', requireAdmin, async (req, res) => {
  const sim = await stmts.getSimulation(parseInt(req.params.id));
  if (!sim) return res.status(404).json({ error: 'Simulation not found' });
  res.json(sim);
});

app.delete('/api/admin/simulations/:id', requireAdmin, async (req, res) => {
  try {
    const simId = parseInt(req.params.id);
    const sim = await stmts.getSimulation(simId);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });

    if (sim.status === 'running' || sim.status === 'paused') {
      return res.status(400).json({ error: 'Cannot delete a running or paused simulation. Stop it first.' });
    }

    // Cascade delete all related data
    await stmts.deleteSimulationData(simId);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete simulation error:', error);
    res.status(500).json({ error: 'Failed to delete simulation' });
  }
});

// Simulation controls
app.post('/api/admin/simulation/:id/start', requireAdmin, async (req, res) => {
  const result = await simulation.start(parseInt(req.params.id));
  res.json(result);
});

app.post('/api/admin/simulation/:id/schedule', requireAdmin, async (req, res) => {
  try {
    const simId = parseInt(req.params.id);
    const { startTime } = req.body; // ISO String or null to cancel

    const sim = await stmts.getSimulation(simId);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });
    if (sim.status !== 'not_started') {
      return res.status(400).json({ error: 'Can only schedule simulations that have not started' });
    }

    let parsedTime = null;
    if (startTime) {
      parsedTime = new Date(startTime);
      if (isNaN(parsedTime.getTime()) || parsedTime < new Date()) {
        return res.status(400).json({ error: 'Scheduled start time must be a valid date in the future' });
      }
    }

    await stmts.scheduleSimulation(parsedTime, simId);

    // Re-broadcast state so all participants get the countdown standby state
    const state = await simulation.getState();
    io.emit('sim:state', state || { status: 'not_started' });

    res.json({ success: true, message: startTime ? `Simulation scheduled successfully` : 'Scheduled start cancelled' });
  } catch (error) {
    console.error('Schedule simulation error:', error);
    res.status(500).json({ error: 'Failed to schedule simulation' });
  }
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
    console.error('Report release error:', error);
    res.status(500).json({ error: 'Failed to release report' });
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
    console.error('Stock create error:', error);
    res.status(500).json({ error: 'Failed to create stock' });
  }
});

app.delete('/api/admin/stocks/:id', requireAdmin, async (req, res) => {
  try {
    await stmts.deleteStock(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    console.error('Stock delete error:', error);
    res.status(500).json({ error: 'Failed to delete stock' });
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
    console.error('Simulation query error:', error);
    res.status(500).json({ error: 'Failed to load simulation data' });
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

// === Per-Simulation Registration (Participant) ===
app.get('/api/participant/available-simulations', requireParticipant, async (req, res) => {
  const sims = await stmts.getRegistrableSimulations(req.session.userId);
  res.json(sims);
});

app.post('/api/participant/simulations/:simId/register', requireParticipant, async (req, res) => {
  try {
    const simId = parseInt(req.params.simId);
    const sim = await stmts.getSimulation(simId);
    if (!sim) return res.status(404).json({ error: 'Simulation not found' });
    if (sim.status !== 'not_started') return res.status(400).json({ error: 'Registration is closed — simulation has already started' });

    await stmts.registerForSim(simId, req.session.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/participant/simulations/join', requireParticipant, async (req, res) => {
  try {
    const { accessCode } = req.body;
    if (!accessCode) {
      return res.status(400).json({ error: 'Access code is required' });
    }

    const code = accessCode.trim().toUpperCase();
    if (code.length !== 4) {
      return res.status(400).json({ error: 'Access code must be exactly 4 characters' });
    }

    const sim = await stmts.getSimulationByAccessCode(code);
    if (!sim) {
      return res.status(404).json({ error: 'Simulation not found. Please check the code and try again.' });
    }

    if (sim.status === 'stopped') {
      return res.status(400).json({ error: 'This simulation has already ended.' });
    }

    const sp = await stmts.getParticipant(sim.id, req.session.userId);
    if (!sp) {
      await stmts.addParticipant(sim.id, req.session.userId, sim.starting_cash);
    }

    res.json({ success: true, simulationId: sim.id });
  } catch (err) {
    console.error('Join simulation error:', err);
    res.status(500).json({ error: 'Failed to join simulation' });
  }
});

// === Per-Simulation Registration (Admin) ===
app.get('/api/admin/simulations/:simId/registrations', requireAdmin, async (req, res) => {
  const regs = await stmts.getSimRegistrations(parseInt(req.params.simId));
  res.json(regs);
});

app.post('/api/admin/simulations/:simId/registrations/:userId/approve', requireAdmin, async (req, res) => {
  await stmts.updateSimRegistration('approved', parseInt(req.params.simId), parseInt(req.params.userId));
  res.json({ success: true });
});

app.post('/api/admin/simulations/:simId/registrations/:userId/reject', requireAdmin, async (req, res) => {
  await stmts.updateSimRegistration('rejected', parseInt(req.params.simId), parseInt(req.params.userId));
  res.json({ success: true });
});

app.post('/api/admin/simulations/:simId/registrations/approve-all', requireAdmin, async (req, res) => {
  const regs = await stmts.getSimRegistrations(parseInt(req.params.simId));
  for (const reg of regs) {
    if (reg.status === 'pending') {
      await stmts.updateSimRegistration('approved', parseInt(req.params.simId), reg.user_id);
    }
  }
  res.json({ success: true });
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

    // Whitelist trade type
    if (type !== 'buy' && type !== 'sell') {
      return res.status(400).json({ error: 'Trade type must be "buy" or "sell"' });
    }

    // Type safety for stockId
    if (typeof stockId !== 'number' && typeof stockId !== 'string') {
      return res.status(400).json({ error: 'Invalid stockId' });
    }

    // Validate and cap quantity
    const parsedQty = Number(quantity);
    if (!Number.isInteger(parsedQty) || parsedQty <= 0) {
      return res.status(400).json({ error: 'Quantity must be a positive whole number' });
    }
    if (parsedQty > 500) {
      return res.status(400).json({ error: 'Maximum 500 shares per trade' });
    }

    const result = await executeTrade(
      req.session.userId,
      parseId(stockId),
      state.id,
      type,
      parsedQty,
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
    console.error('Archive load error:', error);
    res.status(500).json({ error: 'Failed to load archives' });
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
    console.error('Report load error:', error);
    res.status(500).json({ error: 'Failed to load report' });
  }
});

app.get('/api/participant/archives/:simId/leaderboard', requireParticipant, async (req, res) => {
  try {
    const simId = parseInt(req.params.simId);
    const sp = await stmts.getParticipant(simId, req.session.userId);
    if (!sp) return res.status(403).json({ error: 'Not part of this simulation' });
    res.json(await getLeaderboard(simId));
  } catch (error) {
    console.error('Leaderboard load error:', error);
    res.status(500).json({ error: 'Failed to load leaderboard' });
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
  // ─── Enforce required environment variables ────────────────
  const required = ['DATABASE_URL'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`\n❌ FATAL: Missing required environment variables: ${missing.join(', ')}`);
    console.error('   Set these in your .env file or Render environment settings.\n');
    process.exit(1);
  }

  // Log warnings for recommended variables
  const recommended = ['SESSION_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'];
  recommended.forEach(k => {
    if (!process.env[k]) {
      console.warn(`⚠️  Warning: Recommended environment variable "${k}" is not set.`);
    }
  });

  // Initialize database tables
  await initDB();

  // Ensure admin user exists and matches environment variables
  await syncAdminCredentials();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`
  ╔══════════════════════════════════════════════╗
  ║     📈 Stock Market Simulator Running       ║
  ║                                              ║
  ║  🌐 http://localhost:${PORT}                    ║
  ║  👤 Admin: ${(process.env.ADMIN_USERNAME || 'admin').padEnd(30)}║
  ║  🔑 Password: ●●●●●●●●                       ║
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
