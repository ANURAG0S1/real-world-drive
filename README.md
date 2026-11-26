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
| `npm run test:peds` | Headless crowd test: people stay on sidewalks, dodge, fall and get up |

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

* **Elevation** comes from the free [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS Open Data (Terrarium PNGs, zoom 14, about 9 m per pixel). The raw data includes rooftops and tree canopies, so each tile is median-filtered and blurred into drivable ground. Roads, buildings, trees and the physics heightfield all sample the same 8 m grid (`src/world/Ground.ts`), so the car drives on exactly what you see. Tiles for the Greater Noida pack are bundled in `public/terrain/`; elsewhere they stream from S3. Set `VITE_TERRAIN_URL` to use another Terrarium source.

Map data © OpenStreetMap contributors, available under the [ODbL](https://www.openstreetmap.org/copyright). The attribution is shown on every screen.

## Pedestrians

People walk the sidewalks of streets that have them (residential and up) and the middle of footpaths, around the player only: they spawn 35 to 150 m away and are removed past 190 m. They turn onto connecting streets at road ends, stop now and then, and sometimes cross when the car is more than 45 m away. A car heading at someone makes them jump aside; a hit throws them over, and after a few seconds they get back up. The car is not slowed. Each body has jointed limbs (hips, knees, ankles, shoulders, elbows), hands, shoes, a face and one of four hair styles, and people vary in skin, clothing (short or long sleeves, shorts, kurtas, long dresses), bags and height. The walk cycle bends knees and elbows and keeps feet flat; people run with a forward lean when dodging. Every body part is one instanced mesh shared by the whole crowd, so it costs about 23 draw calls however many people there are (about 0.65 ms per frame of CPU for 120). Crowd size follows the quality setting: 30, 55, 80 or 120. Code: `src/world/Pedestrians.ts` (behaviour) and `src/world/pedestrianBody.ts` (body and animation).

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

Vehicles (pick one on the globe screen, defined in `src/vehicle/specs.ts`):

| Car | Drive | 0-100 km/h | 100-0 braking |
| --- | --- | --- | --- |
| Vantage GT sports coupe | RWD | 5.2 s | 34 m |
| Meridian S family sedan | FWD | 9.5 s | 37 m |
| Ridgeback 4x4 SUV | AWD | 8.7 s | 36 m |

Each has its own body shape, suspension, gearbox and engine note, a right-hand-drive
cockpit with a working steering wheel, gear-shift and brake sounds.

Buildings pick one of four facade styles (apartment blocks with balconies, glass
offices, houses with window grilles, industrial sheds) from their OSM tags and
height, many get shops on the ground floor, and homes carry rooftop water tanks
and stair rooms.

Not yet: real bridge and flyover heights, traffic AI, weather and day/night, destination routing, game modes, mobile
controls tuning. The code is organised so each of these is an addition in its
own folder rather than a rewrite.
