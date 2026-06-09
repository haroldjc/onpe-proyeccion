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

The race is decided by where the remaining votes come from, and that varies sharply by
region — Lima leans Fujimori, Cusco leans Sánchez, and foreign votes lean heavily
Fujimori. So the model works **per departamento**, not per ámbito (`buildScenariosByRegion`
in [`projection.js`](./projection.js)):

1. For **each of the 25 departamentos + the foreign segment**, estimate pending valid
   votes as `countedValid × (totalActas − contabilizadas) / contabilizadas`. The missing
   actas include the **observed** ones in the JEE (`enviadasJee`) and not-yet-arrived
   ones (`pendientesJee`).
2. Distribute each region's pending votes by **that region's own current lean**
   (the "esperado" scenario) — so a pending acta inherits its locale's tendency, not a
   national average.
3. Sum across all regions + foreign, and build an uncertainty band by shifting every
   region's pending lean ±3 pts (the two "optimista" scenarios). The single
   `DEFAULT_SWING_PTS` knob and a `DEFAULT_CLOSE_PTS` threshold control the band and the
   too-close flag. The **"Por región"** table in the UI shows each region's numbers.

If the per-region fetch degrades, the app falls back to an ámbito-level model
(`buildScenarios`) so a projection always renders.

**These figures are an unofficial estimate**, not a result. They assume pending actas
carry a similar voter count to counted ones. Crucially, the model does **not** predict
how the JEE will *resolve* observed actas (vote annulments or adjustments) — that
irreducible uncertainty is what the ±band stands in for.

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
- If ONPE is momentarily unreachable, the proxy serves the **last good snapshot**
  (flagged `stale`) instead of failing, and the page shows a "reintentando" state.

### Keeping it warm (avoid cold-start "Not found")

Because the free service spins down when idle, the first visit after a quiet spell
can briefly show Render's "Not Found" page (~30–60 s) while it wakes up. To avoid
that, ping the app every ~10 minutes with a free uptime monitor so it never goes
idle:

1. Sign up for a free monitor — e.g. [UptimeRobot](https://uptimerobot.com) or
   [cron-job.org](https://cron-job.org).
2. Add an **HTTP(s)** monitor pointing at your app's root URL:
   `https://onpe-proyeccion.onrender.com/`
3. Set the interval to **5–10 minutes** (under Render's ~15-min idle window).

The root path serves a static file and does **not** call ONPE, so these pings are
cheap and won't add load to the upstream API. This keeps the service awake so
visitors get an instant page instead of a cold start. (If you'd rather not run a
pinger, Render's paid **Starter** tier removes spin-down entirely.)

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
