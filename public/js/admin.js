// ═══════════════════════════════════════════════════════════════
// ADMIN DASHBOARD — Multi-Simulation Manager
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
    if (currentUser.role !== 'admin') { window.location.href = '/participant'; return; }
  } catch {
    window.location.href = '/';
    return;
  }

  const socket = io();
  let simState = { status: 'not_started' };
  let allSimulations = [];
  let selectedSimId = null; // For stocks/news/leaderboard context
  let stocks = [];

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

  // ─── Navigation ────────────────────────────────────────────
  $$('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      $$('.nav-item').forEach(n => n.classList.remove('active'));
      $$('.panel').forEach(p => p.classList.remove('active'));
      item.classList.add('active');
      $(`#panel-${item.dataset.panel}`).classList.add('active');

      if (item.dataset.panel === 'stocks') { populateSimSelectors(); loadStocks(); }
      if (item.dataset.panel === 'registrations') loadRegistrations();
      if (item.dataset.panel === 'leaderboard') { populateSimSelectors(); }
      if (item.dataset.panel === 'news') { populateSimSelectors(); loadNews(); loadScheduledNews(); loadNewsStocks(selectedSimId || parseInt($('#news-sim-select')?.value)); }
      if (item.dataset.panel === 'simulations') loadSimulations();
      if (item.dataset.panel === 'archive') loadArchive();
    });
  });

  $('#logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  });

  // ═══ SIMULATION MANAGEMENT ════════════════════════════════

  async function loadSimulations() {
    try {
      const res = await fetch('/api/admin/simulations');
      allSimulations = await res.json();
      renderSimList();
      updateActiveSimPanel();
    } catch (err) {
      showToast('FAILED TO LOAD SIMULATIONS', 'error');
    }
  }

  function renderSimList() {
    const container = $('#sim-list');
    if (allSimulations.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>// NO SIMULATIONS CREATED</p></div>';
      return;
    }

    container.innerHTML = allSimulations.map(s => {
      const statusMap = {
        'not_started': '[ NOT STARTED ]',
        'running': '[ RUNNING ]',
        'paused': '[ PAUSED ]',
        'stopped': '[ ARCHIVED ]'
      };
      const badgeClass = s.status === 'stopped' ? 'archived' : s.status.replace('_', '-');
      const isActive = simState.id && simState.id === s.id;

      return `
        <div class="sim-card ${isActive ? 'active-sim' : ''}" onclick="selectSimulation(${s.id})">
          <div class="sim-card-info">
            <h4>${escapeHtml(s.name)}</h4>
            <span>${s.total_days} days // ₹${Number(s.starting_cash).toLocaleString('en-IN')} starting cash</span>
          </div>
          <div class="sim-card-actions">
            <span class="status-badge ${badgeClass}"><span class="status-dot"></span>${statusMap[s.status] || s.status}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function updateActiveSimPanel() {
    const panel = $('#active-sim-panel');
    const activeSim = allSimulations.find(s => s.status === 'running' || s.status === 'paused' || (simState.id && s.id === simState.id));

    if (!activeSim && !selectedSimId) {
      panel.style.display = 'none';
      return;
    }

    const sim = activeSim || allSimulations.find(s => s.id === selectedSimId);
    if (!sim) { panel.style.display = 'none'; return; }

    panel.style.display = 'block';
    selectedSimId = sim.id;

    $('#active-sim-name').textContent = sim.name;

    const statusText = {
      'not_started': '[ NOT STARTED ]',
      'running': '[ RUNNING ]',
      'paused': '[ PAUSED ]',
      'stopped': '[ ARCHIVED ]'
    };

    $('#sim-status-text').textContent = statusText[sim.status] || sim.status;
    const badgeClass = sim.status === 'stopped' ? 'archived' : sim.status.replace('_', '-');
    $('#active-sim-status-badge').innerHTML = `<span class="status-badge ${badgeClass}"><span class="status-dot"></span>${statusText[sim.status]}</span>`;

    const isNotStarted = sim.status === 'not_started';
    const isRunning = sim.status === 'running';
    const isPaused = sim.status === 'paused';
    const isStopped = sim.status === 'stopped';

    $('#btn-start-sim').style.display = isNotStarted ? 'inline-flex' : 'none';
    $('#btn-pause-sim').style.display = isRunning ? 'inline-flex' : 'none';
    $('#btn-resume-sim').style.display = isPaused ? 'inline-flex' : 'none';
    $('#btn-stop-sim').style.display = (isRunning || isPaused) ? 'inline-flex' : 'none';
  }

  function updateSimUI(state) {
    simState = state || simState;

    if (simState.current_day) {
      $('#sim-day-text').textContent = `${simState.current_day}`;
      $('#sim-total-days-text').textContent = `${simState.total_days}`;
    } else {
      $('#sim-day-text').textContent = '—';
      $('#sim-total-days-text').textContent = '—';
    }

    if (simState.status === 'running' && simState.timeRemainingInDay !== undefined) {
      const totalSec = Math.ceil(simState.timeRemainingInDay / 1000);
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      $('#sim-time-left').textContent = `${min}:${String(sec).padStart(2, '0')}`;
    } else {
      $('#sim-time-left').textContent = '—';
    }

    if (simState.dayProgress !== undefined) {
      $('#day-progress-fill').style.width = `${(simState.dayProgress * 100).toFixed(1)}%`;
    }

    // Also update status badge
    const statusText = {
      'not_started': '[ NOT STARTED ]',
      'running': '[ RUNNING ]',
      'paused': '[ PAUSED ]',
      'stopped': '[ ARCHIVED ]'
    };
    if (simState.status) {
      $('#sim-status-text').textContent = statusText[simState.status] || simState.status;
      const badgeClass = simState.status === 'stopped' ? 'archived' : simState.status.replace('_', '-');
      $('#active-sim-status-badge').innerHTML = `<span class="status-badge ${badgeClass}"><span class="status-dot"></span>${statusText[simState.status]}</span>`;
      
      const isRunning = simState.status === 'running';
      const isPaused = simState.status === 'paused';
      $('#btn-start-sim').style.display = simState.status === 'not_started' ? 'inline-flex' : 'none';
      $('#btn-pause-sim').style.display = isRunning ? 'inline-flex' : 'none';
      $('#btn-resume-sim').style.display = isPaused ? 'inline-flex' : 'none';
      $('#btn-stop-sim').style.display = (isRunning || isPaused) ? 'inline-flex' : 'none';
    }

    if (simState.id && !$('#active-sim-panel').style.display !== 'none') {
      $('#active-sim-panel').style.display = 'block';
    }
  }

  window.selectSimulation = function(id) {
    selectedSimId = id;
    const sim = allSimulations.find(s => s.id === id);
    if (!sim) return;

    $('#active-sim-panel').style.display = 'block';
    $('#active-sim-name').textContent = sim.name;

    const state = (simState.id === id) ? simState : sim;
    updateSimUI({ ...state, id });
    updateActiveSimPanel();
  };

  // Create simulation
  $('#btn-create-sim').addEventListener('click', async () => {
    const name = $('#sim-name').value.trim();
    const totalDays = parseInt($('#sim-total-days').value);
    const startingCash = parseFloat($('#sim-starting-cash').value);

    if (!name) { showToast('ENTER SIMULATION NAME', 'error'); return; }
    if (!totalDays || totalDays < 1) { showToast('SET VALID DAYS', 'error'); return; }
    if (!startingCash || startingCash < 100) { showToast('SET VALID STARTING CASH', 'error'); return; }

    try {
      const res = await fetch('/api/admin/simulations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, totalDays, startingCash })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`[ CREATED ] ${name}`, 'success');
        $('#sim-name').value = '';
        selectedSimId = data.id;
        loadSimulations();
      } else showToast(data.error, 'error');
    } catch { showToast('CONNECTION ERROR', 'error'); }
  });

  // Simulation controls
  $('#btn-start-sim').addEventListener('click', async () => {
    if (!selectedSimId) return;
    try {
      const res = await fetch(`/api/admin/simulation/${selectedSimId}/start`, { method: 'POST' });
      const data = await res.json();
      if (data.success) { showToast('[ SIMULATION STARTED ]', 'success'); loadSimulations(); }
      else showToast(data.error, 'error');
    } catch { showToast('CONNECTION ERROR', 'error'); }
  });

  $('#btn-pause-sim').addEventListener('click', async () => {
    if (!selectedSimId) return;
    const res = await fetch(`/api/admin/simulation/${selectedSimId}/pause`, { method: 'POST' });
    const data = await res.json();
    if (data.success) { showToast('[ PAUSED ]', 'info'); loadSimulations(); }
    else showToast(data.error, 'error');
  });

  $('#btn-resume-sim').addEventListener('click', async () => {
    if (!selectedSimId) return;
    const res = await fetch(`/api/admin/simulation/${selectedSimId}/resume`, { method: 'POST' });
    const data = await res.json();
    if (data.success) { showToast('[ RESUMED ]', 'success'); loadSimulations(); }
    else showToast(data.error, 'error');
  });

  $('#btn-stop-sim').addEventListener('click', async () => {
    if (!selectedSimId) return;
    if (!confirm('STOP & ARCHIVE this simulation permanently? This cannot be undone.')) return;
    const res = await fetch(`/api/admin/simulation/${selectedSimId}/stop`, { method: 'POST' });
    const data = await res.json();
    if (data.success) { showToast('[ STOPPED & ARCHIVED ]', 'info'); selectedSimId = null; loadSimulations(); }
    else showToast(data.error, 'error');
  });

  // ─── Simulation Selectors ─────────────────────────────────
  function populateSimSelectors() {
    const options = allSimulations.map(s =>
      `<option value="${s.id}" ${s.id === selectedSimId ? 'selected' : ''}>${escapeHtml(s.name)} [${s.status.toUpperCase()}]</option>`
    ).join('');

    const selectors = ['#stock-sim-select', '#news-sim-select', '#lb-sim-select'];
    selectors.forEach(sel => {
      const el = $(sel);
      if (el) el.innerHTML = options || '<option value="">// NO SIMULATIONS</option>';
    });
  }

  // Selector change handlers
  ['#stock-sim-select', '#news-sim-select', '#lb-sim-select'].forEach(sel => {
    const el = $(sel);
    if (el) {
      el.addEventListener('change', () => {
        const simId = parseInt(el.value);
        if (sel === '#stock-sim-select') { selectedSimId = simId; loadStocks(); }
        if (sel === '#news-sim-select') { selectedSimId = simId; loadNews(); loadScheduledNews(); loadNewsStocks(simId); }
        if (sel === '#lb-sim-select') { loadLeaderboardForSim(simId); }
      });
    }
  });

  // Load stocks for news impact controls
  async function loadNewsStocks(simId) {
    if (!simId) { newsStocks = []; renderStockImpactControls(); return; }
    try {
      const res = await fetch(`/api/admin/simulations/${simId}/stocks`);
      newsStocks = await res.json();
      renderStockImpactControls();
    } catch {
      newsStocks = [];
      renderStockImpactControls();
    }
  }

  // ═══ STOCK MANAGEMENT ═════════════════════════════════════

  async function loadStocks() {
    const simId = selectedSimId || parseInt($('#stock-sim-select')?.value);
    if (!simId) return;

    try {
      const res = await fetch(`/api/admin/simulations/${simId}/stocks`);
      stocks = await res.json();
      renderStocksTable();
    } catch (err) {
      showToast('FAILED TO LOAD STOCKS', 'error');
    }
  }

  function renderStocksTable() {
    const tbody = $('#stocks-table-body');
    if (stocks.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><p>// NO STOCKS</p></td></tr>';
      return;
    }

    tbody.innerHTML = stocks.map(s => {
      const change = ((s.current_price - s.starting_price) / s.starting_price * 100).toFixed(2);
      const stockColor = STOCK_COLORS[s.color_index % STOCK_COLORS.length];
      const isPositive = change >= 0;
      const volBars = s.volatility === 'low' ? 1 : s.volatility === 'medium' ? 2 : 3;
      return `
        <tr>
          <td class="ticker" style="color: ${stockColor}; text-shadow: 0 0 8px ${stockColor}40;">${s.ticker}</td>
          <td style="color: var(--text-primary)">${s.name}</td>
          <td><span class="industry-tag">${s.industry}</span></td>
          <td class="price">₹${s.starting_price.toFixed(2)}</td>
          <td class="price" style="color: ${isPositive ? 'var(--price-up)' : 'var(--price-down)'}">
            ₹${s.current_price.toFixed(2)} (${isPositive ? '+' : ''}${change}%)
          </td>
          <td>
            <div class="volatility-indicator">
              ${[1,2,3].map(i => `<div class="volatility-bar ${i <= volBars ? 'active' : ''}"></div>`).join('')}
            </div>
            <span style="font-size:0.6rem;color:var(--text-muted);margin-left:0.25rem;">${s.volatility.toUpperCase()}</span>
          </td>
          <td class="actions">
            <button class="btn btn-danger btn-sm" onclick="deleteStock(${s.id})">X</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  $('#btn-add-stock').addEventListener('click', async () => {
    const simId = selectedSimId || parseInt($('#stock-sim-select')?.value);
    if (!simId) { showToast('SELECT A SIMULATION FIRST', 'error'); return; }

    const name = $('#stock-name').value.trim();
    const ticker = $('#stock-ticker').value.trim().toUpperCase();
    const industry = $('#stock-industry').value;
    const description = $('#stock-description').value.trim();
    const startingPrice = parseFloat($('#stock-price').value);
    const volatility = $('#stock-volatility').value;

    if (!name || !ticker || !industry || !startingPrice) {
      showToast('FILL ALL FIELDS (name, ticker, industry, price)', 'error');
      return;
    }

    try {
      const res = await fetch(`/api/admin/simulations/${simId}/stocks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ticker, industry, description, startingPrice, volatility })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`[ ${ticker} ADDED ]`, 'success');
        $('#stock-name').value = '';
        $('#stock-ticker').value = '';
        $('#stock-industry').value = '';
        $('#stock-price').value = '';
        $('#stock-description').value = '';
        loadStocks();
      } else showToast(data.error, 'error');
    } catch { showToast('CONNECTION ERROR', 'error'); }
  });

  window.deleteStock = async function(id) {
    if (!confirm('Delete this stock?')) return;
    try {
      const res = await fetch(`/api/admin/stocks/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) { showToast('[ REMOVED ]', 'info'); loadStocks(); }
      else showToast(data.error, 'error');
    } catch { showToast('FAILED', 'error'); }
  };

  // ═══ NEWS PUBLISHER ════════════════════════════════════════

  const analyzeBtn = $('#btn-analyze-news');
  const publishBtn = $('#btn-publish-news');
  const scheduleBtn = $('#btn-schedule-news');
  const headlineInput = $('#news-headline');
  const impactPreview = $('#impact-preview');
  const stockImpactList = $('#stock-impact-list');
  const addImpactBtn = $('#btn-add-impact');

  let publishMode = 'publish';
  let currentAnalysis = null;
  let newsStocks = []; // stocks for the selected simulation

  // ─── Render impact controls when news sim changes ──────────
  function renderStockImpactControls() {
    if (newsStocks.length === 0) {
      stockImpactList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.7rem;">// no stocks in this simulation</p>';
      addImpactBtn.style.display = 'none';
      return;
    }

    stockImpactList.innerHTML = '';
    addImpactBtn.style.display = 'inline-flex';

    // Add one empty row by default
    addImpactRow();

    // Also update suggestion checkboxes
    renderSuggestCheckboxes();
  }

  // ─── AI Suggestion Checkboxes ──────────────────────────────
  const suggestCheckboxes = $('#suggest-stock-checkboxes');
  const suggestionsOutput = $('#suggestions-output');
  const suggestionsList = $('#suggestions-list');

  function renderSuggestCheckboxes() {
    if (newsStocks.length === 0) {
      suggestCheckboxes.innerHTML = '<span style="color: var(--text-muted); font-size: 0.7rem;">// load a simulation to see stocks</span>';
      return;
    }
    suggestCheckboxes.innerHTML = newsStocks.map(s => `
      <label style="display:inline-flex; align-items:center; gap:0.3rem; padding:0.25rem 0.6rem; background:rgba(0,212,255,0.06); border:1px solid rgba(0,212,255,0.15); border-radius:4px; cursor:pointer; font-size:0.7rem; font-family:'Source Code Pro',monospace; color:var(--text-primary); transition:all 0.15s;">
        <input type="checkbox" class="suggest-stock-cb" value="${s.id}" style="accent-color:#8A5CFF;">
        <span style="color:var(--blue-bright);font-weight:600;">${s.ticker}</span> ${s.name}
      </label>
    `).join('');
  }

  // ─── Generate Suggestions Handler ──────────────────────────
  $('#btn-generate-suggestions').addEventListener('click', async () => {
    const simId = selectedSimId || parseInt($('#news-sim-select')?.value);
    if (!simId) { showToast('SELECT A SIMULATION', 'error'); return; }

    const checked = [...document.querySelectorAll('.suggest-stock-cb:checked')];
    const stockIds = checked.map(cb => parseInt(cb.value));
    if (stockIds.length === 0) { showToast('SELECT AT LEAST ONE STOCK', 'error'); return; }

    const sentiment = $('#suggest-sentiment').value;
    const strength = $('#suggest-strength').value;
    const btn = $('#btn-generate-suggestions');

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> GENERATING...';

    try {
      const res = await fetch(`/api/admin/simulations/${simId}/news/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stockIds, sentiment, strength })
      });
      const data = await res.json();

      if (data.headlines && data.headlines.length > 0) {
        suggestionsOutput.style.display = 'block';
        suggestionsList.innerHTML = data.headlines.map((h, i) => `
          <div class="suggestion-item" onclick="document.getElementById('news-headline').value=this.dataset.headline; this.style.borderColor='#8A5CFF'; this.style.background='rgba(138,92,255,0.1)';"
               data-headline="${h.replace(/"/g, '&quot;')}"
               style="padding:0.5rem 0.75rem; margin-bottom:0.35rem; background:rgba(138,92,255,0.03); border:1px solid rgba(138,92,255,0.1); border-radius:4px; cursor:pointer; font-size:0.72rem; color:var(--text-primary); font-family:'Source Code Pro',monospace; transition:all 0.15s;"
               onmouseover="this.style.borderColor='rgba(138,92,255,0.4)'"
               onmouseout="if(this.style.background!=='rgba(138, 92, 255, 0.1)')this.style.borderColor='rgba(138,92,255,0.1)'">
            <span style="color:#8A5CFF;font-weight:700;margin-right:0.3rem;">${i + 1}.</span> ${h}
          </div>
        `).join('');
      } else {
        showToast('NO SUGGESTIONS GENERATED', 'error');
      }
    } catch { showToast('GENERATION FAILED', 'error'); }

    btn.disabled = false;
    btn.innerHTML = '[ ⚡ GENERATE ]';
  });

  function addImpactRow(preset = {}) {
    const row = document.createElement('div');
    row.className = 'impact-row';
    row.style.cssText = 'display:grid; grid-template-columns: 2fr 1fr 1fr 1fr auto; gap:0.5rem; align-items:center; margin-bottom:0.5rem;';

    const stockOptions = newsStocks.map(s =>
      `<option value="${s.id}" ${preset.stockId === s.id ? 'selected' : ''}>${s.ticker} — ${s.name}</option>`
    ).join('');

    row.innerHTML = `
      <select class="form-input impact-stock" style="font-size:0.7rem; padding:0.35rem 0.5rem;">
        <option value="">— SELECT STOCK —</option>
        ${stockOptions}
      </select>
      <select class="form-input impact-sentiment" style="font-size:0.7rem; padding:0.35rem 0.5rem;">
        <option value="positive" ${preset.sentiment === 'positive' ? 'selected' : ''}>↑ POSITIVE</option>
        <option value="negative" ${preset.sentiment === 'negative' ? 'selected' : ''}>↓ NEGATIVE</option>
        <option value="neutral" ${preset.sentiment === 'neutral' ? 'selected' : ''}>→ NEUTRAL</option>
      </select>
      <select class="form-input impact-strength" style="font-size:0.7rem; padding:0.35rem 0.5rem;">
        <option value="mild" ${preset.strength === 'mild' ? 'selected' : ''}>MILD (±2%)</option>
        <option value="moderate" ${preset.strength === 'moderate' ? 'selected' : ''}>MODERATE (±5%)</option>
        <option value="strong" ${preset.strength === 'strong' ? 'selected' : ''}>STRONG (±9%)</option>
      </select>
      <input type="number" class="form-input impact-pct" placeholder="% ±" step="0.5" value="${preset.percentChange || ''}"
             style="font-size:0.7rem; padding:0.35rem 0.5rem;" title="Optional: override strength with exact % change">
      <button class="btn btn-danger btn-sm" style="padding:0.25rem 0.5rem; font-size:0.6rem;" onclick="this.parentElement.remove()">✕</button>
    `;
    stockImpactList.appendChild(row);
  }

  addImpactBtn.addEventListener('click', () => addImpactRow());

  function collectManualImpacts() {
    const rows = stockImpactList.querySelectorAll('.impact-row');
    const impacts = [];
    rows.forEach(row => {
      const stockId = parseInt(row.querySelector('.impact-stock').value);
      if (!stockId) return;

      const stock = newsStocks.find(s => s.id === stockId);
      const sentiment = row.querySelector('.impact-sentiment').value;
      const strength = row.querySelector('.impact-strength').value;
      const pctVal = parseFloat(row.querySelector('.impact-pct').value);

      const impact = {
        stockId,
        ticker: stock?.ticker || '',
        stockName: stock?.name || '',
        industry: stock?.industry || '',
        sentiment,
        strength
      };

      if (!isNaN(pctVal) && pctVal !== 0) {
        impact.percentChange = pctVal;
      }

      impacts.push(impact);
    });
    return impacts;
  }

  // ─── Mode Toggle ───────────────────────────────────────────
  $('#mode-publish').addEventListener('click', () => {
    publishMode = 'publish';
    $('#mode-publish').classList.add('active');
    $('#mode-schedule').classList.remove('active');
    $('#schedule-options').style.display = 'none';
    publishBtn.style.display = 'inline-flex';
    scheduleBtn.style.display = 'none';
  });

  $('#mode-schedule').addEventListener('click', () => {
    publishMode = 'schedule';
    $('#mode-schedule').classList.add('active');
    $('#mode-publish').classList.remove('active');
    $('#schedule-options').style.display = 'block';
    publishBtn.style.display = 'none';
    scheduleBtn.style.display = 'inline-flex';
  });

  const scheduleDay = $('#schedule-day');
  const scheduleTime = $('#schedule-time');

  function updateEffectiveDay() {
    const day = parseInt(scheduleDay.value) || 1;
    const pct = parseInt(scheduleTime.value) || 0;
    $('#effective-day-display').textContent = (day + pct / 100).toFixed(2);
    $('#schedule-time-display').textContent = pct + '%';
  }

  scheduleDay.addEventListener('input', updateEffectiveDay);
  scheduleTime.addEventListener('input', updateEffectiveDay);

  // ─── AI Analyze ────────────────────────────────────────────
  analyzeBtn.addEventListener('click', async () => {
    const simId = selectedSimId || parseInt($('#news-sim-select')?.value);
    if (!simId) { showToast('SELECT A SIMULATION', 'error'); return; }

    const headline = headlineInput.value.trim();
    if (!headline) { showToast('ENTER A HEADLINE', 'error'); return; }

    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = '<span class="spinner"></span> ANALYZING...';

    try {
      const res = await fetch(`/api/admin/simulations/${simId}/news/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headline })
      });
      const data = await res.json();
      currentAnalysis = data;

      const tagsHtml = data.impacts.map(i => {
        const arrow = i.sentiment === 'positive' ? '↑' : i.sentiment === 'negative' ? '↓' : '→';
        return `<span class="impact-tag ${i.sentiment}">${arrow} ${i.industry} — ${i.strength}</span>`;
      }).join('');

      $('#impact-tags').innerHTML = tagsHtml || '<span style="color:var(--text-muted);">// NO SPECIFIC IMPACTS DETECTED</span>';
      $('#impact-summary').textContent = data.summary || '';

      // Render reasoning blocks
      let reasoningHtml = '';
      if (data.impacts && data.impacts.length > 0) {
        data.impacts.forEach(i => {
          if (i.reasoning) {
            reasoningHtml += `<div class="reasoning-block">> ${i.industry} [${i.sentiment.toUpperCase()}/${i.strength.toUpperCase()}]\n${i.reasoning}</div>`;
          }
        });
      }
      if (data.smartInvestorAction) {
        reasoningHtml += `<div class="smart-action-block">> SMART_INVESTOR_ACTION:\n${data.smartInvestorAction}</div>`;
      }
      $('#impact-reasoning').innerHTML = reasoningHtml;

      impactPreview.classList.add('visible');

      // Auto-populate manual impact rows from AI analysis
      stockImpactList.innerHTML = '';
      if (data.impacts && data.impacts.length > 0) {
        data.impacts.forEach(ai => {
          // Find matching stocks by industry
          const matchedStocks = newsStocks.filter(s =>
            s.industry.toLowerCase() === ai.industry.toLowerCase()
          );
          if (matchedStocks.length > 0) {
            matchedStocks.forEach(ms => {
              addImpactRow({
                stockId: ms.id,
                sentiment: ai.sentiment,
                strength: ai.strength
              });
            });
          }
        });
      }
      if (stockImpactList.children.length === 0) addImpactRow();

      scheduleBtn.disabled = false;
    } catch (err) {
      showToast('ANALYSIS FAILED', 'error');
    }

    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '[ AI ANALYZE ]';
  });

  // ─── Build final impacts (merges manual + AI) ──────────────
  function buildFinalImpacts() {
    const manualImpacts = collectManualImpacts();
    if (manualImpacts.length > 0) return manualImpacts;
    if (currentAnalysis && currentAnalysis.impacts) return currentAnalysis.impacts;
    return [];
  }

  // ─── Publish Now ───────────────────────────────────────────
  publishBtn.addEventListener('click', async () => {
    const simId = selectedSimId || parseInt($('#news-sim-select')?.value);
    if (!simId) return;

    const headline = headlineInput.value.trim();
    if (!headline) { showToast('ENTER A HEADLINE', 'error'); return; }

    const impacts = buildFinalImpacts();

    publishBtn.disabled = true;
    publishBtn.innerHTML = '<span class="spinner"></span> PUBLISHING...';

    try {
      const res = await fetch(`/api/admin/simulations/${simId}/news/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headline,
          impacts,
          summary: currentAnalysis?.summary || `Admin-published: ${headline.substring(0, 60)}`,
          reasoning: currentAnalysis?.impacts?.map(i => i.reasoning).join('\n\n') || '',
          smartInvestorAction: currentAnalysis?.smartInvestorAction || ''
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast('[ HEADLINE PUBLISHED ]', 'success');
        resetNewsForm();
        loadNews();
      } else showToast(data.error, 'error');
    } catch { showToast('CONNECTION ERROR', 'error'); }

    publishBtn.disabled = false;
    publishBtn.innerHTML = '[ PUBLISH ]';
  });

  // ─── Schedule ──────────────────────────────────────────────
  scheduleBtn.addEventListener('click', async () => {
    const simId = selectedSimId || parseInt($('#news-sim-select')?.value);
    if (!simId) return;

    const headline = headlineInput.value.trim();
    if (!headline || !currentAnalysis) return;

    const day = parseInt(scheduleDay.value) || 1;
    const pct = parseInt(scheduleTime.value) || 0;
    const scheduledDay = day + pct / 100;

    scheduleBtn.disabled = true;
    scheduleBtn.innerHTML = '<span class="spinner"></span> SCHEDULING...';

    try {
      const res = await fetch(`/api/admin/simulations/${simId}/news/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headline,
          impacts: buildFinalImpacts(),
          summary: currentAnalysis?.summary || '',
          reasoning: currentAnalysis?.impacts?.map(i => i.reasoning).join('\n\n') || '',
          smartInvestorAction: currentAnalysis?.smartInvestorAction || '',
          scheduledDay
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`[ SCHEDULED DAY ${scheduledDay.toFixed(2)} ]`, 'success');
        resetNewsForm();
        loadScheduledNews();
      } else showToast(data.error, 'error');
    } catch { showToast('CONNECTION ERROR', 'error'); }

    scheduleBtn.disabled = false;
    scheduleBtn.innerHTML = '[ ADD TO QUEUE ]';
  });

  function resetNewsForm() {
    headlineInput.value = '';
    impactPreview.classList.remove('visible');
    currentAnalysis = null;
    scheduleBtn.disabled = true;
    suggestionsOutput.style.display = 'none';
    suggestionsList.innerHTML = '';
    renderStockImpactControls();
  }

  // Published News
  async function loadNews() {
    const simId = selectedSimId || parseInt($('#news-sim-select')?.value);
    if (!simId) return;
    try {
      const res = await fetch(`/api/admin/simulations/${simId}/news`);
      const news = await res.json();
      renderAdminNewsList(news);
    } catch { }
  }

  function renderAdminNewsList(newsList) {
    const container = $('#admin-news-list');
    if (newsList.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>// NO HEADLINES PUBLISHED</p></div>';
      return;
    }

    container.innerHTML = newsList.map(n => {
      const impacts = typeof n.impacts === 'string' ? JSON.parse(n.impacts) : n.impacts;
      const impactsList = impacts.impacts || impacts;
      const tagsHtml = (Array.isArray(impactsList) ? impactsList : []).map(i => {
        const arrow = i.sentiment === 'positive' ? '↑' : i.sentiment === 'negative' ? '↓' : '→';
        return `<span class="news-tag ${i.sentiment}">${arrow} ${i.industry}</span>`;
      }).join('');

      return `
        <div class="news-item">
          <span class="news-day-badge">[DAY ${typeof n.sim_day === 'number' ? n.sim_day.toFixed(1) : n.sim_day}]</span>
          <div class="news-content">
            <h4>${escapeHtml(n.headline)}</h4>
            <div class="news-tags">${tagsHtml}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // Scheduled News
  async function loadScheduledNews() {
    const simId = selectedSimId || parseInt($('#news-sim-select')?.value);
    if (!simId) return;
    try {
      const res = await fetch(`/api/admin/simulations/${simId}/news/scheduled`);
      const scheduled = await res.json();
      renderScheduledQueue(scheduled);
    } catch { }
  }

  function renderScheduledQueue(scheduledList) {
    const container = $('#scheduled-news-list');
    $('#scheduled-count').textContent = scheduledList.length;

    if (scheduledList.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>// NO SCHEDULED NEWS</p></div>';
      return;
    }

    container.innerHTML = scheduledList.map(n => {
      const impacts = typeof n.impacts === 'string' ? JSON.parse(n.impacts) : n.impacts;
      const impactsList = impacts.impacts || impacts;
      const tagsHtml = (Array.isArray(impactsList) ? impactsList : []).map(i => {
        const arrow = i.sentiment === 'positive' ? '↑' : i.sentiment === 'negative' ? '↓' : '→';
        return `<span class="news-tag ${i.sentiment}" style="font-size:0.55rem;">${arrow} ${i.industry}</span>`;
      }).join('');

      const dayNum = parseFloat(n.scheduled_day);

      return `
        <div class="scheduled-item">
          <span class="scheduled-day-badge">[DAY ${dayNum.toFixed(2)}]</span>
          <div class="scheduled-info">
            <h4>${escapeHtml(n.headline)}</h4>
            <div style="display:flex;align-items:center;gap:0.3rem;flex-wrap:wrap;margin-top:0.2rem;">
              ${tagsHtml}
            </div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="deleteScheduledNews(${n.id})">X</button>
        </div>
      `;
    }).join('');
  }

  window.deleteScheduledNews = async function(id) {
    try {
      const res = await fetch(`/api/admin/news/scheduled/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) { showToast('[ REMOVED ]', 'info'); loadScheduledNews(); }
      else showToast(data.error, 'error');
    } catch { showToast('CONNECTION ERROR', 'error'); }
  };

  // ═══ REGISTRATIONS ═════════════════════════════════════════

  async function loadRegistrations() {
    try {
      const res = await fetch('/api/admin/registrations');
      const data = await res.json();
      renderPendingList(data.pending);
      renderApprovedList(data.all || data.approved);
    } catch { showToast('FAILED TO LOAD', 'error'); }
  }

  function renderPendingList(pending) {
    const container = $('#pending-list');
    if (pending.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>// NO PENDING</p></div>';
      return;
    }
    container.innerHTML = pending.map(u => `
      <div class="reg-card">
        <div class="user-info">
          <h4>${escapeHtml(u.name)}</h4>
          <span>@${escapeHtml(u.username)} // ${escapeHtml(u.email)}</span>
        </div>
        <div class="user-actions">
          <button class="btn btn-success btn-sm" onclick="approveUser(${u.id})">[ APPROVE ]</button>
          <button class="btn btn-danger btn-sm" onclick="rejectUser(${u.id})">[ REJECT ]</button>
        </div>
      </div>
    `).join('');
  }

  function renderApprovedList(participants) {
    const container = $('#approved-list');
    // Filter to only show approved and deactivated users
    const visible = (participants || []).filter(u => u.status === 'approved' || u.status === 'deactivated');
    if (visible.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>// NO APPROVED</p></div>';
      return;
    }
    container.innerHTML = visible.map(u => {
      const isDeactivated = u.status === 'deactivated';
      return `
      <div class="reg-card" style="${isDeactivated ? 'opacity: 0.6; border-left: 3px solid var(--red-primary);' : ''}">
        <div class="user-info">
          <h4>${escapeHtml(u.name)}</h4>
          <span>@${escapeHtml(u.username)}</span>
        </div>
        <div class="user-actions">
          ${isDeactivated
            ? `<span class="status-badge stopped" style="margin-right:0.5rem"><span class="status-dot"></span>[ DEACTIVATED ]</span>
               <button class="btn btn-success btn-sm" onclick="reactivateUser(${u.id})">[ REACTIVATE ]</button>`
            : `<span class="status-badge running" style="margin-right:0.5rem"><span class="status-dot"></span>[ ACTIVE ]</span>
               <button class="btn btn-danger btn-sm" onclick="deactivateUser(${u.id})">[ DEACTIVATE ]</button>`
          }
        </div>
      </div>
    `}).join('');
  }

  window.approveUser = async function(id) {
    try {
      const res = await fetch(`/api/admin/registrations/${id}/approve`, { method: 'POST' });
      const data = await res.json();
      if (data.success) { showToast('[ APPROVED ]', 'success'); loadRegistrations(); }
    } catch { showToast('FAILED', 'error'); }
  };

  window.rejectUser = async function(id) {
    if (!confirm('Reject this registration?')) return;
    try {
      const res = await fetch(`/api/admin/registrations/${id}/reject`, { method: 'POST' });
      const data = await res.json();
      if (data.success) { showToast('[ REJECTED ]', 'info'); loadRegistrations(); }
    } catch { showToast('FAILED', 'error'); }
  };

  window.deactivateUser = async function(id) {
    if (!confirm('Deactivate this user? They will be unable to log in.')) return;
    try {
      const res = await fetch(`/api/admin/registrations/${id}/deactivate`, { method: 'POST' });
      const data = await res.json();
      if (data.success) { showToast('[ DEACTIVATED ]', 'warning'); loadRegistrations(); }
    } catch { showToast('FAILED', 'error'); }
  };

  window.reactivateUser = async function(id) {
    try {
      const res = await fetch(`/api/admin/registrations/${id}/reactivate`, { method: 'POST' });
      const data = await res.json();
      if (data.success) { showToast('[ REACTIVATED ]', 'success'); loadRegistrations(); }
    } catch { showToast('FAILED', 'error'); }
  };

  // ═══ LEADERBOARD ═══════════════════════════════════════════

  async function loadLeaderboardForSim(simId) {
    if (!simId) return;
    try {
      const res = await fetch(`/api/admin/simulations/${simId}/leaderboard`);
      const data = await res.json();
      renderLeaderboard(data);
    } catch { }
  }

  function renderLeaderboard(leaderboard) {
    const tbody = $('#admin-leaderboard-body');
    if (leaderboard.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><p>// NO PARTICIPANTS</p></td></tr>';
      return;
    }
    tbody.innerHTML = leaderboard.map(p => {
      const rankClass = p.rank <= 3 ? `rank-${p.rank}` : 'rank-other';
      return `
        <tr>
          <td><span class="rank-badge ${rankClass}">${p.rank}</span></td>
          <td>
            <strong style="color: var(--text-bright)">${escapeHtml(p.name)}</strong>
            <br><span style="font-size:0.65rem;color:var(--text-muted);">@${escapeHtml(p.username)}</span>
          </td>
          <td class="mono" style="color:var(--blue-bright)">₹${p.cash.toLocaleString('en-IN', {maximumFractionDigits:0})}</td>
          <td class="mono" style="color:var(--blue-primary)">₹${p.holdingsValue.toLocaleString('en-IN', {maximumFractionDigits:0})}</td>
          <td class="leaderboard-value">₹${p.totalValue.toLocaleString('en-IN', {maximumFractionDigits:0})}</td>
        </tr>
      `;
    }).join('');
  }

  // ═══ ARCHIVE ═══════════════════════════════════════════════

  async function loadArchive() {
    try {
      const res = await fetch('/api/admin/simulations');
      const sims = await res.json();
      const archived = sims.filter(s => s.status === 'stopped');
      renderArchiveList(archived);
    } catch { }
  }

  function renderArchiveList(archives) {
    const container = $('#archive-list');
    if (archives.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>// NO ARCHIVED SIMULATIONS</p></div>';
      return;
    }
    container.innerHTML = archives.map(s => `
      <div class="sim-card">
        <div class="sim-card-info">
          <h4>${escapeHtml(s.name)}</h4>
          <span>${s.total_days} days // stopped ${s.stopped_at ? new Date(s.stopped_at).toLocaleDateString() : '—'} ${s.report_released ? '// REPORT RELEASED' : ''}</span>
        </div>
        <div class="sim-card-actions">
          <span class="status-badge archived"><span class="status-dot"></span>[ ARCHIVED ]</span>
          ${!s.report_released ? `<button class="btn btn-primary btn-sm" onclick="releaseReport(${s.id})">[ RELEASE REPORT ]</button>` : '<span style="color:var(--blue-bright);font-size:0.65rem;">REPORT LIVE</span>'}
          <button class="btn btn-ghost btn-sm" onclick="viewArchiveReport(${s.id})">[ VIEW ]</button>
        </div>
      </div>
    `).join('');
  }

  window.releaseReport = async function(simId) {
    if (!confirm('Release AI Reasoning Report to all participants? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/admin/simulation/${simId}/release-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (data.success) { showToast('[ REPORT RELEASED ]', 'success'); loadArchive(); }
      else showToast(data.error, 'error');
    } catch { showToast('FAILED', 'error'); }
  };

  window.viewArchiveReport = async function(simId) {
    try {
      const res = await fetch(`/api/admin/simulations/${simId}/report`);
      const data = await res.json();
      renderArchiveDetail(data);
    } catch { showToast('FAILED TO LOAD', 'error'); }
  };

  function renderArchiveDetail(data) {
    const detail = $('#archive-detail');
    detail.style.display = 'block';
    $('#archive-detail-title').textContent = `ARCHIVE: ${data.simulation.name}`;

    let html = `<div style="margin-bottom:1rem;">
      <span style="font-size:0.7rem;color:var(--text-muted);">${data.simulation.total_days} days // ₹${Number(data.simulation.starting_cash).toLocaleString()} cash // ${data.leaderboard.length} participants</span>
    </div>`;

    // Leaderboard
    html += '<h4 style="font-size:0.75rem;color:var(--blue-primary);margin:1rem 0 0.5rem;letter-spacing:0.1em;">FINAL LEADERBOARD</h4>';
    html += data.leaderboard.map((p,i) => `<div style="padding:0.3rem 0;color:${i < 3 ? 'var(--blue-bright)' : 'var(--text-muted)'};font-size:0.75rem;">#${p.rank} ${escapeHtml(p.name)} — ₹${p.totalValue.toLocaleString('en-IN',{maximumFractionDigits:0})}</div>`).join('');

    // News timeline with reasoning
    html += '<h4 style="font-size:0.75rem;color:var(--blue-primary);margin:1rem 0 0.5rem;letter-spacing:0.1em;">NEWS & AI REASONING LOG</h4>';
    data.news.forEach(n => {
      const impacts = n.impacts?.impacts || n.impacts || [];
      html += `<div class="report-entry">
        <div class="report-day-tag">[DAY ${typeof n.sim_day === 'number' ? n.sim_day.toFixed(1) : n.sim_day}]</div>
        <div class="report-headline">${escapeHtml(n.headline)}</div>
        <div style="display:flex;gap:0.2rem;flex-wrap:wrap;margin:0.3rem 0;">
          ${(Array.isArray(impacts) ? impacts : []).map(i => `<span class="impact-tag ${i.sentiment}" style="font-size:0.6rem;">${i.sentiment === 'positive' ? '↑' : '↓'} ${i.industry} [${i.strength}]</span>`).join('')}
        </div>
        ${n.reasoning ? `<div class="report-reasoning">${typeof n.reasoning === 'object' ? (n.reasoning.impactDetails || []).map(i => `> ${i.industry}: ${i.reasoning || ''}`).join('\n') : n.reasoning}</div>` : ''}
        ${n.reasoning?.smartInvestorAction ? `<div class="report-smart-action">> OPTIMAL ACTION:\n${n.reasoning.smartInvestorAction}</div>` : ''}
      </div>`;
    });

    $('#archive-detail-content').innerHTML = html;
  }

  // ═══ SOCKET.IO ═════════════════════════════════════════════

  socket.on('simulation:state', (state) => {
    updateSimUI(state);
  });

  socket.on('prices:update', (updates) => {
    updates.forEach(u => {
      const idx = stocks.findIndex(s => s.id === u.id);
      if (idx >= 0) stocks[idx].current_price = u.price;
    });
    if ($('#panel-stocks').classList.contains('active')) renderStocksTable();
  });

  socket.on('news:published', (newsItem) => {
    showToast(`[ NEWS ] ${newsItem.headline.substring(0, 45)}...`, 'info');
    if ($('#panel-news').classList.contains('active')) {
      loadNews();
      loadScheduledNews();
    }
  });

  socket.on('leaderboard:update', (leaderboard) => {
    if ($('#panel-leaderboard').classList.contains('active')) renderLeaderboard(leaderboard);
  });

  socket.on('simulation:stopped', () => {
    showToast('[ SIMULATION ARCHIVED ]', 'info');
    loadSimulations();
  });

  // ═══ UTILITIES ═════════════════════════════════════════════

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ═══ INITIAL LOAD ══════════════════════════════════════════

  loadSimulations();
  loadRegistrations();

  fetch('/api/admin/simulation/state')
    .then(r => r.json())
    .then(state => {
      updateSimUI(state);
      if (state.id) selectedSimId = state.id;
    })
    .catch(() => {});
})();
