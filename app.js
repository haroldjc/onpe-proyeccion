/*
 * Browser logic: fetch the normalized snapshot from our proxy, render the live
 * count, the projection scenarios, and the per-ámbito breakdown. Auto-refreshes
 * every 60 s and keeps the last good data on error.
 */
(function () {
  "use strict";

  var P = window.Projection;
  var REFRESH_MS = 60 * 1000;

  var PARTY_LABEL = {
    FP: "Fuerza Popular",
    JP: "Juntos por el Perú",
  };

  // Display names per candidate. `short` (nombre + primer apellido) is used in the
  // UI; `full` is kept for tooltips. Defined explicitly so accents are correct
  // (ONPE returns all-caps, accentless strings).
  var CANDIDATE = {
    FP: { full: "Keiko Fujimori Higuchi", short: "Keiko Fujimori" },
    JP: { full: "Roberto Sánchez Palomino", short: "Roberto Sánchez" },
  };

  var els = {
    electionName: document.getElementById("electionName"),
    updatedLabel: document.getElementById("updatedLabel"),
    liveDot: document.getElementById("liveDot"),
    refreshBtn: document.getElementById("refreshBtn"),
    verdictBadge: document.getElementById("verdictBadge"),
    verdictBody: document.getElementById("verdictBody"),
    verdictNote: document.getElementById("verdictNote"),
    currentCount: document.getElementById("currentCount"),
    countProgress: document.getElementById("countProgress"),
    countMetrics: document.getElementById("countMetrics"),
    scenarios: document.getElementById("scenarios"),
    swingNote: document.getElementById("swingNote"),
    segments: document.getElementById("segments"),
    main: document.querySelector("main"),
    toast: document.getElementById("toast"),
  };

  var lastGood = null;
  var timer = null;

  // Short display name (nombre + primer apellido), falling back to the ONPE
  // string if an unexpected key appears.
  function shortName(seg, key) {
    if (CANDIDATE[key]) return CANDIDATE[key].short;
    var c = (seg.candidatos || []).find(function (x) {
      return x.key === key;
    });
    return c ? titleCase(c.candidato) : key;
  }
  function fullName(key) {
    return CANDIDATE[key] ? CANDIDATE[key].full : "";
  }
  function partyFor(key) {
    return PARTY_LABEL[key] || key;
  }
  function fmt(n) {
    return P.formatNumber(n);
  }
  function pct(n, d) {
    return P.formatPct(n, d == null ? 2 : d);
  }
  function titleCase(s) {
    return s
      .toLowerCase()
      .replace(/\b([a-záéíóúñ])/g, function (m) {
        return m.toUpperCase();
      });
  }

  function setStatus(state, label) {
    els.liveDot.className = "dot" + (state === "ok" ? "" : " " + state);
    if (label) els.updatedLabel.textContent = label;
  }

  function timeAgo(ms) {
    var diff = Date.now() - ms;
    var min = Math.round(diff / 60000);
    if (min < 1) return "hace instantes";
    if (min === 1) return "hace 1 min";
    if (min < 60) return "hace " + min + " min";
    var h = Math.round(min / 60);
    return "hace " + h + " h";
  }

  function render(data) {
    lastGood = data;
    els.main.querySelector(".error-banner") &&
      els.main.querySelector(".error-banner").remove();

    if (data.election && data.election.nombre) {
      els.electionName.textContent = titleCase(data.election.nombre);
    }

    var upd = data.national.totales.fechaActualizacion;
    setStatus("ok", "Actualizado " + timeAgo(upd));
    els.updatedLabel.title = new Date(upd).toLocaleString("es-PE");

    renderCurrentCount(data.national);
    renderProjection(data);
    renderSegments(data);
  }

  function renderCurrentCount(seg) {
    var result = P.toResult(
      seg.candidatos.reduce(function (acc, c) {
        acc[c.key] = c.totalVotosValidos;
        return acc;
      }, {})
    );
    var leadKey = result[0].key;

    els.countProgress.textContent =
      pct(seg.totales.actasContabilizadas, 2).replace("%", "") +
      "% de actas contabilizadas";

    els.currentCount.innerHTML = result
      .map(function (r) {
        var cls = r.key === leadKey ? " lead" : "";
        return (
          '<div class="cand ' +
          klass(r.key) +
          cls +
          '">' +
          '<div class="cand-top">' +
          '<div><span class="cand-name" title="' +
          esc(fullName(r.key)) +
          '">' +
          esc(shortName(seg, r.key)) +
          '</span><span class="cand-party">' +
          esc(partyFor(r.key)) +
          "</span></div>" +
          '<div style="text-align:right"><div class="cand-pct">' +
          pct(r.pct, 3) +
          '</div><div class="cand-votes">' +
          fmt(r.votes) +
          " votos</div></div>" +
          "</div>" +
          '<div class="bar"><span style="width:' +
          r.pct.toFixed(2) +
          '%"></span></div>' +
          "</div>"
        );
      })
      .join("");

    var t = seg.totales;
    var marginVotes = result[0].votes - result[1].votes;
    els.countMetrics.innerHTML = [
      metric(fmt(t.totalVotosEmitidos), "Votos emitidos"),
      metric(fmt(t.totalVotosValidos), "Votos válidos"),
      metric(fmt(marginVotes), "Diferencia (votos)"),
      metric(pct(t.participacionCiudadana, 2), "Participación"),
    ].join("");
  }

  function renderProjection(data) {
    var proj = P.buildScenarios({ peru: data.peru, extranjero: data.extranjero });
    var exp = proj.expected;
    var winnerKey = exp.winnerKey;
    var top = exp.result[0];
    var nationalLeadKey = P.toResult(
      data.national.candidatos.reduce(function (a, c) {
        a[c.key] = c.totalVotosValidos;
        return a;
      }, {})
    )[0].key;

    // Badge
    if (proj.tooCloseToCall) {
      els.verdictBadge.textContent = "Demasiado reñido";
      els.verdictBadge.className = "badge tooclose";
    } else {
      els.verdictBadge.textContent = "Proyección con margen";
      els.verdictBadge.className = "badge call";
    }

    els.verdictBody.innerHTML =
      '<div class="' +
      klass(winnerKey) +
      '">' +
      '<div class="verdict-name" title="' +
      esc(fullName(winnerKey)) +
      '">' +
      esc(shortName(data.national, winnerKey)) +
      "</div>" +
      '<div class="verdict-party">' +
      esc(partyFor(winnerKey)) +
      "</div>" +
      "</div>" +
      '<div class="verdict-figure">' +
      '<div class="pct">' +
      pct(top.pct, 2) +
      "</div>" +
      '<div class="margin">proyectado · +' +
      fmt(exp.marginVotes) +
      " votos (" +
      pct(exp.marginPct, 2) +
      ")</div>" +
      "</div>";

    var flipNote = "";
    if (winnerKey !== nationalLeadKey) {
      flipNote =
        " El proyectado <strong>invierte</strong> al líder del conteo actual: el voto del " +
        "extranjero pendiente (que se inclina a " +
        esc(partyFor("FP")) +
        ") cambia el resultado.";
    }

    els.verdictNote.innerHTML =
      "Estimación basada en ~" +
      fmt(proj.remaining.total) +
      " votos válidos por contabilizar (~" +
      fmt(proj.remaining.peru) +
      " en Perú, ~" +
      fmt(proj.remaining.extranjero) +
      " en el extranjero), repartidos según la tendencia actual de cada ámbito." +
      (proj.tooCloseToCall
        ? " Incluso en el escenario más favorable al perdedor el margen es mínimo, por eso se marca como demasiado reñido."
        : "") +
      flipNote;

    // Scenarios
    els.swingNote.textContent = "banda ±" + proj.swingPts + " pts por ámbito";
    var swingA = document.getElementById("howtoSwingA");
    var swingB = document.getElementById("howtoSwingB");
    if (swingA) swingA.textContent = proj.swingPts + " pts";
    if (swingB) swingB.textContent = proj.swingPts + " pts";

    els.scenarios.innerHTML = proj.scenarios
      .map(function (s) {
        var meta = SCENARIO_META[s.name];
        var w = s.result[0];
        var isExpected = s.name === "expected";
        return (
          '<div class="scenario' +
          (isExpected ? " expected" : "") +
          '">' +
          "<h3>" +
          meta.title +
          "</h3>" +
          '<span class="tag">' +
          meta.tag +
          "</span>" +
          '<div class="winner"><span class="swatch ' +
          klass(s.winnerKey) +
          '"></span>' +
          esc(shortName(data.national, s.winnerKey)) +
          ' <span class="sc-pct">· ' +
          pct(w.pct, 2) +
          "</span></div>" +
          '<div class="sc-margin">+' +
          fmt(s.marginVotes) +
          " votos · " +
          pct(s.marginPct, 2) +
          "</div>" +
          scenarioCalc(data, s) +
          "</div>"
        );
      })
      .join("");
  }

  // Expandable step-by-step calculation for one scenario, using the real
  // breakdown numbers from projection.js.
  function scenarioCalc(data, s) {
    var rows = s.breakdown
      .map(function (seg) {
        var label = seg.label === "peru" ? "Perú" : "Extranjero";
        var cands = seg.candidates
          .slice()
          .sort(function (a, b) {
            return b.final - a.final;
          })
          .map(function (c) {
            return (
              '<div class="calc-cand">' +
              '<span class="nm"><span class="swatch ' +
              klass(c.key) +
              '"></span>' +
              esc(partyFor(c.key)) +
              "</span>" +
              '<span class="calc-figs">' +
              '<span class="calc-lean">' +
              pct(c.lean * 100, 1) +
              " de pendientes</span>" +
              '<span class="calc-sum">' +
              fmt(c.counted) +
              " <span class='op'>+</span> " +
              fmt(c.added) +
              " <span class='op'>=</span> <strong>" +
              fmt(c.final) +
              "</strong></span>" +
              "</span>" +
              "</div>"
            );
          })
          .join("");
        return (
          '<div class="calc-seg">' +
          '<div class="calc-seg-head">' +
          label +
          ' <span class="muted">· ~' +
          fmt(seg.remaining) +
          " votos pendientes</span></div>" +
          cands +
          "</div>"
        );
      })
      .join("");
    return (
      '<details class="calc">' +
      "<summary>Ver cálculo</summary>" +
      '<div class="calc-legend muted">contados <span class="op">+</span> pendientes asignados <span class="op">=</span> total</div>' +
      rows +
      "</details>"
    );
  }

  var SCENARIO_META = {
    optimisticJP: {
      title: "Optimista " + PARTY_LABEL.JP,
      tag: "pendientes +3 pts a Sánchez",
    },
    expected: { title: "Esperado", tag: "tendencia actual por ámbito" },
    optimisticFP: {
      title: "Optimista " + PARTY_LABEL.FP,
      tag: "pendientes +3 pts a Fujimori",
    },
  };

  function renderSegments(data) {
    var segs = [
      { key: "peru", label: "Perú", seg: data.peru },
      { key: "extranjero", label: "Extranjero", seg: data.extranjero },
    ];
    els.segments.innerHTML = segs
      .map(function (s) {
        var result = P.toResult(
          s.seg.candidatos.reduce(function (a, c) {
            a[c.key] = c.totalVotosValidos;
            return a;
          }, {})
        );
        var rows = result
          .map(function (r) {
            return (
              '<div class="seg-row"><span class="nm"><span class="swatch ' +
              klass(r.key) +
              '"></span>' +
              esc(partyFor(r.key)) +
              "</span><span>" +
              pct(r.pct, 2) +
              "</span></div>"
            );
          })
          .join("");
        return (
          '<div class="segment">' +
          "<h3>" +
          s.label +
          "</h3>" +
          '<div class="seg-sub">' +
          pct(s.seg.totales.actasContabilizadas, 2).replace("%", "") +
          "% de actas · " +
          fmt(s.seg.totales.totalVotosValidos) +
          " votos válidos</div>" +
          rows +
          "</div>"
        );
      })
      .join("");
  }

  // --- small DOM/format helpers ---------------------------------------------

  function klass(key) {
    return key === "FP" ? "fp" : key === "JP" ? "jp" : "";
  }
  function metric(v, k) {
    return '<div class="metric"><div class="v">' + v + '</div><div class="k">' + k + "</div></div>";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function showError(message) {
    if (lastGood) {
      // Keep last good data; just flag the dot and timestamp.
      setStatus("stale", els.updatedLabel.textContent + " · sin actualizar");
    } else {
      setStatus("error", "Error al cargar");
      els.verdictBody.innerHTML =
        '<div class="skeleton">No se pudo obtener datos de ONPE.</div>';
    }
    var existing = els.main.querySelector(".error-banner");
    if (existing) existing.remove();
    var banner = document.createElement("div");
    banner.className = "error-banner";
    banner.textContent = "No se pudo actualizar: " + message + ". Mostrando últimos datos disponibles.";
    if (lastGood) els.main.insertBefore(banner, els.main.firstChild);
  }

  // Toggle the refresh button's loading state.
  function setRefreshing(on) {
    els.refreshBtn.disabled = on;
    els.refreshBtn.classList.toggle("loading", on);
    els.refreshBtn.textContent = on ? "Actualizando…" : "Actualizar";
  }

  // Transient feedback toast. kind: "ok" | "info" | "err".
  var toastTimer = null;
  function showToast(message, kind) {
    var t = els.toast;
    if (!t) return;
    t.textContent = message;
    t.className = "toast show " + (kind || "info");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.className = "toast " + (kind || "info");
    }, 3400);
  }

  /**
   * Fetch a fresh snapshot. `isManual` (button click) drives the loading state
   * and the result toast; automatic refreshes stay silent so they don't nag.
   */
  function load(isManual) {
    // Prevent overlapping manual fetches (button already disabled while loading).
    if (isManual && els.refreshBtn.disabled) return Promise.resolve();
    var prevUpdated = lastGood ? lastGood.national.totales.fechaActualizacion : null;
    if (isManual) setRefreshing(true);

    return fetch("/api/snapshot", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.error) throw new Error(data.message || data.error);
        render(data);
        if (isManual) {
          var now = data.national.totales.fechaActualizacion;
          if (prevUpdated == null) {
            showToast("Datos cargados", "ok");
          } else if (now > prevUpdated) {
            showToast("Datos actualizados a " + timeAgo(now), "ok");
          } else {
            showToast("Sin cambios — los datos ya estaban al día", "info");
          }
        }
      })
      .catch(function (e) {
        showError(e.message || String(e));
        if (isManual) showToast("No se pudo actualizar. Reintenta en unos segundos.", "err");
      })
      .finally(function () {
        if (isManual) setRefreshing(false);
      });
  }

  els.refreshBtn.addEventListener("click", function () {
    load(true);
  });

  // Keep the "hace X min" label fresh between fetches.
  setInterval(function () {
    if (lastGood) {
      var upd = lastGood.national.totales.fechaActualizacion;
      if (els.liveDot.classList.contains("dot") && !els.liveDot.classList.contains("error")) {
        if (!els.liveDot.classList.contains("stale")) {
          els.updatedLabel.textContent = "Actualizado " + timeAgo(upd);
        }
      }
    }
  }, 30000);

  load(false);
  timer = setInterval(function () {
    load(false);
  }, REFRESH_MS);
})();
