/**
 * Dynamic resolution: watches frame times and scales the render resolution
 * down when the GPU cannot keep up, and back up when there is headroom.
 * Changes are rate-limited so the picture does not visibly pump.
 */
export class FrameGovernor {
  /** Multiplier applied to the quality preset's pixel ratio. */
  scale = 1;
  private sum = 0;
  private count = 0;
  private cooldown = 0;

  constructor(
    private readonly minScale = 0.55,
    /** Frame time above which resolution drops (default about 50 fps). */
    private readonly slowMs = 20,
    /** Frame time below which resolution may rise again (about 58 fps). */
    private readonly fastMs = 17.2,
  ) {}

  /** Feed one frame's duration in seconds; returns true when `scale` changed. */
  sample(dt: number): boolean {
    // Ignore stalls from tab switches or chunk builds; they are not steady GPU load.
    if (dt > 0.25) return false;
    this.sum += dt;
    this.count++;
    this.cooldown -= dt;
    if (this.count < 40 || this.cooldown > 0) return false;
    const avgMs = (this.sum / this.count) * 1000;
    this.sum = 0;
    this.count = 0;
    let next = this.scale;
    if (avgMs > this.slowMs) next = Math.max(this.minScale, this.scale - (avgMs > 33 ? 0.15 : 0.08));
    else if (avgMs < this.fastMs) next = Math.min(1, this.scale + 0.05);
    if (Math.abs(next - this.scale) < 1e-3) return false;
    this.scale = next;
    this.cooldown = 1.5;
    return true;
  }

  reset(): void {
    this.scale = 1;
    this.sum = 0;
    this.count = 0;
    this.cooldown = 0;
  }
}
