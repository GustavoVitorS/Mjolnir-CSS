(() => {
  'use strict';

  const scene = document.getElementById('storm-scene');
  const canvas = document.getElementById('lightning');
  const flashLayer = document.getElementById('cloud-flash');
  const hammer = document.getElementById('hammer');
  const hammerHitbox = document.getElementById('hammer-hitbox');

  if (!scene || !canvas || !flashLayer || !hammer || !hammerHitbox) return;

  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
  if (!ctx) return;

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;
  const lowPower = coarsePointer || cores <= 4 || memory <= 4;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const random = (min, max) => min + Math.random() * (max - min);

  class RNG {
    constructor(seed) {
      this.seed = seed >>> 0;
    }

    next() {
      let t = (this.seed += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    range(min, max) {
      return min + (max - min) * this.next();
    }
  }

  let cssWidth = 1;
  let cssHeight = 1;
  let dpr = 1;
  let resizeTimer = 0;

  function resizeCanvas() {
    cssWidth = Math.max(1, window.innerWidth);
    cssHeight = Math.max(1, window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, lowPower ? 1.25 : 1.65);

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resizeCanvas();

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resizeCanvas, 120);
  }, { passive: true });

  // Pointer parallax. Only CSS variables change; the 3D geometry stays on the compositor.
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let pointerActive = false;

  function setPointerTarget(clientX, clientY) {
    const nx = clamp((clientX / cssWidth - 0.5) * 2, -1, 1);
    const ny = clamp((clientY / cssHeight - 0.5) * 2, -1, 1);
    targetX = nx;
    targetY = ny;
    pointerActive = true;
  }

  if (!reducedMotion) {
    scene.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch') return;
      setPointerTarget(event.clientX, event.clientY);
    }, { passive: true });

    scene.addEventListener('pointerleave', () => {
      pointerActive = false;
      targetX = 0;
      targetY = 0;
    }, { passive: true });
  }

  // Lightning model adapted from the Storm project's current V2 approach:
  // seeded midpoint displacement, small branches, layered glow and a brief return stroke.
  let activeBolts = [];
  let flash = 0;
  let nextStrikeAt = performance.now() + random(900, 1800);
  let lastLightningDraw = 0;
  let lastFrame = performance.now();
  let impactTimer = 0;

  function buildBolt(startX, startY, endX, endY, seed, roughness = 1) {
    const rng = new RNG(seed);
    let points = [
      { x: startX, y: startY },
      { x: endX, y: endY }
    ];

    let displacement = cssWidth * 0.07 * roughness;
    const passes = lowPower ? 5 : 6;

    for (let pass = 0; pass < passes; pass += 1) {
      const refined = [points[0]];
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        refined.push({
          x: (a.x + b.x) * 0.5 + rng.range(-displacement, displacement),
          y: (a.y + b.y) * 0.5 + rng.range(-displacement * 0.14, displacement * 0.14)
        }, b);
      }
      points = refined;
      displacement *= 0.48;
    }

    const branches = [];
    const branchCount = lowPower ? (rng.next() < 0.42 ? 1 : 0) : (rng.next() < 0.58 ? 2 : 1);

    for (let b = 0; b < branchCount; b += 1) {
      const index = Math.floor(rng.range(points.length * 0.26, points.length * 0.7));
      const origin = points[index];
      const branch = [{ x: origin.x, y: origin.y }];
      let x = origin.x;
      let y = origin.y;
      const segments = Math.round(rng.range(3, lowPower ? 5 : 7));

      for (let i = 0; i < segments; i += 1) {
        x += rng.range(-cssWidth * 0.038, cssWidth * 0.038);
        y += rng.range(cssHeight * 0.028, cssHeight * 0.068);
        branch.push({ x, y });
      }
      branches.push(branch);
    }

    return { points, branches };
  }

  function setFlashPosition(x, y) {
    const xNorm = clamp(x / cssWidth, 0, 1);
    const yNorm = clamp(y / cssHeight, 0, 1);
    document.documentElement.style.setProperty('--flash-x', `${(xNorm * 100).toFixed(2)}%`);
    document.documentElement.style.setProperty('--flash-y', `${(yNorm * 100).toFixed(2)}%`);
  }

  function addStrike({ startX, startY, endX, endY, strength = 1, targeted = false }) {
    const seed = (Math.random() * 0xFFFFFFFF) >>> 0;

    activeBolts.push({
      bolt: buildBolt(startX, startY, endX, endY, seed, targeted ? 0.72 : 1),
      age: 0,
      life: random(0.19, 0.31),
      strength: strength * random(0.88, 1.08),
      returnStrokeAt: random(0.078, 0.122),
      targeted
    });

    if (activeBolts.length > (lowPower ? 2 : 4)) activeBolts.shift();

    flash = Math.max(flash, 0.82 * strength);
    setFlashPosition(endX, Math.min(endY, cssHeight * 0.38));
  }

  function triggerBackgroundStrike() {
    const startX = random(cssWidth * 0.14, cssWidth * 0.86);
    const startY = random(-cssHeight * 0.04, cssHeight * 0.05);
    const endX = startX + random(-cssWidth * 0.11, cssWidth * 0.11);
    const endY = random(cssHeight * 0.5, cssHeight * 0.9);

    addStrike({ startX, startY, endX, endY, strength: random(0.68, 1.02) });

    if (!lowPower && Math.random() < 0.27) {
      window.setTimeout(() => {
        if (document.hidden) return;
        addStrike({
          startX: clamp(startX + random(-cssWidth * 0.12, cssWidth * 0.12), 0, cssWidth),
          startY: random(-cssHeight * 0.03, cssHeight * 0.05),
          endX: clamp(endX + random(-cssWidth * 0.11, cssWidth * 0.11), 0, cssWidth),
          endY: random(cssHeight * 0.46, cssHeight * 0.78),
          strength: 0.68
        });
      }, random(95, 190));
    }
  }

  function triggerHammerStrike() {
    const rect = hammer.getBoundingClientRect();
    const endX = rect.left + rect.width * 0.5;
    const endY = rect.top + rect.height * 0.21;
    const startX = clamp(endX + random(-cssWidth * 0.08, cssWidth * 0.08), cssWidth * 0.08, cssWidth * 0.92);

    addStrike({
      startX,
      startY: -cssHeight * 0.03,
      endX,
      endY,
      strength: 1.2,
      targeted: true
    });

    window.setTimeout(() => {
      if (document.hidden) return;
      addStrike({
        startX: clamp(startX + random(-cssWidth * 0.06, cssWidth * 0.06), 0, cssWidth),
        startY: 0,
        endX: endX + random(-8, 8),
        endY: endY + random(-5, 7),
        strength: 0.82,
        targeted: true
      });
    }, 92);

    hammer.classList.remove('is-struck');
    void hammer.offsetWidth;
    hammer.classList.add('is-struck');
    clearTimeout(impactTimer);
    impactTimer = window.setTimeout(() => hammer.classList.remove('is-struck'), 460);
  }

  hammerHitbox.addEventListener('click', triggerHammerStrike);

  function drawPath(points) {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  function renderLightning(dt) {
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    flash *= Math.pow(0.026, dt);
    flashLayer.style.opacity = String(clamp(flash, 0, 0.9));

    for (let i = activeBolts.length - 1; i >= 0; i -= 1) {
      const item = activeBolts[i];
      item.age += dt;

      if (item.age > item.life) {
        activeBolts.splice(i, 1);
        continue;
      }

      const returnStroke = Math.abs(item.age - item.returnStrokeAt) < 0.031;
      const fade = clamp(1 - item.age / item.life, 0, 1);
      const intensity = clamp((returnStroke ? 1.18 : fade) * item.strength, 0, 1.35);

      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // Wide blue energy halo.
      ctx.shadowBlur = item.targeted ? 25 : 18;
      ctx.shadowColor = 'rgba(67, 171, 255, 0.95)';
      ctx.strokeStyle = `rgba(61, 153, 255, ${0.29 * intensity})`;
      ctx.lineWidth = item.targeted ? 6.4 : 5.2;
      drawPath(item.bolt.points);

      // Brighter middle channel.
      ctx.shadowBlur = 8;
      ctx.strokeStyle = `rgba(177, 227, 255, ${0.72 * intensity})`;
      ctx.lineWidth = item.targeted ? 2.45 : 2.05;
      drawPath(item.bolt.points);

      // Hot white core.
      ctx.shadowBlur = 2;
      ctx.strokeStyle = `rgba(245, 252, 255, ${0.98 * intensity})`;
      ctx.lineWidth = item.targeted ? 0.92 : 0.78;
      drawPath(item.bolt.points);

      ctx.strokeStyle = `rgba(124, 205, 255, ${0.58 * intensity})`;
      ctx.lineWidth = 0.7;
      for (const branch of item.bolt.branches) drawPath(branch);

      ctx.restore();
    }

    if (activeBolts.length === 0 && flash < 0.012) {
      flashLayer.style.opacity = '0';
      ctx.clearRect(0, 0, cssWidth, cssHeight);
    }
  }

  function scheduleNextStrike(now) {
    const min = reducedMotion ? 4200 : (lowPower ? 2600 : 1900);
    const max = reducedMotion ? 7200 : (lowPower ? 4700 : 3900);
    nextStrikeAt = now + random(min, max);
  }

  function updateHammerParallax() {
    if (reducedMotion) return;

    const ease = pointerActive ? 0.08 : 0.045;
    currentX += (targetX - currentX) * ease;
    currentY += (targetY - currentY) * ease;

    document.documentElement.style.setProperty('--pointer-x', currentX.toFixed(3));
    document.documentElement.style.setProperty('--pointer-y', currentY.toFixed(3));
  }

  function frame(now) {
    if (document.hidden) {
      lastFrame = now;
      requestAnimationFrame(frame);
      return;
    }

    const dt = Math.min(0.08, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;

    updateHammerParallax();

    if (now >= nextStrikeAt) {
      triggerBackgroundStrike();
      scheduleNextStrike(now);
    }

    const lightningFps = lowPower ? 24 : 30;
    if ((activeBolts.length > 0 || flash > 0.012) && now - lastLightningDraw >= 1000 / lightningFps) {
      renderLightning((now - lastLightningDraw) / 1000 || dt);
      lastLightningDraw = now;
    }

    requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastFrame = performance.now();
      scheduleNextStrike(lastFrame);
    }
  });

  scheduleNextStrike(performance.now());
  requestAnimationFrame(frame);
})();
