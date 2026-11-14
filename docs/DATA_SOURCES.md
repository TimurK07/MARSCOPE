# Data sources

All sources below are open NASA (or NASA-partner) data. Each entry was opened and tested by the team on **2026-11-14**.

**Status legend:**
- ✅ Tested: we fetched real data, and it works from the browser (CORS allows it).
- 🟡 Opened: the link works, but the data must be downloaded and preprocessed (no browser CORS).
- ⚠️ Caveat: works, but read the note before use.

Coordinates: we normalise everything to **planetocentric latitude, longitude −180…180°E**, on the Mars 2000 sphere (R = 3,396,190 m).

## Official challenge

- Challenge page: https://www.spaceappschallenge.org/2026/challenges/interplanetary-survival-guide-martian-map/
- Resources listed by the challenge authors:
  - JPL Mars Trek: https://trek.nasa.gov/mars/
  - USGS-NASA Planetary Geologic Mapping Program: https://astrogeology-usgs.hub.arcgis.com/pages/interactive-maps-mars
  - Curiosity's proposed path up Mount Sharp: https://science.nasa.gov/resource/curiositys-proposed-path-up-mount-sharp/
  - NASA Worldview (Earth data): https://worldview.earthdata.nasa.gov/
  - Mars Perseverance Raw Images: https://mars.nasa.gov/mars2020/multimedia/raw-images/

## 1. Map tiles: NASA Mars Trek WMTS ✅

- API docs: https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars
- URL template: `https://trek.nasa.gov/tiles/Mars/EQ/{LAYER}/1.0.0/default/default028mm/{z}/{y}/{x}.{jpg|png}`
- Tiling:
  - Equirectangular, Mars 2000 (`EPSG::104905`), origin −180, 90, 256 px tiles.
  - Zoom 0 is 2×1 tiles.
  - Matches Leaflet `L.CRS.EPSG4326` and Cesium `GeographicTilingScheme`.
- Note the URL order is **z / y (row) / x (col)**.

| Layer | `{LAYER}` | Ext | Max z | Coverage |
|---|---|---|---|---|
| Viking MDIM 2.1 color mosaic | `Mars_Viking_MDIM21_ClrMosaic_global_232m` | jpg | 7 | global |
| MOLA color hillshade | `Mars_MGS_MOLA_ClrShade_merge_global_463m` | jpg | 7 | global |
| MOLA + HRSC color hillshade blend | `Mars_MOLA_blend200ppx_HRSC_ClrShade_clon0dd_200mpp_lzw` | jpg | 8 | global |
| THEMIS day IR mosaic | `THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018` | png | 9 | ±65° lat |
| THEMIS night IR mosaic | `THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018` | png | 9 | ±65° lat |
| TES thermal inertia | `TES_Thermal_Inertia` | png | 1 | global |
| **MRO CTX mosaic, Gale crater** | `Gale_CTX_BlockAdj_dd` | — | 12 | 135.18–139.24°E, 6.57–2.81°S |
| **MRO HiRISE mosaic, Curiosity roving site** | `curiosity_hirise_mosaic` | png | 16 | 137.12–137.73°E, 4.93–4.25°S |
| **MRO HiRISE DEM, Gale crater (1 m)** | `Gale_DEM_SMG_1m` | png | 14 | 137.12–137.73°E, 4.93–4.25°S |
| MRO CTX mosaic, Jezero (controlled) | `JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0` | — | — | Jezero |
| MRO HiRISE mosaic, Jezero (25 cm) | `JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd` | — | 17 | 77.22–77.58°E, 18.31–18.67°N |

**Notes:**
- Regional layers only have tiles inside their bounding box.
- Global geology (USGS SIM 3292) ✅: `https://trek.nasa.gov/mars/trekarcgis/rest/services/SIM3292_Global_Geology/MapServer/WMTS/tile/1.0.0/SIM3292_Global_Geology/default/default028mm/{z}/{y}/{x}.png`
- Global CTX and HiRISE mosaics (via Trek, hosted by Esri) ✅:
  - CTX: `https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{y}/{x}`
  - HiRISE: `https://astro.arcgis.com/arcgis/rest/services/OnMars/HiRISE/MapServer/tile/{z}/{y}/{x}`
  - Both use 512 px tiles.
  - Credit line: "NASA/JPL/MSSS/Caltech Murray Lab/Esri".
- Cesium 3D terrain (Mars Trek) ✅: `https://marshub.s3.amazonaws.com/mars_v14/layer.json` (quantized-mesh).
- Fallback, USGS Astrogeology WMS ✅: `https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/mars/mars_simp_cyl.map&service=WMS&request=GetCapabilities`

