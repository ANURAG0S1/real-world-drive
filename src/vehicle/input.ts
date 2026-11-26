/** Normalised driver input, from keyboard or touch. */
export interface DriveInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (S / Down: brake, then reverse once stopped)
  steer: number; // -1 (right) .. 1 (left)
  handbrake: boolean;
}

export type ActionKey = 'camera' | 'headlights' | 'reset' | 'map' | 'pause';

const ACTION_CODES: Readonly<Record<string, ActionKey>> = {
  KeyC: 'camera',
  KeyH: 'headlights',
  KeyR: 'reset',
  KeyM: 'map',
  Escape: 'pause',
};

/** Keyboard + touch input with smoothed steering so keyboard play is not twitchy. */
export class InputController {
  private readonly keys = new Set<string>();
  private readonly touch = { throttle: false, brake: false, left: false, right: false, handbrake: false, fire: false };
  private steerSmoothed = 0;
  enabled = false;
  onAction: ((a: ActionKey) => void) | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const action = ACTION_CODES[e.code];
      if (action && !e.repeat) {
        this.onAction?.(action);
        e.preventDefault();
        return;
      }
      if (this.enabled && /^(Arrow|Key[WASDF]$|Space)/.test(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseFire = false;
    });
    // Left mouse on the 3D view fires; HUD buttons sit above the canvas and are unaffected.
    const canvas = document.getElementById('scene');
    canvas?.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseFire = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
    });
  }

  private mouseFire = false;

  /** True while the fire control (F or left mouse) is held. */
  firing(): boolean {
    return this.enabled && (this.keys.has('KeyF') || this.mouseFire || this.touch.fire);
  }

  setTouch(control: keyof InputController['touch'], down: boolean): void {
    this.touch[control] = down;
  }

  read(dt: number): DriveInput {
    if (!this.enabled) return { throttle: 0, brake: 0, steer: 0, handbrake: false };
    const k = (c: string): boolean => this.keys.has(c);
    const throttle = k('KeyW') || k('ArrowUp') || this.touch.throttle ? 1 : 0;
    const brake = k('KeyS') || k('ArrowDown') || this.touch.brake ? 1 : 0;
    const left = k('KeyA') || k('ArrowLeft') || this.touch.left;
    const right = k('KeyD') || k('ArrowRight') || this.touch.right;
    const target = (left ? 1 : 0) - (right ? 1 : 0);
    const rate = target === 0 ? 5 : 3.2;
    this.steerSmoothed += (target - this.steerSmoothed) * Math.min(1, rate * dt);
    return { throttle, brake, steer: this.steerSmoothed, handbrake: k('Space') || this.touch.handbrake };
  }
}
