import './style.css';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EngineAudio } from './audio/EngineAudio';
import { DEFAULT_LOCATION, LOCATIONS, type LocationPreset } from './config/locations';
import { DriveSession } from './core/DriveSession';
import { FrameGovernor } from './core/FrameGovernor';
import { loadQuality, QUALITIES, QUALITY_PROFILES, saveQuality, type Quality } from './core/settings';
import { ChunkSource } from './data/chunkSource';
import { Geocoder, presetResults, type PlaceResult } from './data/geocoder';
import { haversineMeters } from './geo/projection';
import type { LatLon } from './geo/types';
import { Globe } from './globe/Globe';
import { $, formatCoords, toast } from './ui/dom';
import { Hud } from './ui/Hud';
import { drawRoadMap } from './ui/MapRenderer';
import { InputController, type ActionKey } from './vehicle/input';
import { VEHICLES, type VehicleSpec } from './vehicle/specs';

type Mode = 'globe' | 'loading' | 'driving' | 'paused' | 'map';

interface Selection {
  readonly name: string;
  readonly detail: string;
  readonly position: LatLon;
  readonly preset: LocationPreset | null;
}

const PACK_BASE = `${import.meta.env.BASE_URL}packs/`;
const TERRAIN_BASE = `${import.meta.env.BASE_URL}terrain/`;

class App {
  private readonly canvas = $('scene') as HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly globe: Globe;
  private readonly source = new ChunkSource();
  private readonly geocoder = new Geocoder();
  private readonly input = new InputController();
  private readonly audio = new EngineAudio();
  private readonly hud = new Hud();
  private readonly governor = new FrameGovernor();
  private vehicle: VehicleSpec = VEHICLES[0];
  private lastGear = '';
  private readonly minimap = ($('minimap') as HTMLCanvasElement).getContext('2d');
  private readonly bigmap = $('bigmap-canvas') as HTMLCanvasElement;
  session: DriveSession | null = null;
  frames = 0;
  private mode: Mode = 'globe';
  private selection: Selection | null = null;
  private quality: Quality = loadQuality();
  private loadedPacks = new Set<string>();
  private bigmapScale = 0.6;
  private lastTime = performance.now();
  private hudTimer = 0;
  private roadTimer = 0;
  private searchAbort: AbortController | null = null;
  private loadToken = 0;
  private placeName = '';

  constructor() {
    const profile = QUALITY_PROFILES[this.quality];
    // The driving view anti-aliases inside its own MSAA buffer, so the canvas only needs it without post-processing.
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: profile.antialias && profile.postfx === 'off', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.globe = new Globe(this.canvas);
    this.globe.onPick = (p) => this.select({ name: 'Pinned location', detail: 'Picked on the globe', position: p, preset: null });
    this.bindUi();
    this.input.onAction = (a) => this.onAction(a);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderResults(presetResults(''), false);
    this.renderCarPicker();
    this.select(this.presetSelection(DEFAULT_LOCATION), false);
    $('pause-quality').textContent = `Graphics: ${this.quality[0].toUpperCase()}${this.quality.slice(1)}`;
    requestAnimationFrame((t) => this.frame(t));
  }

  private presetSelection(p: LocationPreset): Selection {
    return { name: p.name, detail: p.region, position: p.spawn, preset: p };
  }

  // ---------- Globe screen ----------

