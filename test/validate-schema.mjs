/**
 * Conformance test: build a package, extract ALL its files (manifest + bundled
 * XSDs) to a temp dir, and validate the manifest against its own bundled
 * imscp_v1p1.xsd with xmllint. This proves real schema conformance end-to-end,
 * not merely "well-formed XML".
 */
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log("  ✔ " + label); } else { fail++; console.log("  ✗ FAIL: " + label); } };

const TINY = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Conf</title></head>
<body><section data-jalon="s1" data-trigger="view">A</section>
<section data-jalon="s2" data-trigger="click"><button>ok</button></section></body></html>`;

const res = await buildPackage({ html: TINY, title: "Validation Schéma 2004" });
const zip = await JSZip.loadAsync(res.zip);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scorm-schema-"));
for (const name of Object.keys(zip.files)) {
  if (zip.files[name].dir) { continue; }
  const content = await zip.file(name).async("nodebuffer");
  await fs.writeFile(path.join(tmp, name), content);
}

console.log("Schema conformance (xmllint against bundled XSDs):");
let validates = false;
try {
  execFileSync("xmllint", ["--noout", "--schema", path.join(tmp, "imscp_v1p1.xsd"), path.join(tmp, "imsmanifest.xml")], { stdio: "pipe" });
  validates = true;
} catch (e) {
  console.log("  xmllint output:", (e.stderr || e.stdout || String(e)).toString());
}
check("imsmanifest.xml validates against bundled imscp_v1p1.xsd", validates);

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
