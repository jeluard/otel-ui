// ── Camera — pan & zoom state for the main canvas ────────────────────────────

export class Camera {
  x     = 0;      // world-space translation (pixels before scaling)
  y     = 0;
  scale = 1;      // zoom factor

  private readonly MIN_SCALE = 0.08;
  private readonly MAX_SCALE = 4.0;

  /** Apply the camera transform to ctx. Call ctx.save() before, ctx.restore() after. */
  applyTo(ctx: CanvasRenderingContext2D) {
    ctx.translate(this.x, this.y);
    ctx.scale(this.scale, this.scale);
  }

  /** Convert a screen-space point to world space. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.x) / this.scale,
      y: (sy - this.y) / this.scale,
    };
  }

  /** Zoom by `factor` keeping screen point (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number) {
    const newScale = Math.max(this.MIN_SCALE, Math.min(this.MAX_SCALE, this.scale * factor));
    const actualFactor = newScale / this.scale;
    this.x = sx - (sx - this.x) * actualFactor;
    this.y = sy - (sy - this.y) * actualFactor;
    this.scale = newScale;
  }

  /** Pan by (dx, dy) screen pixels. */
  pan(dx: number, dy: number) {
    this.x += dx;
    this.y += dy;
  }

  /** Reset to identity so all nodes centre on screen. */
  reset() {
    this.x = 0;
    this.y = 0;
    this.scale = 1;
  }
}
