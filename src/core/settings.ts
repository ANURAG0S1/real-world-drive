import type { PostFXLevel } from '../render/PostFX';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITIES: readonly Quality[] = ['low', 'medium', 'high', 'ultra'];

export interface QualityProfile {
  readonly pixelRatioCap: number;
  readonly shadowMapSize: number; // 0 disables shadows
  readonly loadRadius: number; // chunks around the player
  readonly antialias: boolean;
  /** People walking the sidewalks around the player. */
  readonly pedestrians: number;
  /** Post-processing: off, bloom + grade, or ambient occlusion + bloom + grade. */
  readonly postfx: PostFXLevel;
  /** Ambient occlusion buffer size relative to the screen (only with postfx 'full'). */
  readonly aoScale: number;
  /** AI cars on the roads around the player. */
  readonly traffic: number;
  /** Live cube-map reflections on the car; 0 disables, otherwise the refresh interval in frames. */
  readonly reflectionInterval: number;
}

export const QUALITY_PROFILES: Readonly<Record<Quality, QualityProfile>> = {
  low: { pixelRatioCap: 1, shadowMapSize: 0, loadRadius: 1, antialias: false, pedestrians: 25, postfx: 'off', aoScale: 0, traffic: 8, reflectionInterval: 0 },
  medium: { pixelRatioCap: 1, shadowMapSize: 1024, loadRadius: 1, antialias: true, pedestrians: 45, postfx: 'basic', aoScale: 0, traffic: 14, reflectionInterval: 0 },
  high: { pixelRatioCap: 1.25, shadowMapSize: 2048, loadRadius: 1, antialias: true, pedestrians: 70, postfx: 'full', aoScale: 0.5, traffic: 22, reflectionInterval: 0 },
  ultra: { pixelRatioCap: 2, shadowMapSize: 4096, loadRadius: 2, antialias: true, pedestrians: 120, postfx: 'full', aoScale: 1, traffic: 34, reflectionInterval: 6 },
};

const KEY = 'rwd.quality';

export function loadQuality(): Quality {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (QUALITIES as readonly string[]).includes(v)) return v as Quality;
  } catch {
    /* storage blocked: fall through to default */
  }
  // Phones and low-core machines start on medium.
  const cores = navigator.hardwareConcurrency ?? 4;
  return window.matchMedia('(pointer: coarse)').matches || cores <= 4 ? 'medium' : 'high';
}

export function saveQuality(q: Quality): void {
  try {
    localStorage.setItem(KEY, q);
  } catch {
    /* non-essential */
  }
}
