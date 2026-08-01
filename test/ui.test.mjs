/**
 * Local web UI (2.1.0): page serving, /api/pack, /api/download, containment.
 */
import { startUi } from "../dist/ui.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✗ FAIL: " + label); }
};

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-test-"));
const PORT = 3971;
const server = await startUi({ port: PORT, outDir, version: "test" });
const base = "http://127.0.0.1:" + PORT;

const HTML = "<!DOCTYPE html><html><head><title>U</title></head><body><section><h2>A</h2><p>x</p></section></body></html>";

console.log("1 — page:");
{
  const r = await fetch(base + "/");
  const body = await r.text();
  check("GET / -> 200 html", r.status === 200 && (r.headers.get("content-type") || "").includes("text/html"));
  check("page carries the app (drop zone + CTA)", body.includes("Drop a course") && body.includes("Package as SCORM"));
  check("both SCORM editions offered", body.includes('data-v="2004"') && body.includes('data-v="1.2"'));
}

console.log("1b — how-it-works video asset:");
{
  const r = await fetch(base + "/assets/how-it-works.mp4");
  check("video served as mp4", r.status === 200 && (r.headers.get("content-type") || "").includes("video/mp4"));
  const buf = Buffer.from(await r.arrayBuffer());
  check("video non trivial (>100 KB)", buf.length > 100 * 1024);
}

console.log("2 — pack via API (1.2 + mastery):");
let downloadUrl = "";
{
  const r = await fetch(base + "/api/pack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "mon cours.html", data: Buffer.from(HTML).toString("base64"), title: "Cours UI", scorm_version: "1.2", mastery: 0.6 }),
  });
  const j = await r.json();
  check("200 ok:true", r.status === 200 && j.ok === true);
  check("SCORM 1.2 produced", j.scorm_version === "1.2" && j.file_name.endsWith("-scorm12.zip"));
  check("zip written to outDir", (await fs.readdir(outDir)).includes(j.file_name));
  check("download link provided", typeof j.download === "string" && j.download.startsWith("/api/download/"));
  downloadUrl = j.download;
}

console.log("3 — download + containment:");
{
  const r = await fetch(base + downloadUrl);
  check("download streams the zip", r.status === 200 && (r.headers.get("content-type") || "").includes("zip"));
  const buf = Buffer.from(await r.arrayBuffer());
  check("PK zip magic", buf.subarray(0, 2).toString("latin1") === "PK");
  const evil = await fetch(base + "/api/download/..%2F..%2Fetc%2Fpasswd");
  check("path traversal -> 404", evil.status === 404);
  const nonzip = await fetch(base + "/api/download/whatever.txt");
  check("non-zip name -> 404", nonzip.status === 404);
}

console.log("4 — bad input is a clean error, not a crash:");
{
  const r = await fetch(base + "/api/pack", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "image.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]).toString("base64"), title: "Bin" }),
  });
  const j = await r.json();
  check("binary input -> ok:false with message", j.ok === false && /HTML/i.test(j.error || ""));
  const r2 = await fetch(base + "/api/pack", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("missing fields -> 400", r2.status === 400);
  const r3 = await fetch(base + "/");
  check("server still alive after errors", r3.status === 200);
}

server.close();
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
