// ═══════════════════════════════════════════════════════════════
// MATRIX DIGITAL RAIN — Dense Vertical Columns (Electric Blue)
// Full-screen cascading character streams
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── Character Set ─────────────────────────────────────────
  const CHARS =
    'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン' +
    'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' +
    '∑∏∫√∂∇≈≠≤≥±×÷¢£¥€$₹@#%&';

  const isAuthPage = !!document.querySelector('.auth-page');

  // ─── Config ────────────────────────────────────────────────
  const FONT_SIZE     = isAuthPage ? 15 : 13;
  const OPACITY       = isAuthPage ? 1.0 : 0.3;
  const FADE_SPEED    = isAuthPage ? 0.04 : 0.07;
  const FLICKER_RATE  = 0.03;

  // ─── Canvas ────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.id = 'matrix-rain';
  Object.assign(canvas.style, {
    position: 'fixed',
    top: '0', left: '0',
    width: '100vw', height: '100vh',
    zIndex: '0',
    pointerEvents: 'none',
    opacity: String(OPACITY),
  });
  document.body.insertBefore(canvas, document.body.firstChild);

  const ctx = canvas.getContext('2d');
  let W, H, cols;
  let drops;

  function randChar() {
    return CHARS[Math.floor(Math.random() * CHARS.length)];
  }

  // ─── Resize ────────────────────────────────────────────────
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const newCols = Math.ceil(W / FONT_SIZE);
    const newDrops = new Float32Array(newCols);
    for (let i = 0; i < newCols; i++) {
      newDrops[i] = drops && i < drops.length
        ? drops[i]
        : -Math.random() * (H / FONT_SIZE);
    }
    drops = newDrops;
    cols = newCols;
  }

  // ─── Main Loop ─────────────────────────────────────────────
  function draw() {
    ctx.fillStyle = `rgba(0, 0, 0, ${FADE_SPEED})`;
    ctx.fillRect(0, 0, W, H);

    ctx.font = `bold ${FONT_SIZE}px "MS Gothic", "Yu Gothic", "Source Code Pro", monospace`;
    ctx.textBaseline = 'top';

    const maxRow = Math.ceil(H / FONT_SIZE);

    for (let i = 0; i < cols; i++) {
      const x = i * FONT_SIZE;
      const row = Math.floor(drops[i]);
      const y = row * FONT_SIZE;

      // ── HEAD: bright white with blue glow ──
      ctx.shadowColor = 'rgba(100, 200, 255, 0.9)';
      ctx.shadowBlur  = 20;
      ctx.fillStyle   = '#ffffff';
      ctx.fillText(randChar(), x, y);

      // Second pass: cyan tinted glow
      ctx.shadowColor = 'rgba(0, 170, 255, 0.9)';
      ctx.shadowBlur  = 12;
      ctx.fillStyle   = 'rgba(180, 230, 255, 0.9)';
      ctx.fillText(randChar(), x, y);

      ctx.shadowBlur = 0;

      // ── NEAR-HEAD: bright blue trail chars ──
      for (let t = 1; t <= 2; t++) {
        const ty = (row - t) * FONT_SIZE;
        if (ty >= 0 && ty < H) {
          ctx.fillStyle = t === 1
            ? 'rgba(0, 180, 255, 0.85)'   // bright cyan-blue
            : 'rgba(0, 140, 255, 0.7)';    // medium blue
          ctx.fillText(randChar(), x, ty);
        }
      }

      // ── RANDOM FLICKER ──
      if (Math.random() < FLICKER_RATE) {
        const flickerRow = Math.floor(Math.random() * maxRow);
        const fy = flickerRow * FONT_SIZE;
        const blue = 150 + Math.floor(Math.random() * 105);
        const green = 60 + Math.floor(Math.random() * 80);
        ctx.fillStyle = `rgba(0, ${green}, ${blue}, ${0.3 + Math.random() * 0.3})`;
        ctx.fillText(randChar(), x, fy);
      }

      // ── Advance drop ──
      drops[i] += 0.4 + Math.random() * 0.5;

      // ── Reset when off screen ──
      if (row > maxRow) {
        if (Math.random() > 0.025) {
          drops[i] = -(Math.random() * 15);
        }
      }
    }

    requestAnimationFrame(draw);
  }

  // ─── Visibility: pause when hidden ─────────────────────────
  let paused = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      paused = true;
    } else if (paused) {
      paused = false;
      requestAnimationFrame(draw);
    }
  });

  const _draw = draw;
  draw = function () {
    if (paused) return;
    _draw();
  };

  // ─── Init ──────────────────────────────────────────────────
  window.addEventListener('resize', resize);
  resize();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  requestAnimationFrame(draw);

  window.matrixRain = {
    pause()  { paused = true; },
    resume() { paused = false; requestAnimationFrame(draw); },
    setOpacity(v) { canvas.style.opacity = v; },
  };
})();
