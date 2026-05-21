// ═══════════════════════════════════════════════════════════════
// PARTICIPANT DASHBOARD — Real-Time Trading Interface
// Matrix Blue Design
// ═══════════════════════════════════════════════════════════════

(async function () {
  'use strict';

  const STOCK_COLORS = ['#00e5ff','#1565c0','#40c4ff','#0091ea','#80d8ff','#00b0ff','#448aff'];

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
  let stockData = {};
  let portfolio = { cash: 0, holdings: [], trades: [] };
  let selectedStock = null;
  let priceChart = null;
  let newsList = [];
  let lastRank = null; // Track leaderboard position for change popups
  let portfolioHistory = []; // {time, value} snapshots for chart
  let portfolioChart = null;

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

  function updateUI(state) {
    simState = state;

    // Always show the trading interface — never block it
    showTrading();

    const statusIndicator = $('#sim-status-indicator');
    const statusBanner = $('#sim-status-banner');

    if (!state || state.status === 'not_started') {
      showStatusBanner('// NO ACTIVE SIMULATION — browse freely, trading disabled until admin starts a simulation.', 'idle');
      statusIndicator.innerHTML = '<span class="status-badge not-started">[ STANDBY ]</span>';
      $('#sim-name').textContent = '—';
      $('#current-day').textContent = '—';
      $('#day-progress-fill').style.width = '0%';
      setTradingEnabled(false);
      return;
    }

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

    // Spectator state: simulation is running/paused/active but user is not a participant
    if (state.status === 'running' && !state.isParticipant) {
      showStatusBanner('// SPECTATING — you are not registered or approved for this active simulation.', 'idle');
      statusIndicator.innerHTML = '<span class="status-badge paused">[ SPECTATING ]</span>';
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

      const volLevel = 'MEDIUM'; // Placeholder
      const volBars = 2;

      const desc = s.description ? s.description.substring(0, 80) + (s.description.length > 80 ? '...' : '') : '';

      return `
        <div class="stock-card ${changeClass}" style="--stock-accent: ${color};"
             onclick="openStockModal(${s.id})" id="stock-card-${s.id}">
          <div class="stock-card-header">
            <div>
              <div class="ticker" style="color: ${color}; text-shadow: 0 0 8px ${color}40;">${s.ticker}</div>
              <div class="company-name">${s.name}</div>
            </div>
            <span class="industry-tag">${s.industry}</span>
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

    // Stock info panel
    let infoEl = $('#modal-stock-info');
    if (!infoEl) {
      infoEl = document.createElement('div');
      infoEl.id = 'modal-stock-info';
      const priceEl = $('#modal-current-price').closest('.modal-info-row') || $('#modal-current-price').parentElement;
      priceEl.parentElement.insertBefore(infoEl, priceEl.nextSibling);
    }
    if (selectedStock.description) {
      infoEl.innerHTML = `
        <div style="margin: 0.5rem 0 0.75rem; padding: 0.6rem 0.75rem; background: rgba(0,170,255,0.05); border: 1px solid rgba(0,170,255,0.15); border-radius: 4px;">
          <div style="font-size: 0.6rem; color: var(--blue-primary); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.25rem; font-weight: 700;">ℹ️ ABOUT THIS COMPANY // ${selectedStock.industry}</div>
          <div style="font-size: 0.72rem; color: var(--text-primary); line-height: 1.5; font-family: 'Source Code Pro', monospace;">${selectedStock.description}</div>
        </div>
      `;
    } else {
      infoEl.innerHTML = '';
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
              backgroundColor: '#010b13',
              titleColor: '#00aaff',
              bodyColor: '#00e5ff',
              borderColor: '#003a5c',
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
                color: '#1a4f6e',
                font: { family: "'Source Code Pro', monospace", size: 9 },
                maxTicksLimit: 10,
              },
              grid: { color: 'rgba(0, 58, 92, 0.15)', drawBorder: false },
            },
            y: {
              display: true,
              ticks: {
                color: '#1a4f6e',
                font: { family: "'Source Code Pro', monospace", size: 9 },
                callback: (v) => `₹${v.toFixed(0)}`,
              },
              grid: { color: 'rgba(0, 58, 92, 0.15)', drawBorder: false },
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
          <td class="ticker" style="color: var(--blue-bright); text-shadow: var(--text-glow-bright);">${h.ticker}</td>
          <td style="color: var(--text-primary)">${h.stock_name}</td>
          <td class="mono">${h.quantity}</td>
          <td class="mono">₹${h.avg_price.toFixed(2)}</td>
          <td class="mono">₹${h.current_price.toFixed(2)}</td>
          <td class="mono" style="color: ${isPositive ? 'var(--price-up)' : 'var(--price-down)'}">
            ${isPositive ? '+' : ''}₹${pnl.toFixed(0)} (${isPositive ? '+' : ''}${pnlPct.toFixed(1)}%)
          </td>
          <td class="mono" style="color: var(--blue-bright)">₹${value.toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
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
          <td><span class="impact-tag ${isBuy ? 'positive' : 'negative'}" style="font-size:0.6rem;">${isBuy ? '[ BUY ]' : '[ SELL ]'}</span></td>
          <td class="ticker" style="color: var(--blue-bright)">${t.ticker}</td>
          <td class="mono">${t.quantity}</td>
          <td class="mono">₹${t.price.toFixed(2)}</td>
          <td class="mono">₹${t.total.toFixed(0)}</td>
          <td class="mono" style="color: var(--text-muted)">D${parseFloat(t.sim_day).toFixed(1)}</td>
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
          <td><span class="rank-badge ${rankClass}">${p.rank}</span></td>
          <td>
            <strong style="color: ${isMe ? 'var(--blue-bright)' : 'var(--text-primary)'}">${escapeHtml(p.name)}${isMe ? ' (you)' : ''}</strong>
          </td>
          <td class="leaderboard-value">₹${p.totalValue.toLocaleString('en-IN', {maximumFractionDigits: 0})}</td>
        </tr>
      `;
    }).join('');
  }

  // ═══ PORTFOLIO PERFORMANCE CHART ═══════════════════════════

  function updatePortfolioChart() {
    if (portfolioHistory.length < 2) return;

    const ctx = document.getElementById('portfolio-perf-chart');
    if (!ctx) return;

    const labels = portfolioHistory.map(p => `D${parseFloat(p.time).toFixed(1)}`);
    const values = portfolioHistory.map(p => p.value);
    const startingCash = simState ? (simState.starting_cash || values[0]) : values[0];

    // Determine if profit or loss for color
    const latestVal = values[values.length - 1];
    const isProfit = latestVal >= startingCash;
    const lineColor = isProfit ? '#00e676' : '#ff5252';
    const fillColor = isProfit ? 'rgba(0,230,118,0.08)' : 'rgba(255,82,82,0.08)';

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
            backgroundColor: '#010b13',
            titleColor: '#00aaff',
            bodyColor: '#00e5ff',
            borderColor: '#003a5c',
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
            ticks: { color: '#1a4f6e', font: { family: "'Source Code Pro', monospace", size: 9 }, maxTicksLimit: 10 },
            grid: { color: 'rgba(0, 58, 92, 0.15)' }
          },
          y: {
            ticks: {
              color: '#1a4f6e',
              font: { family: "'Source Code Pro', monospace", size: 9 },
              callback: (v) => '₹' + (v / 1000).toFixed(0) + 'K'
            },
            grid: { color: 'rgba(0, 58, 92, 0.15)' }
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
          colorIndex: s.color_index
        };
      });
      renderStockGrid(Object.values(stockData));
    }
  } catch { }

  // Always load news
  await loadNews();
})();
