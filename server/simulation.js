const { stmts, db: database } = require('./db');

const DAY_DURATION_MS = 10 * 60 * 1000; // 10 minutes per simulated day
const PRICE_UPDATE_INTERVAL_MS = 2000;   // Update prices every 2 seconds
const HISTORY_SAVE_INTERVAL_MS = 10000;  // Save price history every 10 seconds

class SimulationEngine {
  constructor(io) {
    this.io = io;
    this.priceInterval = null;
    this.dayTimer = null;
    this.historyInterval = null;
    this.stateInterval = null;
    this.newsCheckInterval = null;
    this.activeSimId = null; // Currently active simulation ID
  }

  /**
   * Get the current simulation state from the database.
   */
  getState(simId) {
    const id = simId || this.activeSimId;
    if (!id) return null;

    const sim = stmts.getSimulation.get(id);
    if (!sim) return null;

    let dayProgress = 0;
    let timeRemainingInDay = DAY_DURATION_MS;

    if (sim.status === 'running') {
      const elapsed = sim.elapsed_in_day + (Date.now() - sim.day_start_time);
      dayProgress = Math.min(elapsed / DAY_DURATION_MS, 1);
      timeRemainingInDay = Math.max(0, DAY_DURATION_MS - elapsed);
    } else if (sim.status === 'paused') {
      dayProgress = Math.min(sim.elapsed_in_day / DAY_DURATION_MS, 1);
      timeRemainingInDay = Math.max(0, DAY_DURATION_MS - sim.elapsed_in_day);
    }

    return {
      ...sim,
      dayProgress,
      timeRemainingInDay,
      simDay: sim.status === 'running'
        ? sim.current_day + dayProgress
        : sim.current_day + (sim.elapsed_in_day / DAY_DURATION_MS)
    };
  }

  /**
   * Start a simulation.
   */
  start(simId) {
    const sim = stmts.getSimulation.get(simId);
    if (!sim) return { error: 'Simulation not found' };
    if (sim.status === 'running') return { error: 'Simulation already running' };
    if (sim.status === 'stopped') return { error: 'Cannot restart a stopped simulation' };

    // Check no other sim is running
    const activeSim = stmts.getActiveSimulation.get();
    if (activeSim && activeSim.id !== simId) {
      return { error: `Another simulation "${activeSim.name}" is currently active. Stop it first.` };
    }

    const stocks = stmts.getSimStocks.all(simId);
    if (stocks.length === 0) {
      return { error: 'Add at least one stock before starting' };
    }

    // Fresh start
    if (sim.status === 'not_started') {
      // Reset stock prices
      stmts.resetSimStockPrices.run(simId);

      // Add all approved participants
      const approvedUsers = stmts.getApprovedUsers.all();
      for (const user of approvedUsers) {
        stmts.addParticipant.run(simId, user.id, sim.starting_cash);
      }

      // Record initial prices
      for (const stock of stocks) {
        stmts.addPriceHistory.run(stock.id, simId, stock.starting_price, 1);
      }

      stmts.updateSimulation.run({
        id: simId,
        status: 'running',
        current_day: 1,
        day_start_time: Date.now(),
        elapsed_in_day: 0,
        started_at: new Date().toISOString(),
        paused_at: null,
        stopped_at: null
      });
    }

    this.activeSimId = simId;
    this._startEngines();
    this._broadcastState();

    console.log(`🚀 Simulation "${sim.name}" started: ${sim.total_days} days, ₹${sim.starting_cash} starting cash`);
    return { success: true };
  }

  /**
   * Resume after pause.
   */
  resume(simId) {
    const id = simId || this.activeSimId;
    const sim = stmts.getSimulation.get(id);
    if (!sim || sim.status !== 'paused') return { error: 'Simulation is not paused' };

    stmts.updateSimulation.run({
      id,
      status: 'running',
      current_day: sim.current_day,
      day_start_time: Date.now(),
      elapsed_in_day: sim.elapsed_in_day,
      started_at: sim.started_at,
      paused_at: null,
      stopped_at: null
    });

    this.activeSimId = id;
    this._startEngines();
    this._broadcastState();

    console.log('▶️  Simulation resumed');
    return { success: true };
  }

  /**
   * Pause the simulation.
   */
  pause(simId) {
    const id = simId || this.activeSimId;
    const sim = stmts.getSimulation.get(id);
    if (!sim || sim.status !== 'running') return { error: 'Simulation is not running' };

    const elapsed = sim.elapsed_in_day + (Date.now() - sim.day_start_time);

    stmts.updateSimulation.run({
      id,
      status: 'paused',
      current_day: sim.current_day,
      elapsed_in_day: elapsed,
      day_start_time: 0,
      started_at: sim.started_at,
      paused_at: new Date().toISOString(),
      stopped_at: null
    });

    this._stopEngines();
    this._broadcastState();

    console.log('⏸️  Simulation paused');
    return { success: true };
  }

