/**
 * CLI (`pack`, `selftest`) and batch mode (2.1.0).
 * Spawns the real dist/index.js — same entry point users get via npx.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const pexec = promisify(execFile);
let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✗ FAIL: " + label); }
};

const ENTRY = new URL("../dist/index.js", import.meta.url).pathname;
const HTML = "<!DOCTYPE html><html><head><title>C</title></head><body><section><h2>A</h2><p>x</p></section></body></html>";

console.log("1 — selftest:");
{
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "cli-self-"));
  const { stdout } = await pexec("node", [ENTRY, "selftest"], { env: { ...process.env, SCORM_OUTPUT_DIR: out } });
  check("reports OK + version", /Selftest OK — v\d+\.\d+\.\d+/.test(stdout));
  check("zip actually written", (await fs.readdir(out)).some((f) => f === "selftest-scorm2004.zip"));
}

console.log("2 — pack (single, 2004 default):");
{
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "cli-pack-"));
  const src = path.join(out, "mon-cours.html");
  await fs.writeFile(src, HTML);
  const { stdout } = await pexec("node", [ENTRY, "pack", src], { env: { ...process.env, SCORM_OUTPUT_DIR: out } });
  check("prints output path", stdout.includes("-scorm2004.zip"));
  check("title derived from filename (slug present)", stdout.includes("mon-cours-scorm2004.zip"));
}

console.log("3 — pack --scorm-version 1.2 --mastery:");
{
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "cli-12-"));
  const src = path.join(out, "legacy.html");
  await fs.writeFile(src, HTML);
  const { stdout } = await pexec("node", [ENTRY, "pack", src, "--scorm-version", "1.2", "--mastery", "0.7", "--title", "Legacy Course"], { env: { ...process.env, SCORM_OUTPUT_DIR: out } });
  check("prints SCORM 1.2", stdout.includes("SCORM 1.2"));
  check("file suffix -scorm12.zip", stdout.includes("legacy-course-scorm12.zip"));
}

console.log("4 — batch: one broken course doesn't sink the rest:");
{
  const inDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-batch-in-"));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "cli-batch-out-"));
  await fs.mkdir(path.join(inDir, "cours-un"));
  await fs.writeFile(path.join(inDir, "cours-un", "index.html"), HTML);
  await fs.writeFile(path.join(inDir, "cours-deux.html"), HTML);
  await fs.writeFile(path.join(inDir, "casse.html"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])); // binary
  let code = 0, stdout = "", stderr = "";
  try {
    ({ stdout, stderr } = await pexec("node", [ENTRY, "pack", inDir, "--batch", "--title", "Cat"], { env: { ...process.env, SCORM_OUTPUT_DIR: out } }));
  } catch (e) { code = e.code; stdout = e.stdout; stderr = e.stderr; }
  check("2/3 succeeded", stdout.includes("2/3"));
  check("failure listed with reason", (stderr + stdout).includes("casse.html"));
  check("exit code 1 when some fail", code === 1);
  const files = await fs.readdir(out);
  check("both packages written", files.includes("cat-cours-un-scorm2004.zip") && files.includes("cat-cours-deux-scorm2004.zip"));
  const report = JSON.parse(await fs.readFile(path.join(out, "batch-report.json"), "utf8"));
  check("report: total 3, 2 ok, 1 failed", report.total === 3 && report.succeeded.length === 2 && report.failed.length === 1);
}

console.log("5 — no regression: no args still starts the MCP server:");
{
  // spawn without args: it must NOT run the CLI (we kill it after the banner)
  const { spawn } = await import("node:child_process");
  const p = spawn("node", [ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
  const banner = await new Promise((resolve) => {
    let s = "";
    p.stderr.on("data", (d) => { s += d; if (s.includes("stdio")) { resolve(s); } });
    setTimeout(() => resolve(s), 3000);
  });
  p.kill();
  check("stdio server banner on stderr", banner.includes("running on stdio"));
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
