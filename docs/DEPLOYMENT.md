# Deploying SpaceCam

## Vercel: recommended configuration

Import the GitHub repository at its root. Use **Other** as the framework, Node.js **22.x**, `npm ci` to install, `npm run build` to build, and `dist` as the output directory. `vercel.json` configures the build and `/api/proxy` function. No environment variables or NASA API keys are required.

Official references: [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json), [Node.js functions](https://vercel.com/docs/functions/runtimes/node-js), and [function limits](https://vercel.com/docs/functions/limitations).

For the CLI, install the official `vercel` package, sign in, and run from the repository root:

```bash
npm ci
npm test
vercel          # preview deployment
vercel --prod   # production deployment
```

Deploy from the source root so Vercel builds both `api/` and the static output. A deployment of only `web/` or `dist/` omits the serverless proxy. Do not configure a catch-all SPA rewrite: missing archive-data files should remain 404 responses, not HTML.

## What runs where

| Component | Runtime |
| --- | --- |
| Earth, sky, FITS reprojection, compare and tracking UI | Visitor's browser |
| Static HTML, CSS, JavaScript and bundled images | Vercel static hosting |
| NASA IRSA/JPL requests | `/api/proxy`, a Node.js function |
| Precomputed example fields | Optional Python pipeline, outside the Vercel build |
| FastAPI service | Optional separate Python/Docker host |

The build copies `web/` to `dist/`, sets the default proxy path, and creates an empty `data/fields.json` if no precomputed catalogue exists. It does not download the archive or install Python dependencies.

The proxy accepts GET requests only (plus OPTIONS) to HTTPS URLs on `irsa.ipac.caltech.edu` and `ssd-api.jpl.nasa.gov`. It checks every redirect, excludes browser credentials and cookies, streams the upstream body, caches successful responses at the CDN for one hour, and leaves errors uncached. A request has a 50-second upstream timeout and a configured function duration of 60 seconds. Large or slow archive requests may still fail; narrow the field or retry later. Streaming avoids buffering complete FITS files in the function.

## Verify a deployment

1. Open the deployed home page. Check that Earth and the initial infrared sky appear and the loader completes.
2. Search for M42 or Barnard's Star; enter sky view and open Compare.
3. Test archive comparison and a SPHEREx per-visit request. A missing observation is different from a network failure; try another detector or field when coverage is absent.
4. In browser network tools, confirm `/api/proxy?url=...` returns archive data. Opening `/api/proxy` without a target should return JSON with HTTP 400.
5. Check About → Check connection. An empty example catalogue is expected until data is generated. Direct IRSA/JPL diagnostics may report CORS failures even when the proxy works; use the proxy rows to assess the hosted route.
6. Resize to mobile width and verify search, gallery and comparison controls.

## Precomputed examples

Use the pipeline described in the README before a CLI deployment. Generated `web/data/fields/` and `web/data/fields.json` are excluded from Git but included in a local Vercel build. The manual GitHub Actions workflow uploads generated data as an artifact only. It does not publish it or trigger a Vercel production deployment.

Keep archive generation separate from normal builds: it can require substantial downloads and depends on remote archive availability.

## Other static hosts

Serve `web/` using any static host for the sky maps and archive surveys. For per-visit IRSA and JPL requests, deploy `proxy/worker.js` to Cloudflare Workers and configure its HTTPS URL in `web/js/config.js` (`window.SKYCAM_PROXY`) or through About → IRSA proxy. Saved settings apply to that browser only.

The Cloudflare Worker is an alternative to the Vercel function. GitHub Pages is no longer enabled automatically by this repository's workflows.
