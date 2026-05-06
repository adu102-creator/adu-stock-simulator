// ═══════════════════════════════════════════════════════════════
// HOLOGRAPHIC UI ENGINE — Zero-Gravity Trading Desk
// Parallax · Tilt · Particles · Animated Numbers · Depth Focus
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── Configuration ─────────────────────────────────────────
  const PARALLAX_STRENGTH = 0.012;
  const TILT_MAX_DEG = 4;
  const FLOAT_AMPLITUDE = 6; // px
  const PARTICLE_COUNT = 60;
  const NUMBER_ANIM_DURATION = 600; // ms

  let mouseX = 0.5, mouseY = 0.5; // Normalized 0-1

  // ═══ 1. CURSOR PARALLAX ════════════════════════════════════
  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX / window.innerWidth;
    mouseY = e.clientY / window.innerHeight;
    applyParallax();
    applyTilt(e);
  });

  function applyParallax() {
    const dx = (mouseX - 0.5) * 2; // -1 to 1
    const dy = (mouseY - 0.5) * 2;

    document.querySelectorAll('[data-depth]').forEach(el => {
      const depth = parseFloat(el.dataset.depth) || 1;
      const moveX = dx * PARALLAX_STRENGTH * depth * 100;
      const moveY = dy * PARALLAX_STRENGTH * depth * 100;
      el.style.transform = `translate(${moveX}px, ${moveY}px)`;
    });
  }

  // ═══ 2. PANEL TILT ON HOVER ════════════════════════════════
  function applyTilt(e) {
    document.querySelectorAll('.holo-panel.tiltable').forEach(panel => {
      const rect = panel.getBoundingClientRect();
      const isHovered =
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom;

      if (isHovered) {
        const cx = (e.clientX - rect.left) / rect.width - 0.5;
        const cy = (e.clientY - rect.top) / rect.height - 0.5;
        const rotateY = cx * TILT_MAX_DEG;
        const rotateX = -cy * TILT_MAX_DEG;
        panel.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.01)`;
      } else {
        panel.style.transform = '';
      }
    });
  }

  // ═══ 3. AMBIENT PARTICLE SYSTEM ════════════════════════════
  function initParticles() {
    const canvas = document.createElement('canvas');
    canvas.id = 'holo-particles';
    Object.assign(canvas.style, {
      position: 'fixed',
      top: '0', left: '0',
      width: '100vw', height: '100vh',
      zIndex: '0',
      pointerEvents: 'none',
      opacity: '0.4',
    });

    // Insert after matrix rain canvas if it exists, otherwise as first child
    const matrixCanvas = document.getElementById('matrix-rain');
    if (matrixCanvas && matrixCanvas.nextSibling) {
      document.body.insertBefore(canvas, matrixCanvas.nextSibling);
    } else {
      document.body.insertBefore(canvas, document.body.firstChild);
    }

    const ctx = canvas.getContext('2d');
    let W, H;
    const particles = [];

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    class Particle {
      constructor() { this.reset(); }
      reset() {
        this.x = Math.random() * W;
        this.y = Math.random() * H;
        this.size = 0.5 + Math.random() * 1.5;
        this.speedX = (Math.random() - 0.5) * 0.3;
        this.speedY = -0.1 - Math.random() * 0.3;
        this.alpha = 0.1 + Math.random() * 0.4;
        this.hue = Math.random() < 0.7 ? 195 : (Math.random() < 0.5 ? 160 : 260);
        this.pulseSpeed = 0.005 + Math.random() * 0.01;
        this.pulsePhase = Math.random() * Math.PI * 2;
      }
      update(t) {
        this.x += this.speedX + (mouseX - 0.5) * 0.2;
        this.y += this.speedY;
        this.pulsePhase += this.pulseSpeed;
        const pulse = Math.sin(this.pulsePhase) * 0.3 + 0.7;
        this.currentAlpha = this.alpha * pulse;

        if (this.y < -10 || this.x < -10 || this.x > W + 10) this.reset();
        if (this.y < -10) { this.y = H + 10; this.x = Math.random() * W; }
      }
      draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${this.hue}, 100%, 70%, ${this.currentAlpha})`;
        ctx.fill();

        // Glow
        if (this.size > 1) {
          ctx.beginPath();
          ctx.arc(this.x, this.y, this.size * 3, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${this.hue}, 100%, 60%, ${this.currentAlpha * 0.15})`;
          ctx.fill();
        }
      }
    }

    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(new Particle());
    }

    function animate() {
      ctx.clearRect(0, 0, W, H);
      const t = performance.now();
      particles.forEach(p => { p.update(t); p.draw(ctx); });

      // Occasional light streak
      if (Math.random() < 0.003) {
        const sx = Math.random() * W;
        const sy = Math.random() * H * 0.3;
        const len = 80 + Math.random() * 150;
        const grad = ctx.createLinearGradient(sx, sy, sx + len, sy + len * 0.3);
        grad.addColorStop(0, 'rgba(0, 212, 255, 0)');
        grad.addColorStop(0.5, 'rgba(0, 212, 255, 0.15)');
        grad.addColorStop(1, 'rgba(0, 212, 255, 0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + len, sy + len * 0.3);
        ctx.stroke();
      }

      requestAnimationFrame(animate);
    }
    animate();
  }

  // ═══ 4. ANIMATED NUMBER TRANSITIONS ════════════════════════
  const animatedNumbers = new Map();

  window.animateNumber = function (el, newValue, prefix = '', suffix = '', decimals = 0) {
    if (!el) return;
    const key = el.id || el;
    const current = animatedNumbers.get(key) || 0;
    const target = parseFloat(newValue) || 0;

    if (Math.abs(current - target) < 0.01) return;

    const startTime = performance.now();
    const startValue = current;

    function tick(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / NUMBER_ANIM_DURATION, 1);
      // Ease out cubic
      const ease = 1 - Math.pow(1 - progress, 3);
      const value = startValue + (target - startValue) * ease;

      animatedNumbers.set(key, value);

      if (typeof el === 'string') el = document.getElementById(el);
      if (el) {
        el.textContent = prefix + value.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + suffix;

        // Color feedback
        if (target > startValue) {
          el.style.textShadow = `0 0 12px rgba(0, 212, 255, ${0.6 * (1 - progress)})`;
        } else if (target < startValue) {
          el.style.textShadow = `0 0 12px rgba(138, 92, 255, ${0.6 * (1 - progress)})`;
        }
      }

      if (progress < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  };

  // ═══ 5. PANEL REVEAL ANIMATIONS ════════════════════════════
  function setupPanelReveals() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('holo-revealed');
        }
      });
    }, { threshold: 0.1 });

    document.querySelectorAll('.holo-panel').forEach(panel => {
      observer.observe(panel);
    });
  }

  // ═══ 6. FLOATING ANIMATIONS ════════════════════════════════
  function setupFloatingPanels() {
    document.querySelectorAll('.holo-panel').forEach((panel, i) => {
      const delay = i * 0.3;
      const duration = 4 + Math.random() * 3;
      panel.style.animationDelay = `${delay}s`;
      panel.style.animationDuration = `${duration}s`;
    });
  }

  // ═══ 7. SCANLINE SWEEP ═════════════════════════════════════
  function createScanlineSweep() {
    const sweep = document.createElement('div');
    sweep.className = 'holo-scanline-sweep';
    document.body.appendChild(sweep);
  }

  // ═══ 8. HOLOGRAPHIC GRID OVERLAY ═══════════════════════════
  function createHoloGrid() {
    const grid = document.createElement('div');
    grid.className = 'holo-grid-overlay';
    document.body.appendChild(grid);
  }

  // ═══ INIT ══════════════════════════════════════════════════
  // Only init on dashboard pages (not auth)
  if (!document.querySelector('.auth-page')) {
    initParticles();
    setupFloatingPanels();
    setupPanelReveals();
    createScanlineSweep();
    createHoloGrid();

    // Add perspective wrapper class to body
    document.body.classList.add('holo-environment');
  }
})();
