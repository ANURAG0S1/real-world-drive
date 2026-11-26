# Real World Drive

A browser-based 3D driving game on real-world roads. Spin a 3D Earth, search or
click any place, dive down into its streets and drive a physically simulated car
over roads and buildings generated from OpenStreetMap.

This is the first playable prototype (desktop browsers). The initial test
location is **Greater Noida, Uttar Pradesh, India**.

## Run it

Requirements: Node.js 20 or newer and a desktop browser with WebGL 2.

```bash
npm install
npm run dev          # http://localhost:5173
```

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-checks and builds a static site into `dist/` |
| `npm run preview` | Serves the `dist/` build locally |
| `npm run build:artifact` | Builds a single-file page into `dist-artifact/` (used for the hosted demo) |
| `npm run typecheck` | TypeScript only |
| `npm run test:physics` | Headless handling test: 0-100, top speed, braking, cornering |

No API keys are needed. All map data comes from free OpenStreetMap services.

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Accelerate |
| S / ↓ | Brake, then reverse once stopped |
| A D / ← → | Steer |
| Space | Handbrake |
| C | Cycle camera (chase, cockpit, cinematic) |
| H | Headlights |
| R | Reset the car onto the nearest road |
| M | Full-screen map |
| Esc | Pause menu (reset, sound, graphics quality, back to globe) |

On the globe: drag to rotate, scroll to zoom, click to drop a pin, or search.

## How the map data works

* **Search** uses [Nominatim](https://nominatim.org) (max one request per second, on submit only, as its usage policy asks). If it is unreachable, the built-in city list in `src/config/locations.ts` is used.
* **Roads, buildings, parks, water and trees** come from the [Overpass API](https://overpass-api.de) in a fixed global grid of 0.01° chunks (about 1.1 km). Only the chunks around the car are loaded; distant ones are unloaded. Requests are queued one at a time and retried with backoff, and the client stops trying for a minute if the servers cannot be reached at all.
* **Offline packs**: `public/packs/greater-noida.json` is a snapshot of the Greater Noida area (about 1,300 roads and 3,200 buildings). It loads instantly and is used whenever live Overpass is unavailable, for example on the hosted demo, whose page policy blocks outside requests.
* For heavy use, run your own Overpass instance (see [b1tw153/Overpass-API](https://github.com/b1tw153/Overpass-API)) and point the game at it:

  ```bash
  VITE_OVERPASS_URL=http://localhost:12345/api/interpreter npm run dev
  ```

Map data © OpenStreetMap contributors, available under the [ODbL](https://www.openstreetmap.org/copyright). The attribution is shown on every screen.

## Adding a city

1. Add an entry to `LOCATIONS` in `src/config/locations.ts` with its name and spawn coordinates. It will stream live from Overpass.
2. Optional, for instant offline loading: save an Overpass snapshot as `public/packs/<id>.json` in the format described in `src/data/packFormat.ts` and set `pack: '<id>.json'` on the entry.

## Project layout

```
src/
  main.ts               App state machine: globe → loading → driving, HUD wiring
  config/locations.ts   Curated start locations (add cities here)
  core/                 DriveSession (one drive: scene, physics, world, car), quality settings
  data/                 Overpass client, offline packs, chunk source, OSM parser, Nominatim geocoder
  geo/                  Lat/lon ↔ local metres projection, chunk grid
  globe/                Interactive Earth and its procedural textures (Natural Earth outlines)
  world/                Chunk streaming, road/building/tree mesh builders, sky and lighting
  vehicle/              Car specs, procedural car model, Rapier ray-cast vehicle, input
  camera/               Chase, cockpit and cinematic cameras
  ui/                   HUD gauge, compass, mini-map and full map renderer
  audio/                Synthesised engine, road and tyre sounds (Web Audio)
tests/physics.sim.ts    Headless handling test
```

## What the prototype covers

Done: interactive globe with search and pin drop, fly-in transition, real OSM
roads with markings and sidewalks, extruded buildings with collisions, parks,
trees and streetlights, chunk streaming, one sports car with Rapier suspension,
gearbox, braking, reverse and handbrake, headlights and brake lights, three
cameras, speedometer, RPM, gear, compass, coordinates, mini-map, full map,
engine sound, pause menu and four graphics presets.

Not yet: terrain elevation and real bridge heights, more vehicles (sedan, SUV),
traffic AI, weather and day/night, destination routing, game modes, mobile
controls tuning. The code is organised so each of these is an addition in its
own folder rather than a rewrite.
