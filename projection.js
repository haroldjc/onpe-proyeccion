/*
 * Projection math for the ONPE 2nd-round presidential count.
 *
 * Pure functions only: no DOM, no network. Shared by the browser (app.js) and
 * usable from Node for sanity checks. Works as a plain <script> (attaches to
 * window.Projection) and as a CommonJS module.
 *
 * Terminology:
 *   segment   = a geographic ámbito snapshot: { totales, candidatos }
 *               totales:   { contabilizadas, totalActas, totalVotosValidos, ... }
 *               candidatos: [{ key, totalVotosValidos, ... }, ...]
 *   lean      = { [candidateKey]: fraction } summing to 1, the split applied to
 *               the segment's pending votes.
 *
 * The two candidate keys are stable party codes from ONPE:
 *   "FP" = Fuerza Popular (Keiko Fujimori)
 *   "JP" = Juntos por el Perú (Roberto Sánchez)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Projection = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Default uncertainty band: how far each segment's pending lean is shifted
  // toward a candidate to build the optimistic/pessimistic scenarios, in
  // percentage points. A single transparent knob.
  var DEFAULT_SWING_PTS = 3;

  // If the closest scenario margin is within this many points, the race is
  // flagged "too close to call" even when every scenario names the same winner.
  var DEFAULT_CLOSE_PTS = 0.5;

  /**
   * Estimate the number of valid votes still uncounted in a segment.
   * Scales the segment's counted valid votes by the ratio of pending actas to
   * counted actas. Uses acta *counts* (not rounded percentages) for precision.
   * Returns 0 when nothing is pending or inputs are missing.
   */
  function estimateRemainingValid(segment) {
    var t = (segment && segment.totales) || {};
    var counted = num(t.contabilizadas);
    var total = num(t.totalActas);
    var countedValid = num(t.totalVotosValidos);
    if (counted <= 0 || total <= 0 || countedValid <= 0) return 0;
    var pending = Math.max(0, total - counted);
    return countedValid * (pending / counted);
  }

  /**
   * The current valid-vote share of a segment, as a lean object.
   * Falls back to an even split if the segment has no counted votes.
   */
  function currentLean(segment) {
    var cands = (segment && segment.candidatos) || [];
    var total = 0;
    cands.forEach(function (c) {
      total += num(c.totalVotosValidos);
    });
    var lean = {};
    if (total <= 0) {
      cands.forEach(function (c) {
        lean[c.key] = 1 / Math.max(1, cands.length);
      });
      return lean;
    }
    cands.forEach(function (c) {
      lean[c.key] = num(c.totalVotosValidos) / total;
    });
    return lean;
  }

  /**
   * Shift a two-candidate lean by `pts` percentage points toward `towardKey`,
   * clamped to [0, 1]. Returns a new lean object.
   */
  function shiftLean(lean, towardKey, pts) {
    var keys = Object.keys(lean);
    if (keys.length !== 2) return Object.assign({}, lean);
    var other = keys[0] === towardKey ? keys[1] : keys[0];
    var delta = pts / 100;
    var up = clamp01(num(lean[towardKey]) + delta);
    var out = {};
    out[towardKey] = up;
    out[other] = 1 - up;
    return out;
  }

  /**
   * Counted valid votes per candidate key for a segment.
   */
  function countedByCandidate(segment) {
    var out = {};
    ((segment && segment.candidatos) || []).forEach(function (c) {
      out[c.key] = num(c.totalVotosValidos);
    });
    return out;
  }

  /**
   * Project one segment's final valid votes per candidate given the lean to
   * apply to its pending votes. Returns { [key]: projectedVotes }.
   */
  function projectSegment(segment, lean) {
    var counted = countedByCandidate(segment);
    var remaining = estimateRemainingValid(segment);
    var out = {};
    Object.keys(counted).forEach(function (k) {
      out[k] = counted[k] + remaining * num(lean[k]);
    });
    return out;
  }

  /**
   * Sum per-candidate vote objects.
   */
  function addVotes(a, b) {
    var out = Object.assign({}, a);
    Object.keys(b).forEach(function (k) {
      out[k] = num(out[k]) + num(b[k]);
    });
    return out;
  }

  /**
   * Turn a per-candidate vote object into a sorted result array with shares.
   * [{ key, votes, pct }] descending by votes.
   */
  function toResult(votes) {
    var total = 0;
    Object.keys(votes).forEach(function (k) {
      total += num(votes[k]);
    });
    return Object.keys(votes)
      .map(function (k) {
        return {
          key: k,
          votes: num(votes[k]),
          pct: total > 0 ? (num(votes[k]) / total) * 100 : 0,
        };
      })
      .sort(function (x, y) {
        return y.votes - x.votes;
      });
  }

  /**
   * Detail of how one segment contributes to a scenario: the lean applied to its
   * pending votes, the estimated remaining, and per-candidate counted / added /
   * final figures. This is what the "how it works" view reads.
   */
  function segmentDetail(label, segment, lean) {
    var counted = countedByCandidate(segment);
    var remaining = estimateRemainingValid(segment);
    var candidates = Object.keys(counted).map(function (k) {
      var added = remaining * num(lean[k]);
      return {
        key: k,
        lean: num(lean[k]),
        counted: counted[k],
        added: added,
        final: counted[k] + added,
      };
    });
    return {
      label: label,
      remaining: remaining,
      candidates: candidates,
    };
  }

  /**
   * Build one named scenario from per-segment leans.
   * segments: { peru, extranjero } each a segment snapshot.
   * leans:    { peru: lean, extranjero: lean }.
   */
  function buildScenario(name, segments, leans) {
    var peru = projectSegment(segments.peru, leans.peru);
    var ext = projectSegment(segments.extranjero, leans.extranjero);
    var totalVotes = addVotes(peru, ext);
    var result = toResult(totalVotes);
    var winner = result[0];
    var runnerUp = result[1] || { votes: 0, pct: 0, key: null };
    return {
      name: name,
      result: result,
      winnerKey: winner ? winner.key : null,
      marginVotes: winner.votes - runnerUp.votes,
      marginPct: winner.pct - runnerUp.pct,
      breakdown: [
        segmentDetail("peru", segments.peru, leans.peru),
        segmentDetail("extranjero", segments.extranjero, leans.extranjero),
      ],
    };
  }

  /**
   * Headline projection + uncertainty band.
   *
   * Returns:
   *   {
   *     remaining: { peru, extranjero, total },   // estimated pending valid votes
   *     expected, optimisticFP, optimisticJP,      // scenarios
   *     scenarios: [optimisticJP, expected, optimisticFP], // ordered for display
   *     tooCloseToCall: bool,                       // scenarios disagree on winner
   *     swingPts
   *   }
   *
   * `national` is accepted for completeness but the projection is built from the
   * two segments so the differing segment leans are respected.
   */
  function buildScenarios(segments, options) {
    options = options || {};
    var swing = options.swingPts != null ? options.swingPts : DEFAULT_SWING_PTS;
    var closePts = options.closePts != null ? options.closePts : DEFAULT_CLOSE_PTS;

    var leanPeru = currentLean(segments.peru);
    var leanExt = currentLean(segments.extranjero);

    var keys = Object.keys(leanPeru);
    // Identify the two candidate keys (FP / JP) defensively.
    var fp = keys.indexOf("FP") !== -1 ? "FP" : keys[0];
    var jp = keys.indexOf("JP") !== -1 ? "JP" : keys[1];

    var expected = buildScenario("expected", segments, {
      peru: leanPeru,
      extranjero: leanExt,
    });

    // Optimistic for a candidate = both pending segments swing `swing` pts toward
    // that candidate relative to each segment's current lean.
    var optimisticFP = buildScenario("optimisticFP", segments, {
      peru: shiftLean(leanPeru, fp, swing),
      extranjero: shiftLean(leanExt, fp, swing),
    });
    var optimisticJP = buildScenario("optimisticJP", segments, {
      peru: shiftLean(leanPeru, jp, swing),
      extranjero: shiftLean(leanExt, jp, swing),
    });

    var all = [expected, optimisticFP, optimisticJP];
    var winners = {};
    var minMarginPct = Infinity;
    all.forEach(function (s) {
      winners[s.winnerKey] = true;
      if (s.marginPct < minMarginPct) minMarginPct = s.marginPct;
    });
    // Too close to call when the scenarios disagree on the winner, or when even
    // the tightest scenario margin is within the close threshold.
    var scenariosDisagree = Object.keys(winners).length > 1;
    var tooCloseToCall = scenariosDisagree || minMarginPct < closePts;

    var remPeru = estimateRemainingValid(segments.peru);
    var remExt = estimateRemainingValid(segments.extranjero);

    return {
      remaining: {
        peru: remPeru,
        extranjero: remExt,
        total: remPeru + remExt,
      },
      expected: expected,
      optimisticFP: optimisticFP,
      optimisticJP: optimisticJP,
      scenarios: [optimisticJP, expected, optimisticFP],
      tooCloseToCall: tooCloseToCall,
      scenariosDisagree: scenariosDisagree,
      minMarginPct: minMarginPct,
      swingPts: swing,
      closePts: closePts,
      candidateKeys: { fp: fp, jp: jp },
    };
  }

  /**
   * Region-weighted projection.
   *
   * Counted votes are taken as authoritative (from `options.countedTotals`, the
   * national split) and never re-estimated. Only the *pending* votes are
   * attributed per region: each region's estimated remaining × that region's own
   * lean. This is what makes the model faithful — remaining votes both concentrate
   * in some regions and lean differently — and robust: a region missing its lean
   * only mis-attributes its small pending slice, never its counted votes.
   *
   *   final[k] = countedTotals[k] + Σ_segment ( remaining_seg × lean_seg[k] )
   *
   * regions:    [{ ubigeo, nombre, totales, candidatos }]
   * extranjero: { totales, candidatos }  (single foreign segment, as today)
   * options.countedTotals: { FP, JP } authoritative counted votes (national). If
   *   omitted, derived by summing each segment's counted (needs all candidatos).
   * options.fallbackLean: lean used for a region missing its candidate split.
   *
   * Returns the same shape as buildScenarios, plus a `breakdown` sorted by pending.
   */
  function buildScenariosByRegion(regions, extranjero, options) {
    options = options || {};
    var swing = options.swingPts != null ? options.swingPts : DEFAULT_SWING_PTS;
    var closePts = options.closePts != null ? options.closePts : DEFAULT_CLOSE_PTS;
    var fallbackLean = options.fallbackLean || null;

    var segs = [];
    (regions || []).forEach(function (r) {
      segs.push({ label: r.nombre, kind: "region", ubigeo: r.ubigeo, totales: r.totales || {}, candidatos: (r.candidatos) || [] });
    });
    if (extranjero) {
      segs.push({ label: "Extranjero", kind: "extranjero", ubigeo: null, totales: extranjero.totales || {}, candidatos: extranjero.candidatos || [] });
    }

    // Candidate keys: prefer the provided counted totals, else first segment lean.
    var keys = options.countedTotals ? Object.keys(options.countedTotals) : [];
    if (!keys.length) {
      for (var i = 0; i < segs.length; i++) {
        var l0 = currentLean(segs[i]);
        if (Object.keys(l0).length) {
          keys = Object.keys(l0);
          break;
        }
      }
    }
    var fp = keys.indexOf("FP") !== -1 ? "FP" : keys[0];
    var jp = keys.indexOf("JP") !== -1 ? "JP" : keys[1];

    // Authoritative counted totals (exact). Fall back to summing segment counted.
    var counted = options.countedTotals
      ? Object.assign({}, options.countedTotals)
      : segs.reduce(function (acc, s) {
          return addVotes(acc, countedByCandidate(s));
        }, {});

    // Per-segment lean (own lean, or the fallback when a region lacks candidatos),
    // remaining estimate, and whether the lean was a fallback.
    var perSeg = segs.map(function (s) {
      var hasCands = s.candidatos && s.candidatos.length;
      var lean = hasCands ? currentLean(s) : fallbackLean || evenLean(keys);
      return {
        seg: s,
        remaining: estimateRemainingValid(s),
        lean: lean,
        synth: !hasCands && !!fallbackLean,
      };
    });

    function scenario(name, leanOf) {
      var votes = Object.assign({}, counted);
      perSeg.forEach(function (p) {
        var lean = leanOf(p);
        Object.keys(lean).forEach(function (k) {
          votes[k] = num(votes[k]) + p.remaining * num(lean[k]);
        });
      });
      var result = toResult(votes);
      var winner = result[0] || { votes: 0, pct: 0, key: null };
      var runnerUp = result[1] || { votes: 0, pct: 0, key: null };
      return {
        name: name,
        result: result,
        winnerKey: winner.key,
        marginVotes: winner.votes - runnerUp.votes,
        marginPct: winner.pct - runnerUp.pct,
      };
    }

    var expected = scenario("expected", function (p) {
      return p.lean;
    });
    var optimisticFP = scenario("optimisticFP", function (p) {
      return shiftLean(p.lean, fp, swing);
    });
    var optimisticJP = scenario("optimisticJP", function (p) {
      return shiftLean(p.lean, jp, swing);
    });

    var all = [expected, optimisticFP, optimisticJP];
    var winners = {};
    var minMarginPct = Infinity;
    all.forEach(function (s) {
      winners[s.winnerKey] = true;
      if (s.marginPct < minMarginPct) minMarginPct = s.marginPct;
    });
    var scenariosDisagree = Object.keys(winners).length > 1;
    var tooCloseToCall = scenariosDisagree || minMarginPct < closePts;

    var totalRemaining = 0;
    var breakdown = perSeg.map(function (p) {
      totalRemaining += p.remaining;
      var t = p.seg.totales || {};
      return {
        label: p.seg.label,
        kind: p.seg.kind,
        ubigeo: p.seg.ubigeo,
        remaining: p.remaining,
        lean: p.lean,
        pendingNet: p.remaining * (num(p.lean[jp]) - num(p.lean[fp])),
        actasContabilizadas: t.actasContabilizadas,
        contabilizadas: t.contabilizadas,
        totalActas: t.totalActas,
        enviadasJee: t.enviadasJee,
        pendientesJee: t.pendientesJee,
        synthesizedLean: p.synth,
      };
    });
    breakdown.sort(function (a, b) {
      return b.remaining - a.remaining;
    });

    return {
      remaining: { total: totalRemaining },
      expected: expected,
      optimisticFP: optimisticFP,
      optimisticJP: optimisticJP,
      scenarios: [optimisticJP, expected, optimisticFP],
      tooCloseToCall: tooCloseToCall,
      scenariosDisagree: scenariosDisagree,
      minMarginPct: minMarginPct,
      swingPts: swing,
      closePts: closePts,
      candidateKeys: { fp: fp, jp: jp },
      breakdown: breakdown,
      regionsUsed: (regions || []).length,
    };
  }

  function evenLean(keys) {
    var lean = {};
    (keys || []).forEach(function (k) {
      lean[k] = 1 / Math.max(1, keys.length);
    });
    return lean;
  }

  // --- helpers ---------------------------------------------------------------

  function num(v) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function clamp01(n) {
    return Math.max(0, Math.min(1, n));
  }

  function formatNumber(n) {
    return Math.round(num(n)).toLocaleString("es-PE");
  }

  function formatPct(n, digits) {
    return num(n).toFixed(digits == null ? 2 : digits) + "%";
  }

  return {
    DEFAULT_SWING_PTS: DEFAULT_SWING_PTS,
    estimateRemainingValid: estimateRemainingValid,
    currentLean: currentLean,
    shiftLean: shiftLean,
    projectSegment: projectSegment,
    buildScenario: buildScenario,
    buildScenarios: buildScenarios,
    buildScenariosByRegion: buildScenariosByRegion,
    toResult: toResult,
    formatNumber: formatNumber,
    formatPct: formatPct,
  };
});
