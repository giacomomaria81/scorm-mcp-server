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
  // Suspend-data SPM depends on the dialect the LMS speaks:
  // SCORM 2004 allows 64000 chars, SCORM 1.2 only 4096.
  var SUSPEND_MAX_2004 = 64000, SUSPEND_MAX_12 = 4096;
  var MAX_FRAME_DEPTH = 500;
  var COMMIT_INTERVAL_MS = 5000;

  // dialect: "2004" when API_1484_11 is found, "12" when a SCORM 1.2 API is
  // found. The runtime speaks whichever the hosting LMS exposes, so the same
  // package works in both worlds; only the manifest differs between versions.
  var api = null, dialect = null, initialized = false, terminated = false, previewMode = false, successOnComplete = false;
  var masteryScore = null, lastScaled = null, lastScore = null;
  var pendingInteractions = [], interactionCount = 0, interactionsInited = false;
  try { if (typeof window.__SCORM_MASTERY === "number" && window.__SCORM_MASTERY >= 0 && window.__SCORM_MASTERY <= 1) { masteryScore = window.__SCORM_MASTERY; } } catch (e) {}
  var milestoneIds = [], reached = {}, reachedCount = 0, lastProgress = 0, completed = false;
  var startTime = 0, commitTimer = null, lastCommit = 0;

  function log(m) { if (window.console && console.log) { console.log("[scorm-jalons] " + m); } }

  function keysOf(o) { var a = [], k; for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { a.push(k); } } return a; }

  // ---- API discovery (content side) ---------------------------------------
  // Looks for SCORM 2004 (API_1484_11) first, then SCORM 1.2 (API), walking
  // parent frames. Returns { api, dialect } or null.
  function findAPIInWindow(win) {
    var depth = 0, w = win, parent;
    while (w && depth < MAX_FRAME_DEPTH) {
      try {
        if (w.API_1484_11) { return { api: w.API_1484_11, dialect: "2004" }; }
        if (w.API) { return { api: w.API, dialect: "12" }; }
      }
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

  // ---- dialect bridge ------------------------------------------------------
  // The logical layer below always speaks SCORM 2004 element names; this
  // bridge translates calls and element names for a SCORM 1.2 LMS.
  function apiInit() { try { return dialect === "12" ? api.LMSInitialize("") : api.Initialize(""); } catch (e) { return "false"; } }
  function apiTerminate() { try { return dialect === "12" ? api.LMSFinish("") : api.Terminate(""); } catch (e) { return "false"; } }
  function apiGet(el) { return dialect === "12" ? api.LMSGetValue(el) : api.GetValue(el); }
  function apiSet(el, v) { return dialect === "12" ? api.LMSSetValue(el, v) : api.SetValue(el, v); }
  function apiCommit() { return dialect === "12" ? api.LMSCommit("") : api.Commit(""); }
  function apiLastError() { try { return String(dialect === "12" ? api.LMSGetLastError() : api.GetLastError()); } catch (e) { return ""; } }
  function el12(el) {
    // element-name mapping 2004 -> 1.2; returns null when 1.2 has no equivalent
    if (el === "cmi.completion_status" || el === "cmi.success_status") { return "cmi.core.lesson_status"; }
    if (el === "cmi.location") { return "cmi.core.lesson_location"; }
    if (el === "cmi.session_time") { return "cmi.core.session_time"; }
    if (el === "cmi.exit") { return "cmi.core.exit"; }
    if (el === "cmi.score.raw") { return "cmi.core.score.raw"; }
    if (el === "cmi.score.min") { return "cmi.core.score.min"; }
    if (el === "cmi.score.max") { return "cmi.core.score.max"; }
    if (el === "cmi.score.scaled") { return null; } // 1.2 has no scaled score
    if (el === "cmi.progress_measure") { return null; } // 1.2 has no progress
    return el; // cmi.suspend_data is identical
  }
  function suspendMax() { return dialect === "12" ? SUSPEND_MAX_12 : SUSPEND_MAX_2004; }

  // ---- guarded API calls ---------------------------------------------------
  function get(el) {
    if (!api || !initialized || terminated) { return ""; }
    var mapped = dialect === "12" ? el12(el) : el;
    if (!mapped) { return ""; }
    try { return apiGet(mapped); } catch (e) { log("GetValue error: " + mapped); return ""; }
  }
  // lesson_status is a single field in 1.2 shared by completion AND success:
  // passed/failed must win over completed. Track the strongest value written.
  var LESSON_RANK = { "not attempted": 0, browsed: 0, incomplete: 1, completed: 2, failed: 3, passed: 3 };
  var lessonWritten = null;
  function set(el, val) {
    if (!api || !initialized || terminated) { return; }
    var mapped = dialect === "12" ? el12(el) : el, v = String(val);
    if (!mapped) { return; } // element has no 1.2 equivalent: skip silently
    if (dialect === "12" && mapped === "cmi.core.lesson_status") {
      if (lessonWritten !== null && (LESSON_RANK[v] || 0) < (LESSON_RANK[lessonWritten] || 0)) { return; }
      lessonWritten = v;
    }
    if (dialect === "12" && mapped === "cmi.core.lesson_location" && v.length > 255) { v = v.slice(0, 255); } // 1.2 SPM
    try {
      var ok = apiSet(mapped, v);
      if (ok === "false" || ok === false) {
        log("SetValue refused: " + mapped + " (LMS error " + apiLastError() + ")");
      }
    } catch (e) { log("SetValue error: " + mapped); }
  }
  function doCommit() {
    lastCommit = (new Date()).getTime();
    if (!api || !initialized || terminated) { return; }
    try { apiCommit(); } catch (e) { log("Commit error"); }
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
  // SCORM 1.2 wants HH:MM:SS.ss (CMITimespan), hours zero-padded to 2+ digits
  function hhmmss(ms) {
    if (ms < 0) { ms = 0; }
    var totalSec = ms / 1000;
    var h = Math.floor(totalSec / 3600);
    var rem = totalSec - h * 3600;
    var m = Math.floor(rem / 60);
    var s = Math.round((rem - m * 60) * 100) / 100;
    if (s >= 60) { s = 59.99; }
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var sStr = s < 10 ? "0" + s.toFixed(2) : s.toFixed(2);
    return pad(h) + ":" + pad(m) + ":" + sStr;
  }
  function sessionTime(ms) { return dialect === "12" ? hhmmss(ms) : iso8601(ms); }
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
    while (json.length > suspendMax() && ids.length > 0) {
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
    if (dialect === "12") {
      // 1.2 score.raw is a CMIDecimal 0..100: report the normalised percentage
      set("cmi.score.raw", String(Math.round(scaled * 100)));
      set("cmi.score.min", "0");
      set("cmi.score.max", "100");
    } else {
      set("cmi.score.raw", String(raw));
      set("cmi.score.min", String(min));
      set("cmi.score.max", String(max));
      set("cmi.score.scaled", fmtScaled(scaled));
    }
    if (masteryScore !== null) { set("cmi.success_status", scaled >= masteryScore ? "passed" : "failed"); }
    log("score reported: " + raw + " [" + min + ".." + max + "] scaled=" + fmtScaled(scaled));
    scheduleCommit();
  }

  // ---- question-level tracking: cmi.interactions (v2.3) ---------------------
  // Best-effort by design: interactions are OPTIONAL data. Every write goes
  // through a guarded setter, so an LMS that rejects them (some 1.2 players)
  // logs the refusal and the session carries on untouched.
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function interactionTimestamp() {
    var d = new Date();
    if (dialect === "12") { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function interactionLatency(ms) {
    ms = Number(ms);
    if (!isFinite(ms) || ms < 0) { return null; }
    var s = Math.floor(ms / 1000);
    if (dialect === "12") {
      return pad2(Math.floor(s / 3600)) + ":" + pad2(Math.floor((s % 3600) / 60)) + ":" + pad2(s % 60);
    }
    return "PT" + s + "S";
  }
  function interactionId(raw) {
    var id = String(raw == null ? "" : raw).replace(/[^A-Za-z0-9_.:\-]/g, "_").slice(0, 240);
    return id || ("interaction-" + interactionCount);
  }
  function setRaw(el, v) {
    // Direct dialect write (element names are already dialect-correct here).
    try {
      var ok = apiSet(el, String(v));
      if (ok === "true" || ok === true) { return true; }
      log("SetValue refused: " + el + " (LMS error " + apiLastError() + ")");
    } catch (e) { log("SetValue error: " + el); }
    return false;
  }
  function reportInteraction(spec) {
    if (!spec || typeof spec !== "object") { return; }
    if (!interactionsInited) {
      interactionsInited = true;
      try {
        var c = Number(apiGet("cmi.interactions._count"));
        if (isFinite(c) && c > 0) { interactionCount = c; }
      } catch (e) { /* keep 0 */ }
    }
    var i = interactionCount++;
    var p = "cmi.interactions." + i + ".";
    var type = typeof spec.type === "string" && spec.type ? spec.type : "choice";
    var result = spec.result === true ? "correct"
      : spec.result === false ? "incorrect"
      : (typeof spec.result === "string" ? spec.result : null);
    setRaw(p + "id", interactionId(spec.id));
    setRaw(p + "type", type);
    if (dialect === "12") {
      if (spec.learnerResponse != null) { setRaw(p + "student_response", String(spec.learnerResponse).slice(0, 255)); }
      if (spec.correctResponse != null) { setRaw(p + "correct_responses.0.pattern", String(spec.correctResponse).slice(0, 255)); }
      if (result) { setRaw(p + "result", result === "incorrect" ? "wrong" : result); }
      setRaw(p + "time", interactionTimestamp());
    } else {
      if (spec.learnerResponse != null) { setRaw(p + "learner_response", String(spec.learnerResponse).slice(0, 4000)); }
      if (spec.correctResponse != null) { setRaw(p + "correct_responses.0.pattern", String(spec.correctResponse).slice(0, 4000)); }
      if (result) { setRaw(p + "result", result); }
      if (spec.description != null) { setRaw(p + "description", String(spec.description).slice(0, 250)); }
      setRaw(p + "timestamp", interactionTimestamp());
    }
    var lat = interactionLatency(spec.latencyMs);
    if (lat) { setRaw(p + "latency", lat); }
    if (typeof spec.weighting === "number" && isFinite(spec.weighting)) { setRaw(p + "weighting", String(spec.weighting)); }
    log("interaction reported: #" + i + " " + interactionId(spec.id) + (result ? " (" + result + ")" : ""));
    scheduleCommit();
  }
  function interaction(spec) {
    // Fired before Initialize: memorise and replay once the session is open.
    if (previewMode) { return; }
    if (!initialized || !api) { if (spec && typeof spec === "object") { pendingInteractions.push(spec); } return; }
    reportInteraction(spec);
  }
  function onInteractionEvent(e) { try { interaction((e && e.detail) || null); } catch (err) {} }

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
                 ["scorm:score", onScoreEvent], ["dc:score", onScoreEvent],
                 ["scorm:interaction", onInteractionEvent], ["dc:interaction", onInteractionEvent]];
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
    var cs0 = get("cmi.completion_status");
    // in 1.2 the same field also carries success: passed/failed imply completed
    if (cs0 === "completed" || cs0 === "passed" || cs0 === "failed") { completed = true; }
    pushProgress();
    var loc = get("cmi.location");
    if (loc) { var y = parseInt(loc, 10); if (!isNaN(y) && y > 0) { window.setTimeout(function () { window.scrollTo(0, y); }, 60); } }
  }

  // ---- lifecycle -----------------------------------------------------------
  function startSession() {
    var found = locateAPI();
    api = found ? found.api : null;
    dialect = found ? found.dialect : null;
    if (!api) { previewMode = true; log("no LMS API found - preview mode (no tracking)"); collectMilestones(); wireTriggers(); watchDynamicMilestones(); return; }
    log("LMS API found (SCORM " + (dialect === "12" ? "1.2" : "2004") + ")");
    var res = apiInit();
    initialized = (res === "true" || res === true);
    if (!initialized) {
      var err = apiLastError();
      // 103 = already initialized (2004); 101 covers some 1.2 players' re-init
      if (err === "103" || (dialect === "12" && err === "101")) { initialized = true; }
    }
    if (!initialized) { previewMode = true; log("Initialize failed - preview mode (no tracking)"); collectMilestones(); wireTriggers(); watchDynamicMilestones(); return; }
    startTime = (new Date()).getTime();
    var cs = get("cmi.completion_status");
    if (cs !== "completed" && cs !== "passed" && cs !== "failed") { set("cmi.completion_status", "incomplete"); }
    collectMilestones();
    restore();
    // Replay state accumulated BEFORE Initialize: events fired by the content at
    // load time were memorised, but their SetValue calls were dropped (no API
    // yet). Without this, an early scorm:complete or scorm:score is lost forever.
    if (completed) { set("cmi.completion_status", "completed"); if (successOnComplete) { set("cmi.success_status", "passed"); } }
    if (lastScore) { reportScore(lastScore.raw, lastScore.min, lastScore.max); }
    if (lastProgress > 0) { set("cmi.progress_measure", formatMeasure(lastProgress)); }
    while (pendingInteractions.length) { reportInteraction(pendingInteractions.shift()); }
    wireTriggers();
    watchDynamicMilestones();
    doCommit();
  }
  function endSession() {
    if (previewMode || !initialized || terminated) { return; }
    if (commitTimer) { window.clearTimeout(commitTimer); commitTimer = null; }
    var elapsed = startTime ? ((new Date()).getTime() - startTime) : 0;
    set("cmi.session_time", sessionTime(elapsed));
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
    if (apiTerminate() === "false") { log("Terminate refused (LMS error " + apiLastError() + ")"); }
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
    interaction: function (spec) { interaction(spec); },
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
      terminated = false; initialized = false; api = null; dialect = null; lessonWritten = null;
      startSession();
    }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && !previewMode && initialized && !terminated) { persist(); }
  });
})();
`;
