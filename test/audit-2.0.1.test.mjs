/**
 * Regression tests for the 2.0.1 audit fixes (converter + runtime).
 * Each scenario reproduces a bug found on 2026-07-25; see comments inline.
 */
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✗ FAIL: " + label); }
};

function makeMockApi(initialCmi = {}) {
  const cmi = { ...initialCmi };
  const calls = [];
  return {
    cmi, calls,
    api: {
      Initialize: () => { calls.push(["Initialize"]); return "true"; },
      Terminate: () => { calls.push(["Terminate"]); return "true"; },
      GetValue: (k) => cmi[k] != null ? String(cmi[k]) : "",
      SetValue: (k, v) => { calls.push(["SetValue", k, v]); cmi[k] = v; return "true"; },
      Commit: () => "true",
      GetLastError: () => "0", GetErrorString: () => "", GetDiagnostic: () => "",
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

function run(html, mock, { beforeParseExtra } = {}) {
  return new Promise((resolve) => {
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(window) {
        window.API_1484_11 = mock.api;
        installIO(window);
        if (beforeParseExtra) { beforeParseExtra(window); }
      },
    });
    const w = dom.window;
    w.addEventListener("load", () => { setTimeout(() => resolve({ window: w, dom }), 40); });
  });
}

async function packagedHtml(sample, opts = {}) {
  const res = await buildPackage({ html: sample, title: "Audit 201", auto_milestones: false, autoMilestones: opts.autoMilestones ?? false, ...opts });
  const zip = await JSZip.loadAsync(res.zip);
  return { html: await zip.file("index.html").async("string"), res };
}

// ============================ RUNTIME ============================

console.log("1 — no milestones ≠ completed at open (visited-on-exit instead):");
{
  // Bug: total=0 → progress forced to 1 → markCompleted() AT OPEN, and
  // lastProgress=1 froze all later reporting.
  const bare = "<!DOCTYPE html><html><head><title>x</title></head><body><p>plain</p></body></html>";
  const { html } = await packagedHtml(bare, { autoMilestones: false });
  const mock = makeMockApi();
  const { window } = await run(html, mock);
  check("not completed at open", mock.cmi["cmi.completion_status"] !== "completed");
  window.dispatchEvent(new window.Event("pagehide"));
  check("completed (visited) on exit", mock.cmi["cmi.completion_status"] === "completed");
  check("Terminate called once", mock.calls.filter((c) => c[0] === "Terminate").length === 1);
}

console.log("2 — late declare() after an empty start still reaches 100%:");
{
  const bare = "<!DOCTYPE html><html><head><title>x</title></head><body><p>spa</p></body></html>";
  const { html } = await packagedHtml(bare, { autoMilestones: false });
  const mock = makeMockApi();
  const { window } = await run(html, mock);
  window.SCORM2004.declare("s1"); window.SCORM2004.declare("s2");
  window.SCORM2004.reach("s1");
  check("progress 0.5 reported (not frozen at 1)", mock.cmi["cmi.progress_measure"] === "0.5");
  window.SCORM2004.reach("s2");
  check("completed at 100%", mock.cmi["cmi.completion_status"] === "completed");
}

console.log("3 — events fired BEFORE Initialize are replayed, not lost:");
{
  // Bug: scorm:complete/scorm:score emitted at load (before DOMContentLoaded →
  // startSession) were memorised but their SetValue dropped; line 221 then wrote
  // "incomplete" and the completed guard prevented any later write.
  const early = `<!DOCTYPE html><html><head><title>x</title></head><body><p>e</p>
<script>
window.dispatchEvent(new CustomEvent("scorm:score", { detail: { raw: 8, min: 0, max: 10 } }));
window.dispatchEvent(new CustomEvent("scorm:complete"));
</script></body></html>`;
  // inject runtime BEFORE the content script (packaging puts it in <head>)
  const { html } = await packagedHtml(early, { autoMilestones: false });
  const mock = makeMockApi();
  await run(html, mock);
  check("completion replayed after Initialize", mock.cmi["cmi.completion_status"] === "completed");
  check("score.raw replayed", mock.cmi["cmi.score.raw"] === "8");
  check("score.scaled replayed", mock.cmi["cmi.score.scaled"] === "0.8");
}

console.log("4 — legacy/foreign suspend_data as a STRING doesn't create ghost milestones:");
{
  // Bug: a string passes `d.reached.length` and gets iterated char by char.
  const two = `<!DOCTYPE html><html><head><title>x</title></head><body>
<section data-jalon="a"><h2>A</h2></section><section data-jalon="b"><h2>B</h2></section>
</body></html>`;
  const { html } = await packagedHtml(two, { autoMilestones: false });
  const mock = makeMockApi({ "cmi.suspend_data": JSON.stringify({ v: 1, reached: "ab" }) });
  await run(html, mock);
  // With ghost milestones ("a","b" as chars would collide here, so use measure):
  // both real jalons fire via IO → progress must be exactly 1, not 2/4.
  check("progress reaches 1 (no ghost total)", mock.cmi["cmi.progress_measure"] === "1");
  check("completed", mock.cmi["cmi.completion_status"] === "completed");
}

console.log("5 — suspend_data stays under the 64k SPM:");
{
  const bare = "<!DOCTYPE html><html><head><title>x</title></head><body><p>big</p></body></html>";
  const { html } = await packagedHtml(bare, { autoMilestones: false });
  const mock = makeMockApi();
  const { window } = await run(html, mock);
  for (let i = 0; i < 2000; i++) { window.SCORM2004.reach("milestone-with-a-quite-long-identifier-" + i); }
  window.dispatchEvent(new window.Event("pagehide"));
  const sd = mock.cmi["cmi.suspend_data"];
  check("suspend_data written", typeof sd === "string" && sd.length > 0);
  check("suspend_data ≤ 64000 chars", sd.length <= 64000);
  check("suspend_data still valid JSON", (() => { try { JSON.parse(sd); return true; } catch { return false; } })());
}

console.log("6 — Infinity score is refused (score.raw is real(10,7)):");
{
  const bare = "<!DOCTYPE html><html><head><title>x</title></head><body><p>s</p></body></html>";
  const { html } = await packagedHtml(bare, { autoMilestones: false });
  const mock = makeMockApi();
  const { window } = await run(html, mock);
  window.SCORM2004.score(Infinity, 0, 10);
  check("no score.raw written for Infinity", mock.cmi["cmi.score.raw"] === undefined);
  window.SCORM2004.score(7, 0, 10);
  check("finite score still works", mock.cmi["cmi.score.raw"] === "7");
}

console.log("7 — double injection: single Initialize, no duplicate listeners:");
{
  const bare = "<!DOCTYPE html><html><head><title>x</title></head><body><p>d</p></body></html>";
  const { html } = await packagedHtml(bare, { autoMilestones: false });
  // duplicate the whole runtime <script> block (the one holding the singleton flag)
  const m = html.match(/<script[^>]*>[^<]*?__SCORM_JALONS__[\s\S]*?<\/script>/);
  const doubled = html.replace(m[0], m[0] + m[0]);
  const mock = makeMockApi();
  const { window } = await run(doubled, mock);
  check("Initialize called exactly once", mock.calls.filter((c) => c[0] === "Initialize").length === 1);
  window.dispatchEvent(new window.CustomEvent("scorm:score", { detail: { raw: 5, min: 0, max: 10 } }));
  const scoreWrites = mock.calls.filter((c) => c[0] === "SetValue" && c[1] === "cmi.score.raw").length;
  check("score written once, not twice", scoreWrites === 1);
}

console.log("8 — after Terminate (bfcache), no further SetValue leaks:");
{
  const bare = "<!DOCTYPE html><html><head><title>x</title></head><body><p>b</p></body></html>";
  const { html } = await packagedHtml(bare, { autoMilestones: false });
  const mock = makeMockApi();
  const { window } = await run(html, mock);
  window.dispatchEvent(new window.Event("pagehide"));
  const writesAtTerminate = mock.calls.length;
  window.SCORM2004.reach("late-one");
  check("no SetValue after Terminate", mock.calls.length === writesAtTerminate);
}

// ============================ CONVERTER ============================

console.log("9 — manifest hrefs: '#' in a bundle filename is percent-encoded:");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "href-"));
  await fs.writeFile(path.join(dir, "index.html"), "<!DOCTYPE html><html><head><title>h</title></head><body><img src='img %231.png'><p>x</p></body></html>");
  await fs.writeFile(path.join(dir, "img #1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const r = await buildPackage({ inputPath: dir, title: "Href test" });
  const zip = await JSZip.loadAsync(r.zip);
  const manifest = await zip.file("imsmanifest.xml").async("string");
  check("no raw '#' in file hrefs", !/href="[^"]*#/.test(manifest));
  check("filename encoded as %23", manifest.includes("img%20%231.png"));
}

console.log("10 — non-NCName identifier is replaced (not shipped invalid):");
{
  const r = await buildPackage({ html: "<html><head><title>t</title></head><body><p>x</p></body></html>", title: "Id test", identifier: "mon cours 2024" });
  const zip = await JSZip.loadAsync(r.zip);
  const manifest = await zip.file("imsmanifest.xml").async("string");
  check("invalid id not in manifest", !manifest.includes('identifier="mon cours 2024"'));
  check("conformant id generated", /identifier="COURSE-[A-Z0-9-]+"/.test(manifest));
  check("warning emitted", r.warnings.some((w) => w.includes("xs:ID")));
}

console.log("11 — control characters in title are stripped from the manifest:");
{
  const r = await buildPackage({ html: "<html><head><title>t</title></head><body><p>x</p></body></html>", title: "Formation Dior" });
  const zip = await JSZip.loadAsync(r.zip);
  const manifest = await zip.file("imsmanifest.xml").async("string");
  check("no C0 controls in manifest", !/[ --]/.test(manifest));
  check("title text preserved", manifest.includes("Formation Dior"));
}

console.log("12 — binary file passed as input_path is refused with a clear error:");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bin-"));
  const png = path.join(dir, "image.png");
  await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]));
  let err = null;
  try { await buildPackage({ inputPath: png, title: "Bin test" }); } catch (e) { err = e; }
  check("throws instead of shipping garbage", err !== null);
  check("error names the file", err && err.message.includes("image.png"));
}