  private bindUi(): void {
    $('search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.search(($('search-input') as HTMLInputElement).value);
    });
    $('drive-btn').addEventListener('click', () => this.startDrive());
    $('loading-cancel').addEventListener('click', () => this.backToGlobe());
    $('btn-map').addEventListener('click', () => this.onAction('map'));
    $('btn-camera').addEventListener('click', () => this.onAction('camera'));
    $('btn-lights').addEventListener('click', () => this.onAction('headlights'));
    $('btn-pause').addEventListener('click', () => this.onAction('pause'));
    $('pause-resume').addEventListener('click', () => this.setMode('driving'));
    $('pause-reset').addEventListener('click', () => {
      this.session?.resetCar();
      this.setMode('driving');
    });
    $('pause-globe').addEventListener('click', () => this.backToGlobe());
    $('pause-sound').addEventListener('click', () => {
      this.audio.muted = !this.audio.muted;
      $('pause-sound').textContent = `Sound: ${this.audio.muted ? 'off' : 'on'}`;
    });
    $('pause-quality').addEventListener('click', () => {
      this.quality = QUALITIES[(QUALITIES.indexOf(this.quality) + 1) % QUALITIES.length];
      saveQuality(this.quality);
      this.governor.reset();
      this.renderer.setPixelRatio(this.pixelRatio());
      this.resize();
      $('pause-quality').textContent = `Graphics: ${this.quality[0].toUpperCase()}${this.quality.slice(1)}`;
      toast('Resolution changed now. Shadows and draw distance apply on the next drive.');
    });
    $('map-close').addEventListener('click', () => this.setMode('driving'));
    $('map-zoom-in').addEventListener('click', () => (this.bigmapScale = Math.min(4, this.bigmapScale * 1.4)));
    $('map-zoom-out').addEventListener('click', () => (this.bigmapScale = Math.max(0.12, this.bigmapScale / 1.4)));
    this.bigmap.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.bigmapScale = Math.min(4, Math.max(0.12, this.bigmapScale * Math.exp(-e.deltaY * 0.0015)));
      },
      { passive: false },
    );
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-touch]')) {
      const control = btn.dataset.touch as 'throttle' | 'brake' | 'left' | 'right' | 'handbrake';
      const set = (down: boolean) => (e: Event): void => {
        e.preventDefault();
        this.audio.start();
        btn.classList.toggle('active', down);
        this.input.setTouch(control, down);
      };
      btn.addEventListener('pointerdown', set(true));
      btn.addEventListener('pointerup', set(false));
      btn.addEventListener('pointercancel', set(false));
      btn.addEventListener('pointerleave', set(false));
    }
  }

  private async search(query: string): Promise<void> {
    this.searchAbort?.abort();
    const ctrl = new AbortController();
    this.searchAbort = ctrl;
    const btn = $('search-btn') as HTMLButtonElement;
    btn.disabled = true;
    $('search-note').textContent = 'Searching…';
    try {
      const { results, live } = await this.geocoder.search(query, ctrl.signal);
      if (ctrl.signal.aborted) return;
      this.renderResults(results, live);
      if (!live && query.trim().length >= 2) {
        $('search-note').textContent = results.length
          ? 'Live search is unavailable here, showing built-in cities. You can also click anywhere on the globe.'
          : 'Live search is unavailable here and no built-in city matches. Click anywhere on the globe to pick a spot.';
      } else if (results.length === 0) {
        $('search-note').textContent = 'No places found. Try a different spelling, or click the globe.';
      }
    } catch (err) {
      if (!ctrl.signal.aborted) $('search-note').textContent = 'Search failed. Click the globe to pick a spot instead.';
      console.warn(err);
    } finally {
      btn.disabled = false;
    }
  }

  private renderResults(results: PlaceResult[], live: boolean): void {
    const list = $('search-results');
    list.replaceChildren();
    $('search-note').textContent = live ? '' : $('search-note').textContent;
    for (const r of results.slice(0, 10)) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const name = document.createElement('span');
      name.className = 'r-name';
      name.textContent = r.name;
      if (r.preset?.pack) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'Offline ready';
        name.appendChild(badge);
      } else if (!r.preset) {
        const badge = document.createElement('span');
        badge.className = 'badge live';
        badge.textContent = 'Live';
        name.appendChild(badge);
      }
      const detail = document.createElement('span');
      detail.className = 'r-detail';
      detail.textContent = r.detail;
      b.append(name, detail);
      b.addEventListener('click', () => this.select({ name: r.name, detail: r.detail, position: r.position, preset: r.preset }));
      li.appendChild(b);
      list.appendChild(li);
    }
  }

  private renderCarPicker(): void {
    const list = $('car-list');
    list.replaceChildren();
    for (const v of VEHICLES) {
      const label = document.createElement('label');
      label.className = 'car-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'vehicle';
      input.id = `car-${v.id}`;
      input.value = v.id;
      input.checked = v.id === this.vehicle.id;
      input.addEventListener('change', () => {
        if (input.checked) this.vehicle = v;
      });
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `#${v.paint.toString(16).padStart(6, '0')}`;
      const name = document.createElement('span');
      name.className = 'c-name';
      name.textContent = v.name;
      const kind = document.createElement('span');
      kind.className = 'c-kind';
      kind.textContent = v.kind;
      const stat = document.createElement('span');
      stat.className = 'c-stat';
      stat.textContent = `${v.topSpeedKmh} km/h\n${(v.massKg / 1000).toFixed(2)} t`;
      stat.style.whiteSpace = 'pre';
      label.append(input, swatch, name, kind, stat);
      list.appendChild(label);
    }
  }

  private select(s: Selection, focus = true): void {
    this.selection = s;
    $('place-card').hidden = false;
    $('place-name').textContent = s.name;
    $('place-detail').textContent = s.detail;
    $('place-coords').textContent = formatCoords(s.position.lat, s.position.lon);
    this.globe.showMarker(s.position);
    if (focus) this.globe.focus(s.position);
  }

  // ---------- Session lifecycle ----------

  private async ensurePackFor(p: LatLon): Promise<void> {
    for (const loc of LOCATIONS) {
      if (!loc.pack || this.loadedPacks.has(loc.pack)) continue;
      if (haversineMeters(loc.spawn, p) < 8000) {
        const ok = await this.source.loadPack(PACK_BASE + loc.pack);
        if (ok) this.loadedPacks.add(loc.pack);
        else console.warn(`[app] offline pack ${loc.pack} could not be loaded`);
      }
    }
  }

  private startDrive(): void {
    const sel = this.selection;
    if (!sel || this.mode !== 'globe') return;
    this.audio.start();
    const token = ++this.loadToken;
    ($('drive-btn') as HTMLButtonElement).disabled = true;
    this.globe.setEnabled(false);
    this.placeName = sel.name === 'Pinned location' ? formatCoords(sel.position.lat, sel.position.lon) : sel.name;

    // Start loading while the camera dives, so the two overlap.
    const ready = (async (): Promise<{ session: DriveSession; onRoad: boolean; roadName: string | null }> => {
      await this.ensurePackFor(sel.position);
      const session = new DriveSession(
        { origin: sel.position, headingDeg: sel.preset?.spawnHeadingDeg ?? 0, vehicle: this.vehicle, quality: QUALITY_PROFILES[this.quality] },
        RAPIER,
        this.renderer,
        this.source,
        this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight),
        TERRAIN_BASE,
      );
      try {
        const r = await session.start();
        return { session, ...r };
      } catch (err) {
        session.dispose();
        throw err;
      }
    })();

    let arrived = false;
    this.globe.flyTo(sel.position, () => {
      arrived = true;
      if (token === this.loadToken && this.mode === 'globe') this.setMode('loading');
    });

    ready
      .then(({ session, onRoad, roadName }) => {
        if (token !== this.loadToken) {
          session.dispose();
          return;
        }
        const finish = (): void => {
          if (token !== this.loadToken) {
            session.dispose();
            return;
          }
          this.session = session;
          this.hud.configure(session.car.spec.redlineRpm);
          this.audio.configure(session.car.spec.firingPerRev);
          session.pedestrians.onHit = (kmh) => this.audio.bump(kmh);
          session.onTrafficCrash = (kmh) => this.audio.bump(kmh * 1.5);
          session.weapon.onShot = () => this.audio.gunshot();
          session.onVehicleChanged = (car) => {
            this.hud.configure(car.spec.redlineRpm);
            this.audio.configure(car.spec.firingPerRev);
            toast(`Got into a ${car.spec.kind.toLowerCase()}`, 'info', 1400);
          };
          session.weapon.onDryFire = () => this.audio.dryFire();
          session.weapon.onExplosion = () => this.audio.explosion();
          this.lastGear = '';
          this.setMode('driving');
          const st = session.world.status();
          if (!onRoad) {
            toast(
              st.roads === 0
                ? 'No road data could be loaded for this spot, so you are on open ground. Try a city, or run the game locally for live worldwide maps.'
                : 'No road right here, so you start nearby on open ground.',
              'error',
              7000,
            );
          } else {
            toast(`${roadName ?? 'Unnamed road'} · ${st.buildings} buildings loaded`);
          }
          window.setTimeout(() => $('controls-help').classList.add('fade'), 9000);
        };
        if (arrived) finish();
        else {
          const wait = (): void => {
            if (arrived || token !== this.loadToken) finish();
            else requestAnimationFrame(wait);
          };
          wait();
        }
      })
      .catch((err: unknown) => {
        console.error(err);
        if (token !== this.loadToken) return;
        this.setMode('loading');
        $('loading-title').textContent = 'Could not load this place';
        $('loading-detail').textContent = err instanceof Error ? err.message : 'Unknown error';
      });
  }

  private backToGlobe(): void {
    this.loadToken++;
    this.session?.dispose();
    this.session = null;
    this.audio.suspend();
    $('loading-title').textContent = 'Loading streets';
    $('loading-detail').textContent = 'Fetching OpenStreetMap data';
    ($('drive-btn') as HTMLButtonElement).disabled = false;
    $('controls-help').classList.remove('fade');
    this.globe.setEnabled(true);
    this.globe.zoomBy(40);
    this.setMode('globe');
  }

  private setMode(m: Mode): void {
    this.mode = m;
    $('globe-ui').hidden = m !== 'globe';
    $('loading').hidden = m !== 'loading';
    $('hud').hidden = !(m === 'driving' || m === 'paused' || m === 'map');
    $('pause').hidden = m !== 'paused';
    $('bigmap').hidden = m !== 'map';
    this.input.enabled = m === 'driving';
    if (m === 'driving') this.audio.start();
    if (m === 'map') this.sizeBigmap();
  }

  private onAction(a: ActionKey): void {
    const s = this.session;
    if (!s) return;
    switch (a) {
      case 'pause':
        if (this.mode === 'driving') this.setMode('paused');
        else if (this.mode === 'paused' || this.mode === 'map') this.setMode('driving');
        break;
      case 'map':
        if (this.mode === 'driving') this.setMode('map');
        else if (this.mode === 'map') this.setMode('driving');
        break;
      case 'camera':
        if (this.mode === 'driving') toast(`Camera: ${{ chase: 'Chase', cockpit: 'Cockpit', cinematic: 'Cinematic' }[s.chase.cycle()]}`, 'info', 1200);
        break;
      case 'headlights':
        if (this.mode === 'driving') {
          const on = s.car.toggleHeadlights();
          $('btn-lights').classList.toggle('on', on);
        }
        break;
      case 'enter':
        if (this.mode === 'driving') {
          const msg = s.toggleVehicle();
          if (msg) toast(msg, 'info', 1600);
        }
        break;
      case 'reset':
        if (this.mode === 'driving') s.resetCar();
        break;
    }
  }

  // ---------- Frame loop ----------

  /** Preset pixel-ratio cap, scaled down by the frame governor while the GPU is struggling. */
  private pixelRatio(): number {
    const cap = QUALITY_PROFILES[this.quality].pixelRatioCap;
    return Math.max(0.5, Math.min(window.devicePixelRatio, cap) * this.governor.scale);
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.globe.resize(w, h);
    this.session?.resize(w, h);
    if (this.mode === 'map') this.sizeBigmap();
  }

  private sizeBigmap(): void {
    const r = this.bigmap.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio);
    this.bigmap.width = Math.max(1, Math.round(r.width * dpr));
    this.bigmap.height = Math.max(1, Math.round(r.height * dpr));
  }

  private frame(now: number): void {
    const rawDt = (now - this.lastTime) / 1000;
    const dt = Math.min(0.1, rawDt);
    this.lastTime = now;
    this.frames++;
    try {
      const s = this.session;
      if (s && (this.mode === 'driving' || this.mode === 'paused' || this.mode === 'map')) {
        s.update(dt, this.input.read(dt), this.mode === 'driving', this.input.firing(), this.input.readFoot());
        s.render(this.renderer);
        this.updateHud(s, dt);
        if (this.mode === 'driving' && this.governor.sample(rawDt)) {
          this.renderer.setPixelRatio(this.pixelRatio());
          this.resize();
        }
      } else {
        this.globe.update(dt);
        this.globe.render(this.renderer);
      }
    } catch (err) {
      console.error('[app] frame error', err);
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  private updateHud(s: DriveSession, dt: number): void {
    const t = s.car.getTelemetry();
    const heading = s.car.heading();
    this.hud.update(t, heading);
    this.audio.update(t.rpm, t.throttle, t.speedKmh, t.slip, t.braking);
    if (this.lastGear && t.gear !== this.lastGear && t.gear !== 'R' && this.lastGear !== 'R') this.audio.shift();
    this.lastGear = t.gear;

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 1 / 30;
      const w = s.weapon.status();
      const ammoEl = $('ammo');
      $('ammo-count').textContent = w.reloading ? 'RELOAD' : String(w.ammo);
      ammoEl.classList.toggle('reloading', w.reloading);
      $('crosshair').classList.toggle('firing', this.input.firing());
      // The crosshair is meaningless in the cockpit camera's view of the dash.
      $('crosshair').hidden = s.chase.mode === 'cockpit';
      const pos = s.playerLocal();
      if (this.minimap) {
        drawRoadMap(this.minimap, 440, 440, s.world.roads(), { center: pos, scale: 1.25, rotation: heading }, { pos, heading }, s.traffic.snapshot());
      }
      if (this.mode === 'map') {
        const ctx = this.bigmap.getContext('2d');
        if (ctx) {
          const dpr = this.bigmap.width / Math.max(1, this.bigmap.clientWidth);
          drawRoadMap(ctx, this.bigmap.width, this.bigmap.height, s.world.roads(), { center: pos, scale: this.bigmapScale * dpr, rotation: 0 }, { pos, heading }, s.traffic.snapshot());
        }
      }
    }
    this.roadTimer -= dt;
    if (this.roadTimer <= 0) {
      this.roadTimer = 0.5;
      const ll = s.playerLatLon();
      $('hud-place').textContent = this.placeName;
      $('hud-coords').textContent = formatCoords(ll.lat, ll.lon);
      const near = s.world.nearestRoadPoint(s.playerLocal(), 30);
      $('hud-road').textContent = near ? near.road.name ?? `Unnamed ${near.road.kind} road` : 'Off road';
      const st = s.world.status();
      $('stream-status').textContent =
        st.pending > 0 ? `Streaming map… ${st.loaded} areas loaded` : st.failed > 0 ? `Some map areas failed to load: ${st.lastError ?? ''}` : '';
    }
  }
}

declare global {
  interface Window {
    /** Test hook, only set with ?debug in the URL. */
    __rwd?: App;
  }
}

async function boot(): Promise<void> {
  try {
    await RAPIER.init();
    const app = new App();
    if (new URLSearchParams(location.search).has('debug')) window.__rwd = app;
  } catch (err) {
    console.error(err);
    const msg = document.createElement('div');
    msg.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;color:#e9eef5;font:16px system-ui;padding:24px;text-align:center';
    msg.textContent = `This browser could not start the game (${err instanceof Error ? err.message : 'unknown error'}). WebGL and WebAssembly are required.`;
    document.body.appendChild(msg);
  }
}

void boot();
