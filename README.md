# MARSCOPE

**An interplanetary survival guide for future Mars explorers.**

MARSCOPE is a Marswalk planner. It layers data from several NASA missions over one site on Mars and plans walking routes for astronauts between their habitat and their science targets that stay within a 20° slope limit and a set of planning limits. It is a planning aid: a route that passes is not shown to be safe.

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
- **Hidden steep ground.** A 4 m cell can average out to a walkable slope and still contain steep ground. From the 1 m DEM we count, per cell, the pixels steeper than 20° and show that as a layer, in the point inspector and along the route. It is an indicator, not a hazard probability.
- **Slope hazard layer.** Slope is computed on the 4 m routing grid (between neighbouring cells, an 8 m baseline), which is built from the 1 m DEM. By default only ground that restricts walking is drawn (steep as a tint, no-go as a hatch), so the imagery stays readable.
- **Elevation tint and contours**, painted in the browser from the same DEM.
- **Scale-aware regional layers.** THEMIS thermal infrared (100 m/px) and the USGS global geologic map (1:20M) are too coarse for a 4 km site, so the app hides them at site scale and offers a Gale crater view where they read correctly.
- **Bottom dock** with three tabs. It can be resized, expanded and collapsed.
  - **Terrain profile**: the elevation profile of the route, coloured by slope class and linked to the map.
  - **Point**: click anywhere to read coordinates, elevation, slope class and geologic unit, then set the habitat or add a science target.
  - **Surface view**: the Navcam frames Curiosity took at a selected stop, with local solar time and camera azimuth.
- **Slope-limited route planner.** The fastest walking route over the terrain grid that never crosses a cell, or takes a step, steeper than 20°. The 20° is a MARSCOPE planning assumption informed by NASA lunar EVA documentation, not a NASA limit for Mars. The staircase a grid search gives is straightened only where the straight line stays on walkable ground, is no slower, and crosses no more hidden steep ground. Checkpoints can be dragged, reordered and removed, with undo.
- **Three route priorities.** Fastest, Energy-efficient and Cautious routes for the same checkpoints, compared side by side: distance, walking time, walking energy and hidden steep ground. All three obey the same slope limit and the same mission checks; Walking energy is the model's estimate: an approximation adapted from treadmill research on Earth (Santee et al. 2001), in which Mars gravity enters only the climb and descent terms. Cautious uses a heuristic weight of ours, not a NASA-certified safety model. Each route is optimal on the 4 m grid for its own objective; the straightened route is not proven optimal, and no priority guarantees safety. Routes are computed in a Web Worker.
- **Mission status.** STANDBY, GO, NO-GO, NO ROUTE or UNVERIFIED (the return calculation reached its limit: not a pass and not a confirmed violation), always visible with distance, EVA duration at the planning pace, climb and model energy. GO means the plan is within MARSCOPE's planning limits on a 4 m terrain grid; it is not a statement that the EVA would be safe. On NO-GO the panel names the failed constraint and says what would fix it, for example the longest stop time that still fits the 8-hour limit.
- **Mobile.** A full-screen map with a bottom sheet that snaps to three heights.
- **Conditions at Gale.** The latest weather report from Curiosity's REMS station.

## Project structure

```
app/                 Web app (Vite + React + TypeScript + Leaflet), no backend
  src/lib/model.ts   Physical model: every constant with its source; planning assumptions are marked as such
  src/lib/traverse.ts The hard limits: which cells and which steps may be walked at all
  src/lib/router.ts  A* route search over the terrain grid
  src/lib/returnCheck.ts Return to the habitat: one way back within both the distance and the time limit
  src/lib/pathGeometry.ts Line-of-sight checks, path measuring, straightening within the hard limits
  src/lib/mission.ts GO / NO-GO checks
  src/lib/objectives.ts The three route priorities and their cost functions
  src/lib/planner.ts Whole-plan computation for all priorities (also runs in planner.worker.ts)
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
  prepare_terrain.py Downloads the DEM from NASA Mars Trek; builds elevation, slope and hidden-steepness grids
  test_prepare_terrain.py Checks for that maths
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
.venv/bin/python scripts/test_prepare_terrain.py
```

The first run downloads about 70 MB of DEM tiles into `data/raw/` (not committed) and can take a while; later runs reuse them.

## How the route model works

The study area is a 1024 × 1024 grid of about 4 m cells built from the MRO HiRISE Gale Crater DEM (1 m posts). The elevation of each cell is the mean of its own 4 × 4 DEM pixels, so the grid, the 1 m steepness counts and the imagery describe the same ground. Slope is the difference between neighbouring cells, an 8 m baseline. Each step between cells costs the time a suited astronaut needs to walk it:

