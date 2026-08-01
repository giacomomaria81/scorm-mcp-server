/**
 * SCORM 1.2 support (2.1.0): manifest, schemas, adaptive runtime, batch, CLI.
 *
 * The runtime is dialect-adaptive: it finds either API_1484_11 (2004) or API
 * (1.2) and translates element names + call names. These tests run the REAL
 * packaged runtime against a mock SCORM 1.2 API in jsdom.
 */
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";

const pexec = promisify(execFile);
let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✗ FAIL: " + label); }
};

const SAMPLE = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>S12</title></head>
<body><section data-jalon="a"><h2>A</h2></section><section data-jalon="b"><h2>B</h2></section></body></html>`;

// mock SCORM 1.2 API: LMS-prefixed calls, single lesson_status field
function mockApi12(initial = {}) {
  const cmi = { ...initial };
  const calls = [];
  return {
    cmi, calls,
    api: {
      LMSInitialize: () => { calls.push(["LMSInitialize"]); return "true"; },
      LMSFinish: () => { calls.push(["LMSFinish"]); return "true"; },
      LMSGetValue: (k) => cmi[k] != null ? String(cmi[k]) : "",
      LMSSetValue: (k, v) => { calls.push(["LMSSetValue", k, v]); cmi[k] = v; return "true"; },
      LMSCommit: () => "true",
      LMSGetLastError: () => "0", LMSGetErrorString: () => "", LMSGetDiagnostic: () => "",
    },
  };
}

function installIO(window) {
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { this.cb([{ isIntersecting: true, target: el }], this); }
    unobserve() {} disconnect() {}
  };
}

function run(html, mock) {
  return new Promise((resolve) => {
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(window) { window.API = mock.api; installIO(window); }, // 1.2 API only
    });
    const w = dom.window;
    w.addEventListener("load", () => { setTimeout(() => resolve({ window: w }), 40); });
  });
}

console.log("1 — SCORM 1.2 manifest:");
{
  const r = await buildPackage({ html: SAMPLE, title: "Cours Legacy", scormVersion: "1.2", masteryScore: 0.6 });
  const zip = await JSZip.loadAsync(r.zip);
  const manifest = await zip.file("imsmanifest.xml").async("string");
  check("result.scormVersion = 1.2", r.scormVersion === "1.2");
  check("fileName suffix -scorm12.zip", r.fileName.endsWith("-scorm12.zip"));
  check("schemaversion 1.2", manifest.includes("<schemaversion>1.2</schemaversion>"));
  check("imsproject namespace", manifest.includes("http://www.imsproject.org/xsd/imscp_rootv1p1p2"));
  check("lowercase adlcp:scormtype", manifest.includes('adlcp:scormtype="sco"'));
  check("masteryscore 60 on item", manifest.includes("<adlcp:masteryscore>60</adlcp:masteryscore>"));
  check("no imsss sequencing in 1.2", !manifest.includes("imsss:"));
  const names = Object.keys(zip.files);
  check("1.2 XSDs bundled", names.includes("imscp_rootv1p1p2.xsd") && names.includes("adlcp_rootv1p2.xsd"));
  check("wrapper12 NOT shipped", !names.includes("wrapper12.xsd"));
  check("2004 XSDs NOT shipped in a 1.2 package", !names.includes("imscp_v1p1.xsd"));
}

console.log("2 — 1.2 manifest validates against the XSDs (xmllint):");
{
  const r = await buildPackage({ html: SAMPLE, title: "Validation 12", scormVersion: "1.2", masteryScore: 0.5 });
  const zip = await JSZip.loadAsync(r.zip);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "val12-"));
  for (const name of ["imsmanifest.xml", "imscp_rootv1p1p2.xsd", "adlcp_rootv1p2.xsd", "imsmd_rootv1p2p1.xsd", "ims_xml.xsd"]) {
    await fs.writeFile(path.join(dir, name), await zip.file(name).async("nodebuffer"));
  }
  // validation wrapper importing both namespaces (not shipped in the package)
  await fs.writeFile(path.join(dir, "wrapper12.xsd"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
    '  <xsd:import namespace="http://www.imsproject.org/xsd/imscp_rootv1p1p2" schemaLocation="imscp_rootv1p1p2.xsd"/>\n' +
    '  <xsd:import namespace="http://www.adlnet.org/xsd/adlcp_rootv1p2" schemaLocation="adlcp_rootv1p2.xsd"/>\n</xsd:schema>');
  try {
    await pexec("xmllint", ["--noout", "--schema", path.join(dir, "wrapper12.xsd"), path.join(dir, "imsmanifest.xml")]);
    check("imsmanifest.xml validates (SCORM 1.2)", true);
  } catch (e) {
    check("imsmanifest.xml validates (SCORM 1.2) → " + (e.stderr || e.message), false);
  }
}

console.log("3 — adaptive runtime against a mock 1.2 LMS:");
{
  const r = await buildPackage({ html: SAMPLE, title: "RT12", scormVersion: "1.2", masteryScore: 0.5 });
  const zip = await JSZip.loadAsync(r.zip);
  const html = await zip.file("index.html").async("string");
  const mock = mockApi12();
  const { window } = await run(html, mock);
  check("LMSInitialize called", mock.calls.some((c) => c[0] === "LMSInitialize"));
  check("lesson_status written (1.2 single field)", mock.cmi["cmi.core.lesson_status"] !== undefined);
  check("no 2004 element ever written", !mock.calls.some((c) => c[1] && /^cmi\.(completion_status|success_status|progress_measure|score\.scaled)/.test(c[1])));
  // both milestones fire via IO → completed
  check("lesson_status completed after all milestones", ["completed", "passed"].includes(mock.cmi["cmi.core.lesson_status"]));
  // score: 3/4 → 75% in 0..100, and passed vs mastery 0.5
  window.SCORM2004.score(3, 0, 4);
  check("score.raw normalised to 0..100", mock.cmi["cmi.core.score.raw"] === "75");
  check("score min/max = 0/100", mock.cmi["cmi.core.score.min"] === "0" && mock.cmi["cmi.core.score.max"] === "100");
  check("lesson_status passed (mastery met)", mock.cmi["cmi.core.lesson_status"] === "passed");
  window.dispatchEvent(new window.Event("pagehide"));
  check("LMSFinish called on exit", mock.calls.some((c) => c[0] === "LMSFinish"));
  const st = mock.cmi["cmi.core.session_time"];
  check("session_time in HH:MM:SS.ss (" + st + ")", /^\d{2,}:\d{2}:\d{2}(\.\d{1,2})?$/.test(st || ""));
  check("exit via cmi.core.exit", mock.cmi["cmi.core.exit"] !== undefined);
}

console.log("4 — lesson_status never downgrades passed -> completed/incomplete:");
{
  const r = await buildPackage({ html: SAMPLE, title: "RT12b", scormVersion: "1.2", masteryScore: 0.5 });
  const zip = await JSZip.loadAsync(r.zip);
  const html = await zip.file("index.html").async("string");
  const mock = mockApi12();
  const { window } = await run(html, mock);
  window.SCORM2004.score(4, 0, 4); // passed
  // milestones also completed → a later "completed" write must not override passed
  check("passed survives completion writes", mock.cmi["cmi.core.lesson_status"] === "passed");
  window.SCORM2004.score(0, 0, 4); // failed AFTER passed: rank equal → allowed (real regression)
  check("failed can replace passed (same rank, honest report)", mock.cmi["cmi.core.lesson_status"] === "failed");
}

console.log("5 — suspend_data capped at 4096 for 1.2:");
{
  const r = await buildPackage({ html: "<html><head><title>x</title></head><body><p>s</p></body></html>", scormVersion: "1.2", title: "Cap12", autoMilestones: false });
  const zip = await JSZip.loadAsync(r.zip);
  const html = await zip.file("index.html").async("string");
  const mock = mockApi12();
  const { window } = await run(html, mock);
  for (let i = 0; i < 300; i++) { window.SCORM2004.reach("milestone-with-long-id-" + i); }
  window.dispatchEvent(new window.Event("pagehide"));
  const sd = mock.cmi["cmi.suspend_data"];
  check("suspend_data ≤ 4096 chars (1.2 SPM)", typeof sd === "string" && sd.length <= 4096);
  check("still valid JSON", (() => { try { JSON.parse(sd); return true; } catch { return false; } })());
}

console.log("6 — 2004 behaviour untouched (regression):");
{
  const r = await buildPackage({ html: SAMPLE, title: "Still 2004" });
  check("default is 2004", r.scormVersion === "2004");
  check("default filename unchanged", r.fileName.endsWith("-scorm2004.zip"));
  const zip = await JSZip.loadAsync(r.zip);
  const manifest = await zip.file("imsmanifest.xml").async("string");
  check("2004 manifest unchanged", manifest.includes("2004 4th Edition"));
  check("15 XSD 2004 bundled", r.schemasBundled === 15);
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
