/**
 * Dynamic test: actually RUN the injected runtime against a mock SCORM 2004 API.
 * Verifies: Initialize, progress_measure increments, completion_status="completed",
 * suspend_data round-trip, Terminate on unload, and resume from prior suspend_data.
 */
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";
import { JSDOM } from "jsdom";

const SAMPLE = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>RT</title></head>
<body>
  <section data-jalon="a" data-trigger="view"><h2>A</h2></section>
  <section data-jalon="b" data-trigger="view"><h2>B</h2></section>
  <section data-jalon="c" data-trigger="click"><button id="btn">ok</button></section>
  <video id="vid" data-jalon="d" data-trigger="ended"></video>
</body></html>`;

// Build a package (no remote assets -> no network), extract index.html.
const res = await buildPackage({ html: SAMPLE, title: "Runtime Test" });
const zip = await JSZip.loadAsync(res.zip);
const indexHtml = await zip.file("index.html").async("string");

function makeMockApi(initialCmi = {}) {
  const cmi = { ...initialCmi };
  const calls = [];
  return {
    cmi, calls,
    api: {
      Initialize: () => { calls.push(["Initialize"]); return "true"; },
      Terminate: () => { calls.push(["Terminate"]); return "true"; },
      GetValue: (k) => { calls.push(["GetValue", k]); return cmi[k] != null ? String(cmi[k]) : ""; },
      SetValue: (k, v) => { calls.push(["SetValue", k, v]); cmi[k] = v; return "true"; },
      Commit: () => { calls.push(["Commit"]); return "true"; },
      GetLastError: () => "0", GetErrorString: () => "", GetDiagnostic: () => "",
    },
  };
}

// Minimal IntersectionObserver that reports "in view" immediately on observe.
function installIO(window) {
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { this.cb([{ isIntersecting: true, target: el }], this); }
    unobserve() {}
    disconnect() {}
  };
}

function run(html, mock, prep) {
  return new Promise((resolve) => {
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(window) {
        window.API_1484_11 = mock.api;
        installIO(window);
      },
    });
    const w = dom.window;
    w.addEventListener("load", () => {
      if (prep) { prep(w); }
      // give microtasks/timeouts a tick
      setTimeout(() => { resolve({ window: w }); }, 30);
    });
  });
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✗ FAIL: " + label); }
}

// ---- Scenario 1: fresh session, reach all milestones ----
console.log("Scenario 1 — fresh session, all milestones reached:");
{
  const mock = makeMockApi();
  const { window } = await run(indexHtml, mock, (w) => {
    // view jalons (a,b) fire via IO automatically; trigger click + ended
    w.document.getElementById("btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    w.document.getElementById("vid").dispatchEvent(new w.Event("ended"));
  });

  const setCalls = mock.calls.filter((c) => c[0] === "SetValue");
  const progressVals = setCalls.filter((c) => c[1] === "cmi.progress_measure").map((c) => c[2]);
  const finalProgress = progressVals[progressVals.length - 1];
  const completion = mock.cmi["cmi.completion_status"];
  const suspend = mock.cmi["cmi.suspend_data"];
  let reachedIds = [];
  try { reachedIds = JSON.parse(suspend).reached.sort(); } catch {}

  check("Initialize was called", mock.calls.some((c) => c[0] === "Initialize"));
  check("progress_measure was set multiple times", progressVals.length >= 4);
  check("final progress_measure === '1' (got " + finalProgress + ")", finalProgress === "1");
  check("completion_status === 'completed' (got " + completion + ")", completion === "completed");
  check("suspend_data holds all 4 ids (got " + JSON.stringify(reachedIds) + ")",
        JSON.stringify(reachedIds) === JSON.stringify(["a", "b", "c", "d"]));

  // unload -> Terminate
  window.dispatchEvent(new window.Event("pagehide"));
  await new Promise((r) => setTimeout(r, 20));
  check("Terminate was called on unload", mock.calls.some((c) => c[0] === "Terminate"));
  check("Commit was called", mock.calls.some((c) => c[0] === "Commit"));
  const st = mock.cmi["cmi.session_time"];
  check("session_time set in ISO 8601 duration (got " + st + ")", typeof st === "string" && /^PT\d+H\d+M[\d.]+S$/.test(st));
}

// ---- Scenario 2: resume from prior suspend_data (a,b already done) ----
console.log("Scenario 2 — resume from prior progress (a,b pre-done):");
{
  const mock = makeMockApi({
    "cmi.suspend_data": JSON.stringify({ v: 1, reached: ["a", "b"] }),
    "cmi.completion_status": "incomplete",
    "cmi.location": "0",
  });
  const { window } = await run(indexHtml, mock, null); // don't trigger c/d
  const setCalls = mock.calls.filter((c) => c[0] === "SetValue");
  const progressVals = setCalls.filter((c) => c[1] === "cmi.progress_measure").map((c) => c[2]);
  const finalProgress = progressVals[progressVals.length - 1];
  // a,b restored + a,b view-fire again (already counted) => 2/4 = 0.5, not regressed, not completed
  check("progress restored to >= 0.5 (got " + finalProgress + ")", parseFloat(finalProgress) >= 0.5);
  check("not marked completed yet (got " + mock.cmi["cmi.completion_status"] + ")",
        mock.cmi["cmi.completion_status"] !== "completed");
  window.close();
}

// ---- Scenario 3: preview mode (no API present) must not throw ----
console.log("Scenario 3 — no LMS API (preview mode), must not crash:");
{
  let threw = false;
  try {
    const dom = new JSDOM(indexHtml, { runScripts: "dangerously", beforeParse(w){ installIO(w); /* no API_1484_11 */ } });
    await new Promise((r) => dom.window.addEventListener("load", () => setTimeout(r, 30)));
    check("window.SCORM2004.isPreview() === true", dom.window.SCORM2004 && dom.window.SCORM2004.isPreview() === true);
  } catch (e) { threw = true; }
  check("no exception in preview mode", threw === false);
}

// ---- Scenario 4: API discovery algorithm (parent chain + opener + cross-origin) ----
// Mirrors the runtime's findAPIInWindow/locateAPI exactly, exercised against
// synthetic window objects (jsdom cannot fake a real multi-frame parent chain).
console.log("Scenario 4 — API discovery algorithm (parent walk / opener / cross-origin):");
{
  const MAX_DEPTH = 500;
  function findAPIInWindow(win) {
    let depth = 0;
    while (win) {
      try { if (win.API_1484_11) return win.API_1484_11; } catch (e) {}
      let parent = null;
      try { parent = (win.parent && win.parent !== win) ? win.parent : null; } catch (e) { parent = null; }
      if (!parent) break;
      win = parent;
      if (++depth > MAX_DEPTH) break;
    }
    return null;
  }
  function locateAPI(window) {
    let a = findAPIInWindow(window);
    if (!a) { try { if (window.opener) a = findAPIInWindow(window.opener); } catch (e) {} }
    return a;
  }

  const API = { name: "lms-api" };

  // (a) API two levels up the parent chain
  const top = {}; top.parent = top; top.API_1484_11 = API;
  const mid = { parent: top };
  const child = { parent: mid, opener: null };
  check("finds API two frames up", locateAPI(child) === API);

  // (b) cross-origin parent access throws -> must not crash, falls through to opener
  const opener = { parent: null, API_1484_11: API }; opener.parent = opener;
  const hostile = { opener };
  Object.defineProperty(hostile, "parent", { get() { throw new Error("SecurityError: cross-origin"); } });
  check("survives cross-origin parent and finds API via opener", locateAPI(hostile) === API);

  // (c) genuinely no API anywhere -> null (preview mode upstream)
  const lonelyTop = {}; lonelyTop.parent = lonelyTop;
  const lonely = { parent: lonelyTop, opener: null };
  check("returns null when no API exists", locateAPI(lonely) === null);
}

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
