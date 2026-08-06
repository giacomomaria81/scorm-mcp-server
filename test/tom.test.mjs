/**
 * Mobile-learning Excel export support (2.2.x).
 *
 * Builds a synthetic mobile-learning export (real .xlsx files fabricated as OOXML zips,
 * exactly like Excel writes them: sharedStrings for one template, inline
 * strings for the other) and runs the WHOLE pipeline: detection → xlsx
 * parsing → HTML course generation → SCORM package → xmllint validation →
 * the real packaged runtime + quiz script against a mock LMS in jsdom.
 */
import { buildPackage } from "../dist/converter.js";
import { readXlsx, parseTomActivity, parseTomName, isTomExport, tomTextToHtml } from "../dist/tom.js";
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

// --------------------------------------------------------------------------
// Minimal OOXML writer (the mirror of src/tom.ts's reader)
// --------------------------------------------------------------------------

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** sheets: [{name, cells: {A1: "text"}}]; mode: "shared" | "inline" */
async function makeXlsx(sheets, mode = "shared") {
  const zip = new JSZip();
  const strings = [];
  const sid = (s) => { const i = strings.indexOf(s); if (i >= 0) { return i; } strings.push(s); return strings.length - 1; };

  zip.file("[Content_Types].xml", XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    "</Types>");
  zip.file("_rels/.rels", XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>");
  zip.file("xl/workbook.xml", XML_HEAD +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>");
  zip.file("xl/_rels/workbook.xml.rels", XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    "</Relationships>");

  sheets.forEach((s, i) => {
    const rows = new Map();
    for (const [ref, val] of Object.entries(s.cells)) {
      const r = parseInt(ref.match(/\d+/)[0], 10);
      if (!rows.has(r)) { rows.set(r, []); }
      rows.get(r).push([ref, val]);
    }
    const body = [...rows.keys()].sort((a, b) => a - b).map((r) => {
      const cells = rows.get(r).map(([ref, val]) =>
        mode === "shared"
          ? `<c r="${ref}" t="s"><v>${sid(String(val))}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t>${esc(val)}</t></is></c>`,
      ).join("");
      return `<row r="${r}">${cells}</row>`;
    }).join("");
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, XML_HEAD +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`);
  });

  zip.file("xl/sharedStrings.xml", XML_HEAD +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("") + "</sst>");

  return zip.generateAsync({ type: "nodebuffer" });
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const INSTRUCTIONS = { name: "Instructions", cells: { A1: "Read the Help Center article." } };

async function makeTomExportZip() {
  const mc = await makeXlsx([
    INSTRUCTIONS,
    { name: "Configuration", cells: { D4: "All done!", D5: "You finished the course." } },
    { name: "Cards", cells: {
      A1: "Type", B1: "Front title", E1: "Front text",
      A2: "Info", B2: "Welcome", E2: "[H1:Welcome to retail]\nThis is the introduction.\n[media:logo.png]",
      A3: "Transition", E3: "Next: check your knowledge",
      A4: "Flash", B4: "Pro tip", E4: "What do you say first?", H4: "Reveal", K4: "Answer", N4: "!!Always greet the client",
      A5: "Quiz", Q5: "Which colour is the brand?", T5: "logo.png", U5: "Blue", X5: "Red", AA5: "Green", AD5: "Blue is the brand colour.",
    } },
  ], "shared");

  const qg = await makeXlsx([
    INSTRUCTIONS,
    { name: "Configuration", cells: { D5: "7", D6: "60", D10: "Final quiz", D11: "Answer as fast as you can" } },
    { name: "Cards", cells: {
      A1: "Question", E1: "Answer 1", H1: "Answer 2",
      A2: "What is 2 + 2?", D2: "logo.png", E2: "4", H2: "3", K2: "5", Q2: "Basic arithmetic.",
      A3: "Capital of France?", E3: "Paris", H3: "Rome", K3: "Madrid", N3: "Berlin", Q3: "It is Paris.",
    } },
  ], "inline");

  const zip = new JSZip();
  zip.file("Retail Essentials - Mobile Course - EN.xlsx", mc);
  zip.file("Retail Essentials - Quiz Game - EN.xlsx", qg);
  zip.file("media/logo.png", PNG_1PX);
  return { zipBuf: await zip.generateAsync({ type: "nodebuffer" }), mc, qg };
}

function mockApi2004(initial = {}) {
  const cmi = { ...initial };
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

function runDom(html, mock) {
  return new Promise((resolve) => {
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(window) { window.API_1484_11 = mock.api; installIO(window); },
    });
    const w = dom.window;
    w.addEventListener("load", () => { setTimeout(() => resolve({ window: w }), 40); });
  });
}

// --------------------------------------------------------------------------

const { zipBuf, mc } = await makeTomExportZip();
const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "tom-test-"));
const tomZipPath = path.join(tmpBase, "Retail Essentials.zip");
await fs.writeFile(tomZipPath, zipBuf);

console.log("1 — xlsx reader + template parsing (unit):");
{
  const wb = await readXlsx(mc);
  check("3 sheets read", wb.sheets.length === 3);
  check("shared strings resolved", wb.sheets[2].cells.get("A2") === "Info");
  const warnings = [];
  const act = parseTomActivity(wb, "Retail Essentials - Mobile Course - EN.xlsx", warnings);
  check("detected mobile-course", act.type === "mobile-course");
  check("4 cards parsed (info, transition, flash, quiz)", act.cards.length === 4);
  check("quiz card has 3 answers, 1 correct",
    act.cards[3].kind === "quiz" && act.cards[3].q.answers.length === 3 &&
    act.cards[3].q.answers.filter((a) => a.correct).length === 1);
  const name = parseTomName("Retail Essentials - Quiz Game - EN.xlsx");
  check("filename parsed (course/activity/lang)",
    name.course === "Retail Essentials" && name.activity === "Quiz Game" && name.language === "en");
  check("isTomExport true (xlsx, no html)", isTomExport(["a - b - EN.xlsx", "media/x.png"]));
  check("isTomExport false when HTML present", !isTomExport(["a.xlsx", "index.html"]));
  const html = tomTextToHtml(">><<Centre me\n!!Important", new Map(), []);
  check("layout codes rendered", html.includes('class="center"') && html.includes('class="highlight"'));
}

console.log("2 — TOM zip → SCORM 2004 package:");
let pkgHtml = "";
{
  const r = await buildPackage({ inputPath: tomZipPath });
  const zip = await JSZip.loadAsync(r.zip);
  const names = Object.keys(zip.files);
  check("title derived from templates (no title given)", r.title === "Retail Essentials");
  check("fileName reflects derived title", r.fileName.startsWith("retail-essentials"));
  check("index.html generated", names.includes("index.html"));
  check("media shipped", names.includes("media/logo.png"));
  check("xlsx templates NOT shipped", !names.some((n) => n.endsWith(".xlsx")));
  check("manifest present", names.includes("imsmanifest.xml"));
  check("migration warning surfaced", r.warnings.some((w) => w.includes("Export mobile-learning")));
  pkgHtml = await zip.file("index.html").async("string");
  check("both activities in page", pkgHtml.includes("Welcome to retail") && pkgHtml.includes("What is 2 + 2?"));
  check("3 quiz questions total", (pkgHtml.match(/class="card quiz"/g) || []).length === 3);
  check("flash card button kept", pkgHtml.includes("Reveal"));
  // the pipeline may inline the image as a data URI (its normal offline
  // behaviour) or keep the relative path — both are correct
  check("media resolved (path or inlined data URI)",
    pkgHtml.includes('src="media/logo.png"') || /src="data:image\/png/.test(pkgHtml));
  check("highlight code applied", pkgHtml.includes('class="highlight"'));
  check("runtime injected", pkgHtml.includes("API_1484_11"));

  const manifest = await zip.file("imsmanifest.xml").async("string");
  check("manifest lists media file", manifest.includes('href="media/logo.png"'));

  const dir = path.join(tmpBase, "val2004");
  await fs.mkdir(dir, { recursive: true });
  for (const n of names.filter((x) => x.endsWith(".xsd") || x === "imsmanifest.xml")) {
    await fs.writeFile(path.join(dir, path.basename(n)), await zip.file(n).async("nodebuffer"));
  }
  try {
    await pexec("xmllint", ["--noout", "--schema", path.join(dir, "imscp_v1p1.xsd"), path.join(dir, "imsmanifest.xml")]);
    check("manifest validates (SCORM 2004, xmllint)", true);
  } catch (e) {
    check("manifest validates (SCORM 2004, xmllint) → " + (e.stderr || e.message), false);
  }
}

console.log("3 — packaged course runs: quiz scoring against a mock LMS:");
{
  const mock = mockApi2004();
  const { window: w } = await runDom(pkgHtml, mock);
  const quizzes = w.document.querySelectorAll("[data-quiz]");
  check("3 interactive quizzes in DOM", quizzes.length === 3);
  // answer all questions: 2 correct, 1 wrong
  let clicked = 0;
  quizzes.forEach((quiz, i) => {
    const want = i < 2 ? "1" : "0";
    const btn = [...quiz.querySelectorAll("[data-answer]")].find((b) => b.getAttribute("data-correct") === want);
    if (btn) { btn.click(); clicked++; }
  });
  await new Promise((r) => setTimeout(r, 30));
  check("all 3 questions answered", clicked === 3);
  check("score.raw reported = 2", mock.cmi["cmi.score.raw"] === "2");
  check("score.max reported = 3", mock.cmi["cmi.score.max"] === "3");
  const scaled = Number(mock.cmi["cmi.score.scaled"]);
  check("score.scaled ≈ 0.667", scaled > 0.66 && scaled < 0.67);
  check("wrong answer visually marked", w.document.querySelector(".answer.ko") !== null);
  check("correction revealed after answering", [...w.document.querySelectorAll(".correction")].some((c) => !c.hidden));
  const banner = w.document.getElementById("score-banner");
  check("score banner shown (2 / 3)", banner.classList.contains("on") && banner.textContent.includes("2 / 3"));
  // flash card flips
  const flash = w.document.querySelector("[data-flash]");
  flash.querySelector("[data-flash-btn]").click();
  check("flash card flips to back", flash.querySelector(".flash-back").hidden === false);
}

console.log("4 — SCORM 1.2 variant of the same export:");
{
  const r = await buildPackage({ inputPath: tomZipPath, scormVersion: "1.2", masteryScore: 0.6 });
  const zip = await JSZip.loadAsync(r.zip);
  const manifest = await zip.file("imsmanifest.xml").async("string");
  check("1.2 manifest generated", manifest.includes("<schemaversion>1.2</schemaversion>"));
  check("masteryscore present", manifest.includes("<adlcp:masteryscore>60</adlcp:masteryscore>"));
  check("fileName suffix -scorm12.zip", r.fileName.endsWith("-scorm12.zip"));
}

console.log("5 — directory input stays untouched:");
{
  const dir = path.join(tmpBase, "as-folder");
  await fs.mkdir(path.join(dir, "media"), { recursive: true });
  const zin = await JSZip.loadAsync(zipBuf);
  for (const [name, entry] of Object.entries(zin.files)) {
    if (entry.dir) { continue; }
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), await entry.async("nodebuffer"));
  }
  const before = (await fs.readdir(dir)).sort();
  const r = await buildPackage({ inputPath: dir, title: "From folder" });
  const after = (await fs.readdir(dir)).sort();
  check("package built from a TOM folder", r.zip.length > 1000);
  check("no index.html written into the user's folder", JSON.stringify(before) === JSON.stringify(after) && !after.includes("index.html"));
}

console.log("6 — resilience:");
{
  // unknown template shape → plain-content fallback with a warning
  const weird = await makeXlsx([{ name: "Feuille1", cells: { A1: "Some standalone note", B2: "Another cell" } }], "inline");
  const z = new JSZip();
  z.file("Notes - Divers - FR.xlsx", weird);
  z.file("media/logo.png", PNG_1PX);
  const p = path.join(tmpBase, "weird.zip");
  await fs.writeFile(p, await z.generateAsync({ type: "nodebuffer" }));
  const r = await buildPackage({ inputPath: p });
  check("unknown template imported as content", r.zip.length > 1000);
  check("fallback warning emitted", r.warnings.some((w) => w.includes("plain content")));

  // corrupt xlsx → clear error, no crash, temp dirs cleaned
  const bad = new JSZip();
  bad.file("Broken - Course - EN.xlsx", Buffer.from("not an xlsx at all"));
  const pb = path.join(tmpBase, "bad.zip");
  await fs.writeFile(pb, await bad.generateAsync({ type: "nodebuffer" }));
  let err = null;
  try { await buildPackage({ inputPath: pb }); } catch (e) { err = e; }
  check("unreadable export → explicit error", err !== null && /Mobile-learning Excel export/.test(err.message));

  // an html file alongside xlsx → NOT treated as TOM (html wins)
  const mix = new JSZip();
  mix.file("index.html", "<!doctype html><html><head><title>Direct</title></head><body><h1>Hi</h1></body></html>");
  mix.file("data.xlsx", mc);
  const pm = path.join(tmpBase, "mix.zip");
  await fs.writeFile(pm, await mix.generateAsync({ type: "nodebuffer" }));
  const rm = await buildPackage({ inputPath: pm, title: "Direct" });
  const zmix = await JSZip.loadAsync(rm.zip);
  const mixHtml = await zmix.file("index.html").async("string");
  check("html entry wins over xlsx", mixHtml.includes("<h1>Hi</h1>") && !mixHtml.includes("data-quiz"));
}

console.log("7 — batch over a catalogue of TOM exports:");
{
  const cat = path.join(tmpBase, "catalogue");
  await fs.mkdir(cat, { recursive: true });
  await fs.copyFile(tomZipPath, path.join(cat, "Course A.zip"));
  await fs.copyFile(tomZipPath, path.join(cat, "Course B.zip"));
  const out = path.join(tmpBase, "out");
  await pexec("node", ["dist/index.js", "pack", cat, "--batch", "--out", out]);
  const produced = (await fs.readdir(out)).filter((f) => f.endsWith(".zip"));
  check("batch (CLI): 2 TOM courses packaged", produced.length === 2);
  const report = JSON.parse(await fs.readFile(path.join(out, "batch-report.json"), "utf8"));
  check("batch report: 2 successes, 0 failures",
    report.total === 2 && report.succeeded.length === 2 && report.failed.length === 0);
}

await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
console.log(`\nTOM: ${pass} passed, ${fail} failed`);
if (fail > 0) { process.exit(1); }
