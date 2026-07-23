// V2.0.0 contract — score/events, mastery manifest, bundle input, Claude Design pipeline.
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log("  ✔ " + name); }
  else { failed++; console.log("  ✖ " + name + (extra ? " — " + extra : "")); }
}
function mockApi(initial = {}) {
  const cmi = { ...initial };
  return {
    cmi,
    api: {
      Initialize: () => "true", Terminate: () => "true",
      GetValue: (k) => (cmi[k] != null ? String(cmi[k]) : ""),
      SetValue: (k, v) => { cmi[k] = String(v); return "true"; },
      Commit: () => "true", GetLastError: () => "0", GetErrorString: () => "", GetDiagnostic: () => "",
    },
  };
}
async function buildIndex(opts) {
  const res = await buildPackage(opts);
  const zip = await JSZip.loadAsync(res.zip);
  const entry = opts.__entry || "index.html";
  return { res, zip, indexHtml: await zip.file(entry).async("string") };
}
function runSco(indexHtml, mock) {
  return new Promise((resolve) => {
    const dom = new JSDOM(indexHtml, { runScripts: "dangerously", beforeParse(w) { w.API_1484_11 = mock.api; } });
    dom.window.addEventListener("load", () => setTimeout(() => resolve(dom.window), 30));
  });
}

// ---------------------------------------------------------------- 1) score() + mastery
{
  console.log("1 — runtime score() + mastery pass/fail:");
  const { res, indexHtml } = await buildIndex({ html: `<!DOCTYPE html><html><body><section data-jalon="a">x</section></body></html>`, title: "Score", masteryScore: 0.5 });
  check("mastery manifest has imsss objectives", true, ""); // asserted below via zip
  const zip = await JSZip.loadAsync(res.zip);
  const man = await zip.file("imsmanifest.xml").async("string");
  check("manifest: primaryObjective + minNormalizedMeasure 0.5", man.includes("imsss:primaryObjective") && man.includes("<imsss:minNormalizedMeasure>0.5"), "");
  check("manifest: completionThreshold completedByMeasure", man.includes('completedByMeasure="true"'));

  const mock = mockApi();
  const w = await runSco(indexHtml, mock);
  w.SCORM2004.score(8, 0, 10);
  check("cmi.score.raw=8 / max=10 / scaled=0.8", mock.cmi["cmi.score.raw"] === "8" && mock.cmi["cmi.score.max"] === "10" && mock.cmi["cmi.score.scaled"] === "0.8", JSON.stringify(mock.cmi));
  check("success_status = passed (0.8 >= 0.5)", mock.cmi["cmi.success_status"] === "passed", mock.cmi["cmi.success_status"]);

  const mock2 = mockApi();
  const w2 = await runSco(indexHtml, mock2);
  w2.SCORM2004.score(3, 0, 10);
  check("success_status = failed (0.3 < 0.5)", mock2.cmi["cmi.success_status"] === "failed", mock2.cmi["cmi.success_status"]);
}

// ---------------------------------------------------------------- 2) CustomEvent contract
{
  console.log("2 — CustomEvent contract (scorm:progress / :score / :complete):");
  const { indexHtml } = await buildIndex({ html: `<!DOCTYPE html><html><body><section data-jalon="a">x</section><section data-jalon="b">y</section></body></html>`, title: "Events" });
  const mock = mockApi();
  const w = await runSco(indexHtml, mock);
  w.dispatchEvent(new w.CustomEvent("scorm:score", { detail: { raw: 5, min: 0, max: 10 } }));
  check("scorm:score → cmi.score.scaled 0.5", mock.cmi["cmi.score.scaled"] === "0.5", JSON.stringify(mock.cmi));
  w.dispatchEvent(new w.CustomEvent("scorm:progress", { detail: 1 }));
  check("scorm:progress 1 → progress_measure 1", mock.cmi["cmi.progress_measure"] === "1", mock.cmi["cmi.progress_measure"]);
  check("scorm:progress 1 → completed", mock.cmi["cmi.completion_status"] === "completed", mock.cmi["cmi.completion_status"]);
}

