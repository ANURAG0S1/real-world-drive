import type { Telemetry } from '../vehicle/Car';
import { $ } from './dom';

const START_DEG = 135;
const SWEEP_DEG = 270;
const CX = 100;
const CY = 100;
const R = 86;

function polar(deg: number, r = R): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
}

function arcPath(fromFrac: number, toFrac: number): string {
  if (toFrac - fromFrac < 0.001) return '';
  const a0 = START_DEG + SWEEP_DEG * fromFrac;
  const a1 = START_DEG + SWEEP_DEG * toFrac;
  const [x0, y0] = polar(a0);
  const [x1, y1] = polar(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Speedometer, RPM arc, gear and compass. */
export class Hud {
  private readonly speedEl = $('speed');
  private readonly gearEl = $('gear');
  private readonly rpmEl = $('rpm');
  private readonly rpmArc = $('rpm-arc') as unknown as SVGPathElement;
  private readonly strip = $('compass-strip');
  private lastSpeed = -1;
  private lastGear = '';

  constructor(private readonly redline: number) {
    ($('rpm-track') as unknown as SVGPathElement).setAttribute('d', arcPath(0, 1));
    ($('rpm-red') as unknown as SVGPathElement).setAttribute('d', arcPath(0.86, 1));
    const ticks = $('gauge-ticks') as unknown as SVGGElement;
    const maxK = Math.ceil(redline / 1000);
    const ns = 'http://www.w3.org/2000/svg';
    ticks.replaceChildren();
    for (let k = 0; k <= maxK; k++) {
      const f = (k * 1000) / (maxK * 1000);
      const deg = START_DEG + SWEEP_DEG * f;
      const [x0, y0] = polar(deg, R - 10);
      const [x1, y1] = polar(deg, R - 18);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', x0.toFixed(1));
      line.setAttribute('y1', y0.toFixed(1));
      line.setAttribute('x2', x1.toFixed(1));
      line.setAttribute('y2', y1.toFixed(1));
      line.setAttribute('class', 'tick');
      ticks.appendChild(line);
      const [tx, ty] = polar(deg, R - 28);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', tx.toFixed(1));
      label.setAttribute('y', ty.toFixed(1));
      label.setAttribute('class', 'tick-label');
      label.textContent = String(k);
      ticks.appendChild(label);
    }
    this.maxRpm = maxK * 1000;
    this.buildCompass();
  }

  private readonly maxRpm: number;

  private buildCompass(): void {
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    const parts: string[] = [];
    // Three full turns so we can scroll without running out.
    for (let turn = 0; turn < 3; turn++) {
      for (let d = 0; d < 360; d += 15) {
        const n = names[d];
        const cls = n ? (n === 'N' ? 'card north' : 'card') : '';
        parts.push(`<span class="${cls}">${n ?? (d % 45 === 0 ? '' : '·')}</span>`);
      }
    }
    this.strip.innerHTML = parts.join('');
  }

  update(t: Telemetry, headingRad: number): void {
    const speed = Math.round(t.speedKmh);
    if (speed !== this.lastSpeed) {
      this.speedEl.textContent = String(speed);
      this.lastSpeed = speed;
    }
    if (t.gear !== this.lastGear) {
      this.gearEl.textContent = t.gear;
      this.lastGear = t.gear;
    }
    this.rpmEl.textContent = String(Math.round(t.rpm / 50) * 50);
    this.rpmArc.setAttribute('d', arcPath(0, Math.min(1, t.rpm / this.maxRpm)));
    this.rpmArc.style.stroke = t.rpm > this.redline * 0.9 ? 'var(--red)' : '';

    // 30 px per 15 degrees; centre the middle turn on the current heading.
    let deg = (headingRad * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    const px = (360 + deg) * 2 - 140 + 15;
    this.strip.style.transform = `translateX(${-px}px)`;
  }
}
