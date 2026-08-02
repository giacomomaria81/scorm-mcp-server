/**
 * Local web UI: `scorm-mcp-server ui` starts a localhost-only server with a
 * drag & drop page — input → conversion → SCORM output (2004 or 1.2).
 *
 * Design: extends the product's visual identity (warm noir / ivory / coral,
 * build-log as the signature conversion moment). No framework, no build step:
 * one dependency-free page served inline, talking to two JSON endpoints.
 *
 * Security: binds 127.0.0.1 only; downloads are path-contained to the output
 * directory; uploads land in a fresh temp dir per request.
 */
import * as http from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { buildPackage } from "./converter.js";
const UI_ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/ui");
const MAX_BODY = 200 * 1024 * 1024; // 200 MB upload ceiling
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new Error("Payload too large (max 200 MB)"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}
function json(res, code, body) {
    const s = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
    res.end(s);
}
export async function startUi(opts) {
    await fs.mkdir(opts.outDir, { recursive: true });
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || "/", "http://127.0.0.1");
            if (req.method === "GET" && url.pathname === "/") {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(PAGE(opts.version));
                return;
            }
            if (req.method === "GET" && url.pathname === "/assets/how-it-works.mp4") {
                try {
                    const data = await fs.readFile(path.join(UI_ASSETS, "how-it-works.mp4"));
                    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": data.length, "Cache-Control": "max-age=86400" });
                    res.end(data);
                }
                catch {
                    json(res, 404, { ok: false, error: "not found" });
                }
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/pack") {
                const body = JSON.parse((await readBody(req)).toString("utf8"));
                if (!body || typeof body.name !== "string" || typeof body.data !== "string") {
                    json(res, 400, { ok: false, error: "Expected { name, data(base64), ... }" });
                    return;
                }
                const safeName = path.basename(body.name).replace(/[^\w.\- ]+/g, "_") || "input";
                const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scorm-ui-"));
                const inputPath = path.join(tmp, safeName);
                await fs.writeFile(inputPath, Buffer.from(body.data, "base64"));
                const t0 = Date.now();
                try {
                    const result = await buildPackage({
                        inputPath,
                        title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : safeName.replace(/\.(zip|html?)$/i, ""),
                        language: typeof body.language === "string" && body.language ? body.language : "fr-FR",
                        scormVersion: body.scorm_version === "1.2" ? "1.2" : "2004",
                        masteryScore: typeof body.mastery === "number" && body.mastery >= 0 && body.mastery <= 1 ? body.mastery : undefined,
                        successOnCompletion: body.success_on_completion === true,
                        autoMilestones: body.auto_milestones !== false,
                    });
                    const outputPath = path.join(opts.outDir, result.fileName);
                    await fs.writeFile(outputPath, result.zip);
                    json(res, 200, {
                        ok: true,
                        file_name: result.fileName,
                        output_path: outputPath,
                        download: "/api/download/" + encodeURIComponent(result.fileName),
                        size_bytes: result.zip.length,
                        duration_ms: Date.now() - t0,
                        scorm_version: result.scormVersion,
                        format: result.format,
                        files_count: result.filesCount,
                        milestone_count: result.milestoneCount,
                        milestones_auto: result.milestonesAuto,
                        schemas_bundled: result.schemasBundled,
                        vendored: result.vendored,
                        warnings: result.warnings,
                    });
                }
                finally {
                    fs.rm(tmp, { recursive: true, force: true }).catch(() => { });
                }
                return;
            }
            if (req.method === "GET" && url.pathname.startsWith("/api/download/")) {
                const name = path.basename(decodeURIComponent(url.pathname.slice("/api/download/".length)));
                const file = path.join(opts.outDir, name);
                // containment: basename() already strips traversal; double-check anyway
                if (!path.resolve(file).startsWith(path.resolve(opts.outDir) + path.sep) || !name.endsWith(".zip")) {
                    json(res, 404, { ok: false, error: "not found" });
                    return;
                }
                try {
                    const data = await fs.readFile(file);
                    res.writeHead(200, {
                        "Content-Type": "application/zip",
                        "Content-Disposition": 'attachment; filename="' + name + '"',
                        "Content-Length": data.length,
                    });
                    res.end(data);
                }
                catch {
                    json(res, 404, { ok: false, error: "not found" });
                }
                return;
            }
            json(res, 404, { ok: false, error: "not found" });
        }
        catch (err) {
            json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    });
    await new Promise((resolve) => server.listen(opts.port ?? 3117, "127.0.0.1", resolve));
    return server;
}
// ---------------------------------------------------------------------------
// The page. One file, no framework, no build step.
// ---------------------------------------------------------------------------
const PAGE = (version) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SCORM Packager</title>
<style>
  /* Apple-inspired system: one accent (#0066cc), ink #1d1d1f, white/parchment
     canvases, SF Pro stack, pill buttons, hairline dividers. Quiet, premium. */
  :root {
    --primary: #0066cc; --primary-focus: #0071e3;
    --ink: #1d1d1f; --muted: #7a7a7a; --muted-80: #333333;
    --hairline: #e0e0e0; --divider: #f0f0f0;
    --canvas: #ffffff; --parchment: #f5f5f7; --pearl: #fafafc;
    --green: #248a3d; --amber: #9a6a00; --amber-bg: #fbf3e2; --red: #de3a3f;
    --display: "SF Pro Display", system-ui, -apple-system, "Segoe UI", sans-serif;
    --text: "SF Pro Text", system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, monospace;
    --ease-out: cubic-bezier(0, 0, 0.2, 1);
    --ease-expressive: cubic-bezier(0.16, 1, 0.3, 1);
    --t-fast: 150ms; --t-normal: 250ms; --t-moderate: 400ms;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--canvas); color: var(--ink); font-family: var(--text); -webkit-font-smoothing: antialiased; }

  /* ---------- entrance choreography: one focal cascade, then stillness ------ */
  @keyframes riseIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
  @keyframes settleIn { from { opacity: 0; transform: translateY(12px) scale(.985); } to { opacity: 1; transform: none; } }
  nav, h1, .sub, .film, .drop, .opts, .cta, footer { animation: riseIn var(--t-moderate) var(--ease-expressive) both; }
  nav { animation-duration: 300ms; }
  h1 { animation-delay: 60ms; }
  .sub { animation-delay: 130ms; }
  .film { animation-delay: 210ms; animation-duration: 500ms; }
  .drop { animation-delay: 300ms; }
  .opts { animation-delay: 380ms; }
  .cta { animation-delay: 450ms; }
  footer { animation-delay: 550ms; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
  a { color: var(--primary); text-decoration: none; }
  a:hover { text-decoration: underline; }

  nav {
    display: flex; justify-content: center; align-items: center; gap: 10px;
    padding: 14px 22px; border-bottom: 1px solid var(--divider);
    font-size: 12px; color: var(--muted-80);
  }
  nav .ver { color: var(--muted); }

  main { max-width: 640px; margin: 0 auto; padding: 0 22px 96px; }

  h1 {
    font-family: var(--display); font-size: clamp(40px, 7vw, 56px); font-weight: 600;
    line-height: 1.07; letter-spacing: -0.28px; text-align: center; margin: 84px 0 18px;
  }
  .sub {
    font-size: 19px; font-weight: 300; line-height: 1.47; color: var(--muted-80);
    text-align: center; max-width: 46ch; margin: 0 auto 56px;
  }

  /* ---------- how-it-works film ---------- */
  .film {
    display: block; width: 100%; border-radius: 18px; border: 1px solid var(--divider);
    margin-bottom: 44px; background: var(--pearl);
  }

  /* ---------- drop zone ---------- */
  .drop {
    background: var(--parchment); border: 1px solid transparent; border-radius: 18px;
    padding: 52px 28px; text-align: center; cursor: pointer;
    transition: border-color var(--t-fast) var(--ease-out), background var(--t-fast) var(--ease-out), transform var(--t-normal) var(--ease-expressive);
  }
  .drop:hover { transform: translateY(-2px); }
  .drop:hover { background: #f0f0f3; }
  .drop.over { border-color: var(--primary-focus); background: #eef4fc; }
  .drop:focus-visible { outline: 2px solid var(--primary-focus); outline-offset: 2px; }
  .drop .lead { font-size: 17px; font-weight: 600; }
  .drop .browse { color: var(--primary); font-weight: 400; }
  .drop .hint { color: var(--muted); font-size: 13px; margin-top: 8px; }
  .filechip {
    display: none; align-items: center; gap: 14px; text-align: left;
    background: var(--parchment); border-radius: 14px; padding: 16px 20px;
  }
  .filechip .fname { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .filechip .fsize { color: var(--muted); font-size: 13px; flex: none; }
  .filechip button { margin-left: auto; background: none; border: 0; color: var(--muted); font-size: 19px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
  .filechip button:hover { color: var(--ink); }

  /* ---------- options ---------- */
  .opts { margin-top: 34px; display: grid; gap: 22px; }
  label.field { display: grid; gap: 8px; font-size: 14px; color: var(--muted-80); }
  input[type=text] {
    background: var(--canvas); border: 1px solid var(--hairline); border-radius: 12px;
    padding: 12px 15px; color: var(--ink); font: 400 17px var(--text); outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  input[type=text]:focus { border-color: var(--primary-focus); box-shadow: 0 0 0 3px rgba(0,113,227,.18); }
  .row { display: flex; gap: 28px; flex-wrap: wrap; align-items: end; }
  .seg { display: inline-flex; background: var(--parchment); border-radius: 999px; padding: 3px; }
  .seg button {
    border: 0; background: none; color: var(--muted-80); font: 400 14px var(--text);
    padding: 8px 18px; border-radius: 999px; cursor: pointer; transition: background .15s, color .15s, box-shadow .15s;
  }
  .seg button.on { background: var(--canvas); color: var(--ink); font-weight: 600; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .mastery { display: flex; align-items: center; gap: 10px; }
  .mastery input[type=checkbox] { accent-color: var(--primary); width: 15px; height: 15px; }
  .mastery input[type=text] { width: 62px; text-align: center; padding: 8px 6px; font-size: 15px; }
  .mastery .pct { color: var(--muted); font-size: 14px; }
  .mastery-note { font-size: 12.5px; color: var(--muted); line-height: 1.45; }

  /* ---------- CTA ---------- */
  .cta {
    margin-top: 40px; width: 100%; border: 0; border-radius: 999px; cursor: pointer;
    background: var(--primary); color: #fff; font: 600 17px var(--text);
    padding: 15px; transition: background .15s, opacity .15s;
  }
  .cta { transition: background var(--t-fast) var(--ease-out), transform var(--t-fast) var(--ease-out), box-shadow var(--t-fast) var(--ease-out); }
  .cta:hover:not(:disabled) { background: var(--primary-focus); transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,102,204,.25); }
  .cta:active:not(:disabled) { transform: translateY(0) scale(.99); box-shadow: none; }
  .cta:focus-visible { outline: 2px solid var(--primary-focus); outline-offset: 3px; }
  .cta:disabled { opacity: .35; cursor: default; }

  /* ---------- build log ---------- */
  .log { display: none; margin-top: 40px; background: var(--pearl); border: 1px solid var(--divider); border-radius: 18px; padding: 26px 30px; }
  .log .line { display: flex; gap: 13px; align-items: baseline; font: 14px var(--mono); color: var(--muted-80); padding: 7px 0; opacity: 0; transform: translateY(6px); transition: opacity .35s, transform .35s; }
  .log .line.show { opacity: 1; transform: none; }
  .log .tick { color: var(--green); font-weight: 700; }
  .log .spin { color: var(--primary); display: inline-block; animation: rot 1s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }

  /* ---------- result ---------- */
  .result { display: none; margin-top: 40px; }
  .result.on .card { animation: settleIn 450ms var(--ease-expressive) both; }
  .result.on .badge { animation: riseIn 350ms var(--ease-expressive) both; }
  .result.on .actions { animation: riseIn 400ms var(--ease-expressive) both; animation-delay: 240ms; }
  .filechip { animation: settleIn 300ms var(--ease-expressive) both; }
  .result .card { background: var(--parchment); border-radius: 18px; padding: 28px 30px; }
  .result .zipline { display: flex; align-items: center; gap: 11px; flex-wrap: wrap; }
  .result .zipname { font: 600 16px var(--mono); word-break: break-all; }
  .result .okdot { color: var(--green); font-size: 17px; font-weight: 700; }
  .badges { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
  .badge { font: 400 12.5px var(--text); color: var(--muted-80); background: var(--canvas); border-radius: 999px; padding: 5px 13px; }
  .badge.v { color: var(--primary); font-weight: 600; }
  .warns { margin-top: 16px; display: grid; gap: 8px; }
  .warn { font-size: 13.5px; line-height: 1.5; color: var(--amber); background: var(--amber-bg); border-radius: 10px; padding: 10px 14px; }
  .actions { display: flex; gap: 18px; margin-top: 24px; align-items: center; }
  .dl {
    flex: 1; text-align: center; border-radius: 999px; padding: 13px;
    background: var(--primary); color: #fff; font: 600 15px var(--text); transition: background .15s;
  }
  .dl { transition: background var(--t-fast) var(--ease-out), transform var(--t-fast) var(--ease-out), box-shadow var(--t-fast) var(--ease-out); }
  .dl:hover { background: var(--primary-focus); text-decoration: none; transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,102,204,.25); }
  .again { background: none; border: 0; color: var(--primary); font: 400 15px var(--text); cursor: pointer; padding: 13px 6px; }
  .again:hover { text-decoration: underline; }
  .error { display: none; margin-top: 32px; color: var(--red); background: #fdf0f0; border-radius: 12px; padding: 14px 18px; font-size: 14px; line-height: 1.5; }
  footer { border-top: 1px solid var(--divider); margin-top: 90px; padding: 22px; text-align: center; color: var(--muted); font-size: 12px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<nav><span>SCORM&nbsp;Packager</span><span class="ver">v${version} &middot; runs locally</span></nav>
<main>
  <h1>Drop a course.<br>Get SCORM.</h1>
  <p class="sub">An HTML file, a Claude Design bundle or a zipped module in &mdash; an LMS&#8209;ready package out. Assets embedded, tracking wired, manifest validated. Nothing leaves this machine.</p>

  <video class="film" src="/assets/how-it-works.mp4" autoplay muted loop playsinline
         aria-label="How it works: drop a course, it gets wrapped, import it in any LMS"
         onerror="this.style.display='none'"></video>

  <div class="drop" id="drop" role="button" tabindex="0" aria-label="Choose a file">
    <div class="lead">Drop your course here, or <span class="browse">browse</span></div>
    <div class="hint">.html &middot; .zip (bundle, Claude Design .dc, or a Teach on Mars content export)</div>
  </div>
  <div class="filechip" id="chip">
    <span class="fname" id="fname"></span>
    <span class="fsize" id="fsize"></span>
    <button id="clear" title="Remove" aria-label="Remove file">&times;</button>
  </div>
  <input type="file" id="file" accept=".html,.htm,.zip" class="hidden">

  <div class="opts" id="opts">
    <label class="field">Course title
      <input type="text" id="title" placeholder="Shown in the LMS" autocomplete="off">
    </label>
    <div class="row">
      <label class="field">SCORM edition
        <span class="seg" id="seg">
          <button type="button" data-v="2004" class="on">2004</button>
          <button type="button" data-v="1.2">1.2 &middot; legacy</button>
        </span>
      </label>
      <label class="field">Quiz pass mark
        <span class="mastery">
          <input type="checkbox" id="mastery-on">
          <input type="text" id="mastery" value="50" disabled inputmode="numeric">
          <span class="pct">%</span>
        </span>
      </label>
    </div>
    <div class="mastery-note">Only if your course reports a quiz score &mdash; learners at or above the mark are recorded as &ldquo;passed&rdquo;.</div>
  </div>

  <button class="cta" id="go" disabled>Package as SCORM</button>

  <div class="log" id="log">
    <div class="line" id="l0"><span class="spin">&#9696;</span><span>reading course&hellip;</span></div>
    <div class="line" id="l1"><span class="tick">&#10003;</span><span>assets embedded &middot; works offline</span></div>
    <div class="line" id="l2"><span class="tick">&#10003;</span><span>tracking runtime injected</span></div>
    <div class="line" id="l3"><span class="tick">&#10003;</span><span id="l3t">manifest validated &middot; SCORM 2004</span></div>
  </div>

  <div class="result" id="result">
    <div class="card">
      <div class="zipline"><span class="okdot">&#10003;</span><span class="zipname" id="zipname"></span></div>
      <div class="badges" id="badges"></div>
      <div class="warns" id="warns"></div>
      <div class="actions">
        <a class="dl" id="dl" href="#" download>Download package</a>
        <button class="again" id="again">Package another</button>
      </div>
    </div>
  </div>

  <div class="error" id="error"></div>
</main>
<footer>Free &amp; open source &middot; <a href="https://github.com/giacomomaria81/scorm-mcp-server" target="_blank" rel="noopener">github.com/giacomomaria81/scorm-mcp-server</a></footer>
<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var drop = $("drop"), chip = $("chip"), fileInput = $("file"), titleI = $("title");
  var go = $("go"), seg = $("seg"), masteryOn = $("mastery-on"), mastery = $("mastery");
  var state = { file: null, version: "2004" };

  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
  function setFile(f) {
    if (!f) { return; }
    if (!/\\.(zip|html?)$/i.test(f.name)) { showError("Only .html or .zip files — export your module first."); return; }
    state.file = f;
    $("fname").textContent = f.name;
    $("fsize").textContent = fmtSize(f.size);
    drop.style.display = "none";
    chip.style.display = "flex";
    if (!titleI.value.trim()) {
      titleI.value = f.name.replace(/\\.(zip|html?)$/i, "").replace(/[-_]+/g, " ").replace(/\\s+/g, " ").trim()
        .replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
    }
    go.disabled = false;
    hideError();
  }
  function reset() {
    state.file = null; fileInput.value = "";
    chip.style.display = "none"; drop.style.display = "block";
    $("result").style.display = "none"; $("log").style.display = "none";
    go.disabled = true; go.style.display = "block"; $("opts").style.display = "grid";
    hideError();
    for (var i = 0; i < 4; i++) { $("l" + i).classList.remove("show"); }
  }
  function showError(msg) { var e = $("error"); e.textContent = msg; e.style.display = "block"; }
  function hideError() { $("error").style.display = "none"; }

  drop.addEventListener("click", function () { fileInput.click(); });
  drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { fileInput.click(); } });
  fileInput.addEventListener("change", function () { setFile(fileInput.files[0]); });
  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) { setFile(e.dataTransfer.files[0]); });
  $("clear").addEventListener("click", reset);
  $("again").addEventListener("click", reset);

  seg.addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) { return; }
    seg.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on"); state.version = b.dataset.v;
    $("l3t").textContent = "manifest validated · SCORM " + (state.version === "1.2" ? "1.2" : "2004");
  });
  masteryOn.addEventListener("change", function () { mastery.disabled = !masteryOn.checked; });

  function showLog() {
    $("log").style.display = "block";
    $("l0").classList.add("show");
    setTimeout(function () { $("l1").classList.add("show"); }, 500);
    setTimeout(function () { $("l2").classList.add("show"); }, 950);
    setTimeout(function () { $("l3").classList.add("show"); }, 1400);
  }

  go.addEventListener("click", function () {
    if (!state.file) { return; }
    go.disabled = true; go.style.display = "none"; $("opts").style.display = "none"; hideError();
    showLog();
    var reader = new FileReader();
    reader.onload = function () {
      var b64 = String(reader.result).split(",")[1];
      var payload = {
        name: state.file.name, data: b64,
        title: titleI.value.trim(), scorm_version: state.version,
      };
      if (masteryOn.checked) {
        var pct = parseInt(mastery.value, 10);
        if (!isNaN(pct)) { payload.mastery = Math.min(100, Math.max(0, pct)) / 100; }
      }
      var started = Date.now();
      fetch("/api/pack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          // let the log finish its little ceremony
          var wait = Math.max(0, 1900 - (Date.now() - started));
          setTimeout(function () { render(data); }, wait);
        })
        .catch(function (err) { $("log").style.display = "none"; go.style.display = "block"; go.disabled = false; $("opts").style.display = "grid"; showError(String(err)); });
    };
    reader.readAsDataURL(state.file);
  });

  function render(data) {
    $("log").style.display = "none";
    if (!data.ok) {
      go.style.display = "block"; go.disabled = false; $("opts").style.display = "grid";
      showError(data.error || "Packaging failed.");
      return;
    }
    $("zipname").textContent = data.file_name;
    $("dl").href = data.download;
    var badges = [
      ["v", "SCORM " + (data.scorm_version === "1.2" ? "1.2" : "2004")],
      ["", fmtSize(data.size_bytes)],
      ["", data.milestone_count + " milestone" + (data.milestone_count === 1 ? "" : "s") + (data.milestones_auto ? " · auto" : "")],
      ["", data.format === "claude-design" ? "Claude Design" : "HTML"],
      ["", data.duration_ms + " ms"],
    ];
    $("badges").innerHTML = badges.map(function (b) {
      return '<span class="badge ' + b[0] + '">' + b[1] + "</span>";
    }).join("");
    $("warns").innerHTML = (data.warnings || []).map(function (w) {
      return '<div class="warn">' + w.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</div>";
    }).join("");
    var res = $("result");
    res.classList.remove("on"); void res.offsetWidth; // restart the animation
    res.classList.add("on");
    res.querySelectorAll(".badge").forEach(function (b, i) { b.style.animationDelay = (90 + i * 60) + "ms"; });
    res.style.display = "block";
  }
})();
</script>
</body>
</html>`;
