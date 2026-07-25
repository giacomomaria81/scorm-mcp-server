/**
 * Client-side runtime injected into every packaged SCO (production-hardened).
 *
 * Exported as a plain string (no backticks / no ${...} inside) so it embeds
 * verbatim into a <script> tag without escaping issues.
 *
 * Hardening vs v1:
 *  - Robust API discovery: walks parent frames AND opener AND top, with
 *    try/catch around cross-origin frame access (never throws into content).
 *  - Full SCORM 2004 lifecycle: Initialize (with "already initialized" 103
 *    handling), guarded single Terminate, correct cmi.exit semantics.
 *  - cmi.session_time reported as ISO 8601 duration on exit (time tracking).
 *  - Throttled Commit (avoids hammering the LMS) + forced commit on exit/hide.
 *  - Every API call wrapped in try/catch so a quirky LMS can't break rendering.
 *  - Graceful "preview mode" when no LMS API is present (standalone/offline).
 */
export const SCORM_RUNTIME = `
(function () {
  "use strict";

  // Singleton: a double injection would double-Initialize, double the event
  // listeners (duplicated score writes) and Terminate twice.
  if (window.__SCORM_JALONS__) { return; }
  window.__SCORM_JALONS__ = true;

  var SUSPEND_VERSION = 1;
  var SUSPEND_MAX_CHARS = 64000; // SCORM 2004 SPM for cmi.suspend_data
  var MAX_FRAME_DEPTH = 500;
  var COMMIT_INTERVAL_MS = 5000;

  var api = null, initialized = false, terminated = false, previewMode = false, successOnComplete = false;
  var masteryScore = null, lastScaled = null, lastScore = null;
  try { if (typeof window.__SCORM_MASTERY === "number" && window.__SCORM_MASTERY >= 0 && window.__SCORM_MASTERY <= 1) { masteryScore = window.__SCORM_MASTERY; } } catch (e) {}
  var milestoneIds = [], reached = {}, reachedCount = 0, lastProgress = 0, completed = false;
  var startTime = 0, commitTimer = null, lastCommit = 0;

  function log(m) { if (window.console && console.log) { console.log("[scorm-jalons] " + m); } }

  function keysOf(o) { var a = [], k; for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { a.push(k); } } return a; }

  // ---- API discovery (content side) ---------------------------------------
  function findAPIInWindow(win) {
    var depth = 0, w = win, parent;
    while (w && depth < MAX_FRAME_DEPTH) {
      try { if (w.API_1484_11) { return w.API_1484_11; } }
      catch (e) { return null; } // cross-origin frame -> cannot reach further
      try { parent = w.parent; } catch (e) { return null; }
      if (parent && parent !== w) { w = parent; depth++; } else { break; }
    }
    return null;
  }
  function locateAPI() {
    var f = findAPIInWindow(window);
    if (!f) { try { if (window.opener) { f = findAPIInWindow(window.opener); } } catch (e) {} }
    if (!f) { try { if (window.top && window.top !== window) { f = findAPIInWindow(window.top); } } catch (e) {} }
    return f;
  }

  // ---- guarded API calls ---------------------------------------------------
  function get(el) {
    if (!api || !initialized || terminated) { return ""; }
    try { return api.GetValue(el); } catch (e) { log("GetValue error: " + el); return ""; }
  }
  function set(el, val) {
    if (!api || !initialized || terminated) { return; }
    try {
      var ok = api.SetValue(el, String(val));
      if (ok === "false" || ok === false) {
        var ec = ""; try { ec = String(api.GetLastError()); } catch (e2) {}
        log("SetValue refused: " + el + " (LMS error " + ec + ")");
      }
    } catch (e) { log("SetValue error: " + el); }
  }
  function doCommit() {
    lastCommit = (new Date()).getTime();
    if (!api || !initialized || terminated) { return; }
    try { api.Commit(""); } catch (e) { log("Commit error"); }
  }
  function scheduleCommit() {
    if (commitTimer) { return; }
    var since = (new Date()).getTime() - lastCommit;
    var wait = COMMIT_INTERVAL_MS - since; if (wait < 0) { wait = 0; }
    commitTimer = window.setTimeout(function () { commitTimer = null; doCommit(); }, wait);
  }

  // ---- progress / completion ----------------------------------------------
  function formatMeasure(p) { if (p >= 1) { return "1"; } if (p <= 0) { return "0"; } return String(Math.round(p * 10000) / 10000); }
  function iso8601(ms) {
    if (ms < 0) { ms = 0; }
    var totalSec = ms / 1000;
    var h = Math.floor(totalSec / 3600);
    var rem = totalSec - h * 3600;
    var m = Math.floor(rem / 60);
    var s = Math.round((rem - m * 60) * 100) / 100;
    if (s >= 60) { s = 59.99; }
    return "PT" + h + "H" + m + "M" + s + "S";
  }
  function pushProgress() {
    var total = milestoneIds.length;
    // total 0 must NOT mean "100%": a SPA that declares its milestones after
    // load would be marked completed at open, and lastProgress=1 would freeze
    // all real reporting forever. No milestone model (yet) = report nothing;
    // endSession() handles the "no milestones at all" case as visited-on-exit.
    if (total === 0) { return; }
    var p = reachedCount / total;
    if (p < lastProgress) { p = lastProgress; }
    lastProgress = p;
    set("cmi.progress_measure", formatMeasure(p));
    if (p >= 1 && !completed) { markCompleted(); }
  }
  function markCompleted() { completed = true; set("cmi.completion_status", "completed"); if (successOnComplete) { set("cmi.success_status", "passed"); } log("module completed"); }

  function suspendJson() {
    var ids = keysOf(reached);
    var json = JSON.stringify({ v: SUSPEND_VERSION, reached: ids });
    // Above the SPM the LMS rejects the whole SetValue (silently for us): better
    // to persist a truncated resume list than to lose resume entirely.
    while (json.length > SUSPEND_MAX_CHARS && ids.length > 0) {
      ids.pop();
      json = JSON.stringify({ v: SUSPEND_VERSION, reached: ids });
    }
    return json;
  }
  function persist() {
    set("cmi.suspend_data", suspendJson());
    var y = window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0;
    set("cmi.location", String(y));
    set("cmi.exit", "suspend");
    scheduleCommit();
  }

  // ---- score reporting (v2) ------------------------------------------------
  function fmtScaled(x) { if (x >= 1) { return "1"; } if (x <= 0) { return "0"; } return String(Math.round(x * 10000) / 10000); }
  function reportScore(raw, min, max) {
    raw = Number(raw);
    if (!isFinite(raw)) { return; } // NaN AND Infinity (score.raw is real(10,7))
    min = Number(min); if (!isFinite(min)) { min = 0; }
    max = Number(max); if (!isFinite(max) || !(max > min)) { max = min + 100; }
    var scaled = (raw - min) / (max - min);
    if (scaled < 0) { scaled = 0; } if (scaled > 1) { scaled = 1; }
    lastScaled = scaled;
    lastScore = { raw: raw, min: min, max: max }; // kept for replay after Initialize
    set("cmi.score.raw", String(raw));
    set("cmi.score.min", String(min));
    set("cmi.score.max", String(max));
    set("cmi.score.scaled", fmtScaled(scaled));
    if (masteryScore !== null) { set("cmi.success_status", scaled >= masteryScore ? "passed" : "failed"); }
    log("score reported: " + raw + " [" + min + ".." + max + "] scaled=" + fmtScaled(scaled));
    scheduleCommit();
  }

  // ---- event contract (v2): scorm:progress / scorm:complete / scorm:score ---
  // (dc:* aliases accepted). Any app can emit CustomEvents without knowing SCORM.
  function onProgressEvent(e) {
    try {
      var v = e && e.detail;
      if (v && typeof v === "object") { v = v.value; }
      v = Number(v);
      if (isNaN(v)) { return; }
      if (v > 1) { v = 1; } if (v < 0) { v = 0; }
      if (v > lastProgress) { lastProgress = v; set("cmi.progress_measure", formatMeasure(v)); scheduleCommit(); }
      if (v >= 1) { if (!completed) { markCompleted(); } persist(); }
    } catch (err) {}
  }
  function onCompleteEvent() { try { if (!completed) { markCompleted(); } persist(); } catch (err) {} }
  function onScoreEvent(e) { try { var d = (e && e.detail) || {}; reportScore(d.raw, d.min, d.max); } catch (err) {} }
  function wireEventContract() {
    var pairs = [["scorm:progress", onProgressEvent], ["dc:progress", onProgressEvent],
                 ["scorm:complete", onCompleteEvent], ["dc:complete", onCompleteEvent],
                 ["scorm:score", onScoreEvent], ["dc:score", onScoreEvent]];
    for (var i = 0; i < pairs.length; i++) {
      try { window.addEventListener(pairs[i][0], pairs[i][1]); } catch (e) {}
      try { document.addEventListener(pairs[i][0], pairs[i][1]); } catch (e) {}
    }
  }
  wireEventContract();

  // ---- reach a milestone ---------------------------------------------------
  function reach(id) {
    if (!id || reached[id]) { return; }
    var known = false, i;
    for (i = 0; i < milestoneIds.length; i++) { if (milestoneIds[i] === id) { known = true; break; } }
    if (!known) { milestoneIds.push(id); log("milestone declared on the fly: " + id); }
    reached[id] = true; reachedCount++;
    log("milestone reached: " + id + " (" + reachedCount + "/" + milestoneIds.length + ")");
    pushProgress(); persist();
  }

  // ---- discover + wire -----------------------------------------------------
  function collectMilestones() {
    try {
      var se = document.querySelector("[data-scorm-success]");
      if (se) { var sv = (se.getAttribute("data-scorm-success") || "").toLowerCase(); successOnComplete = (sv === "" || sv === "on-completion" || sv === "true"); }
    } catch (e) {}
    var nodes = document.querySelectorAll("[data-jalon]"), seen = {}, i, id;
    // seed with already-known ids so a re-collect (bfcache resume, dynamic DOM)
    // never duplicates entries and inflates the total
    for (i = 0; i < milestoneIds.length; i++) { seen[milestoneIds[i]] = true; }
    for (i = 0; i < nodes.length; i++) { id = nodes[i].getAttribute("data-jalon"); if (id && !seen[id]) { seen[id] = true; milestoneIds.push(id); } }
  }
  var io = null;
  function ensureObserver() {
    if (io || !window.IntersectionObserver) { return; }
    // A fixed threshold of 0.5 can NEVER fire for an element taller than twice
    // the viewport (its intersection ratio is capped below 0.5), leaving the
    // module incomplete forever. Instead: threshold 0 + a rootMargin band around
    // the middle of the viewport — "reached" when the element crosses the zone
    // the reader is actually looking at, whatever its size.
    io = new IntersectionObserver(function (entries) {
      var k; for (k = 0; k < entries.length; k++) {
        if (entries[k].isIntersecting) { var id = entries[k].target.getAttribute("data-jalon"); io.unobserve(entries[k].target); reach(id); }
      }
    }, { rootMargin: "-35% 0px -35% 0px", threshold: 0 });
  }
  function wireNode(node) {
    if (node.__scormWired) { return; }
    node.__scormWired = true;
    var id = node.getAttribute("data-jalon");
    var trig = (node.getAttribute("data-trigger") || "view").toLowerCase();
    if (trig === "click") { node.addEventListener("click", function () { reach(id); }, { once: true }); }
    else if (trig === "ended") { node.addEventListener("ended", function () { reach(id); }, { once: true }); }
    else { ensureObserver(); if (io) { io.observe(node); } else { reach(id); } }
  }
  function wireTriggers() {
    var nodes = document.querySelectorAll("[data-jalon]"), j;
    for (j = 0; j < nodes.length; j++) { wireNode(nodes[j]); }
  }
  function watchDynamicMilestones() {
    // SPAs inject their screens after load: without this, a data-jalon added
    // later is neither counted nor wired — the feature silently dies.
    if (!window.MutationObserver || !document.body) { return; }
    try {
      var mo = new MutationObserver(function () {
        var before = milestoneIds.length;
        collectMilestones();
        wireTriggers();
        if (milestoneIds.length !== before) { pushProgress(); }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  // ---- resume --------------------------------------------------------------
  function restore() {
    var raw = get("cmi.suspend_data"), i;
    if (raw) {
      try {
        var d = JSON.parse(raw);
        // d.reached MUST be an array: a string would pass a bare .length check
        // and be iterated character by character, creating one ghost milestone
        // per letter and making 100% unreachable.
        if (d && d.reached && Object.prototype.toString.call(d.reached) === "[object Array]" && d.reached.length) {
          for (i = 0; i < d.reached.length; i++) {
            var id = d.reached[i];
            var known = false, j;
            for (j = 0; j < milestoneIds.length; j++) { if (milestoneIds[j] === id) { known = true; break; } }
            if (!known) { milestoneIds.push(id); }
            if (!reached[id]) { reached[id] = true; reachedCount++; }
          }
        }
      } catch (e) { log("suspend_data parse error"); }
    }
    if (get("cmi.completion_status") === "completed") { completed = true; }
    pushProgress();
    var loc = get("cmi.location");
    if (loc) { var y = parseInt(loc, 10); if (!isNaN(y) && y > 0) { window.setTimeout(function () { window.scrollTo(0, y); }, 60); } }
  }

  // ---- lifecycle -----------------------------------------------------------
  function startSession() {
    api = locateAPI();
    if (!api) { previewMode = true; log("no LMS API found - preview mode (no tracking)"); collectMilestones(); wireTriggers(); watchDynamicMilestones(); return; }
    var res; try { res = api.Initialize(""); } catch (e) { res = "false"; }
    initialized = (res === "true" || res === true);
    if (!initialized) { var err = ""; try { err = String(api.GetLastError()); } catch (e2) {} if (err === "103") { initialized = true; } }
    if (!initialized) { previewMode = true; log("Initialize failed - preview mode (no tracking)"); collectMilestones(); wireTriggers(); watchDynamicMilestones(); return; }
    startTime = (new Date()).getTime();
    if (get("cmi.completion_status") !== "completed") { set("cmi.completion_status", "incomplete"); }
    collectMilestones();
    restore();
    // Replay state accumulated BEFORE Initialize: events fired by the content at
    // load time were memorised, but their SetValue calls were dropped (no API
    // yet). Without this, an early scorm:complete or scorm:score is lost forever.
    if (completed) { set("cmi.completion_status", "completed"); if (successOnComplete) { set("cmi.success_status", "passed"); } }
    if (lastScore) { reportScore(lastScore.raw, lastScore.min, lastScore.max); }
    if (lastProgress > 0) { set("cmi.progress_measure", formatMeasure(lastProgress)); }
    wireTriggers();
    watchDynamicMilestones();
    doCommit();
  }
  function endSession() {
    if (previewMode || !initialized || terminated) { return; }
    if (commitTimer) { window.clearTimeout(commitTimer); commitTimer = null; }
    var elapsed = startTime ? ((new Date()).getTime() - startTime) : 0;
    set("cmi.session_time", iso8601(elapsed));
    if (!completed && milestoneIds.length === 0) {
      // No milestone model at all (content declared nothing): "visited" is the
      // only signal available — report completed on exit rather than leaving
      // the learner incomplete forever.
      completed = true;
      set("cmi.completion_status", "completed");
      if (successOnComplete) { set("cmi.success_status", "passed"); }
    }
    set("cmi.suspend_data", suspendJson());
    var y = window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0;
    set("cmi.location", String(y));
    set("cmi.exit", completed ? "normal" : "suspend");
    doCommit();
    // Flip the flag only after the final writes: set()/get() refuse to run once
    // terminated (protects against post-bfcache writes on iOS/Safari).
    terminated = true;
    try { api.Terminate(""); } catch (e) { log("Terminate error"); }
  }

  // public hook for programmatic milestones
  function declare(id) {
    if (!id) { return; }
    for (var i = 0; i < milestoneIds.length; i++) { if (milestoneIds[i] === id) { return; } }
    milestoneIds.push(id);
    pushProgress();
  }

  window.SCORM2004 = {
    reach: function (id) { reach(id); },
    declare: function (id) { declare(id); },
    score: function (raw, min, max) { reportScore(raw, min, max); },
    complete: function () { markCompleted(); persist(); },
    progress: function () { return lastProgress; },
    isPreview: function () { return previewMode; }
  };

  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", startSession); }
  else { startSession(); }
  window.addEventListener("pagehide", endSession);
  window.addEventListener("beforeunload", endSession);
  window.addEventListener("pageshow", function (ev) {
    // iOS/Safari bfcache: pagehide fired endSession (Terminate), then the page
    // comes back alive. Without a re-Initialize every later write is an LMS
    // error 133. Start a fresh session against the API.
    if (ev && ev.persisted && terminated) {
      terminated = false; initialized = false; api = null;
      startSession();
    }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && !previewMode && initialized && !terminated) { persist(); }
  });
})();
`;