// ---------------------------------------------------------------- 3) Claude Design bundle pipeline
{
  console.log("3 — Claude Design (.dc) bundle: detection + inject-before-support + manifest tree:");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-"));
  await fs.mkdir(path.join(dir, "_ds"), { recursive: true });
  await fs.writeFile(path.join(dir, "support.js"), 'var REACT_URL="https://unpkg.com/react@18.3.1/umd/react.production.min.js";');
  await fs.writeFile(path.join(dir, "_ds", "tokens.css"), ":root{--x:1}");
  await fs.writeFile(path.join(dir, "Module.dc.html"),
    '<!DOCTYPE html><html><head><script src="support.js"></script></head><body><x-dc></x-dc><script type="text/x-dc">class C{}</script></body></html>');

  const res = await buildPackage({ inputPath: dir, title: "DC No Vendor", vendorCdn: false });
  check("format detected: claude-design", res.format === "claude-design", res.format);
  check("files preserved (>=3: html, support.js, tokens.css)", res.filesCount >= 3, "files=" + res.filesCount);
  const zip = await JSZip.loadAsync(res.zip);
  const entry = await zip.file("Module.dc.html").async("string");
  check("runtime injected BEFORE support.js", entry.includes("scorm-jalons-runtime") && entry.indexOf("scorm-jalons-runtime") < entry.indexOf("support.js"));
  const man = await zip.file("imsmanifest.xml").async("string");
  check("manifest lists support.js and _ds/tokens.css", man.includes("support.js") && man.includes("_ds/tokens.css"));
  check("entry href is Module.dc.html", man.includes('href="Module.dc.html"'));
  check("warning when vendor disabled + CDN present", res.warnings.some(w => w.toLowerCase().includes("réseau filtré")), JSON.stringify(res.warnings));

  // with vendoring (network): __resources mapping present
  const res2 = await buildPackage({ inputPath: dir, title: "DC Vendor" });
  const entry2 = await (await JSZip.loadAsync(res2.zip)).file("Module.dc.html").async("string");
  check("vendored ≥1 CDN lib → __resources injected", res2.vendored.length >= 1 && entry2.includes("window.__resources"), "vendored=" + JSON.stringify(res2.vendored));

  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 4) generic multi-file bundle
{
  console.log("4 — generic multi-file bundle (not .dc):");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gen-"));
  await fs.writeFile(path.join(dir, "style.css"), "body{color:#010203}");
  await fs.writeFile(path.join(dir, "index.html"), '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body><section data-jalon="a">x</section></body></html>');
  const res = await buildPackage({ inputPath: dir, title: "Generic Bundle" });
  check("format: html, tree preserved", res.format === "html" && res.filesCount >= 2, "files=" + res.filesCount);
  const idx = await (await JSZip.loadAsync(res.zip)).file("index.html").async("string");
  check("entry inlined (css embedded) + runtime present", idx.includes("#010203") && idx.includes("scorm-jalons-runtime"));
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 5) zip-slip guard
{
  console.log("5 — zip input with a path-traversal entry is neutralised:");
  const z = new JSZip();
  z.file("index.html", '<!DOCTYPE html><html><body><section data-jalon="a">x</section></body></html>');
  z.file("../evil.txt", "SHOULD-NOT-ESCAPE");
  const zipBuf = await z.generateAsync({ type: "nodebuffer" });
  const tmpZip = path.join(os.tmpdir(), "slip-" + Date.now() + ".zip");
  await fs.writeFile(tmpZip, zipBuf);
  const res = await buildPackage({ inputPath: tmpZip, title: "Slip" });
  const names = Object.keys((await JSZip.loadAsync(res.zip)).files);
  check("no traversal entry in output package", !names.some(n => n.includes("..")), JSON.stringify(names));
  check("still built a valid package from index.html", res.format === "html");
  await fs.rm(tmpZip, { force: true });
}

// ---------------------------------------------------------------- 6) .dc html passed alone → warning
{
  console.log("6 — .dc HTML passed as a lone string warns about missing siblings:");
  const res = await buildPackage({ html: '<!DOCTYPE html><html><head><script src="support.js"></script></head><body><x-dc></x-dc><script type="text/x-dc">class C{}</script></body></html>', title: "Lone DC" });
  check("warning about missing support.js/_ds", res.warnings.some(w => w.includes("Claude Design")), JSON.stringify(res.warnings));
}

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
