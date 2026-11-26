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
  muted = false;

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

      Object.assign(this, { ctx, master, oscA, oscB, filter, engineGain, noiseGain, noiseFilter, skidGain });
    } catch (err) {
      console.warn('[audio] could not start', err);
    }
  }

  update(rpm: number, throttle: number, speedKmh: number, slip: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.oscA || !this.oscB || !this.filter || !this.engineGain || !this.noiseGain || !this.noiseFilter || !this.skidGain || !this.master) return;
    const t = ctx.currentTime;
    // Four-stroke V8 firing frequency: rpm / 60 * cylinders / 2.
    const f = (rpm / 60) * 4;
    this.oscA.frequency.setTargetAtTime(f, t, 0.03);
    this.oscB.frequency.setTargetAtTime(f * 0.5 * 1.004, t, 0.03);
    this.filter.frequency.setTargetAtTime(350 + rpm * 0.25 + throttle * 900, t, 0.05);
    this.engineGain.gain.setTargetAtTime(0.12 + throttle * 0.14, t, 0.05);
    this.noiseGain.gain.setTargetAtTime(Math.min(0.25, speedKmh / 500), t, 0.1);
    this.noiseFilter.frequency.setTargetAtTime(250 + speedKmh * 6, t, 0.1);
    const skid = speedKmh > 15 ? Math.max(0, Math.min(1, (slip - 0.35) * 1.5)) : 0;
    this.skidGain.gain.setTargetAtTime(skid * 0.12, t, 0.05);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, t, 0.05);
  }

  suspend(): void {
    void this.ctx?.suspend();
  }
}
