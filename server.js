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
const CACHE_TTL_MS = 20 * 1000;

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

let cache = { at: 0, payload: null };

async function onpeFetch(pathAndQuery) {
  const url = ONPE_BASE + pathAndQuery;
  const res = await fetch(url, { headers: ONPE_HEADERS });
  const text = await res.text();
  if (!res.ok) {
    throw new Error("ONPE " + res.status + " for " + pathAndQuery + ": " + text.slice(0, 120));
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // CloudFront served the SPA HTML instead of JSON.
    throw new Error("Non-JSON response for " + pathAndQuery);
  }
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

async function buildSnapshot() {
  const election = await resolveElectionId();
  const [national, peru, extranjero] = await Promise.all([
    segmentSnapshot(election.id, null),
    segmentSnapshot(election.id, AMBITO.PERU),
    segmentSnapshot(election.id, AMBITO.EXTRANJERO),
  ]);
  return {
    election: { id: election.id, nombre: election.nombre },
    national,
    peru,
    extranjero,
    fetchedAt: Date.now(),
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache.payload && now - cache.at < CACHE_TTL_MS) {
    return cache.payload;
  }
  const payload = await buildSnapshot();
  cache = { at: now, payload };
  return payload;
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

  const entry = STATIC_FILES[urlPath];
  if (entry) {
    serveStatic(res, entry);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("ONPE results app running at http://localhost:" + PORT);
});
