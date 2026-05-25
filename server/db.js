const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Schema ────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'participant' CHECK(role IN ('admin','participant')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS simulations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      total_days INTEGER DEFAULT 5,
      starting_cash DOUBLE PRECISION DEFAULT 10000,
      status TEXT DEFAULT 'not_started' CHECK(status IN ('not_started','running','paused','stopped')),
      current_day INTEGER DEFAULT 0,
      day_start_time BIGINT DEFAULT 0,
      elapsed_in_day BIGINT DEFAULT 0,
      report_released INTEGER DEFAULT 0,
      report_released_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      started_at TIMESTAMP,
      paused_at TIMESTAMP,
      stopped_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS simulation_participants (
      simulation_id INTEGER NOT NULL REFERENCES simulations(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      cash DOUBLE PRECISION DEFAULT 0,
      report_visible INTEGER DEFAULT 0,
      PRIMARY KEY (simulation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS stocks (
      id SERIAL PRIMARY KEY,
      simulation_id INTEGER NOT NULL REFERENCES simulations(id),
      name TEXT NOT NULL,
      ticker TEXT NOT NULL,
      industry TEXT NOT NULL,
      description TEXT DEFAULT '',
      starting_price DOUBLE PRECISION NOT NULL,
      current_price DOUBLE PRECISION NOT NULL,
      volatility TEXT DEFAULT 'medium' CHECK(volatility IN ('low','medium','high')),
      buy_pressure DOUBLE PRECISION DEFAULT 0,
      color_index INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(simulation_id, ticker)
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id SERIAL PRIMARY KEY,
      stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
      simulation_id INTEGER NOT NULL REFERENCES simulations(id),
      price DOUBLE PRECISION NOT NULL,
      sim_day DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
      simulation_id INTEGER NOT NULL REFERENCES simulations(id),
      type TEXT NOT NULL CHECK(type IN ('buy','sell')),
      quantity INTEGER NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      total DOUBLE PRECISION NOT NULL,
      sim_day DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS holdings (
      user_id INTEGER NOT NULL REFERENCES users(id),
      stock_id INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
      simulation_id INTEGER NOT NULL REFERENCES simulations(id),
      quantity INTEGER DEFAULT 0,
      avg_price DOUBLE PRECISION DEFAULT 0,
      PRIMARY KEY (user_id, stock_id, simulation_id)
    );

    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      simulation_id INTEGER NOT NULL REFERENCES simulations(id),
      headline TEXT NOT NULL,
      impacts TEXT NOT NULL,
      reasoning TEXT DEFAULT '',
      sim_day DOUBLE PRECISION NOT NULL,
      scheduled_day DOUBLE PRECISION DEFAULT NULL,
      status TEXT DEFAULT 'published' CHECK(status IN ('scheduled','published')),
      admin_edits TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Create indexes
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_price_history_stock ON price_history(stock_id, sim_day);
    CREATE INDEX IF NOT EXISTS idx_price_history_sim ON price_history(simulation_id);
    CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
    CREATE INDEX IF NOT EXISTS idx_trades_stock ON trades(stock_id);
    CREATE INDEX IF NOT EXISTS idx_trades_sim ON trades(simulation_id);
    CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);
    CREATE INDEX IF NOT EXISTS idx_holdings_sim ON holdings(simulation_id);
    CREATE INDEX IF NOT EXISTS idx_stocks_sim ON stocks(simulation_id);
    CREATE INDEX IF NOT EXISTS idx_news_sim ON news(simulation_id);
    CREATE INDEX IF NOT EXISTS idx_sim_participants ON simulation_participants(simulation_id);
  `);

  // Migration: Add 'deactivated' to user status options
  try {
    await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check`);
    await pool.query(`ALTER TABLE users ADD CONSTRAINT users_status_check CHECK(status IN ('pending','approved','rejected','deactivated'))`);
  } catch (e) {
    // Constraint may already be updated — ignore
  }

  // Migration: Create simulation_registrations table for per-simulation registration
  await pool.query(`
    CREATE TABLE IF NOT EXISTS simulation_registrations (
      simulation_id INTEGER NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (simulation_id, user_id)
    );
  `);

  console.log('  ✅ PostgreSQL schema initialized');
}

// ─── Query Helpers ─────────────────────────────────────────────
async function queryOne(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function queryAll(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function execute(sql, params = []) {
  const { rows, rowCount } = await pool.query(sql, params);
  return { lastInsertRowid: rows[0]?.id, changes: rowCount };
}

// ─── Prepared Statements (Async) ───────────────────────────────

const stmts = {
  // Users
  createUser: async (p) => execute(
    'INSERT INTO users (username, name, email, password_hash, role, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [p.username, p.name, p.email, p.password_hash, p.role, p.status]
  ),
  getUserByUsername: (u) => queryOne('SELECT * FROM users WHERE username = $1', [u]),
  getUserById: (id) => queryOne('SELECT * FROM users WHERE id = $1', [id]),
  getUserByEmail: (e) => queryOne('SELECT * FROM users WHERE email = $1', [e]),
  getPendingUsers: () => queryAll("SELECT id, username, name, email, created_at FROM users WHERE role = 'participant' AND status = 'pending'"),
  getApprovedUsers: () => queryAll("SELECT id, username, name, email, created_at FROM users WHERE role = 'participant' AND status = 'approved'"),
  getAllParticipants: () => queryAll("SELECT id, username, name, email, status, created_at FROM users WHERE role = 'participant'"),
  approveUser: (id) => execute("UPDATE users SET status = 'approved' WHERE id = $1 AND role = 'participant'", [id]),
  rejectUser: (id) => execute("UPDATE users SET status = 'rejected' WHERE id = $1 AND role = 'participant'", [id]),
  deactivateUser: (id) => execute("UPDATE users SET status = 'deactivated' WHERE id = $1 AND role = 'participant'", [id]),
  reactivateUser: (id) => execute("UPDATE users SET status = 'approved' WHERE id = $1 AND role = 'participant' AND status = 'deactivated'", [id]),
  updateUserPasswordHash: (username, hash) => execute("UPDATE users SET password_hash = $1 WHERE username = $2", [hash, username]),

  // Simulations
  createSimulation: async (p) => execute(
    "INSERT INTO simulations (name, total_days, starting_cash, status) VALUES ($1,$2,$3,'not_started') RETURNING id",
    [p.name, p.total_days, p.starting_cash]
  ),
  getSimulation: (id) => queryOne('SELECT * FROM simulations WHERE id = $1', [id]),
  getAllSimulations: () => queryAll('SELECT * FROM simulations ORDER BY created_at DESC'),
  getActiveSimulation: () => queryOne("SELECT * FROM simulations WHERE status IN ('running', 'paused') LIMIT 1"),
  getArchivedSimulations: () => queryAll("SELECT * FROM simulations WHERE status = 'stopped' ORDER BY stopped_at DESC"),
  deleteSimulationData: async (simId) => {
    // Delete in correct order respecting foreign keys
    await pool.query('DELETE FROM trades WHERE simulation_id = $1', [simId]);
    await pool.query('DELETE FROM holdings WHERE simulation_id = $1', [simId]);
    await pool.query('DELETE FROM price_history WHERE simulation_id = $1', [simId]);
    await pool.query('DELETE FROM news WHERE simulation_id = $1', [simId]);
    await pool.query('DELETE FROM stocks WHERE simulation_id = $1', [simId]);
    await pool.query('DELETE FROM simulation_participants WHERE simulation_id = $1', [simId]);
    await pool.query('DELETE FROM simulation_registrations WHERE simulation_id = $1', [simId]);
    await pool.query('DELETE FROM simulations WHERE id = $1', [simId]);
  },
  updateSimulation: (p) => execute(
    'UPDATE simulations SET status=$1, current_day=$2, day_start_time=$3, elapsed_in_day=$4, started_at=$5, paused_at=$6, stopped_at=$7 WHERE id=$8',
    [p.status, p.current_day, p.day_start_time, p.elapsed_in_day, p.started_at, p.paused_at, p.stopped_at, p.id]
  ),
  updateSimStatus: (status, stopped_at, id) => execute(
    'UPDATE simulations SET status = $1, stopped_at = $2 WHERE id = $3', [status, stopped_at, id]
  ),
  releaseReport: (released_at, id) => execute(
    'UPDATE simulations SET report_released = 1, report_released_at = $1 WHERE id = $2', [released_at, id]
  ),

  // Simulation Participants
  addParticipant: (simId, userId, cash) => execute(
    'INSERT INTO simulation_participants (simulation_id, user_id, cash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [simId, userId, cash]
  ),
  getParticipant: (simId, userId) => queryOne(
    'SELECT * FROM simulation_participants WHERE simulation_id = $1 AND user_id = $2', [simId, userId]
  ),
  getSimParticipants: (simId) => queryAll(
    'SELECT sp.*, u.username, u.name, u.email FROM simulation_participants sp JOIN users u ON sp.user_id = u.id WHERE sp.simulation_id = $1', [simId]
  ),
  updateParticipantCash: (amount, simId, userId) => execute(
    'UPDATE simulation_participants SET cash = cash + $1 WHERE simulation_id = $2 AND user_id = $3', [amount, simId, userId]
  ),
  setParticipantCash: (cash, simId, userId) => execute(
    'UPDATE simulation_participants SET cash = $1 WHERE simulation_id = $2 AND user_id = $3', [cash, simId, userId]
  ),
  setParticipantReportVisible: (visible, simId, userId) => execute(
    'UPDATE simulation_participants SET report_visible = $1 WHERE simulation_id = $2 AND user_id = $3', [visible, simId, userId]
  ),
  setAllParticipantsReportVisible: (simId) => execute(
    'UPDATE simulation_participants SET report_visible = 1 WHERE simulation_id = $1', [simId]
  ),

  // Simulation Registrations (per-sim registration)
  registerForSim: (simId, userId) => execute(
    "INSERT INTO simulation_registrations (simulation_id, user_id, status) VALUES ($1,$2,'pending') ON CONFLICT (simulation_id, user_id) DO NOTHING RETURNING simulation_id",
    [simId, userId]
  ),
  getSimRegistrations: (simId) => queryAll(
    'SELECT sr.*, u.username, u.name, u.email FROM simulation_registrations sr JOIN users u ON sr.user_id = u.id WHERE sr.simulation_id = $1 ORDER BY sr.created_at ASC',
    [simId]
  ),
  getSimRegistration: (simId, userId) => queryOne(
    'SELECT * FROM simulation_registrations WHERE simulation_id = $1 AND user_id = $2', [simId, userId]
  ),
  updateSimRegistration: (status, simId, userId) => execute(
    'UPDATE simulation_registrations SET status = $1 WHERE simulation_id = $2 AND user_id = $3', [status, simId, userId]
  ),
  getApprovedSimRegistrations: (simId) => queryAll(
    'SELECT sr.*, u.username, u.name FROM simulation_registrations sr JOIN users u ON sr.user_id = u.id WHERE sr.simulation_id = $1 AND sr.status = \'approved\'',
    [simId]
  ),
  getRegistrableSimulations: (userId) => queryAll(
    `SELECT s.*, 
      (SELECT sr.status FROM simulation_registrations sr WHERE sr.simulation_id = s.id AND sr.user_id = $1) as reg_status
     FROM simulations s WHERE s.status = 'not_started' ORDER BY s.created_at DESC`,
    [userId]
  ),

  // Stocks
  createStock: async (p) => execute(
    'INSERT INTO stocks (simulation_id, name, ticker, industry, description, starting_price, current_price, volatility, color_index) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [p.simulation_id, p.name, p.ticker, p.industry, p.description, p.starting_price, p.current_price, p.volatility, p.color_index]
  ),
  updateStock: (p) => execute(
    'UPDATE stocks SET name=$1, ticker=$2, industry=$3, description=$4, starting_price=$5, current_price=$6, volatility=$7 WHERE id=$8',
    [p.name, p.ticker, p.industry, p.description, p.starting_price, p.current_price, p.volatility, p.id]
  ),
  deleteStock: (id) => execute('DELETE FROM stocks WHERE id = $1', [id]),
  getStock: (id) => queryOne('SELECT * FROM stocks WHERE id = $1', [id]),
  getSimStocks: (simId) => queryAll('SELECT * FROM stocks WHERE simulation_id = $1 ORDER BY ticker', [simId]),
  updateStockPrice: (price, pressure, id) => execute(
    'UPDATE stocks SET current_price = $1, buy_pressure = $2 WHERE id = $3', [price, pressure, id]
  ),
  resetSimStockPrices: (simId) => execute(
    'UPDATE stocks SET current_price = starting_price, buy_pressure = 0 WHERE simulation_id = $1', [simId]
  ),
  getStockCount: async (simId) => {
    const row = await queryOne('SELECT COUNT(*)::integer as count FROM stocks WHERE simulation_id = $1', [simId]);
    return row;
  },

  // Price History
  addPriceHistory: (stockId, simId, price, simDay) => execute(
    'INSERT INTO price_history (stock_id, simulation_id, price, sim_day) VALUES ($1,$2,$3,$4)', [stockId, simId, price, simDay]
  ),
  getPriceHistory: (stockId) => queryAll(
    'SELECT price, sim_day, created_at FROM price_history WHERE stock_id = $1 ORDER BY sim_day ASC', [stockId]
  ),
  getSimPriceHistory: (simId) => queryAll(
    'SELECT ph.*, s.ticker FROM price_history ph JOIN stocks s ON ph.stock_id = s.id WHERE ph.simulation_id = $1 ORDER BY ph.sim_day ASC', [simId]
  ),

  // Trades
  addTrade: (p) => execute(
    'INSERT INTO trades (user_id, stock_id, simulation_id, type, quantity, price, total, sim_day) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [p.user_id, p.stock_id, p.simulation_id, p.type, p.quantity, p.price, p.total, p.sim_day]
  ),
  getUserSimTrades: (userId, simId) => queryAll(
    'SELECT t.*, s.ticker, s.name as stock_name FROM trades t JOIN stocks s ON t.stock_id = s.id WHERE t.user_id = $1 AND t.simulation_id = $2 ORDER BY t.created_at DESC',
    [userId, simId]
  ),
  getRecentTrades: (stockId) => queryAll(
    "SELECT * FROM trades WHERE stock_id = $1 AND created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC", [stockId]
  ),

  // Holdings
  getHolding: (userId, stockId, simId) => queryOne(
    'SELECT * FROM holdings WHERE user_id = $1 AND stock_id = $2 AND simulation_id = $3', [userId, stockId, simId]
  ),
  upsertHolding: (p) => execute(
    `INSERT INTO holdings (user_id, stock_id, simulation_id, quantity, avg_price)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT(user_id, stock_id, simulation_id) DO UPDATE SET quantity = EXCLUDED.quantity, avg_price = EXCLUDED.avg_price`,
    [p.user_id, p.stock_id, p.simulation_id, p.quantity, p.avg_price]
  ),
  getUserSimHoldings: (userId, simId) => queryAll(
    'SELECT h.*, s.ticker, s.name as stock_name, s.current_price, s.starting_price FROM holdings h JOIN stocks s ON h.stock_id = s.id WHERE h.user_id = $1 AND h.simulation_id = $2 AND h.quantity > 0',
    [userId, simId]
  ),

  // News
  addNews: (simId, headline, impacts, reasoning, simDay) => execute(
    'INSERT INTO news (simulation_id, headline, impacts, reasoning, sim_day) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [simId, headline, impacts, reasoning, simDay]
  ),
  addScheduledNews: (simId, headline, impacts, reasoning, scheduledDay, status) => execute(
    'INSERT INTO news (simulation_id, headline, impacts, reasoning, sim_day, scheduled_day, status) VALUES ($1,$2,$3,$4,0,$5,$6) RETURNING id',
    [simId, headline, impacts, reasoning, scheduledDay, status]
  ),
  getSimNews: (simId) => queryAll(
    "SELECT * FROM news WHERE simulation_id = $1 AND status = 'published' ORDER BY sim_day DESC, created_at DESC", [simId]
  ),
  getScheduledSimNews: (simId) => queryAll(
    "SELECT * FROM news WHERE simulation_id = $1 AND status = 'scheduled' ORDER BY scheduled_day ASC", [simId]
  ),
  getDueScheduledNews: (simId, day) => queryAll(
    "SELECT * FROM news WHERE simulation_id = $1 AND status = 'scheduled' AND scheduled_day <= $2", [simId, day]
  ),
  publishScheduledNews: (simDay, id) => execute(
    "UPDATE news SET status = 'published', sim_day = $1 WHERE id = $2", [simDay, id]
  ),
  deleteScheduledNews: (id) => execute(
    "DELETE FROM news WHERE id = $1 AND status = 'scheduled'", [id]
  ),
  updateNewsAdminEdits: (edits, id) => execute(
    'UPDATE news SET admin_edits = $1 WHERE id = $2', [edits, id]
  ),
  getAllSimNews: (simId) => queryAll(
    'SELECT * FROM news WHERE simulation_id = $1 ORDER BY sim_day ASC, created_at ASC', [simId]
  ),
};

// ─── Helper Functions ──────────────────────────────────────────

async function createUser(username, name, email, password, role = 'participant') {
  const password_hash = bcrypt.hashSync(password, 10);
  return stmts.createUser({
    username, name, email, password_hash,
    role,
    status: role === 'admin' ? 'approved' : 'pending',
  });
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

async function getLeaderboard(simulationId) {
  const participants = await stmts.getSimParticipants(simulationId);
  const stocks = await stmts.getSimStocks(simulationId);
  const stockMap = {};
  stocks.forEach(s => { stockMap[s.id] = s; });

  const results = [];
  for (const p of participants) {
    const holdings = await stmts.getUserSimHoldings(p.user_id, simulationId);
    let holdingsValue = 0;
    holdings.forEach(h => {
      holdingsValue += h.quantity * h.current_price;
    });
    results.push({
      userId: p.user_id,
      username: p.username,
      name: p.name,
      cash: p.cash,
      holdingsValue,
      totalValue: p.cash + holdingsValue
    });
  }

  return results
    .sort((a, b) => b.totalValue - a.totalValue)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

async function executeTrade(userId, stockId, simulationId, type, quantity, simDay) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [participant] } = await client.query(
      'SELECT * FROM simulation_participants WHERE simulation_id = $1 AND user_id = $2', [simulationId, userId]
    );
    const { rows: [stock] } = await client.query(
      'SELECT * FROM stocks WHERE id = $1', [stockId]
    );

    if (!participant || !stock) throw new Error('Invalid user or stock');
    if (stock.simulation_id !== simulationId) throw new Error('Stock does not belong to this simulation');
    if (quantity <= 0) throw new Error('Quantity must be positive');

    const price = stock.current_price;
    const total = price * quantity;

    if (type === 'buy') {
      if (participant.cash < total) throw new Error('Insufficient cash');

      const { rows: [existingHolding] } = await client.query(
        'SELECT * FROM holdings WHERE user_id = $1 AND stock_id = $2 AND simulation_id = $3', [userId, stockId, simulationId]
      );
      const currentQty = existingHolding ? existingHolding.quantity : 0;
      const currentAvg = existingHolding ? existingHolding.avg_price : 0;
      const newQty = currentQty + quantity;
      const newAvg = ((currentAvg * currentQty) + total) / newQty;

      await client.query('UPDATE simulation_participants SET cash = cash + $1 WHERE simulation_id = $2 AND user_id = $3', [-total, simulationId, userId]);
      await client.query(
        `INSERT INTO holdings (user_id, stock_id, simulation_id, quantity, avg_price)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(user_id, stock_id, simulation_id) DO UPDATE SET quantity = EXCLUDED.quantity, avg_price = EXCLUDED.avg_price`,
        [userId, stockId, simulationId, newQty, newAvg]
      );
      await client.query(
        'INSERT INTO trades (user_id, stock_id, simulation_id, type, quantity, price, total, sim_day) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [userId, stockId, simulationId, 'buy', quantity, price, total, simDay]
      );
      const currentPressure = stock.buy_pressure || 0;
      await client.query('UPDATE stocks SET current_price = $1, buy_pressure = $2 WHERE id = $3',
        [stock.current_price, currentPressure + quantity * 0.001, stockId]
      );

      await client.query('COMMIT');
      return { type: 'buy', quantity, price, total, newCash: participant.cash - total };

    } else if (type === 'sell') {
      const { rows: [holding] } = await client.query(
        'SELECT * FROM holdings WHERE user_id = $1 AND stock_id = $2 AND simulation_id = $3', [userId, stockId, simulationId]
      );
      if (!holding || holding.quantity < quantity) throw new Error('Insufficient holdings');

      const newQty = holding.quantity - quantity;

      await client.query('UPDATE simulation_participants SET cash = cash + $1 WHERE simulation_id = $2 AND user_id = $3', [total, simulationId, userId]);
      await client.query(
        `INSERT INTO holdings (user_id, stock_id, simulation_id, quantity, avg_price)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(user_id, stock_id, simulation_id) DO UPDATE SET quantity = EXCLUDED.quantity, avg_price = EXCLUDED.avg_price`,
        [userId, stockId, simulationId, newQty, newQty > 0 ? holding.avg_price : 0]
      );
      await client.query(
        'INSERT INTO trades (user_id, stock_id, simulation_id, type, quantity, price, total, sim_day) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [userId, stockId, simulationId, 'sell', quantity, price, total, simDay]
      );
      const currentPressure = stock.buy_pressure || 0;
      await client.query('UPDATE stocks SET current_price = $1, buy_pressure = $2 WHERE id = $3',
        [stock.current_price, currentPressure - quantity * 0.001, stockId]
      );

      await client.query('COMMIT');
      return { type: 'sell', quantity, price, total, newCash: participant.cash + total };
    }

    throw new Error('Invalid trade type');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}


async function syncAdminCredentials() {
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const adminEmail = 'admin@simulator.local';

  try {
    // Query database for user with role = 'admin'
    const { rows } = await pool.query("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
    const admin = rows[0];

    if (!admin) {
      // Create admin if not exists
      await createUser(adminUsername, 'Administrator', adminEmail, adminPassword, 'admin');
      console.log('✅ Admin user created in database');
    } else {
      // Synchronize credentials in place to avoid any unique constraint conflicts
      const passwordMatches = verifyPassword(adminPassword, admin.password_hash);
      const usernameMatches = admin.username === adminUsername;

      if (!passwordMatches || !usernameMatches) {
        const password_hash = bcrypt.hashSync(adminPassword, 10);
        await pool.query(
          "UPDATE users SET username = $1, password_hash = $2 WHERE id = $3",
          [adminUsername, password_hash, admin.id]
        );
        console.log('🔄 Admin credentials successfully synchronized with Render environment variables');
      }
    }
  } catch (e) {
    console.error('❌ Admin credential synchronization error:', e.message);
  }
}

module.exports = {
  pool,
  stmts,
  initDB,
  createUser,
  verifyPassword,
  executeTrade,
  getLeaderboard,
  syncAdminCredentials
};