- **Walking speed vs slope** follows Marquez (2007) as implemented in the SEXTANT planner used by NASA's BASALT programme. It is a lunar model built on very little data: twelve average speeds from the second Apollo 14 EVA, on slopes between about −8° and +6.5°, to which a piecewise-linear profile from −15° to +15° was drawn. It walks 1.6 m/s on the level. Outside its range SEXTANT deliberately holds the speed at 0.05 m/s so that such ground is heavily penalised; that value is a placeholder, not a measurement. SEXTANT's own author reports field traverses of about 20 minutes that the model had estimated at 4 to 5.
- **Two walking times.** Every route is shown with two times for the same geometry. *Model time* uses the speed model above; it is what the Fastest priority minimises. *Planning time* caps that speed at 2 km/h: `v = min(v_model, 2000 m / 3600 s)`. The 2 km/h is the pace NASA EVA-EXP-0075 assumes for lunar walking excursions ("on relatively level regolith"); MARSCOPE adopts it as a planning assumption, set in `model.ts`. Neither figure is a validated walking time for Mars, and the pair is not a confidence interval or a guaranteed minimum and maximum: both inherit the model's limits. EVA duration is walking time plus the time at the targets, and it is given for both. The 8-hour limit is judged on the planning one.
- **Walking energy** is metabolic energy by Santee et al. (2001) as implemented in SEXTANT, computed at the model's walking speed and shown as a model estimate. The study behind it had 16 people on a treadmill on Earth at one speed (1.34 m/s), on grades of ±12 %, carrying up to 18 kg; MARSCOPE applies it to a suited mass of 180 kg on slopes up to 20° on Mars. Mars gravity (3.73 m/s²) enters the climb and descent terms only; the level-walking term, 82 to 87 % of the energy on our test routes, is the Earth value. It covers walking only; work at the targets is not modelled.
- **Slope limit of 20°** and **EVA duration of 8 hours** are suit capabilities listed in NASA EVA-EXP-0075, a 2020 summary of the Artemis lunar EVA concept of operations. Using them for Mars is our assumption: they are MARSCOPE planning limits, not official safety standards for Mars. The 8 hours are compared with the EVA duration at the planning pace (see *Two walking times* above). The 20° limit applies to every cell and to every step actually walked: a step between two cells is refused when the rise between them, over the horizontal length of the step, is steeper than 20°, even if both cells read as walkable. Straightened routes are checked the same way, move by move and piece by piece. The route never clips no-go cells diagonally, slope is stored rounded up, and cells without data are not walkable.
- **Return to the habitat.** From every point of the route there must be one way back that is no longer than 2 km and takes no more than 60 minutes at the planning pace (never faster than 2 km/h). The check is computed with that time from the start; it is not the model's fastest route rescaled. Both limits are judged on the same path: the shortest way back and the fastest way back are usually different paths, so checking each limit on its own best path would be wrong in both directions. The planner decides this exactly (a shortest-path search with a resource constraint) and uses the same answer for all three priorities. **The 2 km and 60 minutes are MARSCOPE planning assumptions, set in `model.ts`, not NASA requirements for Mars.** They are adapted from the same NASA document: lunar walking excursions within a 2 km radius, about 2 km/h, one hour of secondary oxygen.
- **Background radiation**: the surface rate multiplied by each of the two EVA durations. The rate, 0.67 mSv/day, is the average galactic cosmic ray dose equivalent Curiosity's RAD measured in Gale crater from August 2012 to June 2013 (Hassler et al. 2014, as quoted in the SwRI release). That period was a solar maximum, when this background is lower than at solar minimum, so it is a historical average and not a constant. Solar particle events, suit shielding and habitat shielding are not included. The same background applies inside an unshielded habitat, so the figure is exposure during the hours of the EVA, not exposure caused by it. It is not a validated astronaut dose, it is not compared with any dose limit (NASA's career limit is an effective dose, a different quantity), and it does not enter GO / NO-GO.

- **Walking time also depends on the measuring scale.** Times are measured in pieces of 4 to 6 m. The same routes measured in 1 m pieces on the 1 m DEM come out 5 to 15 % longer by the model, because its speed collapses above 15° and shorter pieces cross that threshold more often. Energy moves by 1 to 4 % and distance not at all.

The suited mass and the time spent at each target are planning inputs the user sets. Links to every source are in the app and in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## NASA data used

- **USGS Astrogeology**: Viking MDIM 2.1 colorized global mosaic (credit NASA/JPL/USGS), IAU Gazetteer of Planetary Nomenclature.
- **NASA JPL Mars Trek**: MOLA global elevation, HiRISE and CTX mosaics, HiRISE 1 m DEM, THEMIS infrared mosaics, Viking color mosaic, USGS global geologic map.
- **Mars Science Laboratory (Curiosity)**: rover traverse and waypoints, raw Navcam images, REMS weather reports. For radiation the app uses one published figure, the average surface rate from RAD (see below), not the RAD data set.

Exact dataset names and URLs: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Team

- **Timur Kaliev**
- **Ilya Krivoshapov**

## License

[Apache License 2.0](LICENSE)
