# MARSCOPE

**An interplanetary survival guide for future Mars explorers.**

MARSCOPE is a Marswalk planner. It layers data from several NASA missions over one site on Mars and finds a safe walking route for astronauts between their habitat and their science targets.

Built for the **NASA Space Apps Challenge 2026**, challenge *Interplanetary Survival Guide: Martian Map*.

## What it does

MARSCOPE plans a surface EVA ("Marswalk") on Mount Sharp in Gale crater, the area Curiosity is exploring right now.

MARSCOPE opens on an interactive 3D globe of Mars and continues into a 2D mission workspace, as one place seen at two scales.

- **Global view: 3D Mars.** A sphere textured with the Viking MDIM 2.1 color mosaic. Rotate, zoom, and pick any point to read its coordinates, MOLA elevation and geologic unit. Feature names come from the IAU/USGS gazetteer. Imagery sharpens as you approach, from the same NASA Mars Trek tiles the 2D map uses, down to the MRO CTX mosaic inside Gale crater.
- **One continuous descent.** Zoom into the study area, or press *Enter Gale crater workspace*, and the globe hands over to the 2D map at the same centre, scale and orientation. Zoom the map all the way out, or press *Mars*, to return. The mission is never reset.
- **The mission on the planet.** At planetary scale the plan is a marker with its verdict. Closer in you see the study area frame, and closer still the real route geometry and checkpoints, at true size.
- **Aligned handover.** On the final approach the globe's view slides so that its focus sits exactly where the centre of the 2D map is, whatever the window size or panel state. Up close it shows the same HiRISE and CTX tiles as the map.
- **Honest limits.** The globe is imagery on a sphere, with no terrain relief. Routing and GO / NO-GO exist only inside the study area, where the 1 m terrain model is; a point picked anywhere else says so.

The local view is a map-first workspace: a tool rail on the left, the map in the centre with a dock underneath, and the mission panel on the right.

- **Mission map.** HiRISE, CTX and Viking imagery of the site, with the planned route, Curiosity's traverse and the crew's checkpoints drawn on top. The map takes about three quarters of the screen.
- **Tool rail and data panes.** Map layers, environment, scientific context and sources open as panes over the map. Each layer has a description, a legend, a switch and an opacity control.
- **Slope hazard layer.** We compute slope from the 1 m DEM. By default only ground that restricts walking is drawn (steep as a tint, no-go as a hatch), so the imagery stays readable.
- **Elevation tint and contours**, painted in the browser from the same DEM.
- **Scale-aware regional layers.** THEMIS thermal infrared (100 m/px) and the USGS global geologic map (1:20M) are too coarse for a 4 km site, so the app hides them at site scale and offers a Gale crater view where they read correctly.
- **Bottom dock** with three tabs. It can be resized, expanded and collapsed.
  - **Terrain profile**: the elevation profile of the route, coloured by slope class and linked to the map.
  - **Point**: click anywhere to read coordinates, elevation, slope class and geologic unit, then set the habitat or add a science target.
  - **Surface view**: the Navcam frames Curiosity took at a selected stop, with local solar time and camera azimuth.
- **Safe route planner.** The fastest walking route that never crosses terrain steeper than NASA's 20° limit. Checkpoints can be dragged, reordered and removed, with undo.
- **Mission status.** STANDBY, GO, NO-GO or NO ROUTE, always visible with distance, EVA duration, climb and energy. On NO-GO the panel names the failed constraint and says what would fix it, for example the longest stop time that still fits the 8-hour limit.
- **Mobile.** A full-screen map with a bottom sheet that snaps to three heights.
- **Conditions at Gale.** The latest weather report from Curiosity's REMS station.

## Project structure

```
app/                 Web app (Vite + React + TypeScript + Leaflet), no backend
  src/lib/model.ts   Physical model: every constant with its source
  src/lib/router.ts  A* least-time route search over the terrain grid
  src/lib/overlays.ts Slope hazard, elevation tint and contour rasters
  src/lib/advice.ts  Plain-language guidance for a NO-GO plan
  src/lib/globe.ts   Mars sphere geometry: coordinates, great circles, altitude and zoom
  src/lib/globeEngine.ts 3D globe renderer (three.js), loaded lazily
  src/lib/viewTransition.ts Rules for moving between the globe and the 2D map
  src/components/    Map, tool rail, data panes, dock, mission panel, mobile sheet
  src/hooks/usePlan.ts Checkpoints with undo, route and go/no-go checks
  src/styles/        Design tokens and styles by workspace area
  public/data/gale/  Terrain grids produced by the script below
scripts/
  prepare_terrain.py Downloads the DEM patch from NASA Mars Trek and computes slope
  fetch_globe_assets.py Downloads the globe's first texture and the feature names
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

If WebGL is slow or missing, add `?view=2d` to the address to open straight in the 2D workspace (this also happens by itself when WebGL cannot start).

To build a static site: `npm run build` (output in `app/dist`). To run the tests: `npm test`. They include a comparison of the route search with an exhaustive search and safety checks on the real terrain grid.

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
- **Metabolic cost** follows Santee et al. (2001), with Mars gravity of 3.73 m/s². It covers walking only; work at the targets is not modelled.
- **Slope limit of 20°**, **EVA duration of 8 hours** and **2 km walking range** come from NASA EVA-EXP-0075 (Exploration EVA System Concept of Operations). The route never clips no-go cells diagonally, and slope is stored rounded up so the limit is strict.
- **Walk back.** From every point of the route we compute the fastest safe way back to the habitat over the terrain. The plan must keep the longest of these within 2 km and the slowest within 60 minutes. The 60 minutes is our reading of the same NASA document, not a NASA requirement.
- **Radiation**: 0.67 mSv/day, the average galactic cosmic ray dose equivalent Curiosity's RAD measured in Gale crater (Hassler et al., 2014), compared with the 600 mSv career limit of NASA-STD-3001.

The suited mass and the time spent at each target are planning inputs the user sets. Links to every source are in the app and in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## NASA data used

- **USGS Astrogeology**: Viking MDIM 2.1 colorized global mosaic (credit NASA/JPL/USGS), IAU Gazetteer of Planetary Nomenclature.
- **NASA JPL Mars Trek**: MOLA global elevation, HiRISE and CTX mosaics, HiRISE 1 m DEM, THEMIS infrared mosaics, Viking color mosaic, USGS global geologic map.
- **Mars Science Laboratory (Curiosity)**: rover traverse and waypoints, raw Navcam images, REMS weather reports, RAD radiation measurements.

Exact dataset names and URLs: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Team

- **Timur Kaliev**
- **Ilya Krivoshapov**

## License

[Apache License 2.0](LICENSE)
