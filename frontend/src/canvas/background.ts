// ── Background: animated grid + floating dust particles ─────────────────────

import { C } from '../core/theme.ts';

interface DustParticle {
  x: number; y: number;
  vx: number; vy: number;
  opacity: number;
  size: number;
}

const DUST_COUNT = 60;
const dust: DustParticle[] = [];

// Offscreen canvas caching the static dot grid (re-rendered only on resize)
let bgDotCanvas: HTMLCanvasElement | null = null;

export function initBackground(w: number, h: number) {
  dust.length = 0;
  for (let i = 0; i < DUST_COUNT; i++) {
    dust.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.2,
      vy: (Math.random() - 0.5) * 0.2,
      opacity: 0.02 + Math.random() * 0.06,
      size: 1 + Math.random() * 2,
    });
  }

  // Pre-render the static dot grid once so drawBackground can blit it with
  // a single drawImage() instead of ~2000 arc() calls per frame.
  bgDotCanvas = document.createElement('canvas');
  bgDotCanvas.width  = w;
  bgDotCanvas.height = h;
  const bCtx = bgDotCanvas.getContext('2d')!;
  bCtx.fillStyle = C.bg;
  bCtx.fillRect(0, 0, w, h);
  const gridSize = 32;
  bCtx.fillStyle = 'rgba(255,255,255,0.06)';
  bCtx.beginPath();
  for (let gx = 0; gx < w; gx += gridSize) {
    for (let gy = 92; gy < h; gy += gridSize) {
      bCtx.moveTo(gx + 0.8, gy); // moveTo avoids connecting line between circles
      bCtx.arc(gx, gy, 0.8, 0, Math.PI * 2);
    }
  }
  bCtx.fill();
}

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  dt: number,
  time: number
) {
  // Blit pre-rendered dot grid (one drawImage vs ~2000 arc() calls per frame)
  if (bgDotCanvas) {
    ctx.drawImage(bgDotCanvas, 0, 0);
  } else {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
  }

  // ── Dust / stars ──
  for (const d of dust) {
    d.x += d.vx * dt * 0.06;
    d.y += d.vy * dt * 0.06;
    if (d.x < 0) d.x += w - 280;
    if (d.x > w - 280) d.x -= w - 280;
    if (d.y < 92) d.y += h - 92;
    if (d.y > h) d.y = 92;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(148,163,184,${d.opacity})`;
    ctx.fill();
  }
}
