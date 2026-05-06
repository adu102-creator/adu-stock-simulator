const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'simulator.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'participant' CHECK(role IN ('admin','participant')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS simulations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    total_days INTEGER DEFAULT 5,
    starting_cash REAL DEFAULT 10000,
    status TEXT DEFAULT 'not_started' CHECK(status IN ('not_started','running','paused','stopped')),
    current_day INTEGER DEFAULT 0,
    day_start_time INTEGER DEFAULT 0,
    elapsed_in_day INTEGER DEFAULT 0,
    report_released INTEGER DEFAULT 0,
    report_released_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    paused_at DATETIME,
    stopped_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS simulation_participants (
    simulation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    cash REAL DEFAULT 0,
    report_visible INTEGER DEFAULT 0,
    PRIMARY KEY (simulation_id, user_id),
    FOREIGN KEY (simulation_id) REFERENCES simulations(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    simulation_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    ticker TEXT NOT NULL,
    industry TEXT NOT NULL,
    description TEXT DEFAULT '',
    starting_price REAL NOT NULL,
    current_price REAL NOT NULL,
    volatility TEXT DEFAULT 'medium' CHECK(volatility IN ('low','medium','high')),
    buy_pressure REAL DEFAULT 0,
    color_index INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (simulation_id) REFERENCES simulations(id),
    UNIQUE(simulation_id, ticker)
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_id INTEGER NOT NULL,
    simulation_id INTEGER NOT NULL,
    price REAL NOT NULL,
    sim_day REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE,
    FOREIGN KEY (simulation_id) REFERENCES simulations(id)
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stock_id INTEGER NOT NULL,
    simulation_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('buy','sell')),
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    total REAL NOT NULL,
    sim_day REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE,
    FOREIGN KEY (simulation_id) REFERENCES simulations(id)
  );

  CREATE TABLE IF NOT EXISTS holdings (
    user_id INTEGER NOT NULL,
    stock_id INTEGER NOT NULL,
    simulation_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 0,
    avg_price REAL DEFAULT 0,
    PRIMARY KEY (user_id, stock_id, simulation_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE,
    FOREIGN KEY (simulation_id) REFERENCES simulations(id)
  );

  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    simulation_id INTEGER NOT NULL,
    headline TEXT NOT NULL,
    impacts TEXT NOT NULL,
    reasoning TEXT DEFAULT '',
    sim_day REAL NOT NULL,
    scheduled_day REAL DEFAULT NULL,
    status TEXT DEFAULT 'published' CHECK(status IN ('scheduled','published')),
    admin_edits TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (simulation_id) REFERENCES simulations(id)
  );

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

// ─── Migrations — add new columns to existing DBs ────────────
try {
  db.exec("ALTER TABLE stocks ADD COLUMN description TEXT DEFAULT ''");
  console.log('  ✅ Migration: Added description column to stocks');
} catch (e) {
  // Column already exists — ignore
}

// ─── Prepared Statements ───────────────────────────────────────

