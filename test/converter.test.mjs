/**
 * Deterministic converter test (local fixtures, no network).
 * Verifies the hardened inlining: stylesheet + recursive @import + url(),
 * inline-style url(), srcset, favicon, integrity/crossorigin stripping,
 * preload removal, and that the ADL XSD schemas are bundled.
 */
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log("  ✔ " + label); } else { fail++; console.log("  ✗ FAIL: " + label); } };

const res = await buildPackage({
  inputPath: path.join(here, "fixtures", "module.html"),
  title: "Fixture Conformité",
});

const zip = await JSZip.loadAsync(res.zip);
const names = Object.keys(zip.files);
const html = await zip.file("index.html").async("string");

console.log("Converter hardening:");
check("milestones detected = 3 (intro,image,bloc)", JSON.stringify(res.milestoneIds) === JSON.stringify(["intro", "image", "bloc"]));
check("no remaining relative href to a.css", !/href="a\.css"/.test(html));
check("no remaining relative src to lib.js", !/src="lib\.js"/.test(html));
check("no remaining relative src to dot.png", !/src="dot\.png"/.test(html));
check("no remaining url(dot.png) anywhere", !/url\((['"]?)dot\.png\1\)/.test(html));
check("@import resolved (no @import left)", !/@import/i.test(html));
check("stylesheet inlined as <style>", /<style>[\s\S]*background/.test(html));
check("nested b.css content inlined (h1 background-image)", /h1\s*\{\s*background-image/.test(html));
check("data: URIs present (assets inlined)", (html.match(/data:image\/png;base64,/g) || []).length >= 4);
check("favicon href is now data:", /<link[^>]+rel="icon"[^>]+href="data:image\/png/.test(html) || /<link[^>]+href="data:image\/png[^>]+rel="icon"/.test(html));
check("preload link removed", !/rel="preload"/.test(html));
check("preconnect link removed", !/rel="preconnect"/.test(html));
check("integrity attribute stripped from inlined script", !/integrity=/.test(html));
check("crossorigin attribute stripped", !/crossorigin=/.test(html));
check("srcset rewritten to data URIs", /srcset="data:image\/png[^"]*1x[^"]*data:image\/png[^"]*2x"/.test(html) || (html.match(/srcset="[^"]*data:image\/png/g) || []).length >= 1);
check("inline style url() inlined", /style="background:url\((['"]?)data:image\/png/.test(html));
check("inline script body preserved (window.__lib)", /window\.__lib\s*=\s*1/.test(html));
check("DOCTYPE preserved", /^<!doctype html>/i.test(html.trim()));

console.log("\nSchema bundling:");
check("schemasBundled === 15", res.schemasBundled === 15);
check("imscp_v1p1.xsd present in package", names.includes("imscp_v1p1.xsd"));
check("adlcp_v1p3.xsd present", names.includes("adlcp_v1p3.xsd"));
check("imsss_v1p0.xsd present", names.includes("imsss_v1p0.xsd"));
check("imsmanifest.xml at root", names.includes("imsmanifest.xml"));

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