console.log("13 — symlink escaping the module folder is not inlined:");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sym-"));
  const secret = await fs.mkdtemp(path.join(os.tmpdir(), "secret-"));
  await fs.writeFile(path.join(secret, "secret.txt"), "TOP-SECRET-CONTENT");
  await fs.writeFile(path.join(dir, "index.html"), "<!DOCTYPE html><html><head><title>s</title><link rel='stylesheet' href='style.css'></head><body><p>x</p></body></html>");
  let symlinkOk = true;
  try { await fs.symlink(path.join(secret, "secret.txt"), path.join(dir, "style.css")); } catch { symlinkOk = false; }
  if (symlinkOk) {
    const r = await buildPackage({ inputPath: path.join(dir, "index.html"), title: "Symlink test" });
    const zip = await JSZip.loadAsync(r.zip);
    const out = await zip.file("index.html").async("string");
    check("symlinked outside content NOT embedded", !out.includes("TOP-SECRET-CONTENT") && !out.includes(Buffer.from("TOP-SECRET-CONTENT").toString("base64")));
  } else {
    check("symlink unsupported on this FS — skipped", true);
  }
}

console.log("14 — zip without any HTML entry doesn't leak its temp dir:");
{
  const zip = new JSZip();
  zip.file("readme.txt", "no html here");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const zipPath = path.join(os.tmpdir(), "nohtml-" + Date.now() + ".zip");
  await fs.writeFile(zipPath, buf);
  const before = (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("scorm-in-")).length;
  let err = null;
  try { await buildPackage({ inputPath: zipPath, title: "No html" }); } catch (e) { err = e; }
  const after = (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("scorm-in-")).length;
  check("fails with an error", err !== null);
  check("no scorm-in-* temp dir left behind", after <= before);
}

console.log("15 — CSS @import containing $' patterns is not corrupted:");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "css-"));
  await fs.writeFile(path.join(dir, "index.html"), "<!DOCTYPE html><html><head><title>c</title><link rel='stylesheet' href='main.css'></head><body><p>x</p></body></html>");
  await fs.writeFile(path.join(dir, "main.css"), "@import url('sub.css');\nbody { color: red; }");
  await fs.writeFile(path.join(dir, "sub.css"), ".q::after { content: \"$' and $& are literals\"; }");
  const r = await buildPackage({ inputPath: path.join(dir, "index.html"), title: "CSS dollar" });
  const zip = await JSZip.loadAsync(r.zip);
  const out = await zip.file("index.html").async("string");
  check("$' survives verbatim", out.includes("$' and $& are literals"));
  check("no duplicated tail after $'", (out.match(/color: red/g) || []).length === 1);
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
