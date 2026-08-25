import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const res = await buildPackage({
  inputPath: path.join(here, "sample-module.html"),
  title: "Le N°5 — Histoire & Service",
  language: "fr-FR",
});

const outPath = path.join(here, res.fileName);
await fs.writeFile(outPath, res.zip);

console.log("=== BUILD RESULT ===");
console.log("file:", outPath);
console.log("size (Ko):", (res.zip.length / 1024).toFixed(1));
console.log("milestones:", res.milestoneCount, JSON.stringify(res.milestoneIds));
console.log("warnings:", res.warnings.length ? "\n - " + res.warnings.join("\n - ") : "none");

// re-open the zip and inspect
const zip = await JSZip.loadAsync(res.zip);
console.log("\n=== PACKAGE CONTENTS ===");
for (const name of Object.keys(zip.files)) { console.log(" -", name); }

const manifest = await zip.file("imsmanifest.xml").async("string");
const indexHtml = await zip.file("index.html").async("string");

console.log("\n=== MANIFEST CHECKS ===");
console.log("schemaversion 2004 4th:", /2004 4th Edition/.test(manifest));
console.log("scormType sco:", /adlcp:scormType="sco"/.test(manifest));
console.log("href index.html:", /href="index.html"/.test(manifest));

console.log("\n=== INDEX.HTML CHECKS ===");
const residualHttpSrc = (indexHtml.match(/src="https?:\/\//g) || []).length;
const residualHttpHref = (indexHtml.match(/href="https?:\/\//g) || []).length;
const residualCssUrlHttp = (indexHtml.match(/url\(https?:\/\//g) || []).length;
console.log("remaining http src= :", residualHttpSrc);
console.log("remaining http href= :", residualHttpHref);
console.log("remaining http url() :", residualCssUrlHttp);
console.log("data: URIs present:", (indexHtml.match(/data:[^"')]+/g) || []).length);
console.log("runtime injected:", /scorm-jalons-runtime/.test(indexHtml));
console.log("API_1484_11 finder present:", /API_1484_11/.test(indexHtml));
console.log("progress_measure call present:", /cmi\.progress_measure/.test(indexHtml));
console.log("data-jalon attrs preserved:", (indexHtml.match(/data-jalon=/g) || []).length);
