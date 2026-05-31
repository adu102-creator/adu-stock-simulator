// ═══════════════════════════════════════════════════════════════
// PARTICIPANT DASHBOARD — Real-Time Trading Interface
// Matrix Blue Design
// ═══════════════════════════════════════════════════════════════

(async function () {
  'use strict';

  const STOCK_COLORS = ['#00e5ff', '#00ff66', '#bd00ff', '#ff0055', '#ff9f1c', '#ffd700', '#00ffcc'];

  // ─── Auth Check ────────────────────────────────────────────
  let currentUser = null;
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/'; return; }
    currentUser = await res.json();
    if (currentUser.role !== 'participant') { window.location.href = '/admin'; return; }
  } catch {
    window.location.href = '/';
    return;
  }

  // User display
  document.getElementById('user-name').textContent = '@' + currentUser.username;
  document.getElementById('user-avatar').textContent = currentUser.name.charAt(0).toUpperCase();

  const socket = io();
  let simState = null;
  let countdownInterval = null;
  let stockData = {};
  let portfolio = { cash: 0, holdings: [], trades: [] };
  let selectedStock = null;
  let priceChart = null;
  let newsList = [];
  let lastRank = null; // Track leaderboard position for change popups
  let portfolioHistory = []; // {time, value} snapshots for chart
  let portfolioChart = null;
  let chartViewMode = 'all'; // 'all' or 'day'

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ─── Toast ─────────────────────────────────────────────────
  function showToast(message, type = 'info') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(15px)';
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  function showRankPopup(message, type = 'rank-up') {
    // Remove existing rank popup
    const existing = document.querySelector('.rank-popup');
    if (existing) existing.remove();

    const popup = document.createElement('div');
    popup.className = `rank-popup ${type}`;
    popup.innerHTML = `<span>${message}</span>`;
    document.body.appendChild(popup);

    setTimeout(() => {
      popup.style.opacity = '0';
      popup.style.transform = 'translate(-50%, -60%) scale(0.8)';
      setTimeout(() => popup.remove(), 400);
    }, 4000);
  }

  // ─── Logout ────────────────────────────────────────────────
  $('#logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  });

  // ─── Tab Navigation ───────────────────────────────────────
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      $(`#${btn.dataset.tab}`).classList.add('active');

      if (btn.dataset.tab === 'portfolio-tab') loadPortfolio();
      if (btn.dataset.tab === 'leaderboard-tab') loadLeaderboard();
      if (btn.dataset.tab === 'archive-tab') loadArchives();
      if (btn.dataset.tab === 'register-tab') loadAvailableSimulations();
    });
  });

  // ─── News Feed Toggle ─────────────────────────────────────
  const newsToggle = $('#news-toggle');
  const newsFeedContent = $('#news-feed-content');
  let newsCollapsed = false;

  newsToggle.addEventListener('click', () => {
    newsCollapsed = !newsCollapsed;
    newsFeedContent.style.display = newsCollapsed ? 'none' : 'block';
    newsToggle.textContent = newsCollapsed ? 'EXPAND' : 'COLLAPSE';
  });

  // ─── Access Code Join Simulation ─────────────────────────
  let selectedLobbySimId = null;
  let selectedLobbySimName = '';
  let lobbyListTimerInterval = null;

  const btnJoinSim = $('#btn-join-sim');
  const btnCancelJoin = $('#btn-cancel-join');
  const inputJoinAccessCode = $('#join-access-code');

  // Cancel joining overlay and restore the lobby list
  if (btnCancelJoin) {
    btnCancelJoin.addEventListener('click', () => {
      selectedLobbySimId = null;
      selectedLobbySimName = '';
      inputJoinAccessCode.value = '';
      $('#join-code-panel').style.display = 'none';
      $('#sim-list-container').style.display = 'block';
      loadLobbySimulations();
    });
  }

  window.selectLobbySimulation = function(simId, name) {
    selectedLobbySimId = simId;
    selectedLobbySimName = name;
    
    // Clear code input
    inputJoinAccessCode.value = '';
    
    // Hide list and show access panel
    $('#sim-list-container').style.display = 'none';
    $('#join-code-panel').style.display = 'block';
    $('#join-lobby-description').textContent = `// ENTER ACCESS CODE TO JOIN "${name.toUpperCase()}" //`;
    
    // Focus the input
    inputJoinAccessCode.focus();
  };

  async function loadLobbySimulations() {
    if (lobbyListTimerInterval) {
      clearInterval(lobbyListTimerInterval);
      lobbyListTimerInterval = null;
    }

    const listElement = $('#lobby-sims-list');
    if (!listElement) return;

    try {
      const res = await fetch('/api/participant/available-simulations');
      const sims = await res.json();

      if (!Array.isArray(sims) || sims.length === 0) {
        listElement.innerHTML = '<div class="empty-state"><p>// NO ACTIVE OR UPCOMING SIMULATIONS AT THIS TIME //</p></div>';
        return;
      }

      listElement.innerHTML = sims.map(sim => {
        const hasStart = !!sim.scheduled_start_time;
        const timeLabel = hasStart ? formatCountdownLabel(sim.scheduled_start_time) : '--:--:--';
        const startSecs = hasStart ? Math.ceil((new Date(sim.scheduled_start_time) - new Date()) / 1000) : null;
        
        return `
          <div class="glass-card lobby-sim-card" style="padding: 1rem; border-color: rgba(0, 170, 255, 0.15); border-radius: 0; display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.3);" id="lobby-card-${sim.id}">
            <div>
              <h5 style="font-family: 'Source Code Pro', monospace; color: #fff; font-size: 0.82rem; margin: 0 0 0.25rem 0;">[ ${escapeHtml(sim.name)} ]</h5>
              <span style="font-size: 0.65rem; color: var(--text-muted); font-family: 'Source Code Pro', monospace;">₹${Number(sim.starting_cash).toLocaleString('en-IN')} starting cash // ${sim.total_days} days</span>
            </div>
            <div style="display: flex; align-items: center; gap: 1.5rem;">
              <div style="text-align: right;">
                <div style="font-size: 0.6rem; color: var(--text-muted); font-family: 'Source Code Pro', monospace; text-transform: uppercase;">START IN</div>
                <div class="lobby-sim-timer" data-sim-id="${sim.id}" data-time-left="${startSecs !== null ? startSecs : ''}" style="font-family: 'Source Code Pro', monospace; font-size: 1rem; color: var(--blue-bright); text-shadow: 0 0 10px rgba(0, 170, 255, 0.25);">${timeLabel}</div>
              </div>
              <button class="btn btn-primary btn-sm" style="font-size: 0.75rem; padding: 0.35rem 0.8rem; border-radius: 0;" onclick="selectLobbySimulation(${sim.id}, '${escapeHtml(sim.name)}')">[ JOIN ]</button>
            </div>
          </div>
        `;
      }).join('');

      // Run live update interval for all individual countdown timers
      const timerElements = document.querySelectorAll('.lobby-sim-timer');
      lobbyListTimerInterval = setInterval(() => {
        timerElements.forEach(el => {
          const timeLeftAttr = el.getAttribute('data-time-left');
          if (timeLeftAttr !== '' && timeLeftAttr !== null) {
            let secondsLeft = parseInt(timeLeftAttr);
            secondsLeft = Math.max(0, secondsLeft - 1);
            el.setAttribute('data-time-left', secondsLeft);
            
            if (secondsLeft <= 0) {
              el.textContent = 'STARTING...';
            } else {
              const hrs = Math.floor(secondsLeft / 3600);
              const mins = Math.floor((secondsLeft % 3600) / 60);
              const secs = secondsLeft % 60;
              el.textContent = `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
            }
          }
        });
      }, 1000);

    } catch (e) {
      console.error('Error loading available sims:', e);
      listElement.innerHTML = '<div class="empty-state"><p>// ERROR LOADING SIMULATIONS //</p></div>';
    }
  }

  function formatCountdownLabel(scheduledTimeStr) {
    const scheduledTime = new Date(scheduledTimeStr);
    const now = new Date();
    const t = scheduledTime - now;
    if (t <= 0) return 'STARTING...';
    
    const hours = Math.floor(t / (1000 * 60 * 60));
    const mins = Math.floor((t % (1000 * 60 * 60)) / (1000 * 60));
    const secs = Math.floor((t % (1000 * 60)) / 1000);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  if (btnJoinSim && inputJoinAccessCode) {
    const handleJoin = async () => {
      const accessCode = inputJoinAccessCode.value.trim().toUpperCase();
      if (!accessCode) {
        showToast('// ERROR: Please enter an access code.', 'error');
        return;
      }
      if (accessCode.length !== 4) {
        showToast('// ERROR: Access code must be exactly 4 characters.', 'error');
        return;
      }

      btnJoinSim.disabled = true;
      btnJoinSim.textContent = '[ ENROLLING... ]';

      try {
        const res = await fetch('/api/participant/simulations/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessCode })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('// ACCESS GRANTED // Auto-enrolled in simulation!', 'success');
          inputJoinAccessCode.value = '';
          selectedLobbySimId = null;
          selectedLobbySimName = '';
          
          if (lobbyListTimerInterval) {
            clearInterval(lobbyListTimerInterval);
            lobbyListTimerInterval = null;
          }

          // Re-fetch simulation state and refresh UI immediately
          const simRes = await fetch('/api/participant/simulation');
          const simData = await simRes.json();
          updateUI(simData);
          if (simData.participantCash !== undefined) {
            portfolio.cash = simData.participantCash;
          }
          await loadPortfolio();
          
          // Re-fetch stocks & news
          const stocksRes = await fetch('/api/participant/stocks');
          const { stocks: stocksList } = await stocksRes.json();
          if (stocksList) {
            stocksList.forEach(s => {
              stockData[s.id] = {
                id: s.id,
                ticker: s.ticker,
                name: s.name,
                price: s.current_price,
                startingPrice: s.starting_price,
                percentChange: ((s.current_price - s.starting_price) / s.starting_price * 100),
                industry: s.industry,
                description: s.description || '',
                colorIndex: s.color_index,
                volatility: s.volatility || 'medium'
              };
            });
            renderStockGrid(Object.values(stockData));
          }
          await loadNews();
        } else {
          showToast(data.error || '// ERROR: Access code verification failed.', 'error');
        }
      } catch (err) {
        console.error(err);
        showToast('// ERROR: Connection failed.', 'error');
      } finally {
        btnJoinSim.disabled = false;
        btnJoinSim.textContent = '[ ENTER LOBBY ]';
      }
    };

    btnJoinSim.addEventListener('click', handleJoin);
    inputJoinAccessCode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleJoin();
      }
    });
  }

  function updateUI(state) {
    simState = state;

    const statusIndicator = $('#sim-status-indicator');

    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    // Case 1 & Case 2: No active simulation OR exists but user has not joined yet
    if (!state || !state.id || !state.isParticipant) {
      $('#waiting-screen').style.display = 'flex';
      $('#trading-interface').style.display = 'none';
      $('#lobby-countdown-container').style.display = 'none';
      
      // If they are currently in the process of entering code, keep the join panel open
      if (selectedLobbySimId !== null) {
        $('#sim-list-container').style.display = 'none';
        $('#join-code-panel').style.display = 'block';
      } else {
        $('#sim-list-container').style.display = 'block';
        $('#join-code-panel').style.display = 'none';
        loadLobbySimulations();
      }
      return;
    }

    // Case 3: Joined participant but simulation is not started yet (Lobby stage)
    if (state.status === 'not_started') {
      $('#waiting-screen').style.display = 'flex';
      $('#trading-interface').style.display = 'none';
      $('#sim-list-container').style.display = 'none';
      $('#join-code-panel').style.display = 'none';
      $('#lobby-countdown-container').style.display = 'block';
      
      $('#waiting-title').textContent = 'LOBBY JOINED';
      $('#waiting-message').textContent = `// Ready for simulation: ${state.name} //`;

      const scheduledTime = state.scheduled_start_time ? new Date(state.scheduled_start_time) : null;
      const now = new Date();
      if (scheduledTime && scheduledTime > now) {
        // We have an active countdown! Show the big clock.
        $('#waiting-icon').style.display = 'none'; // focus on the clock
        
        const updateCountdown = () => {
          const t = scheduledTime - new Date();
          if (t <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
            $('#lobby-countdown-clock').textContent = 'LAUNCHING...';
            $('#lobby-countdown-label').textContent = '// THE MARKET IS INITIALIZING //';
            return;
          }
          const hours = Math.floor(t / (1000 * 60 * 60));
          const mins = Math.floor((t % (1000 * 60 * 60)) / (1000 * 60));
          const secs = Math.floor((t % (1000 * 60)) / 1000);
          const hh = hours.toString().padStart(2, '0');
          const mm = mins.toString().padStart(2, '0');
          const ss = secs.toString().padStart(2, '0');
          
          $('#lobby-countdown-clock').textContent = `${hh}:${mm}:${ss}`;
          $('#lobby-countdown-label').textContent = '// COUNTDOWN TO LAUNCH //';
        };
        
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
      } else {
        // No scheduled start time yet. Show retro standby status.
        $('#waiting-icon').style.display = 'block';
        $('#lobby-countdown-clock').textContent = 'STANDBY';
        $('#lobby-countdown-label').textContent = '// WAITING FOR HOST TO START THE MARKET //';
      }
      return;
    }

    // Case 4: Running, Paused, or Stopped simulation (Joined participant)
    $('#waiting-screen').style.display = 'none';
    showTrading();

    if (state.status === 'paused') {
      showStatusBanner('// SIMULATION PAUSED — trading is temporarily disabled. Your data is preserved.', 'paused');
      statusIndicator.innerHTML = '<span class="status-badge paused">[ PAUSED ]</span>';
      $('#sim-name').textContent = state.name || '—';
      $('#current-day').textContent = `${state.current_day}/${state.total_days}`;
      setTradingEnabled(false);
      return;
    }

    if (state.status === 'stopped') {
      showStatusBanner('// SIMULATION ENDED — check the ARCHIVE tab for results and AI reports.', 'stopped');
      statusIndicator.innerHTML = '<span class="status-badge stopped">[ ENDED ]</span>';
      $('#sim-name').textContent = state.name || '—';
      $('#current-day').textContent = `${state.current_day}/${state.total_days}`;
      setTradingEnabled(false);
      return;
    }

    // Running state
    hideStatusBanner();
    setTradingEnabled(true);

    // Update header info
    $('#sim-name').textContent = state.name || '—';
    $('#current-day').textContent = `${state.current_day}/${state.total_days}`;
    statusIndicator.innerHTML = '<span class="status-badge running"><span class="status-dot"></span>[ LIVE ]</span>';

    // Day progress
    if (state.dayProgress !== undefined) {
      $('#day-progress-fill').style.width = `${(state.dayProgress * 100).toFixed(1)}%`;
    }

    // Live indicator
    const liveIndicator = $('#live-indicator');
    liveIndicator.style.display = state.status === 'running' ? 'inline-flex' : 'none';
  }

  function showStatusBanner(msg, type) {
    let banner = $('#sim-status-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'sim-status-banner';
      const tradingInterface = $('#trading-interface');
      const dayProgress = tradingInterface.querySelector('.day-progress');
      if (dayProgress) {
        dayProgress.after(banner);
      } else {
        tradingInterface.querySelector('.top-bar').after(banner);
      }
    }
    banner.className = `sim-status-banner ${type}`;
    banner.innerHTML = `<span class="banner-icon">${type === 'idle' ? '◆' : type === 'paused' ? '⏸' : '■'}</span> <span>${msg}</span>`;
    banner.style.display = 'flex';
  }

  function hideStatusBanner() {
    const banner = $('#sim-status-banner');
    if (banner) banner.style.display = 'none';
  }

  function setTradingEnabled(enabled) {
    // Disable/enable all trade-related buttons
    const tradeButtons = document.querySelectorAll('.btn-buy, .btn-sell, #execute-trade-btn');
    tradeButtons.forEach(btn => {
      btn.disabled = !enabled;
      if (!enabled) {
        btn.title = 'Trading disabled — no active simulation';
      } else {
        btn.title = '';
      }
    });
  }

  function showTrading() {
    $('#waiting-screen').style.display = 'none';
    $('#trading-interface').style.display = 'flex';
  }

  // ═══ STOCKS ════════════════════════════════════════════════

  function renderStockGrid(updates) {
    // Merge updates into stockData
    if (Array.isArray(updates)) {
      updates.forEach(u => {
        stockData[u.id] = { ...stockData[u.id], ...u };
      });
    }

    const grid = $('#stock-grid');
    const stockList = Object.values(stockData);

    if (stockList.length === 0) {
      grid.innerHTML = '<div class="empty-state"><p>// loading_stocks...</p></div>';
      return;
    }

    grid.innerHTML = stockList.map(s => {
      const isPositive = s.percentChange >= 0;
      const changeClass = isPositive ? 'positive' : 'negative';
      const arrow = isPositive ? '↑' : '↓';
      const color = STOCK_COLORS[s.colorIndex % STOCK_COLORS.length];

      const volVal = (s.volatility || 'medium').toLowerCase();
      const volLevel = volVal.toUpperCase();
      const volBars = volVal === 'low' ? 1 : (volVal === 'high' ? 3 : 2);

      const desc = s.description ? s.description.substring(0, 80) + (s.description.length > 80 ? '...' : '') : '';

      return `
        <div class="stock-card ${changeClass}" style="--stock-accent: ${color};"
             onclick="openStockModal(${s.id})" id="stock-card-${s.id}">
          <div class="stock-card-header">
            <div>
              <div class="ticker" style="color: ${color}; text-shadow: 0 0 8px ${color}40;">${escapeHtml(s.ticker)}</div>
              <div class="company-name">${escapeHtml(s.name)}</div>
            </div>
            <span class="industry-tag">${escapeHtml(s.industry)}</span>
          </div>
          <div class="stock-card-price" id="price-${s.id}">₹${s.price.toFixed(2)}</div>
          <div class="stock-card-change ${changeClass}">
            ${arrow} ${isPositive ? '+' : ''}${s.percentChange.toFixed(2)}%
          </div>
          ${desc ? `<div class="stock-card-desc">${desc}</div>` : ''}
          <div class="stock-card-footer">
            <div class="volatility-indicator">
              ${[1,2,3].map(i => `<div class="volatility-bar ${i <= volBars ? 'active' : ''}"></div>`).join('')}
            </div>
            <span class="vol-label">${volLevel}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // ═══ STOCK MODAL ═══════════════════════════════════════════

  const stockModal = $('#stock-modal');
  const modalClose = $('#modal-close');

  modalClose.addEventListener('click', () => {
    stockModal.classList.remove('active');
    selectedStock = null;
  });

  stockModal.addEventListener('click', (e) => {
    if (e.target === stockModal) {
      stockModal.classList.remove('active');
      selectedStock = null;
    }
  });

  window.openStockModal = async function(stockId) {
    selectedStock = stockData[stockId];
    if (!selectedStock) return;

    stockModal.classList.add('active');
    const color = STOCK_COLORS[selectedStock.colorIndex % STOCK_COLORS.length];

    $('#modal-ticker').textContent = selectedStock.ticker;
    $('#modal-ticker').style.color = color;
    $('#modal-ticker').style.textShadow = `0 0 8px ${color}40`;
    $('#modal-company-name').textContent = selectedStock.name;
    $('#modal-current-price').textContent = `₹${selectedStock.price.toFixed(2)}`;
    $('#modal-starting-price').textContent = `₹${selectedStock.startingPrice.toFixed(2)}`;
    $('#modal-percent-change').textContent = `${selectedStock.percentChange >= 0 ? '+' : ''}${selectedStock.percentChange.toFixed(2)}%`;
    $('#modal-percent-change').style.color = selectedStock.percentChange >= 0 ? 'var(--price-up)' : 'var(--price-down)';

    // Stock info panel — always show industry, optionally show description
    const infoEl = $('#modal-stock-info');
    if (infoEl) {
      const descHtml = selectedStock.description
        ? `<div class="company-info-desc">${selectedStock.description}</div>`
        : '';
      infoEl.innerHTML = `
        <div class="company-info-card">
          <div class="company-info-header">
            <span class="info-icon">ℹ️</span> ABOUT THIS COMPANY // <span class="company-industry">${(selectedStock.industry || 'GENERAL').toUpperCase()}</span>
          </div>
          ${descHtml}
        </div>
      `;
    }

    // Holdings
    const holding = portfolio.holdings.find(h => h.stock_id === stockId);
    $('#modal-holdings').textContent = holding ? holding.quantity : '0';

    $('#trade-available-cash').textContent = `₹${portfolio.cash.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;

    // Update estimated cost
    updateEstimatedCost();

    // Load price chart
    await loadPriceChart(stockId, color);
  };

  // Estimated cost
  const tradeQtyInput = $('#trade-quantity');
  tradeQtyInput.addEventListener('input', updateEstimatedCost);

  function updateEstimatedCost() {
    if (!selectedStock) return;
    const qty = parseInt(tradeQtyInput.value) || 0;
    const cost = qty * selectedStock.price;
    $('#trade-estimated-cost').textContent = `₹${cost.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;
  }

  // Chart
  async function loadPriceChart(stockId, color) {
    try {
      const res = await fetch(`/api/participant/stocks/${stockId}/history`);
      const history = await res.json();

      const labels = history.map(h => `D${parseFloat(h.sim_day).toFixed(1)}`);
      const prices = history.map(h => h.price);

      const ctx = document.getElementById('price-chart');

      if (priceChart) priceChart.destroy();

      priceChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: selectedStock.ticker,
            data: prices,
            borderColor: color,
            backgroundColor: `${color}10`,
            borderWidth: 1.5,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointHoverBackgroundColor: color,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#02050d',
              titleColor: '#00e5ff',
              bodyColor: '#e0f7fc',
              borderColor: 'rgba(0, 229, 255, 0.25)',
              borderWidth: 1,
              titleFont: { family: "'Source Code Pro', monospace", size: 11 },
              bodyFont: { family: "'Source Code Pro', monospace", size: 12 },
              padding: 10,
              displayColors: false,
              callbacks: {
                label: (ctx) => `₹${ctx.parsed.y.toFixed(2)}`
              }
            }
          },
          scales: {
            x: {
              display: true,
              ticks: {
                color: '#5d7285',
                font: { family: "'Source Code Pro', monospace", size: 9 },
                maxTicksLimit: 10,
              },
              grid: { color: 'rgba(0, 229, 255, 0.08)', drawBorder: false },
            },
            y: {
              display: true,
              ticks: {
                color: '#5d7285',
                font: { family: "'Source Code Pro', monospace", size: 9 },
                callback: (v) => `₹${v.toFixed(0)}`,
              },
              grid: { color: 'rgba(0, 229, 255, 0.08)', drawBorder: false },
            }
          },
          animation: { duration: 300 },
          interaction: { mode: 'index', intersect: false },
        }
      });
    } catch (err) {
      console.error('Chart error:', err);
    }
  }

  // ═══ TRADING ═══════════════════════════════════════════════

  $('#btn-buy').addEventListener('click', () => executeTrade('buy'));
  $('#btn-sell').addEventListener('click', () => executeTrade('sell'));

  async function executeTrade(type) {
    if (!selectedStock || !simState || simState.status !== 'running') {
      showToast('TRADING UNAVAILABLE', 'error');
      return;
    }

    const quantity = parseInt(tradeQtyInput.value);
    if (!quantity || quantity <= 0) {
      showToast('ENTER VALID QUANTITY', 'error');
      return;
    }

    const btn = type === 'buy' ? $('#btn-buy') : $('#btn-sell');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.innerHTML = `<span class="spinner"></span> ${type === 'buy' ? 'BUYING' : 'SELLING'}...`;

    try {
      const res = await fetch('/api/participant/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stockId: selectedStock.id,
          type,
          quantity
        })
      });

      const data = await res.json();

      if (res.ok && data.success) {
        showToast(`[ ${type.toUpperCase()} ] ${quantity}x ${selectedStock.ticker} @ ₹${data.price.toFixed(2)}`, 'success');
        portfolio.cash = data.newCash;
        updatePortfolioDisplay();
        await loadPortfolio();

        // Update modal holdings
        const holding = portfolio.holdings.find(h => h.stock_id === selectedStock.id);
        $('#modal-holdings').textContent = holding ? holding.quantity : '0';
        $('#trade-available-cash').textContent = `₹${portfolio.cash.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;
      } else {
        showToast(data.error || 'TRADE FAILED', 'error');
      }
    } catch {
      showToast('CONNECTION ERROR', 'error');
    }

    btn.disabled = false;
    btn.innerHTML = originalText;
  }

  // ═══ PORTFOLIO ═════════════════════════════════════════════

  async function loadPortfolio() {
    try {
      const res = await fetch('/api/participant/portfolio');
      portfolio = await res.json();
      updatePortfolioDisplay();
      renderHoldings();
      renderTrades();
    } catch (err) {
      console.error('Portfolio error:', err);
    }
  }

  function updatePortfolioDisplay() {
    const holdingsValue = portfolio.holdings
      ? portfolio.holdings.reduce((sum, h) => sum + (h.quantity * h.current_price), 0)
      : 0;

    $('#cash-balance').textContent = `₹${portfolio.cash.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;
    $('#holdings-value').textContent = `₹${holdingsValue.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;
    $('#total-value').textContent = `₹${(portfolio.cash + holdingsValue).toLocaleString('en-IN', {maximumFractionDigits: 0})}`;
  }

  function renderHoldings() {
    const tbody = $('#holdings-table-body');
    if (!portfolio.holdings || portfolio.holdings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><p>// no holdings — start trading</p></td></tr>';
      return;
    }

    tbody.innerHTML = portfolio.holdings.map(h => {
      const pnl = (h.current_price - h.avg_price) * h.quantity;
      const pnlPct = ((h.current_price - h.avg_price) / h.avg_price * 100);
      const isPositive = pnl >= 0;
      const value = h.quantity * h.current_price;

      return `
        <tr>
          <td class="ticker text-left" style="color: var(--blue-bright); text-shadow: var(--text-glow-bright);">${escapeHtml(h.ticker)}</td>
          <td class="text-left" style="color: var(--text-primary)">${escapeHtml(h.stock_name)}</td>
          <td class="mono text-center">${h.quantity}</td>
          <td class="mono text-right">₹${h.avg_price.toFixed(2)}</td>
          <td class="mono text-right">₹${h.current_price.toFixed(2)}</td>
          <td class="mono text-right" style="color: ${isPositive ? 'var(--price-up)' : 'var(--price-down)'}">
            ${isPositive ? '+' : ''}₹${pnl.toFixed(0)} (${isPositive ? '+' : ''}${pnlPct.toFixed(1)}%)
          </td>
          <td class="mono text-right" style="color: var(--blue-bright)">₹${value.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
        </tr>
      `;
    }).join('');
  }

  function renderTrades() {
    const tbody = $('#trades-table-body');
    if (!portfolio.trades || portfolio.trades.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><p>// no trades executed</p></td></tr>';
      return;
    }

    tbody.innerHTML = portfolio.trades.map(t => {
      const isBuy = t.type === 'buy';
      return `
        <tr>
          <td class="text-left"><span class="impact-tag ${isBuy ? 'positive' : 'negative'}" style="font-size:0.6rem;">${isBuy ? '[ BUY ]' : '[ SELL ]'}</span></td>
          <td class="ticker text-left" style="color: var(--blue-bright)">${escapeHtml(t.ticker)}</td>
          <td class="mono text-center">${t.quantity}</td>
          <td class="mono text-right">₹${t.price.toFixed(2)}</td>
          <td class="mono text-right">₹${t.total.toFixed(0)}</td>
          <td class="mono text-center" style="color: var(--text-muted)">D${parseFloat(t.sim_day).toFixed(1)}</td>
        </tr>
      `;
    }).join('');
  }

  // ═══ LEADERBOARD ═══════════════════════════════════════════

  async function loadLeaderboard() {
    try {
      const res = await fetch('/api/participant/leaderboard');
      const data = await res.json();
      renderLeaderboard(data);
    } catch { }
  }

  function renderLeaderboard(leaderboard) {
    const tbody = $('#leaderboard-body');
    if (leaderboard.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state"><p>// no participants</p></td></tr>';
      return;
    }

    tbody.innerHTML = leaderboard.map(p => {
      const rankClass = p.rank <= 3 ? `rank-${p.rank}` : 'rank-other';
      const isMe = p.userId === currentUser.id;

      return `
        <tr style="${isMe ? 'background: rgba(0, 170, 255, 0.05);' : ''}">
          <td class="text-center"><span class="rank-badge ${rankClass}">${p.rank}</span></td>
          <td class="text-left">
            <strong style="color: ${isMe ? 'var(--blue-bright)' : 'var(--text-primary)'}">${escapeHtml(p.name)}${isMe ? ' (you)' : ''}</strong>
          </td>
          <td class="leaderboard-value text-right" style="padding-right: 1.5rem;">₹${p.totalValue.toLocaleString('en-IN', {maximumFractionDigits: 0})}</td>
        </tr>
      `;
    }).join('');
  }

  // ═══ PORTFOLIO PERFORMANCE CHART ═══════════════════════════

  // ─── Chart View Toggle ─────────────────────────────────────
  const chartViewDayBtn = document.getElementById('chart-view-day');
  const chartViewAllBtn = document.getElementById('chart-view-all');

  if (chartViewDayBtn && chartViewAllBtn) {
    chartViewDayBtn.addEventListener('click', () => {
      chartViewMode = 'day';
      chartViewDayBtn.classList.add('active');
      chartViewAllBtn.classList.remove('active');
      forceChartRedraw();
    });
    chartViewAllBtn.addEventListener('click', () => {
      chartViewMode = 'all';
      chartViewAllBtn.classList.add('active');
      chartViewDayBtn.classList.remove('active');
      forceChartRedraw();
    });
  }

  function forceChartRedraw() {
    // Destroy existing chart and recreate with new data range
    if (portfolioChart) {
      portfolioChart.destroy();
      portfolioChart = null;
    }
    updatePortfolioChart();
  }

  function getFilteredPortfolioData() {
    if (chartViewMode === 'day' && simState) {
      const currentDay = Math.floor(simState.simDay || simState.current_day || 1);
      return portfolioHistory.filter(p => Math.floor(p.time) === currentDay);
    }
    return portfolioHistory;
  }

  function updatePortfolioChart() {
    const filteredData = getFilteredPortfolioData();
    if (filteredData.length < 2) return;

    const ctx = document.getElementById('portfolio-perf-chart');
    if (!ctx) return;

    const labels = filteredData.map(p => {
      if (chartViewMode === 'day') {
        // Show time-within-day as percentage
        const dayFraction = (p.time % 1) * 100;
        return `${dayFraction.toFixed(0)}%`;
      }
      return `D${parseFloat(p.time).toFixed(1)}`;
    });
    const values = filteredData.map(p => p.value);
    const startingCash = simState ? (simState.starting_cash || values[0]) : values[0];

    // Determine if profit or loss for color
    const latestVal = values[values.length - 1];
    const isProfit = latestVal >= startingCash;
    const lineColor = isProfit ? '#00ff66' : '#ff4d6d';
    const fillColor = isProfit ? 'rgba(0, 255, 102, 0.08)' : 'rgba(255, 77, 109, 0.08)';

    if (portfolioChart) {
      portfolioChart.data.labels = labels;
      portfolioChart.data.datasets[0].data = values;
      portfolioChart.data.datasets[0].borderColor = lineColor;
      portfolioChart.data.datasets[0].backgroundColor = fillColor;
      // Update reference line
      if (portfolioChart.data.datasets[1]) {
        portfolioChart.data.datasets[1].data = new Array(labels.length).fill(startingCash);
      }
      portfolioChart.update('none');
      return;
    }

    portfolioChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Portfolio Value',
          data: values,
          borderColor: lineColor,
          backgroundColor: fillColor,
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: lineColor,
        }, {
          label: 'Starting Cash',
          data: new Array(labels.length).fill(startingCash),
          borderColor: 'rgba(255,255,255,0.15)',
          borderWidth: 1,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#02050d',
            titleColor: '#00e5ff',
            bodyColor: '#e0f7fc',
            borderColor: 'rgba(0, 229, 255, 0.25)',
            borderWidth: 1,
            titleFont: { family: "'Source Code Pro', monospace", size: 11 },
            bodyFont: { family: "'Source Code Pro', monospace", size: 11 },
            callbacks: {
              label: (ctx) => `₹${ctx.parsed.y.toLocaleString('en-IN', {maximumFractionDigits: 0})}`
            }
          }
        },
        scales: {
          x: {
            title: {
              display: true,
              text: chartViewMode === 'day' ? 'TIME IN DAY (%)' : 'SIMULATION DAY',
              color: 'rgba(0, 229, 255, 0.3)',
              font: { family: "'Source Code Pro', monospace", size: 9 }
            },
            ticks: { color: '#5d7285', font: { family: "'Source Code Pro', monospace", size: 9 }, maxTicksLimit: 10 },
            grid: { color: 'rgba(0, 229, 255, 0.08)' }
          },
          y: {
            ticks: {
              color: '#5d7285',
              font: { family: "'Source Code Pro', monospace", size: 9 },
              callback: (v) => '₹' + (v / 1000).toFixed(0) + 'K'
            },
            grid: { color: 'rgba(0, 229, 255, 0.08)' }
          }
        },
        interaction: { intersect: false, mode: 'index' }
      }
    });
  }

  // ═══ NEWS FEED ═════════════════════════════════════════════


  async function loadNews() {
    try {
      const res = await fetch('/api/participant/news');
      newsList = await res.json();
      renderNewsFeed();
    } catch { }
  }

  function renderNewsFeed() {
    const container = $('#news-feed-content');
    const countEl = $('#news-count');

    countEl.textContent = newsList.length;

    if (newsList.length === 0) {
      container.innerHTML = '<div class="news-empty">// awaiting_headlines — live feed will appear here</div>';
      return;
    }

    container.innerHTML = newsList.map(n => {
      return `
        <div class="news-item">
          <span class="news-day-badge">[DAY ${typeof n.sim_day === 'number' ? n.sim_day.toFixed(1) : n.sim_day}]</span>
          <div class="news-content">
            <h4>${escapeHtml(n.headline)}</h4>
          </div>
        </div>
      `;
    }).join('');
  }

  // ═══ PER-SIMULATION REGISTRATION ═══════════════════════════

  async function loadAvailableSimulations() {
    try {
      const res = await fetch('/api/participant/available-simulations');
      const sims = await res.json();
      renderAvailableSimulations(sims);
    } catch { }
  }

  function renderAvailableSimulations(sims) {
    const container = $('#available-sims-list');
    if (!sims || sims.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>// no simulations open for registration</p></div>';
      return;
    }

    container.innerHTML = sims.map(s => {
      const regStatus = s.reg_status;
      let actionHtml = '';

      if (regStatus === 'approved') {
        actionHtml = '<span class="status-badge" style="background:rgba(0,200,80,0.1);color:#00c850;border:1px solid rgba(0,200,80,0.3);padding:0.2rem 0.6rem;font-size:0.6rem;">✓ APPROVED</span>';
      } else if (regStatus === 'pending') {
        actionHtml = '<span class="status-badge" style="background:rgba(255,200,0,0.1);color:#ffaa00;border:1px solid rgba(255,200,0,0.3);padding:0.2rem 0.6rem;font-size:0.6rem;">⏳ PENDING</span>';
      } else if (regStatus === 'rejected') {
        actionHtml = '<span class="status-badge" style="background:rgba(255,50,50,0.1);color:#ff5252;border:1px solid rgba(255,50,50,0.3);padding:0.2rem 0.6rem;font-size:0.6rem;">✕ REJECTED</span>';
      } else {
        actionHtml = `<button class="btn btn-primary btn-sm" onclick="registerForSim(${s.id})" style="font-size:0.6rem;padding:0.2rem 0.6rem;">[ REGISTER ]</button>`;
      }

      return `
        <div class="sim-card" style="cursor:default; margin-bottom:0.5rem;">
          <div class="sim-card-info">
            <h4>${escapeHtml(s.name)}</h4>
            <span>${s.total_days} days // ₹${Number(s.starting_cash).toLocaleString('en-IN')} starting cash</span>
          </div>
          <div class="sim-card-actions">
            ${actionHtml}
          </div>
        </div>
      `;
    }).join('');
  }

  window.registerForSim = async function(simId) {
    try {
      const res = await fetch(`/api/participant/simulations/${simId}/register`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('[ REGISTERED ] Waiting for admin approval', 'info');
        loadAvailableSimulations();
      } else {
        showToast(data.error || 'Registration failed', 'error');
      }
    } catch { showToast('REGISTRATION FAILED', 'error'); }
  };

  // ═══ ARCHIVES & LEARNING REPORTS ═══════════════════════════

  async function loadArchives() {
    try {
      const res = await fetch('/api/participant/archives');
      const archives = await res.json();
      renderArchiveList(archives);
    } catch { }
  }

  function renderArchiveList(archives) {
    const container = $('#participant-archive-list');
    if (archives.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>// no archived simulations</p></div>';
      return;
    }

    container.innerHTML = archives.map(s => `
      <div class="sim-card" style="cursor: default;">
        <div class="sim-card-info">
          <h4>${escapeHtml(s.name)}</h4>
          <span>${s.total_days} days // ended ${s.stopped_at ? new Date(s.stopped_at).toLocaleDateString() : '—'}</span>
        </div>
        <div class="sim-card-actions">
          <span class="status-badge archived"><span class="status-dot"></span>[ ARCHIVED ]</span>
          <button class="btn btn-ghost btn-sm" onclick="viewArchiveLeaderboard(${s.id})">[ RANKINGS ]</button>
          ${s.reportVisible ? `<button class="btn btn-primary btn-sm" onclick="viewLearningReport(${s.id})">[ AI REPORT ]</button>` : '<span style="font-size:0.6rem;color:var(--text-muted);">// report locked</span>'}
        </div>
      </div>
    `).join('');
  }

  window.viewArchiveLeaderboard = async function(simId) {
    try {
      const res = await fetch(`/api/participant/archives/${simId}/leaderboard`);
      const data = await res.json();

      const reportViewer = $('#report-viewer');
      reportViewer.style.display = 'block';
      $('#report-title').textContent = '// FINAL RANKINGS';

      let html = '<div class="glass-card"><table class="leaderboard-table"><thead><tr><th>RANK</th><th>PARTICIPANT</th><th>TOTAL VALUE</th></tr></thead><tbody>';
      html += data.map(p => {
        const rankClass = p.rank <= 3 ? `rank-${p.rank}` : 'rank-other';
        const isMe = p.userId === currentUser.id;
        return `<tr style="${isMe ? 'background: rgba(0, 170, 255, 0.05);' : ''}">
          <td><span class="rank-badge ${rankClass}">${p.rank}</span></td>
          <td><strong style="color: ${isMe ? 'var(--blue-bright)' : 'var(--text-primary)'}">${escapeHtml(p.name)}${isMe ? ' (you)' : ''}</strong></td>
          <td class="leaderboard-value">₹${p.totalValue.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
        </tr>`;
      }).join('');
      html += '</tbody></table></div>';

      $('#report-content').innerHTML = html;
    } catch { showToast('FAILED TO LOAD', 'error'); }
  };

  window.viewLearningReport = async function(simId) {
    try {
      const res = await fetch(`/api/participant/archives/${simId}/report`);
      if (!res.ok) {
        const errData = await res.json();
        showToast(errData.error || 'REPORT UNAVAILABLE', 'error');
        return;
      }
      const data = await res.json();

      const reportViewer = $('#report-viewer');
      reportViewer.style.display = 'block';
      $('#report-title').textContent = `// AI LEARNING REPORT — ${data.simulation.name}`;

      let html = '';
      html += `<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:1rem;padding:0.5rem;border:1px solid var(--blue-border);background:var(--bg-panel);">// This report reveals the AI reasoning behind each news event. Study causal chains and optimal actions to improve your trading strategy.</div>`;

      if (data.news && data.news.length > 0) {
        data.news.forEach(n => {
          if (n.status === 'scheduled') return; // Skip unpublished
          const impacts = n.impacts?.impacts || n.impacts || [];
          const reasoning = n.reasoning || {};

          html += `<div class="report-entry">
            <div class="report-day-tag">[DAY ${typeof n.sim_day === 'number' ? n.sim_day.toFixed(1) : n.sim_day}]</div>
            <div class="report-headline">${escapeHtml(n.headline)}</div>
            <div style="display:flex;gap:0.2rem;flex-wrap:wrap;margin:0.3rem 0;">
              ${(Array.isArray(impacts) ? impacts : []).map(i => `<span class="impact-tag ${i.sentiment}" style="font-size:0.6rem;">${i.sentiment === 'positive' ? '↑' : i.sentiment === 'negative' ? '↓' : '→'} ${i.industry} [${i.strength}]</span>`).join('')}
            </div>`;

          // Per-industry reasoning
          const impactDetails = reasoning.impactDetails || impacts;
          if (Array.isArray(impactDetails) && impactDetails.length > 0) {
            html += '<div class="report-reasoning">';
            impactDetails.forEach(i => {
              if (i.reasoning) {
                html += `> ${i.industry.toUpperCase()} [${(i.sentiment || '').toUpperCase()}/${(i.strength || '').toUpperCase()}]\n${i.reasoning}\n\n`;
              }
            });
            html += '</div>';
          }

          // Smart investor action
          if (reasoning.smartInvestorAction) {
            html += `<div class="report-smart-action">> OPTIMAL_ACTION:\n${reasoning.smartInvestorAction}</div>`;
          }

          html += '</div>';
        });
      } else {
        html += '<div class="empty-state"><p>// no news events during simulation</p></div>';
      }

      // Leaderboard summary
      html += '<h4 style="font-size:0.75rem;color:var(--blue-primary);margin:1.5rem 0 0.5rem;letter-spacing:0.1em;text-shadow:0 0 8px rgba(0,170,255,0.3);">FINAL RESULTS</h4>';
      html += '<div class="glass-card"><table class="leaderboard-table"><thead><tr><th>RANK</th><th>PARTICIPANT</th><th>TOTAL</th></tr></thead><tbody>';
      data.leaderboard.forEach(p => {
        const isMe = p.userId === currentUser.id;
        const rankClass = p.rank <= 3 ? `rank-${p.rank}` : 'rank-other';
        html += `<tr style="${isMe ? 'background:rgba(0,170,255,0.05);' : ''}"><td><span class="rank-badge ${rankClass}">${p.rank}</span></td><td style="color:${isMe?'var(--blue-bright)':'var(--text-primary)'}">${escapeHtml(p.name)}${isMe?' (you)':''}</td><td class="leaderboard-value">₹${p.totalValue.toLocaleString('en-IN',{maximumFractionDigits:0})}</td></tr>`;
      });
      html += '</tbody></table></div>';

      $('#report-content').innerHTML = html;
    } catch (err) {
      showToast('FAILED TO LOAD REPORT', 'error');
      console.error(err);
    }
  };

  // ═══ SOCKET.IO ═════════════════════════════════════════════

  socket.on('simulation:state', (state) => {
    updateUI(state);
  });

  socket.on('prices:update', (updates) => {
    const prevData = { ...stockData };

    updates.forEach(u => {
      stockData[u.id] = { ...stockData[u.id], ...u };
    });

    // Animate price flash
    updates.forEach(u => {
      const priceEl = document.getElementById(`price-${u.id}`);
      if (priceEl) {
        const prev = prevData[u.id]?.price;
        const current = u.price;
        if (prev !== undefined) {
          priceEl.textContent = `₹${current.toFixed(2)}`;
          if (current > prev) {
            priceEl.classList.remove('price-down');
            priceEl.classList.add('price-up');
          } else if (current < prev) {
            priceEl.classList.remove('price-up');
            priceEl.classList.add('price-down');
          }
          setTimeout(() => {
            priceEl.classList.remove('price-up', 'price-down');
          }, 500);
        }
      }
    });

    renderStockGrid(updates);

    // Update modal if open
    if (selectedStock && stockData[selectedStock.id]) {
      const s = stockData[selectedStock.id];
      $('#modal-current-price').textContent = `₹${s.price.toFixed(2)}`;
      $('#modal-percent-change').textContent = `${s.percentChange >= 0 ? '+' : ''}${s.percentChange.toFixed(2)}%`;
      $('#modal-percent-change').style.color = s.percentChange >= 0 ? 'var(--price-up)' : 'var(--price-down)';
      selectedStock = s;
      updateEstimatedCost();
    }

    // Update portfolio header
    if (portfolio.holdings) {
      let holdingsVal = 0;
      portfolio.holdings.forEach(h => {
        const sd = stockData[h.stock_id];
        if (sd) {
          h.current_price = sd.price;
          holdingsVal += h.quantity * sd.price;
        }
      });
      $('#holdings-value').textContent = `₹${holdingsVal.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;
      const totalVal = portfolio.cash + holdingsVal;
      $('#total-value').textContent = `₹${totalVal.toLocaleString('en-IN', {maximumFractionDigits: 0})}`;

      // Track portfolio value for chart (snapshot every update)
      const simDay = simState ? (simState.simDay || simState.current_day || 1) : 1;
      portfolioHistory.push({ time: simDay, value: totalVal });
      // Keep max 500 points
      if (portfolioHistory.length > 500) portfolioHistory.shift();
      // Update chart every 3rd snapshot
      if (portfolioHistory.length % 3 === 0) updatePortfolioChart();
    }
  });

  socket.on('news:published', (newsItem) => {
    // Prepend to news list
    newsList.unshift(newsItem);
    renderNewsFeed();

    // Mark the first item as breaking news (pulsing red)
    const firstItem = document.querySelector('#news-feed-content .news-item');
    if (firstItem) {
      firstItem.classList.add('news-breaking');
      setTimeout(() => firstItem.classList.remove('news-breaking'), 15000);
    }

    // Create massive BREAKING NEWS overlay banner
    const existing = document.querySelector('.news-flash-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'news-flash-overlay';
    overlay.innerHTML = `
      <span class="breaking-label">⚡ BREAKING NEWS</span>
      <span class="breaking-text">${newsItem.headline}</span>
    `;
    document.body.appendChild(overlay);

    // Auto-remove after 8 seconds
    setTimeout(() => {
      overlay.style.animation = 'breakingNewsDrop 0.4s ease-in reverse';
      setTimeout(() => overlay.remove(), 400);
    }, 8000);

    // Click to dismiss
    overlay.addEventListener('click', () => {
      overlay.style.animation = 'breakingNewsDrop 0.3s ease-in reverse';
      setTimeout(() => overlay.remove(), 300);
    });
    overlay.style.cursor = 'pointer';

    // Brief flash on the news feed panel too
    const feedPanel = $('#news-feed-panel');
    feedPanel.classList.add('news-flash');
    setTimeout(() => feedPanel.classList.remove('news-flash'), 2000);
  });

  socket.on('leaderboard:update', (data) => {
    // Track rank changes and show popups
    if (data && data.length > 0 && currentUser) {
      const myEntry = data.find(p => p.userId === currentUser.id);
      if (myEntry) {
        const currentRank = myEntry.rank;
        if (lastRank !== null && currentRank !== lastRank) {
          if (currentRank === 1 && lastRank !== 1) {
            showRankPopup('👑 YOU\'RE #1!', 'rank-first');
          } else if (currentRank < lastRank) {
            showRankPopup(`🔼 You moved UP to #${currentRank}!`, 'rank-up');
          } else if (currentRank > lastRank) {
            showRankPopup(`🔽 You dropped to #${currentRank}`, 'rank-down');
          }
        }
        lastRank = currentRank;
      }
    }
    if ($('#leaderboard-tab').classList.contains('active')) {
      renderLeaderboard(data);
    }
  });

  socket.on('simulation:newday', ({ day, totalDays }) => {
    showToast(`[ DAY ${day} / ${totalDays} ]`, 'info');
    loadPortfolio();
  });

  socket.on('simulation:stopped', () => {
    showToast('[ SIMULATION ENDED ]', 'info');
    updateUI({ status: 'stopped' });
  });

  // ═══ UTILITIES ═════════════════════════════════════════════

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ═══ INITIAL LOAD ══════════════════════════════════════════

  // Load initial state
  try {
    const simRes = await fetch('/api/participant/simulation');
    const simData = await simRes.json();
    updateUI(simData);

    if (simData.participantCash !== undefined) {
      portfolio.cash = simData.participantCash;
    }
  } catch { }

  // Always load portfolio (will show zeros if no sim)
  try {
    await loadPortfolio();
  } catch { }

  // Always load stocks
  try {
    const stocksRes = await fetch('/api/participant/stocks');
    const { stocks: stocksList } = await stocksRes.json();
    if (stocksList) {
      stocksList.forEach(s => {
        stockData[s.id] = {
          id: s.id,
          ticker: s.ticker,
          name: s.name,
          price: s.current_price,
          startingPrice: s.starting_price,
          percentChange: ((s.current_price - s.starting_price) / s.starting_price * 100),
          industry: s.industry,
          description: s.description || '',
          colorIndex: s.color_index,
          volatility: s.volatility || 'medium'
        };
      });
      renderStockGrid(Object.values(stockData));
    }
  } catch { }

  // Always load news
  await loadNews();
})();