## 2. Elevation queries ✅

**Point elevation, Gale 1 m HiRISE DEM** (float32, metres):
- `https://trek.nasa.gov/mars/trekarcgis/rest/services/Gale_DEM_SMG_1m/ImageServer/identify?geometry={"x":LON,"y":LAT}&geometryType=esriGeometryPoint&returnGeometry=false&returnCatalogItems=false&f=json`
- Test: Curiosity's landing site (137.4417°E, 4.5895°S) returned −4503.08 m.

**DEM patch export** (GeoTIFF, for slope and route preprocessing):
- `https://trek.nasa.gov/mars/trekarcgis/rest/services/Gale_DEM_SMG_1m/ImageServer/exportImage?bbox=W,S,E,N&bboxSR=104905&size=W_PX,H_PX&format=tiff&pixelType=F32&f=image`

**Global point elevation (MOLA):**
- `https://trek.nasa.gov/mars/trekarcgis/rest/services/mola128_mola64_merge_90Nto90S_SimpleC_clon0/ImageServer/identify?...` (same parameters)

## 3. Rover data (mars.nasa.gov) ✅

| Data | URL | Notes |
|---|---|---|
| Curiosity waypoints | https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json | GeoJSON, 1389 points; latest is sol 5073 (2026-11-13) |
| Curiosity traverse | https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_traverse.json | GeoJSON MultiLineString |
| Perseverance waypoints | https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json | GeoJSON |
| Perseverance traverse | https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json | GeoJSON, CRS84 |
| Curiosity raw images API | `https://mars.nasa.gov/api/v1/raw_image_items/?order=sol%20desc,instrument_sort%20asc&per_page=N&page=0&condition_1=msl:mission` | newest image taken 2026-11-13 |
| Perseverance raw images API | `https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&num=N&page=0&order=sol+desc` | newest image taken 2026-11-06 |

⚠️ **REMS weather feed (Curiosity):** `https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json` ✅
- Provided by Centro de Astrobiología (CAB) "for outreach purposes only".
- Scientific REMS data lives in PDS. Use the feed only for display, labelled as outreach.

## 4. Survival / science layers (preprocessing needed) 🟡

| Theme | Dataset | URL | Format / size |
|---|---|---|---|
| Ice (shallow) | SWIM 2.0 composite ice consistency (NASA-funded, PSI/JPL) | https://swim.psi.edu/output/SWIM2/Global/Composite/ | GeoTIFF float32, ~71 MB each, 60°S–60°N |
| Water (hydrogen) | Mars Odyssey GRS H2O map, `ODY-M-GRS-5-ELEMENTS-V1.0` | https://pds-geosciences.wustl.edu/ody/ody-m-grs-5-elements-v1/odgm_xxxx/data/smoothed/h2o_sr_5x5.tab | ASCII, 187 KB, 5°×5° |
| Elevation | MOLA MEGDR | https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/ | `meg004` 2 MB, `meg016` 33 MB; 0–360°E |
| Albedo, thermal inertia | MGS TES special products | https://pds-geosciences.wustl.edu/mgs/mgs-m-tes-special-v1/ | float32 `.img`, 10–17 MB |
| Dust | TES Dust Cover Index (Ruff & Christensen 2002) | https://www.mars.asu.edu/~ruff/DCI/ | GeoTIFF, 50 MB |
| Radiation | MSL RAD reduced data (Gale crater only) | https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/ | point measurements along Curiosity's traverse |
| Human landing sites | Exploration Zones (NASA EMC), Mars Trek | https://trek.nasa.gov/mars/trekarcgis/rest/services/EZMars/MapServer/2/query?where=1%3D1&outFields=*&outSR=4326&f=geojson | GeoJSON, 51 features ✅ |
| Past landing sites | PDS ODE landing sites | https://ode.rsl.wustl.edu/mars/pagehelp/Content/Missions_Instruments/Landing_Sites.htm | table |
| Place names | IAU/USGS Gazetteer of Planetary Nomenclature | https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.zip | shapefile, 5.4 MB, 0–360°E |

## 5. 3D globe

| Use | Dataset | URL | Notes |
|---|---|---|---|
| First globe texture (bundled, 2048 × 1024, 382 kB) | Viking MDIM 2.1 colorized global mosaic | USGS Astrogeology WMS, layer `MDIM21_color`: https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/mars/mars_simp_cyl.map&service=WMS&request=GetCapabilities | Service metadata: Fees "None", AccessConstraints "None". Credit NASA/JPL/USGS. Fetched by `scripts/fetch_globe_assets.py` |
| Sharper globe texture (4096 × 2048, loaded at run time) | same layer, same service | same | one request |
| Detail on approach | Viking MDIM 2.1 tiles (zoom 4–7) and Gale CTX mosaic tiles (zoom 8–12) | NASA JPL Mars Trek, see section 1 | the same tiles the 2D map shows |
| Feature names and positions | IAU/USGS Gazetteer of Planetary Nomenclature | https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.zip | planetocentric, east-positive 0–360; 16 features used |
| Elevation of a picked point | MGS MOLA global DEM | https://trek.nasa.gov/mars/trekarcgis/rest/services/mola128_mola64_merge_90Nto90S_SimpleC_clon0/ImageServer/identify | see section 2 |

