// Audit fixes contract:
//  1. SECURITY — a reference escaping the module folder (../, /absolute) must
//     NEVER be inlined into the package, and must produce a warning.
//  2. VISIBILITY — un-bundled ES module graphs (<script type="module"> with
//     relative imports) and importmaps must produce a warning.
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log("  ✔ " + name); }
  else { failed++; console.log("  ✖ " + name + (extra ? " — " + extra : "")); }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scorm-audit-"));
const moduleDir = path.join(tmp, "module");
await fs.mkdir(moduleDir, { recursive: true });

// secret OUTSIDE the module folder — must never end up in the package
const SECRET = "TOP-SECRET-DO-NOT-INLINE-" + Date.now();
await fs.writeFile(path.join(tmp, "secret.txt"), SECRET);
// legit asset INSIDE the module folder — must still be inlined
await fs.writeFile(path.join(moduleDir, "ok.css"), "body{color:#123456}");

const html = `<!DOCTYPE html><html><head>
  <link rel="stylesheet" href="ok.css">
  <link rel="stylesheet" href="../secret.txt">
</head><body>
  <img src="../secret.txt" alt="">
  <section data-jalon="a">hello</section>
</body></html>`;

const htmlPath = path.join(moduleDir, "index.html");
await fs.writeFile(htmlPath, html);

console.log("Security: path containment (no exfiltration outside module dir):");
const res = await buildPackage({ inputPath: htmlPath, title: "Audit Sec" });
const zip = await JSZip.loadAsync(res.zip);
const out = await zip.file("index.html").async("string");

check("secret content NOT inlined into package", !out.includes(SECRET));
check("in-folder asset still inlined (ok.css)", out.includes("#123456"));
check("warning emitted for outside reference",
  res.warnings.some(w => w.includes("hors du dossier")),
  JSON.stringify(res.warnings));

console.log("Visibility: ES module graphs / importmap warnings:");
const htmlMod = `<!DOCTYPE html><html><body>
  <script type="importmap">{"imports":{"lib":"./lib.js"}}</script>
  <script type="module">import { x } from "./chunk.js"; x();</script>
  <section data-jalon="a">hi</section>
</body></html>`;
const res2 = await buildPackage({ html: htmlMod, title: "Audit Mod" });
check("module-with-relative-imports warning",
  res2.warnings.some(w => w.toLowerCase().includes("module")),
  JSON.stringify(res2.warnings));
check("importmap warning",
  res2.warnings.some(w => w.toLowerCase().includes("importmap")),
  JSON.stringify(res2.warnings));

// a plain module WITHOUT relative imports must NOT warn about modules
const res3 = await buildPackage({ html: `<!DOCTYPE html><body><script type="module">console.log(1)</script><i data-jalon="a"></i></body>`, title: "Audit Mod Clean" });
check("no false-positive module warning",
  !res3.warnings.some(w => w.toLowerCase().includes("module")),
  JSON.stringify(res3.warnings));

await fs.rm(tmp, { recursive: true, force: true });

console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