const stmts = {
  // Users
  createUser: db.prepare(`
    INSERT INTO users (username, name, email, password_hash, role, status)
    VALUES (@username, @name, @email, @password_hash, @role, @status)
  `),
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getPendingUsers: db.prepare("SELECT id, username, name, email, created_at FROM users WHERE role = 'participant' AND status = 'pending'"),
  getApprovedUsers: db.prepare("SELECT id, username, name, email, created_at FROM users WHERE role = 'participant' AND status = 'approved'"),
  getAllParticipants: db.prepare("SELECT id, username, name, email, status, created_at FROM users WHERE role = 'participant'"),
  approveUser: db.prepare("UPDATE users SET status = 'approved' WHERE id = ? AND role = 'participant'"),
  rejectUser: db.prepare("UPDATE users SET status = 'rejected' WHERE id = ? AND role = 'participant'"),

  // Simulations
  createSimulation: db.prepare(`
    INSERT INTO simulations (name, total_days, starting_cash, status)
    VALUES (@name, @total_days, @starting_cash, 'not_started')
  `),
  getSimulation: db.prepare('SELECT * FROM simulations WHERE id = ?'),
  getAllSimulations: db.prepare('SELECT * FROM simulations ORDER BY created_at DESC'),
  getActiveSimulation: db.prepare("SELECT * FROM simulations WHERE status IN ('running', 'paused') LIMIT 1"),
  getArchivedSimulations: db.prepare("SELECT * FROM simulations WHERE status = 'stopped' ORDER BY stopped_at DESC"),
  updateSimulation: db.prepare(`
    UPDATE simulations SET
    status = @status, current_day = @current_day,
    day_start_time = @day_start_time, elapsed_in_day = @elapsed_in_day,
    started_at = @started_at, paused_at = @paused_at, stopped_at = @stopped_at
    WHERE id = @id
  `),
  updateSimStatus: db.prepare('UPDATE simulations SET status = ?, stopped_at = ? WHERE id = ?'),
  releaseReport: db.prepare("UPDATE simulations SET report_released = 1, report_released_at = ? WHERE id = ?"),

  // Simulation Participants
  addParticipant: db.prepare(`
    INSERT OR IGNORE INTO simulation_participants (simulation_id, user_id, cash)
    VALUES (?, ?, ?)
  `),
  getParticipant: db.prepare('SELECT * FROM simulation_participants WHERE simulation_id = ? AND user_id = ?'),
  getSimParticipants: db.prepare(`
    SELECT sp.*, u.username, u.name, u.email
    FROM simulation_participants sp JOIN users u ON sp.user_id = u.id
    WHERE sp.simulation_id = ?
  `),
  updateParticipantCash: db.prepare('UPDATE simulation_participants SET cash = cash + ? WHERE simulation_id = ? AND user_id = ?'),
  setParticipantCash: db.prepare('UPDATE simulation_participants SET cash = ? WHERE simulation_id = ? AND user_id = ?'),
  setParticipantReportVisible: db.prepare('UPDATE simulation_participants SET report_visible = ? WHERE simulation_id = ? AND user_id = ?'),
  setAllParticipantsReportVisible: db.prepare('UPDATE simulation_participants SET report_visible = 1 WHERE simulation_id = ?'),

  // Stocks
  createStock: db.prepare(`
    INSERT INTO stocks (simulation_id, name, ticker, industry, description, starting_price, current_price, volatility, color_index)
    VALUES (@simulation_id, @name, @ticker, @industry, @description, @starting_price, @current_price, @volatility, @color_index)
  `),
  updateStock: db.prepare(`
    UPDATE stocks SET name = @name, ticker = @ticker, industry = @industry, description = @description,
    starting_price = @starting_price, current_price = @current_price, volatility = @volatility
    WHERE id = @id
  `),
  deleteStock: db.prepare('DELETE FROM stocks WHERE id = ?'),
  getStock: db.prepare('SELECT * FROM stocks WHERE id = ?'),
  getSimStocks: db.prepare('SELECT * FROM stocks WHERE simulation_id = ? ORDER BY ticker'),
  updateStockPrice: db.prepare('UPDATE stocks SET current_price = ?, buy_pressure = ? WHERE id = ?'),
  resetSimStockPrices: db.prepare('UPDATE stocks SET current_price = starting_price, buy_pressure = 0 WHERE simulation_id = ?'),
  getStockCount: db.prepare('SELECT COUNT(*) as count FROM stocks WHERE simulation_id = ?'),

  // Price History
  addPriceHistory: db.prepare('INSERT INTO price_history (stock_id, simulation_id, price, sim_day) VALUES (?, ?, ?, ?)'),
  getPriceHistory: db.prepare('SELECT price, sim_day, created_at FROM price_history WHERE stock_id = ? ORDER BY sim_day ASC'),
  getSimPriceHistory: db.prepare('SELECT ph.*, s.ticker FROM price_history ph JOIN stocks s ON ph.stock_id = s.id WHERE ph.simulation_id = ? ORDER BY ph.sim_day ASC'),

  // Trades
  addTrade: db.prepare(`
    INSERT INTO trades (user_id, stock_id, simulation_id, type, quantity, price, total, sim_day)
    VALUES (@user_id, @stock_id, @simulation_id, @type, @quantity, @price, @total, @sim_day)
  `),
  getUserSimTrades: db.prepare('SELECT t.*, s.ticker, s.name as stock_name FROM trades t JOIN stocks s ON t.stock_id = s.id WHERE t.user_id = ? AND t.simulation_id = ? ORDER BY t.created_at DESC'),
  getRecentTrades: db.prepare("SELECT * FROM trades WHERE stock_id = ? AND created_at > datetime('now', '-5 minutes') ORDER BY created_at DESC"),

  // Holdings
  getHolding: db.prepare('SELECT * FROM holdings WHERE user_id = ? AND stock_id = ? AND simulation_id = ?'),
  upsertHolding: db.prepare(`
    INSERT INTO holdings (user_id, stock_id, simulation_id, quantity, avg_price)
    VALUES (@user_id, @stock_id, @simulation_id, @quantity, @avg_price)
    ON CONFLICT(user_id, stock_id, simulation_id) DO UPDATE SET
    quantity = @quantity, avg_price = @avg_price
  `),
  getUserSimHoldings: db.prepare(`
    SELECT h.*, s.ticker, s.name as stock_name, s.current_price, s.starting_price
    FROM holdings h JOIN stocks s ON h.stock_id = s.id
    WHERE h.user_id = ? AND h.simulation_id = ? AND h.quantity > 0
  `),

  // News
  addNews: db.prepare('INSERT INTO news (simulation_id, headline, impacts, reasoning, sim_day) VALUES (?, ?, ?, ?, ?)'),
  addScheduledNews: db.prepare('INSERT INTO news (simulation_id, headline, impacts, reasoning, sim_day, scheduled_day, status) VALUES (?, ?, ?, ?, 0, ?, ?)'),
  getSimNews: db.prepare("SELECT * FROM news WHERE simulation_id = ? AND status = 'published' ORDER BY sim_day DESC, created_at DESC"),
  getScheduledSimNews: db.prepare("SELECT * FROM news WHERE simulation_id = ? AND status = 'scheduled' ORDER BY scheduled_day ASC"),
  getDueScheduledNews: db.prepare("SELECT * FROM news WHERE simulation_id = ? AND status = 'scheduled' AND scheduled_day <= ?"),
  publishScheduledNews: db.prepare("UPDATE news SET status = 'published', sim_day = ? WHERE id = ?"),
  deleteScheduledNews: db.prepare("DELETE FROM news WHERE id = ? AND status = 'scheduled'"),
  updateNewsAdminEdits: db.prepare("UPDATE news SET admin_edits = ? WHERE id = ?"),
  getAllSimNews: db.prepare("SELECT * FROM news WHERE simulation_id = ? ORDER BY sim_day ASC, created_at ASC"),
};