  /**
   * Permanently stop and archive a simulation.
   */
  stop(simId) {
    const id = simId || this.activeSimId;
    const sim = stmts.getSimulation.get(id);
    if (!sim) return { error: 'Simulation not found' };
    if (sim.status === 'stopped') return { error: 'Simulation already stopped' };
    if (sim.status === 'not_started') return { error: 'Simulation has not started' };

    // Save final price history
    this._recordPriceHistory(id);

    this._stopEngines();

    // Calculate elapsed properly for running sims
    let finalElapsed = sim.elapsed_in_day;
    if (sim.status === 'running') {
      finalElapsed = sim.elapsed_in_day + (Date.now() - sim.day_start_time);
    }

    stmts.updateSimulation.run({
      id,
      status: 'stopped',
      current_day: sim.current_day,
      elapsed_in_day: finalElapsed,
      day_start_time: 0,
      started_at: sim.started_at,
      paused_at: null,
      stopped_at: new Date().toISOString()
    });

    if (this.activeSimId === id) {
      this.activeSimId = null;
    }

    this._broadcastState();
    this._broadcastLeaderboard(id);
    this.io.emit('simulation:stopped', { simulationId: id, message: 'Simulation archived!' });

    console.log(`🛑 Simulation "${sim.name}" stopped and archived`);
    return { success: true };
  }

  /**
   * Apply news impacts to stock prices.
   */
  applyNewsImpact(impacts, simId) {
    const id = simId || this.activeSimId;
    if (!id) return;

    const stocks = stmts.getSimStocks.all(id);

    const strengthMultiplier = {
      'mild': 0.02,
      'moderate': 0.05,
      'strong': 0.09
    };

    for (const impact of impacts) {
      let affectedStocks = [];

      // Direct stock targeting (admin-controlled) takes priority
      if (impact.stockId) {
        const stock = stocks.find(s => s.id === impact.stockId);
        if (stock) affectedStocks = [stock];
      } else if (impact.industry) {
        // Fallback to industry-based matching
        affectedStocks = stocks.filter(s =>
          s.industry.toLowerCase() === impact.industry.toLowerCase()
        );
      }

      for (const stock of affectedStocks) {
        const multiplier = strengthMultiplier[impact.strength] || 0.02;
        let direction = 0;
        if (impact.sentiment === 'positive') direction = 1;
        else if (impact.sentiment === 'negative') direction = -1;

        // Use custom percentage if provided, otherwise use strength multiplier
        const pctChange = impact.percentChange
          ? Math.abs(impact.percentChange) / 100
          : multiplier;
        const finalDirection = impact.percentChange
          ? (impact.percentChange >= 0 ? 1 : -1)
          : direction;

        // Sharp, immediate movement + random variation
        const variation = 1 + (Math.random() - 0.5) * 0.3;
        const change = stock.current_price * pctChange * finalDirection * variation;
        const newPrice = Math.max(0.01, stock.current_price + change);

        stmts.updateStockPrice.run(newPrice, stock.buy_pressure || 0, stock.id);
      }
    }
  }

  /**
   * Start all engine intervals.
   */
  _startEngines() {
    this._stopEngines();

    // Price update engine
    this.priceInterval = setInterval(() => {
      this._updatePrices();
    }, PRICE_UPDATE_INTERVAL_MS);

    // Day advancement timer
    this.dayTimer = setInterval(() => {
      this._checkDayAdvancement();
    }, 1000);

    // Price history recording
    this.historyInterval = setInterval(() => {
      this._recordPriceHistory();
    }, HISTORY_SAVE_INTERVAL_MS);

    // Broadcast state updates
    this.stateInterval = setInterval(() => {
      this._broadcastState();
      if (this.activeSimId) {
        this._broadcastLeaderboard(this.activeSimId);
      }
    }, 3000);

    // Check for scheduled news
    this.newsCheckInterval = setInterval(() => {
      this._checkScheduledNews();
    }, 3000);
  }

  /**
   * Stop all engine intervals.
   */
  _stopEngines() {
    if (this.priceInterval) { clearInterval(this.priceInterval); this.priceInterval = null; }
    if (this.dayTimer) { clearInterval(this.dayTimer); this.dayTimer = null; }
    if (this.historyInterval) { clearInterval(this.historyInterval); this.historyInterval = null; }
    if (this.stateInterval) { clearInterval(this.stateInterval); this.stateInterval = null; }
    if (this.newsCheckInterval) { clearInterval(this.newsCheckInterval); this.newsCheckInterval = null; }
  }