The globe has no elevation model: it is imagery on the Mars 2000 sphere (radius 3,396,190 m).

We could not open the USGS copyright policy page from our environment, so the usage terms above rest on the WMS service's own metadata.

## 6. Model constants

| Constant | Value | Source |
|---|---|---|
| Max traversable slope | 20° | NASA EVA-EXP-0075, "Exploration EVA System Concept of Operations Summary for Artemis Phase 1 Lunar Surface Mission" (Feb 2020): https://www.nasa.gov/wp-content/uploads/2020/01/topic_1-_eva_lunar_surface_concept_of_operations.pdf. Listed there as a capability of the lunar suit: "Walking up/down/across a slope of up to 20°". **Applying it to Mars is our assumption** |
| Max EVA duration | 8 h ("6±2 hours") | Same document, also a suit capability. Applied to Mars as an assumption |
| Return distance limit | 2 km | **MARSCOPE planning assumption, configurable (`RETURN_LIMITS` in `model.ts`). Not a NASA requirement for Mars.** Adapted from the same document: lunar "exploration excursions of up to a 2 km radius away from the lander (TBR)", "depending on terrain". We apply it to the length of a way back over the terrain |
| Return time limit | 60 min | **MARSCOPE planning assumption, configurable (same place). Not a NASA requirement.** Adapted from the same document: "~2 km/hr walking pace on relatively level regolith" and "Secondary O2 on suit provides an additional hour of gas" |
| Walking speed vs slope | piecewise, max 1.6 m/s | Marquez (2008), as implemented in SEXTANT: https://github.com/norheim/pextant/blob/master/pextant/explorers.py |
| Metabolic cost | level + slope terms | Santee et al. (2001), as implemented in SEXTANT (same file) |
| Surface GCR dose equivalent | 0.67 mSv/day | Curiosity RAD, Hassler et al. (2014): https://www.swri.org/press-release/swri-scientists-publish-first-radiation-measurements-surface-mars |
| Solar storm, 20 May 2024 | 8,100 µGy | NASA JPL: https://www.jpl.nasa.gov/news/nasa-watches-mars-light-up-during-epic-solar-storm/ |
| Career radiation limit | 600 mSv | NASA-STD-3001 Vol 1 Rev B [V1 4030]: https://www.nasa.gov/wp-content/uploads/2020/10/2022-01-05_nasa-std-3001_vol.1_rev._b_final_draft_with_signature_010522.pdf |
| Mars surface gravity | 3.73 m/s² | NASA NSSDC Mars Fact Sheet: https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html |

### How the planner uses these

- **Two grids from one DEM.** The route search runs on a 1024 × 1024 grid of about 4 m cells. A second export of the same HiRISE DEM at about 1 m (4096 × 4096, exactly 4 × 4 pixels per cell) is used only to measure what the coarse grid hides.
- **Elevation precision.** Stored in 2 cm steps. With the earlier 10 cm steps the grade of one 4 m step could be off by 1.4°, which moved walking speed by 4% on a typical step and 23% on a bad one.
- **Hard limits (the same for every route priority, for straightening and for the return check; `traverse.ts`).**
  - *Cells.* A cell is walkable only if its slope is 20° or less. Slope is stored in steps of 0.01°, rounded up, so a stored value is never below the true slope. Cells without terrain data are not walkable.
  - *Steps.* A step between two neighbouring cells is allowed only if the rise between their centres, over the horizontal length of the step (about 4 m, or about 5.7 m diagonally), is 20° or less, uphill or downhill. This is needed because a cell's slope is a central difference across its neighbours (an 8 m baseline) and does not see the drop between the cell and the one next to it. On our grid 3,717 of 3,055,746 neighbour pairs of walkable cells are steeper than 20° (up to 44.5°); all are refused. A grade that is not a number is refused.
  - *Corners.* A diagonal step is refused when either of the two cells it passes between is not walkable.