// ─── Helper Functions ──────────────────────────────────────────

module.exports = {
  db,
  stmts,

  createUser(username, name, email, password, role = 'participant') {
    const password_hash = bcrypt.hashSync(password, 10);
    return stmts.createUser.run({
      username, name, email, password_hash,
      role,
      status: role === 'admin' ? 'approved' : 'pending',
    });
  },

  verifyPassword(password, hash) {
    return bcrypt.compareSync(password, hash);
  },

  getLeaderboard(simulationId) {
    const participants = stmts.getSimParticipants.all(simulationId);
    const stocks = stmts.getSimStocks.all(simulationId);
    const stockMap = {};
    stocks.forEach(s => { stockMap[s.id] = s; });

    return participants.map(p => {
      const holdings = stmts.getUserSimHoldings.all(p.user_id, simulationId);
      let holdingsValue = 0;
      holdings.forEach(h => {
        holdingsValue += h.quantity * h.current_price;
      });
      return {
        userId: p.user_id,
        username: p.username,
        name: p.name,
        cash: p.cash,
        holdingsValue,
        totalValue: p.cash + holdingsValue
      };
    }).sort((a, b) => b.totalValue - a.totalValue)
      .map((p, i) => ({ ...p, rank: i + 1 }));
  },

  executeTrade(userId, stockId, simulationId, type, quantity, simDay) {
    const participant = stmts.getParticipant.get(simulationId, userId);
    const stock = stmts.getStock.get(stockId);

    if (!participant || !stock) throw new Error('Invalid user or stock');
    if (stock.simulation_id !== simulationId) throw new Error('Stock does not belong to this simulation');
    if (quantity <= 0) throw new Error('Quantity must be positive');

    const price = stock.current_price;
    const total = price * quantity;

    if (type === 'buy') {
      if (participant.cash < total) throw new Error('Insufficient cash');

      const existingHolding = stmts.getHolding.get(userId, stockId, simulationId);
      const currentQty = existingHolding ? existingHolding.quantity : 0;
      const currentAvg = existingHolding ? existingHolding.avg_price : 0;
      const newQty = currentQty + quantity;
      const newAvg = ((currentAvg * currentQty) + total) / newQty;

      const tradeTransaction = db.transaction(() => {
        stmts.updateParticipantCash.run(-total, simulationId, userId);
        stmts.upsertHolding.run({
          user_id: userId, stock_id: stockId, simulation_id: simulationId,
          quantity: newQty, avg_price: newAvg
        });
        stmts.addTrade.run({
          user_id: userId, stock_id: stockId, simulation_id: simulationId,
          type: 'buy', quantity, price, total, sim_day: simDay
        });
        // Update buy pressure
        const currentPressure = stock.buy_pressure || 0;
        stmts.updateStockPrice.run(stock.current_price, currentPressure + quantity * 0.001, stockId);
      });
      tradeTransaction();

      return { type: 'buy', quantity, price, total, newCash: participant.cash - total };
    } else if (type === 'sell') {
      const holding = stmts.getHolding.get(userId, stockId, simulationId);
      if (!holding || holding.quantity < quantity) throw new Error('Insufficient holdings');

      const newQty = holding.quantity - quantity;

      const tradeTransaction = db.transaction(() => {
        stmts.updateParticipantCash.run(total, simulationId, userId);
        stmts.upsertHolding.run({
          user_id: userId, stock_id: stockId, simulation_id: simulationId,
          quantity: newQty, avg_price: newQty > 0 ? holding.avg_price : 0
        });
        stmts.addTrade.run({
          user_id: userId, stock_id: stockId, simulation_id: simulationId,
          type: 'sell', quantity, price, total, sim_day: simDay
        });
        // Update sell pressure
        const currentPressure = stock.buy_pressure || 0;
        stmts.updateStockPrice.run(stock.current_price, currentPressure - quantity * 0.001, stockId);
      });
      tradeTransaction();

      return { type: 'sell', quantity, price, total, newCash: participant.cash + total };
    }

    throw new Error('Invalid trade type');
  }
};