  /**
   * Update all stock prices using Geometric Brownian Motion.
   */
  _updatePrices() {
    if (!this.activeSimId) return;

    const stocks = stmts.getSimStocks.all(this.activeSimId);
    const updates = [];

    const volatilityMap = {
      'low': 0.8,
      'medium': 1.5,
      'high': 3.0
    };

    for (const stock of stocks) {
      const dt = PRICE_UPDATE_INTERVAL_MS / DAY_DURATION_MS;
      const volatility = (volatilityMap[stock.volatility] || 1.5) / 100;

      // GBM: dS = μSdt + σSdW
      const drift = 0.0001;
      const randomShock = this._gaussianRandom() * volatility * Math.sqrt(dt);
      const priceChange = stock.current_price * (drift * dt + randomShock);

      // Supply/demand pressure effect
      const pressure = (stock.buy_pressure || 0);
      const pressureEffect = stock.current_price * pressure * 0.01;

      // Decay buy pressure over time
      const decayedPressure = pressure * 0.995;

      const newPrice = Math.max(0.01, stock.current_price + priceChange + pressureEffect);
      const percentChange = ((newPrice - stock.starting_price) / stock.starting_price) * 100;

      stmts.updateStockPrice.run(newPrice, decayedPressure, stock.id);

      updates.push({
        id: stock.id,
        ticker: stock.ticker,
        name: stock.name,
        price: Math.round(newPrice * 100) / 100,
        startingPrice: stock.starting_price,
        percentChange: Math.round(percentChange * 100) / 100,
        industry: stock.industry,
        colorIndex: stock.color_index
      });
    }

    this.io.emit('prices:update', updates);
  }

  /**
   * Check if the current day has elapsed and advance.
   */
  _checkDayAdvancement() {
    if (!this.activeSimId) return;

    const sim = stmts.getSimulation.get(this.activeSimId);
    if (!sim || sim.status !== 'running') return;

    const elapsed = sim.elapsed_in_day + (Date.now() - sim.day_start_time);

    if (elapsed >= DAY_DURATION_MS) {
      const nextDay = sim.current_day + 1;

      if (nextDay > sim.total_days) {
        // Simulation finished — auto stop
        this.stop(this.activeSimId);
        return;
      }

      // Record end-of-day prices
      this._recordPriceHistory();

      // Start next day
      stmts.updateSimulation.run({
        id: this.activeSimId,
        status: 'running',
        current_day: nextDay,
        day_start_time: Date.now(),
        elapsed_in_day: 0,
        started_at: sim.started_at,
        paused_at: null,
        stopped_at: null
      });

      this.io.emit('simulation:newday', { day: nextDay, totalDays: sim.total_days });
      console.log(`📅 Day ${nextDay} of ${sim.total_days}`);
    }
  }

  /**
   * Record current prices to history.
   */
  _recordPriceHistory(simId) {
    const id = simId || this.activeSimId;
    if (!id) return;

    const state = this.getState(id);
    if (!state || state.status === 'not_started') return;

    const stocks = stmts.getSimStocks.all(id);
    const insertHistory = database.transaction(() => {
      for (const stock of stocks) {
        stmts.addPriceHistory.run(stock.id, id, stock.current_price, state.simDay);
      }
    });
    insertHistory();
  }

  /**
   * Broadcast simulation state to all connected clients.
   */
  _broadcastState() {
    const state = this.activeSimId ? this.getState(this.activeSimId) : null;
    this.io.emit('simulation:state', state || { status: 'not_started' });
  }

  /**
   * Broadcast leaderboard to all connected clients.
   */
  _broadcastLeaderboard(simId) {
    const { getLeaderboard } = require('./db');
    const leaderboard = getLeaderboard(simId);
    this.io.emit('leaderboard:update', leaderboard);
  }

  /**
   * Check for scheduled news items that should be auto-published.
   */
  _checkScheduledNews() {
    if (!this.activeSimId) return;

    const state = this.getState(this.activeSimId);
    if (!state || state.status !== 'running') return;

    const currentSimDay = state.simDay;
    const dueNews = stmts.getDueScheduledNews.all(this.activeSimId, currentSimDay);

    for (const newsItem of dueNews) {
      try {
        const impactsData = JSON.parse(newsItem.impacts);
        const impactsList = impactsData.impacts || impactsData;

        // Mark as published
        stmts.publishScheduledNews.run(currentSimDay, newsItem.id);

        // Apply price impacts
        if (Array.isArray(impactsList) && impactsList.length > 0) {
          this.applyNewsImpact(impactsList, this.activeSimId);
        }

        // Broadcast to all clients (hide impact details from participants)
        const broadcastItem = {
          headline: newsItem.headline,
          sim_day: Math.round(currentSimDay * 100) / 100,
          timestamp: new Date().toISOString()
        };

        this.io.emit('news:published', broadcastItem);
        console.log(`📰 Auto-published scheduled news: "${newsItem.headline.substring(0, 50)}..." at Day ${currentSimDay.toFixed(2)}`);
      } catch (err) {
        console.error('Failed to auto-publish scheduled news:', err);
      }
    }
  }

  /**
   * Generate a Gaussian random number using Box-Muller transform.
   */
  _gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  /**
   * Recovery: if the server restarts and a simulation was running, resume the engines.
   */
  recover() {
    const activeSim = stmts.getActiveSimulation.get();
    if (activeSim) {
      this.activeSimId = activeSim.id;
      if (activeSim.status === 'running') {
        console.log(`🔄 Recovering running simulation "${activeSim.name}"...`);
        this._startEngines();
      }
    }
  }
}

module.exports = SimulationEngine;
