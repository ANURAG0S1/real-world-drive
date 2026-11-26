/**
 * Synthesised engine: two detuned oscillators through a low-pass filter whose
 * pitch and brightness follow RPM and throttle, plus filtered noise for tyre
 * and wind. No audio files needed. Browsers require a user gesture to start.
 */
export class EngineAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private oscA: OscillatorNode | null = null;
  private oscB: OscillatorNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private noiseGain: GainNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;
  private skidGain: GainNode | null = null;
  private squeal: OscillatorNode | null = null;
  private squealGain: GainNode | null = null;
  private firingPerRev = 4;
  private duckUntil = 0;
  muted = false;

  /** Match the engine note to a vehicle: pulses per revolution = cylinders / 2. */
  configure(firingPerRev: number): void {
    this.firingPerRev = firingPerRev;
  }

  /** Gear change: a brief torque cut (volume dip) and a mechanical clunk. */
  shift(): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineGain || !this.master || this.muted) return;
    const t = ctx.currentTime;
    this.duckUntil = t + 0.14;
    const thunk = ctx.createOscillator();
    thunk.type = 'triangle';
    thunk.frequency.setValueAtTime(140, t);
    thunk.frequency.exponentialRampToValueAtTime(55, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    thunk.connect(g).connect(this.master);
    thunk.start(t);
    thunk.stop(t + 0.12);
  }

  /** A dull body thump when the car clips a pedestrian; louder at speed. */
  bump(kmh: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.5, 0.12 + kmh / 120), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  /** Safe to call repeatedly; only the first call (inside a user gesture) creates the graph. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 600;
      filter.Q.value = 4;
      const engineGain = ctx.createGain();
      engineGain.gain.value = 0.2;
      filter.connect(engineGain).connect(master);

      const oscA = ctx.createOscillator();
      oscA.type = 'sawtooth';
      const oscB = ctx.createOscillator();
      oscB.type = 'square';
      const bGain = ctx.createGain();
      bGain.gain.value = 0.45;
      oscA.connect(filter);
      oscB.connect(bGain).connect(filter);
      oscA.start();
      oscB.start();

      // Shared looping noise buffer for road and skid sounds.
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      noise.loop = true;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.value = 400;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0;
      noise.connect(noiseFilter).connect(noiseGain).connect(master);
      const skidFilter = ctx.createBiquadFilter();
      skidFilter.type = 'bandpass';
      skidFilter.frequency.value = 1400;
      skidFilter.Q.value = 3;
      const skidGain = ctx.createGain();
      skidGain.gain.value = 0;
      noise.connect(skidFilter).connect(skidGain).connect(master);
      noise.start();

      // Brake squeal: a quiet high sine that only sounds when braking at low speed.
      const squeal = ctx.createOscillator();
      squeal.type = 'sine';
      squeal.frequency.value = 2900;
      const squealGain = ctx.createGain();
      squealGain.gain.value = 0;
      squeal.connect(squealGain).connect(master);
      squeal.start();

      Object.assign(this, { ctx, master, oscA, oscB, filter, engineGain, noiseGain, noiseFilter, skidGain, squeal, squealGain });
    } catch (err) {
      console.warn('[audio] could not start', err);
    }
  }

  update(rpm: number, throttle: number, speedKmh: number, slip: number, braking: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.oscA || !this.oscB || !this.filter || !this.engineGain || !this.noiseGain || !this.noiseFilter || !this.skidGain || !this.master) return;
    const t = ctx.currentTime;
    // Four-stroke firing frequency: rpm / 60 * cylinders / 2.
    const f = (rpm / 60) * this.firingPerRev;
    this.oscA.frequency.setTargetAtTime(f, t, 0.03);
    this.oscB.frequency.setTargetAtTime(f * 0.5 * 1.004, t, 0.03);
    this.filter.frequency.setTargetAtTime(350 + rpm * 0.25 + throttle * 900, t, 0.05);
    const ducking = t < this.duckUntil;
    this.engineGain.gain.setTargetAtTime(ducking ? 0.03 : 0.12 + throttle * 0.14, t, ducking ? 0.015 : 0.05);
    this.noiseGain.gain.setTargetAtTime(Math.min(0.25, speedKmh / 500), t, 0.1);
    this.noiseFilter.frequency.setTargetAtTime(250 + speedKmh * 6, t, 0.1);
    const skid = speedKmh > 15 ? Math.max(0, Math.min(1, (slip - 0.35) * 1.5)) : 0;
    this.skidGain.gain.setTargetAtTime(skid * 0.12, t, 0.05);
    if (this.squeal && this.squealGain) {
      const on = braking && speedKmh > 3 && speedKmh < 35;
      this.squealGain.gain.setTargetAtTime(on ? 0.025 * (1 - speedKmh / 35) : 0, t, 0.08);
      this.squeal.frequency.setTargetAtTime(2700 + speedKmh * 12, t, 0.1);
    }
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, t, 0.05);
  }

  suspend(): void {
    void this.ctx?.suspend();
  }
}
