# Proyección 2da Vuelta — Elecciones Presidenciales Perú 2026

A tiny, zero-dependency web app that shows the **live ONPE official count** for the
2026 second-round presidential election and projects the **most probable winner**
from the votes still pending.

## Run

```bash
node server.js
# open http://localhost:5173   (set PORT=xxxx to change)
```

No `npm install` — it uses only Node's built-in `http`/`fetch` (Node 18+).

## What it shows

- **Conteo actual** — official valid-vote shares, votes, margin, % of actas counted,
  participation.
- **Proyección** — the expected winner once pending votes are estimated in, plus a
  prominent *"Demasiado reñido / too close to call"* banner when the race is within the
  uncertainty band.
- **Escenarios** — three side-by-side projections (optimista Sánchez / esperado /
  optimista Fujimori) so the uncertainty is explicit, not hidden behind one number.
- **Por ámbito** — the Perú vs Extranjero split, which is *why* the projection can
  differ from the raw national count.

## How the projection works

The race is decided by where the remaining votes come from, and the two segments lean
very differently (domestic ~50/50; foreign leans heavily Fuerza Popular while only
~⅓ counted). The model, in [`projection.js`](./projection.js):

1. For each ámbito, estimate pending valid votes as
   `countedValid × (totalActas − contabilizadas) / contabilizadas`.
2. Distribute those pending votes by that ámbito's **current** candidate lean
   (the "esperado" scenario).
3. Build an uncertainty band by shifting each ámbito's pending lean ±3 pts toward each
   candidate (the two "optimista" scenarios). The single `DEFAULT_SWING_PTS` knob and a
   `DEFAULT_CLOSE_PTS` threshold control the band and the too-close flag.

**These figures are an unofficial estimate**, not a result. They assume pending actas
carry a similar voter count to counted ones; foreign actas are smaller, so the foreign
estimate is an upper bound — surfaced in the band rather than hidden.

## Deploy (free, on Render)

This is a Node server (it must run server-side to proxy ONPE), so use a host that
runs Node — not a static-only host. Render's free tier works with no code changes.

1. **Push to GitHub** (the repo includes `package.json` + `render.yaml`):
   ```bash
   git init && git add -A && git commit -m "ONPE results app"
   gh repo create onpe-proyeccion --public --source=. --push
   # or create a repo on github.com and: git remote add origin <url> && git push -u origin main
   ```
2. **Create the service on Render** → https://dashboard.render.com
   - Easiest: **New → Blueprint**, pick the repo. Render reads `render.yaml` and
     configures everything (build `npm install`, start `node server.js`, free plan).
   - Or **New → Web Service**, pick the repo, and accept the auto-detected Node
     settings (Render runs `npm start`, which is `node server.js`).
3. Open the `*.onrender.com` URL Render gives you.

Notes:
- The free tier **sleeps after ~15 min idle**; the first request after sleeping
  takes ~30 s to cold-start, then it's fast again.
- `PORT` is provided by Render and already read by `server.js` — nothing to set.
- If ONPE ever blocks the host's datacenter IP (the proxy mimics a browser, so this
  is unlikely), `/api/snapshot` would return a 502; the page keeps the last good data.

## Data source

The app proxies the official ONPE backend
(`resultadosegundavuelta.onpe.gob.pe/presentacion-backend`) server-side, because that
API sends no CORS headers and only returns JSON to browser-like requests. `server.js`
resolves the active election id, fetches the national + Perú + Extranjero summaries in
parallel, normalizes them, and serves a single `/api/snapshot`. The page polls it every
60 s and keeps the last good data if a refresh fails.

## Files

| File | Role |
|------|------|
| `server.js` | Static server + `/api/snapshot` ONPE proxy (no deps) |
| `projection.js` | Pure projection math (shared by browser; Node-testable) |
| `index.html` / `styles.css` / `app.js` | The dashboard UI |
