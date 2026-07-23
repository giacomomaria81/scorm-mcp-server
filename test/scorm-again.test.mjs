/**
 * test/scorm-again.test.mjs — validate the generated SCO against scorm-again's
 * strict SCORM 2004 runtime (independent, spec-compliant data-model validation).
 *
 * Deps (dev):  npm i -D scorm-again jsdom    (jszip is already a dependency)
 * Run:         node test/scorm-again.test.mjs
 *
 * Why: a hand-written mock can't prove conformance. scorm-again rejects any
 * malformed cmi element or value with an error code, so "every SetValue
 * accepted, error 0" means our runtime speaks SCORM 2004 correctly.
 */
import { Scorm2004API } from "scorm-again/scorm2004";
import { JSDOM } from "jsdom";
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";

const SAMPLE = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>RT</title></head>
<body>
  <section data-jalon="a" data-trigger="view"><h2>A</h2></section>
  <section data-jalon="b" data-trigger="view"><h2>B</h2></section>
  <section data-jalon="c" data-trigger="click"><button id="btn">ok</button></section>
  <video id="vid" data-jalon="d" data-trigger="ended"></video>
</body></html>`;

const res = await buildPackage({ html: SAMPLE, title: "scorm-again conformance" });
const zip = await JSZip.loadAsync(res.zip);
const indexHtml = await zip.file("index.html").async("string");

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✔ " + l); } else { fail++; console.log("  ✗ FAIL: " + l); } };

const setLog = [];
let api;

const dom = new JSDOM(indexHtml, {
  runScripts: "dangerously",
  url: "https://lms.local/courses/sco/index.html", // real origin so localStorage works
  pretendToBeVisual: true,
  beforeParse(window) {
    global.window = window;
    global.localStorage = window.localStorage;
    global.document = window.document;
    api = new Scorm2004API({ autocommit: false, enableOfflineSupport: false, logLevel: "ERROR" });
    const origSet = api.SetValue.bind(api);
    api.SetValue = (el, val) => { const rc = origSet(el, val); setLog.push({ el, val, rc, err: String(api.GetLastError()) }); return rc; };
    window.IntersectionObserver = class { constructor(cb){ this.cb = cb; } observe(el){ this.cb([{ isIntersecting:true, target:el }], this); } unobserve(){} disconnect(){} };
    window.API_1484_11 = api;
  },
});

const w = dom.window;
await new Promise((resolve) => {
  w.addEventListener("load", () => {
    w.document.getElementById("btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    w.document.getElementById("vid").dispatchEvent(new w.Event("ended"));
    setTimeout(resolve, 40);
  });
});
w.dispatchEvent(new w.Event("pagehide"));
await new Promise((r) => setTimeout(r, 30));

const lastOf = (el) => { const e = [...setLog].reverse().find((c) => c.el === el); return e ? e.val : undefined; };
const badCalls = setLog.filter((c) => c.rc !== "true" || (c.err !== "0" && c.err !== ""));

console.log("Validation against scorm-again (strict SCORM 2004 runtime):");
check("at least one SetValue recorded", setLog.length > 0);
check("EVERY SetValue accepted (rc=true, error=0)", badCalls.length === 0);
badCalls.slice(0, 5).forEach((c) => console.log("     rejected:", c.el, "=", JSON.stringify(c.val), "err=" + c.err));
check("completion_status === 'completed' (got " + lastOf("cmi.completion_status") + ")", lastOf("cmi.completion_status") === "completed");
check("progress_measure === '1' (got " + lastOf("cmi.progress_measure") + ")", String(lastOf("cmi.progress_measure")) === "1");
check("session_time is an ISO 8601 duration scorm-again accepted (got " + lastOf("cmi.session_time") + ")", /^PT/.test(lastOf("cmi.session_time") || ""));
let ok = false; try { ok = JSON.parse(lastOf("cmi.suspend_data")).reached.length === 4; } catch {}
check("suspend_data round-trips 4 milestones", ok);

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
