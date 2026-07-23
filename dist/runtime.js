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

  var SUSPEND_VERSION = 1;
  var MAX_FRAME_DEPTH = 500;
  var COMMIT_INTERVAL_MS = 5000;

  var api = null, initialized = false, terminated = false, previewMode = false, successOnComplete = false;
  var masteryScore = null, lastScaled = null;
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
    if (!api || !initialized) { return ""; }
    try { return api.GetValue(el); } catch (e) { log("GetValue error: " + el); return ""; }
  }
  function set(el, val) {
    if (!api || !initialized) { return; }
    try { api.SetValue(el, String(val)); } catch (e) { log("SetValue error: " + el); }
  }
  function doCommit() {
    lastCommit = (new Date()).getTime();
    if (!api || !initialized) { return; }
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
    var p = total > 0 ? (reachedCount / total) : 1;
    if (p < lastProgress) { p = lastProgress; }
    lastProgress = p;
    set("cmi.progress_measure", formatMeasure(p));
    if (p >= 1 && !completed) { markCompleted(); }
  }
  function markCompleted() { completed = true; set("cmi.completion_status", "completed"); if (successOnComplete) { set("cmi.success_status", "passed"); } log("module completed"); }

  function persist() {
    set("cmi.suspend_data", JSON.stringify({ v: SUSPEND_VERSION, reached: keysOf(reached) }));
    var y = window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0;
    set("cmi.location", String(y));
    set("cmi.exit", "suspend");
    scheduleCommit();
  }

  // ---- score reporting (v2) ------------------------------------------------
  function fmtScaled(x) { if (x >= 1) { return "1"; } if (x <= 0) { return "0"; } return String(Math.round(x * 10000) / 10000); }
  function reportScore(raw, min, max) {
    raw = Number(raw);
    if (isNaN(raw)) { return; }
    min = Number(min); if (isNaN(min)) { min = 0; }
    max = Number(max); if (isNaN(max) || !(max > min)) { max = min + 100; }
    var scaled = (raw - min) / (max - min);
    if (scaled < 0) { scaled = 0; } if (scaled > 1) { scaled = 1; }
    lastScaled = scaled;
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
    for (i = 0; i < nodes.length; i++) { id = nodes[i].getAttribute("data-jalon"); if (id && !seen[id]) { seen[id] = true; milestoneIds.push(id); } }
  }
  function wireTriggers() {
    var nodes = document.querySelectorAll("[data-jalon]"), io = null, j;
    if (window.IntersectionObserver) {
      io = new IntersectionObserver(function (entries) {
        var k; for (k = 0; k < entries.length; k++) {
          if (entries[k].isIntersecting) { var id = entries[k].target.getAttribute("data-jalon"); io.unobserve(entries[k].target); reach(id); }
        }
      }, { threshold: 0.5 });
    }
    for (j = 0; j < nodes.length; j++) {
      (function (node) {
        var id = node.getAttribute("data-jalon");
        var trig = (node.getAttribute("data-trigger") || "view").toLowerCase();
        if (trig === "click") { node.addEventListener("click", function () { reach(id); }, { once: true }); }
        else if (trig === "ended") { node.addEventListener("ended", function () { reach(id); }, { once: true }); }
        else { if (io) { io.observe(node); } else { reach(id); } }
      })(nodes[j]);
    }
  }

  // ---- resume --------------------------------------------------------------
  function restore() {
    var raw = get("cmi.suspend_data"), i;
    if (raw) {
      try {
        var d = JSON.parse(raw);
        if (d && d.reached && d.reached.length) {
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
    if (!api) { previewMode = true; log("no LMS API found - preview mode (no tracking)"); collectMilestones(); return; }
    var res; try { res = api.Initialize(""); } catch (e) { res = "false"; }
    initialized = (res === "true" || res === true);
    if (!initialized) { var err = ""; try { err = String(api.GetLastError()); } catch (e2) {} if (err === "103") { initialized = true; } }
    if (!initialized) { previewMode = true; log("Initialize failed - preview mode (no tracking)"); collectMilestones(); return; }
    startTime = (new Date()).getTime();
    if (get("cmi.completion_status") !== "completed") { set("cmi.completion_status", "incomplete"); }
    collectMilestones();
    restore();
    wireTriggers();
    doCommit();
  }
  function endSession() {
    if (previewMode || !initialized || terminated) { return; }
    terminated = true;
    if (commitTimer) { window.clearTimeout(commitTimer); commitTimer = null; }
    var elapsed = startTime ? ((new Date()).getTime() - startTime) : 0;
    set("cmi.session_time", iso8601(elapsed));
    set("cmi.suspend_data", JSON.stringify({ v: SUSPEND_VERSION, reached: keysOf(reached) }));
    var y = window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0;
    set("cmi.location", String(y));
    set("cmi.exit", completed ? "normal" : "suspend");
    doCommit();
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
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && !previewMode && initialized && !terminated) { persist(); }
  });
})();
`;
