/*
 * Zero-dependency Node server for the ONPE 2nd-round results app.
 *
 *   - Serves the static front-end (index.html, app.js, styles.css, projection.js).
 *   - Exposes GET /api/snapshot, which fetches the relevant ONPE endpoints
 *     server-side (the API has no CORS and rejects non-browser-looking requests),
 *     normalizes them into a single payload, and returns it to the page.
 *
 * Run: node server.js   then open http://localhost:3000
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 5173;
const ONPE_BASE = "https://resultadosegundavuelta.onpe.gob.pe/presentacion-backend";
const FALLBACK_ELECTION_ID = 10; // "SEGUNDA ELECCION PRESIDENCIAL 2026"
const CACHE_TTL_MS = 60 * 1000; // heavier (~55-call) snapshot → longer cache
const REGION_CONCURRENCY = 8; // parallel upstream calls when fanning out by region

// Geographic ámbito codes discovered in the ONPE bundle.
const AMBITO = { PERU: 1, EXTRANJERO: 2 };

// Map ONPE party names to stable keys used throughout the app.
const PARTY_KEY = {
  "FUERZA POPULAR": "FP",
  "JUNTOS POR EL PERÚ": "JP",
  "JUNTOS POR EL PERU": "JP",
};

// Header set verified to get JSON (not the SPA HTML) past CloudFront.
const ONPE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "es-PE,es;q=0.9,en;q=0.8",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  Referer: "https://resultadosegundavuelta.onpe.gob.pe/main/resumen",
};

const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/projection.js": { file: "projection.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

// `payload` is the freshness-gated cache; `lastGood` is kept indefinitely so we
// can serve it if ONPE has a transient hiccup (stale-while-error).
let cache = { at: 0, payload: null };
let lastGood = null;

const FETCH_TIMEOUT_MS = 8000;
const FETCH_RETRIES = 2; // total attempts = 1 + retries

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetch one ONPE endpoint as JSON, with a hard timeout and a couple of retries.
// ONPE/CloudFront intermittently returns the SPA HTML or is slow; retrying a
// single flaky call keeps it from sinking the whole snapshot.
async function onpeFetch(pathAndQuery) {
  const url = ONPE_BASE + pathAndQuery;
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    if (attempt > 0) await delay(250 * attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: ONPE_HEADERS, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        throw new Error("ONPE " + res.status + " for " + pathAndQuery + ": " + text.slice(0, 120));
      }
      return JSON.parse(text); // throws if CloudFront served the SPA HTML
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("Failed to fetch " + pathAndQuery);
}

async function resolveElectionId() {
  try {
    const r = await onpeFetch("/proceso/proceso-electoral-activo");
    const id = r && r.data && r.data.idEleccionPrincipal;
    return { id: id || FALLBACK_ELECTION_ID, nombre: (r && r.data && r.data.nombre) || "" };
  } catch (e) {
    return { id: FALLBACK_ELECTION_ID, nombre: "" };
  }
}

function normalizeCandidatos(data) {
  const arr = (data && data.data) || [];
  return arr.map((c) => ({
    key: PARTY_KEY[(c.nombreAgrupacionPolitica || "").trim().toUpperCase()] || c.nombreAgrupacionPolitica,
    partido: c.nombreAgrupacionPolitica,
    candidato: c.nombreCandidato,
    totalVotosValidos: c.totalVotosValidos,
    porcentajeVotosValidos: c.porcentajeVotosValidos,
    porcentajeVotosEmitidos: c.porcentajeVotosEmitidos,
  }));
}

function normalizeTotales(data) {
  const d = (data && data.data) || {};
  return {
    actasContabilizadas: d.actasContabilizadas,
    contabilizadas: d.contabilizadas,
    totalActas: d.totalActas,
    actasEnviadasJee: d.actasEnviadasJee,
    enviadasJee: d.enviadasJee, // count of observed actas sent to the JEE
    actasPendientesJee: d.actasPendientesJee,
    pendientesJee: d.pendientesJee,
    participacionCiudadana: d.participacionCiudadana,
    totalVotosEmitidos: d.totalVotosEmitidos,
    totalVotosValidos: d.totalVotosValidos,
    fechaActualizacion: d.fechaActualizacion,
  };
}

async function segmentSnapshot(electionId, ambito) {
  const ambitoQ = ambito ? "&idAmbitoGeografico=" + ambito : "";
  const tipoFiltro = ambito ? "ambito_geografico" : "eleccion";
  const q = "?idEleccion=" + electionId + ambitoQ + "&tipoFiltro=" + tipoFiltro;
  const [totales, participantes] = await Promise.all([
    onpeFetch("/resumen-general/totales" + q),
    onpeFetch("/resumen-general/participantes" + q),
  ]);
  return {
    totales: normalizeTotales(totales),
    candidatos: normalizeCandidatos(participantes),
  };
}

// Run an async fn over items with a bounded number of concurrent workers.
// Returns results in input order; a thrown fn rejects the whole pool, so callers
// pass an fn that catches and returns a sentinel when partial failure is OK.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function fetchDepartamentos(electionId) {
  const r = await onpeFetch(
    "/ubigeos/departamentos?idEleccion=" + electionId + "&idAmbitoGeografico=" + AMBITO.PERU
  );
  return ((r && r.data) || []).map((d) => ({ ubigeo: d.ubigeo, nombre: d.nombre }));
}

// One departamento's snapshot. totales is required; if the per-region candidate
// breakdown fails, we return candidatos:null and flag it so the projection can
// fall back to the Perú ámbito lean for this region.
async function regionSnapshot(electionId, dep) {
  const common =
    "?idEleccion=" + electionId + "&idAmbitoGeografico=" + AMBITO.PERU + "&tipoFiltro=ubigeo_nivel_01";
  // The two endpoints take the departamento via DIFFERENT param names:
  //  - resumen-general/totales                              → idUbigeoDepartamento
  //  - eleccion-presidencial/participantes-ubicacion-geo... → ubigeoNivel1
  const totalesQ = common + "&idUbigeoDepartamento=" + dep.ubigeo;
  const partsQ = common + "&ubigeoNivel1=" + dep.ubigeo;
  const totales = normalizeTotales(await onpeFetch("/resumen-general/totales" + totalesQ));
  let candidatos = null;
  let candidatosOk = false;
  try {
    const p = await onpeFetch("/eleccion-presidencial/participantes-ubicacion-geografica" + partsQ);
    candidatos = normalizeCandidatos(p);
    candidatosOk = candidatos.length > 0;
  } catch (e) {
    candidatosOk = false;
  }
  return { ubigeo: dep.ubigeo, nombre: dep.nombre, totales, candidatos, candidatosOk };
}

async function buildSnapshot() {
  const election = await resolveElectionId();

  // Header/summary + ámbito segments (also the fallback if regions degrade).
  const [national, peru, extranjero, departamentos] = await Promise.all([
    segmentSnapshot(election.id, null),
    segmentSnapshot(election.id, AMBITO.PERU),
    segmentSnapshot(election.id, AMBITO.EXTRANJERO),
    fetchDepartamentos(election.id).catch(() => []),
  ]);

  // Fan out across departamentos with bounded concurrency. A region that fails
  // entirely is dropped (null) rather than sinking the whole snapshot.
  let regions = [];
  if (departamentos.length) {
    const fetched = await mapPool(departamentos, REGION_CONCURRENCY, (dep) =>
      regionSnapshot(election.id, dep).catch(() => null)
    );
    regions = fetched.filter(Boolean);
  }

  // Completeness: do the regions we got reconcile to the Perú ámbito total?
  const peruValid = (peru.totales && peru.totales.totalVotosValidos) || 0;
  const regionsValid = regions.reduce(
    (s, r) => s + ((r.totales && r.totales.totalVotosValidos) || 0),
    0
  );
  const coverage = peruValid > 0 ? regionsValid / peruValid : 0;

  return {
    election: { id: election.id, nombre: election.nombre },
    national,
    peru,
    extranjero,
    regions,
    regionCoverage: coverage, // ~1.0 when all regions present
    fetchedAt: Date.now(),
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_TTL_MS) {
    return cache.payload;
  }
  try {
    const payload = await buildSnapshot();
    cache = { at: now, payload };
    lastGood = payload;
    return payload;
  } catch (e) {
    // Transient ONPE failure: serve the last good snapshot rather than nothing,
    // flagged so the client can show a subtle "sin actualizar" state.
    if (lastGood) {
      return Object.assign({}, lastGood, { stale: true, staleReason: String(e.message || e) });
    }
    throw e;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function serveStatic(res, entry) {
  const filePath = path.join(__dirname, entry.file);
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  if (urlPath === "/api/snapshot") {
    try {
      const payload = await getSnapshot();
      sendJson(res, 200, payload);
    } catch (e) {
      sendJson(res, 502, { error: "upstream_failed", message: String(e.message || e) });
    }
    return;
  }

  // Quietly answer favicon requests so they don't show up as 404s.
  if (urlPath === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  const entry = STATIC_FILES[urlPath];
  if (entry) {
    serveStatic(res, entry);
    return;
  }

  // Single-page app: serve index.html for any other GET so a stray path or a
  // refresh never lands on a bare "Not found". Non-GET methods still 404.
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(res, STATIC_FILES["/"]);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("ONPE results app running at http://localhost:" + PORT);
});
