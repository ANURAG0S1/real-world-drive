export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITIES: readonly Quality[] = ['low', 'medium', 'high', 'ultra'];

export interface QualityProfile {
  readonly pixelRatioCap: number;
  readonly shadowMapSize: number; // 0 disables shadows
  readonly loadRadius: number; // chunks around the player
  readonly antialias: boolean;
}

export const QUALITY_PROFILES: Readonly<Record<Quality, QualityProfile>> = {
  low: { pixelRatioCap: 1, shadowMapSize: 0, loadRadius: 1, antialias: false },
  medium: { pixelRatioCap: 1.25, shadowMapSize: 1024, loadRadius: 1, antialias: true },
  high: { pixelRatioCap: 1.75, shadowMapSize: 2048, loadRadius: 1, antialias: true },
  ultra: { pixelRatioCap: 2, shadowMapSize: 4096, loadRadius: 2, antialias: true },
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
