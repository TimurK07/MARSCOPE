# MARSCOPE

**An interplanetary survival guide for future Mars explorers.**

MARSCOPE is a Marswalk planner. It layers data from several NASA missions over one site on Mars and finds a safe walking route for astronauts between their habitat and their science targets.

Built for the **NASA Space Apps Challenge 2026**, challenge *Interplanetary Survival Guide: Martian Map*.

## What it does

MARSCOPE plans a surface EVA ("Marswalk") on Mount Sharp in Gale crater, the area Curiosity is exploring right now.

- **Mission map.** HiRISE, CTX and Viking imagery of the site, with the planned route, Curiosity's traverse and the crew's checkpoints drawn on top.
- **Scientific data layers**, grouped as imagery, terrain, environmental and scientific context. Each has a description, a legend, a switch and an opacity control.
- **Slope hazard layer.** We compute slope from the 1 m DEM. By default only ground that restricts walking is drawn (steep as a tint, no-go as a hatch), so the imagery stays readable.
- **Elevation tint and contours**, painted in the browser from the same DEM.
- **Scale-aware regional layers.** THEMIS thermal infrared (100 m/px) and the USGS global geologic map (1:20M) are too coarse for a 4 km site, so the app hides them at site scale and offers a Gale crater view where they read correctly.
- **Point inspector.** Click anywhere to read coordinates, elevation, slope class and geologic unit, then set the habitat or add a science target from there.
- **Safe route planner.** The fastest walking route that never crosses terrain steeper than NASA's 20° limit. Checkpoints can be dragged, reordered and removed, with undo.
- **Mission verdict.** GO or NO-GO against EVA duration, distance from the habitat and steepest slope, plus distance, time, climb, metabolic energy, radiation dose and a terrain profile linked to the map.
- **Surface view.** Select a Curiosity stop to see the Navcam frames taken there, with local solar time and camera azimuth.
- **Conditions at Gale.** The latest weather report from Curiosity's REMS station.

## Project structure

```
app/                 Web app (Vite + React + TypeScript + Leaflet), no backend
  src/lib/model.ts   Physical model: every constant with its source
  src/lib/router.ts  A* least-time route search over the terrain grid
  src/lib/overlays.ts Slope hazard, elevation tint and contour rasters
  src/components/    Map, data panel, mission panel, inspector, surface view
  src/hooks/usePlan.ts Checkpoints with undo, route and go/no-go checks
  public/data/gale/  Terrain grids produced by the script below
scripts/
  prepare_terrain.py Downloads the DEM patch from NASA Mars Trek and computes slope
docs/
  DATA_SOURCES.md    Every NASA dataset and endpoint we use, with links
```

## Getting started

Requirements: Node.js 20 or newer.

```bash
cd app
npm install
npm run dev
```

Then open http://localhost:5173. Click **Load example** in the EVA plan panel to see a planned route.

To build a static site: `npm run build` (output in `app/dist`). To run the unit tests for the model and the route search: `npm test`.

### Rebuilding the terrain data (optional)

The prepared terrain grids are already in the repository. To regenerate them from the NASA source (Python 3.10+):

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/prepare_terrain.py
```

## How the route model works

The study area is a 1024 × 1024 grid (about 4 m per cell) cut from the MRO HiRISE Gale Crater DEM. Each step between cells costs the time a suited astronaut needs to walk it:

- **Walking speed vs slope** follows Marquez (2008), derived from Apollo traverse data, as implemented in the SEXTANT planner used by NASA's BASALT programme.
- **Metabolic cost** follows Santee et al. (2001), with Mars gravity of 3.73 m/s².
- **Slope limit of 20°**, **EVA duration of 8 hours** and **2 km walking range** come from NASA EVA-EXP-0075 (Exploration EVA System Concept of Operations).
- **Radiation**: 0.67 mSv/day, the average galactic cosmic ray dose equivalent Curiosity's RAD measured in Gale crater (Hassler et al., 2014), compared with the 600 mSv career limit of NASA-STD-3001.

The suited mass and the time spent at each target are planning inputs the user sets. Links to every source are in the app and in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## NASA data used

- **NASA JPL Mars Trek**: HiRISE and CTX mosaics, HiRISE 1 m DEM, THEMIS infrared mosaics, Viking color mosaic, USGS global geologic map.
- **Mars Science Laboratory (Curiosity)**: rover traverse and waypoints, raw Navcam images, REMS weather reports, RAD radiation measurements.

Exact dataset names and URLs: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Team

- **Timur Kaliev**
- **Ilya Krivoshapov**

## License

[Apache License 2.0](LICENSE)
