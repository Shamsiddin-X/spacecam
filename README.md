# SpaceCam

**Explore the infrared sky of NASA SPHEREx through time.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Checks](https://github.com/Shamsiddin-X/spacecam/actions/workflows/ci.yml/badge.svg)](https://github.com/Shamsiddin-X/spacecam/actions/workflows/ci.yml)

[Русский](README.ru.md) · [Deployment guide](docs/DEPLOYMENT.md) · [Contributing](CONTRIBUTING.md)

SpaceCam is an independent, open-source sky explorer. Fly from a 3D Earth into infrared sky maps, pick a field, compare observations from different epochs, and investigate objects that move or change brightness. It uses real archive imagery; it is not an official NASA product.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShamsiddin-X%2Fspacecam)

## Features

- A WebGL Earth and all-sky scene, 72 selectable sky sectors, object search, and shareable views.
- SPHEREx infrared channels and archive surveys including DSS2, 2MASS, AllWISE, and Pan-STARRS.
- Side-by-side, blink, swipe, difference, stack, trail, and animation views.
- Object tracking, light curves, motion estimates, and candidate change detection.
- A gallery of 136 catalogue targets, including the Messier objects, nearby fast stars, and deep fields.
- A built-in Vercel proxy for public NASA IRSA/JPL requests; no API keys are required.

Availability depends on archive coverage, service availability, and the selected detector. Comparisons across instruments also differ in wavelength, resolution, and depth. Detections are **candidates**, not confirmed discoveries or calibrated scientific measurements.

## Run locally

Use Node.js **22.x**:

```bash
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). The development server serves the site and the same proxy handler used on Vercel. Source files are served directly; refresh after editing. Set `PORT` to use another port.

```bash
npm test       # syntax, local asset references, routing and proxy tests
npm run build # static site in dist/
```

The JavaScript application and proxy have no third-party npm dependencies. Internet access is needed for archive requests. Initial Earth textures and the opening sky overview are bundled.

## Deploy to Vercel

Import this repository in Vercel or use the Deploy button above. Keep the **Root Directory at the repository root** (not `web/`). The checked-in configuration selects:

| Setting | Value |
| --- | --- |
| Framework preset | Other |
| Node.js | 22.x |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Serverless endpoint | `/api/proxy` |
| Environment variables | None required |

Vercel serves the static site and the NASA proxy in one deployment. The build automatically configures the browser to use `/api/proxy`. Do not deploy `dist/` on its own if you need the proxy. See [deployment details and verification](docs/DEPLOYMENT.md), including archive timeouts and alternatives for static hosts.

## Data and optional Python tools

SpaceCam loads maps and archive images on demand. A fresh checkout does **not** contain precomputed per-visit example fields. This does not block the Vercel build: it publishes an empty example index, and live archive requests remain available through the proxy.

The optional Python pipeline downloads and aligns a selection of fields:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r python/requirements.txt
cd python
python -m pytest -q
python -m pipeline.build --out ../web/data --only nep,m42
```

Use Python **3.11+**; CI uses 3.11. Generated data is ignored by Git. To include locally generated examples in a Vercel deployment, build the fields first, then deploy with the Vercel CLI from the repository root. For Git-based deployments, publish generated fields to suitable storage or deliberately commit a small selection after reviewing its size. Running the manual **Build optional example fields** workflow creates a downloadable artifact; it does not update production.

An optional FastAPI service and Dockerfile are also included for a separate, persistent Python deployment. Vercel uses the Node proxy, not this Python service.

## Project layout

```text
api/proxy.js            Vercel function entry point
lib/nasa-proxy.js       Streaming, allowlisted NASA archive proxy
web/                   HTML, CSS, WebGL, FITS/WCS and comparison tools
web/assets/            Bundled opening-scene imagery and source credits
scripts/               Dependency-free build, checks and local server
tests/                 Proxy and browser-routing regression tests
python/skywatch/        Optional FastAPI service and image processing
python/pipeline/        Optional precomputed field builder
proxy/worker.js         Alternative Cloudflare Worker for static hosting
.github/workflows/     CI and manual example-data generation
vercel.json            Vercel build, function and response settings
```

## Credits and license

Code is licensed under the [MIT License](LICENSE), © 2026 Shamsiddin Kadirov. Third-party imagery, scientific data, and fonts retain their own terms; the code license does not relicense them. Bundled image sources are documented in [web/assets/README.md](web/assets/README.md).

This research uses data from the SPHEREx mission (NASA/JPL-Caltech/IPAC), obtained from the [NASA/IPAC Infrared Science Archive](https://irsa.ipac.caltech.edu/). HiPS and hips2fits services are provided by [CDS Strasbourg](https://aladin.cds.unistra.fr/hips/). Small-body identification uses [NASA JPL SSD](https://ssd-api.jpl.nasa.gov/). Earth imagery is credited to NASA Visible Earth. Inter Tight and IBM Plex Mono are loaded through Google Fonts.