- **Return to the habitat (`returnCheck.ts`).** A plan passes only if, from every point of the route, there is **one** way back within both return limits. The shortest and the fastest way back are in general different paths, so the two limits cannot be tested separately: that can reject a plan that has a good way back, and accept one that has none. The question is decided exactly:
  1. *Bounds.* For a weight `w` between 0 and 1, a search outwards from the habitat finds the cheapest way back from every cell by the cost `w · distance / 2 km + (1 − w) · time / 60 min`. A path within both limits costs at most 1 for every `w`, so a cell whose cheapest cost is above 1 for some `w` has no such path. `w = 0` and `w = 1` are the fastest and the shortest way back.
  2. *Witnesses.* Each of those searches yields a real path for every cell; if one is within both limits, the cell passes.
  3. *Exact search.* Cells still open get a search over (distance, time) labels towards the habitat. A label is dropped only when a bound from step 1 proves it cannot finish within both limits, or another label at the same cell is no longer and no slower.
  The search has a work budget. If it runs out the mission status is **UNVERIFIED**: no way back within both limits was found, and none was ruled out. That is shown apart from NO-GO, which is reserved for a limit shown to be broken, and it is never GO: GO requires a real path within both limits from every point of the route. The budget has not run out on the real terrain in any test. Return figures are rounded against the plan (lengths and times up, room to spare down), so a display never looks better than the number behind it. Ways back are grid paths towards the habitat with the same walking model (a climb home is slower than the walk out) and are not straightened, so their length is never understated. The check is shared by the three priorities, so their return verdicts cannot differ for the same point. The figures shown ("way back: distance", "way back: time") describe one path from the worst point of the route.
- **Hidden steep ground (derived metric).** For every cell we count how many of its 16 source pixels are steeper than 20°, with slope taken over about 2 m. It is shown as a layer, in the point inspector and in the route telemetry. It is an indicator of roughness, not a probability of anything, and it does not change the hard limit: a cell is never blocked or unblocked by it.
- **Straightened routes.** The grid search gives a staircase. A straight shortcut replaces part of it only if every cell the line crosses is walkable (including both cells beside any corner it touches), every move from one crossed cell to the next and every piece of the line as walked is within the 20° limit, it costs no more by the route's own objective with the same direction-dependent model, and it crosses no more hidden steep ground. Distance, time, climb and energy are then measured along the straightened path. Ways back to the habitat are still grid paths, so their length is never understated by straightening.
- **What the terrain data cannot show.** The DEM has 1 m posts and comes from stereo imagery. Rocks, ledges and loose ground smaller than a few metres are not in it, and we resample it on the server. Compared with the tilt Curiosity measured at 157 of its stops in the study area, our 4 m slope is 0.7° lower on average with a spread of 2.5°. No route here should be read as cleared of hazards.
- **Three route priorities, one set of rules.** Every priority uses the same walkable cells, the same corner rule and the same mission checks. Only the cost of a step differs:
  - *Fastest*: walking time, `d / v(grade)`.
  - *Energy-efficient*: walking energy by Santee et al. (2001) for the suited mass the user sets. This is an approximation: the model comes from walking on Earth and is scaled to Mars gravity as in SEXTANT; it is not a measurement of suited walking on Mars.
  - *Cautious*: `time × (1 + 4 × s)`, where `s` is the share of the cell's 1 m pixels steeper than 20° (a cell with no valid 1 m pixels counts as `s = 1`). **The weight 4 is a heuristic coefficient of ours. It is not a NASA standard, not a NASA-certified safety model and not a measured risk.**
  The search is A* with a lower bound per metre for each cost (1/1.6 s for time and for Cautious; the numerically found minimum of the energy model for Energy), so each route is optimal on the 4 m grid for its own cost. Straightening then accepts a shortcut only if it does not raise that same cost. The optimality holds for the grid path and its objective only; the straightened route is not proven optimal.
- **Comparing priorities.** All three are measured by the same code. Hidden steep ground is reported as a total and per kilometre, because a longer route collects more of it over the same kind of ground. The return check does not depend on the priority: every priority is judged by the same ways back.
- **Feasibility comes first.** GO / NO-GO is assessed only for a route that exists. A plan with an unreachable checkpoint is NO ROUTE.
- **Energy is walking energy.** Work at the targets is not modelled.

Note: we read the walking-speed and metabolic formulas in the open-source SEXTANT code, which attributes them to Marquez (2008) and Santee et al. (2001). We did not read the original papers directly.

## Not used / unverified

- **Mars Climate Database** (LMD with ESA/CNES/OU/IAA). Partner co-funded, but the full data is "on request" and the web interface is rate-limited. Not planned.
- **MRO Mars Climate Sounder** (PDS Atmospheres). Profile data, not gridded. Too heavy for 48 h.
- **Esri-hosted tiles.** They serve NASA imagery, but the host is Esri. Credit them as above.
