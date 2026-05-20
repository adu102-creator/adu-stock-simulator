const { stmts, pool } = require('./db');

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
    this.activeImpacts = [];  // Persistent news impact queue
  }

  /**
   * Get the current simulation state from the database.
   */
  async getState(simId) {
    const id = simId || this.activeSimId;
    if (!id) return null;

    const sim = await stmts.getSimulation(id);
    if (!sim) return null;

    // PostgreSQL returns BIGINT as string, convert to number
    const dayStartTime = Number(sim.day_start_time) || 0;
    const elapsedInDay = Number(sim.elapsed_in_day) || 0;

    let dayProgress = 0;
    let timeRemainingInDay = DAY_DURATION_MS;

    if (sim.status === 'running') {
      const elapsed = elapsedInDay + (Date.now() - dayStartTime);
      dayProgress = Math.min(elapsed / DAY_DURATION_MS, 1);
      timeRemainingInDay = Math.max(0, DAY_DURATION_MS - elapsed);
    } else if (sim.status === 'paused') {
      dayProgress = Math.min(elapsedInDay / DAY_DURATION_MS, 1);
      timeRemainingInDay = Math.max(0, DAY_DURATION_MS - elapsedInDay);
    }

    return {
      ...sim,
      day_start_time: dayStartTime,
      elapsed_in_day: elapsedInDay,
      dayProgress,
      timeRemainingInDay,
      simDay: sim.status === 'running'
        ? sim.current_day + dayProgress
        : sim.current_day + (elapsedInDay / DAY_DURATION_MS)
    };
  }

  /**
   * Start a simulation.
   */
  async start(simId) {
    const sim = await stmts.getSimulation(simId);
    if (!sim) return { error: 'Simulation not found' };
    if (sim.status === 'running') return { error: 'Simulation already running' };
    if (sim.status === 'stopped') return { error: 'Cannot restart a stopped simulation' };

    // Check no other sim is running
    const activeSim = await stmts.getActiveSimulation();
    if (activeSim && activeSim.id !== simId) {
      return { error: `Another simulation "${activeSim.name}" is currently active. Stop it first.` };
    }

    const stocks = await stmts.getSimStocks(simId);
    if (stocks.length === 0) {
      return { error: 'Add at least one stock before starting' };
    }

    // Fresh start
    if (sim.status === 'not_started') {
      await stmts.resetSimStockPrices(simId);

      const approvedUsers = await stmts.getApprovedUsers();
      for (const user of approvedUsers) {
        await stmts.addParticipant(simId, user.id, sim.starting_cash);
      }

      for (const stock of stocks) {
        await stmts.addPriceHistory(stock.id, simId, stock.starting_price, 1);
      }

      this.activeImpacts = []; // Clear impact queue for fresh start

      await stmts.updateSimulation({
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
  async resume(simId) {
    const id = simId || this.activeSimId;
    const sim = await stmts.getSimulation(id);
    if (!sim || sim.status !== 'paused') return { error: 'Simulation is not paused' };

    await stmts.updateSimulation({
      id,
      status: 'running',
      current_day: sim.current_day,
      day_start_time: Date.now(),
      elapsed_in_day: Number(sim.elapsed_in_day) || 0,
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
  async pause(simId) {
    const id = simId || this.activeSimId;
    const sim = await stmts.getSimulation(id);
    if (!sim || sim.status !== 'running') return { error: 'Simulation is not running' };

    const elapsed = (Number(sim.elapsed_in_day) || 0) + (Date.now() - (Number(sim.day_start_time) || 0));

    await stmts.updateSimulation({
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
  async stop(simId) {
    const id = simId || this.activeSimId;
    const sim = await stmts.getSimulation(id);
    if (!sim) return { error: 'Simulation not found' };
    if (sim.status === 'stopped') return { error: 'Simulation already stopped' };
    if (sim.status === 'not_started') return { error: 'Simulation has not started' };

    // Save final price history
    await this._recordPriceHistory(id);

    this._stopEngines();
    this.activeImpacts = []; // Clear impact queue

    let finalElapsed = Number(sim.elapsed_in_day) || 0;
    if (sim.status === 'running') {
      finalElapsed = finalElapsed + (Date.now() - (Number(sim.day_start_time) || 0));
    }

    await stmts.updateSimulation({
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
  async applyNewsImpact(impacts, simId) {
    const id = simId || this.activeSimId;
    if (!id) return;

    const stocks = await stmts.getSimStocks(id);

    const strengthMultiplier = {
      'mild': 0.02,
      'moderate': 0.05,
      'strong': 0.09
    };

    // How many ticks the impact persists (at 2s per tick)
    const strengthDuration = {
      'mild': 15,      // ~30 seconds
      'moderate': 30,   // ~1 minute
      'strong': 60      // ~2 minutes
    };

    for (const impact of impacts) {
      let affectedStocks = [];

      if (impact.stockId) {
        const stock = stocks.find(s => s.id === impact.stockId);
        if (stock) affectedStocks = [stock];
      } else if (impact.industry) {
        affectedStocks = stocks.filter(s =>
          s.industry.toLowerCase() === impact.industry.toLowerCase()
        );
      }

      for (const stock of affectedStocks) {
        const multiplier = strengthMultiplier[impact.strength] || 0.02;
        let direction = 0;
        if (impact.sentiment === 'positive') direction = 1;
        else if (impact.sentiment === 'negative') direction = -1;

        const pctChange = impact.percentChange
          ? Math.abs(impact.percentChange) / 100
          : multiplier;
        const finalDirection = impact.percentChange
          ? (impact.percentChange >= 0 ? 1 : -1)
          : direction;

        // Immediate price jump (50% of total impact)
        const variation = 1 + (Math.random() - 0.5) * 0.3;
        const immediateChange = stock.current_price * pctChange * finalDirection * variation * 0.5;
        const newPrice = Math.max(0.01, stock.current_price + immediateChange);

        // Reset buy_pressure on negative news to prevent demand overriding bad news
        let newPressure = stock.buy_pressure || 0;
        if (finalDirection < 0) {
          newPressure = Math.min(0, newPressure * 0.2); // Crush positive pressure on bad news
        } else if (finalDirection > 0) {
          newPressure = Math.max(0, newPressure) + multiplier * 2; // Boost positive momentum
        }

        await stmts.updateStockPrice(newPrice, newPressure, stock.id);

        // Queue persistent impact (remaining 50% spread over time with decay)
        const totalTicks = strengthDuration[impact.strength] || 15;
        const persistentMagnitude = stock.current_price * pctChange * finalDirection * variation * 0.5 / totalTicks;

        this.activeImpacts.push({
          stockId: stock.id,
          magnitude: persistentMagnitude,
          remainingTicks: totalTicks,
          totalTicks: totalTicks
        });
      }
    }
  }

  /**
   * Start all engine intervals.
   */
  _startEngines() {
    this._stopEngines();

    this.priceInterval = setInterval(() => {
      this._updatePrices().catch(e => console.error('Price update error:', e));
    }, PRICE_UPDATE_INTERVAL_MS);

    this.dayTimer = setInterval(() => {
      this._checkDayAdvancement().catch(e => console.error('Day advancement error:', e));
    }, 1000);

    this.historyInterval = setInterval(() => {
      this._recordPriceHistory().catch(e => console.error('History record error:', e));
    }, HISTORY_SAVE_INTERVAL_MS);

    this.stateInterval = setInterval(() => {
      this._broadcastState();
      if (this.activeSimId) {
        this._broadcastLeaderboard(this.activeSimId);
      }
    }, 3000);

    this.newsCheckInterval = setInterval(() => {
      this._checkScheduledNews().catch(e => console.error('News check error:', e));
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
  async _updatePrices() {
    if (!this.activeSimId) return;

    const stocks = await stmts.getSimStocks(this.activeSimId);
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

      // Buy pressure with cap (Fix #5)
      const pressure = (stock.buy_pressure || 0);
      const rawPressure = pressure * 0.01;
      const cappedPressure = Math.max(-0.02, Math.min(0.02, rawPressure));
      const pressureEffect = stock.current_price * cappedPressure;
      const decayedPressure = pressure * 0.97; // Faster decay (was 0.995)

      // Apply persistent news impacts (Fix #4)
      let newsForce = 0;
      for (const impact of this.activeImpacts) {
        if (impact.stockId === stock.id && impact.remainingTicks > 0) {
          // Linear decay: force weakens as ticks decrease
          const decayRatio = impact.remainingTicks / impact.totalTicks;
          newsForce += impact.magnitude * decayRatio;
          impact.remainingTicks--;
        }
      }
      // Clean up expired impacts
      this.activeImpacts = this.activeImpacts.filter(i => i.remainingTicks > 0);

      const newPrice = Math.max(0.01, stock.current_price + priceChange + pressureEffect + newsForce);
      const percentChange = ((newPrice - stock.starting_price) / stock.starting_price) * 100;

      await stmts.updateStockPrice(newPrice, decayedPressure, stock.id);

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
  async _checkDayAdvancement() {
    if (!this.activeSimId) return;

    const sim = await stmts.getSimulation(this.activeSimId);
    if (!sim || sim.status !== 'running') return;

    const elapsed = (Number(sim.elapsed_in_day) || 0) + (Date.now() - (Number(sim.day_start_time) || 0));

    if (elapsed >= DAY_DURATION_MS) {
      const nextDay = sim.current_day + 1;

      if (nextDay > sim.total_days) {
        await this.stop(this.activeSimId);
        return;
      }

      await this._recordPriceHistory();

      await stmts.updateSimulation({
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
  async _recordPriceHistory(simId) {
    const id = simId || this.activeSimId;
    if (!id) return;

    const state = await this.getState(id);
    if (!state || state.status === 'not_started') return;

    const stocks = await stmts.getSimStocks(id);
    for (const stock of stocks) {
      await stmts.addPriceHistory(stock.id, id, stock.current_price, state.simDay);
    }
  }

  /**
   * Broadcast simulation state to all connected clients.
   */
  async _broadcastState() {
    const state = this.activeSimId ? await this.getState(this.activeSimId) : null;
    this.io.emit('simulation:state', state || { status: 'not_started' });
  }

  /**
   * Broadcast leaderboard to all connected clients.
   */
  async _broadcastLeaderboard(simId) {
    const { getLeaderboard } = require('./db');
    const leaderboard = await getLeaderboard(simId);
    this.io.emit('leaderboard:update', leaderboard);
  }

  /**
   * Check for scheduled news items that should be auto-published.
   */
  async _checkScheduledNews() {
    if (!this.activeSimId) return;

    const state = await this.getState(this.activeSimId);
    if (!state || state.status !== 'running') return;

    const currentSimDay = state.simDay;
    const dueNews = await stmts.getDueScheduledNews(this.activeSimId, currentSimDay);

    for (const newsItem of dueNews) {
      try {
        const impactsData = JSON.parse(newsItem.impacts);
        const impactsList = impactsData.impacts || impactsData;

        await stmts.publishScheduledNews(currentSimDay, newsItem.id);

        if (Array.isArray(impactsList) && impactsList.length > 0) {
          await this.applyNewsImpact(impactsList, this.activeSimId);
        }

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
  async recover() {
    const activeSim = await stmts.getActiveSimulation();
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
