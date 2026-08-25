/**
 * scorm_validate test suite — the standalone conformance checker (v2.3).
 *
 * Positive paths: a freshly built 2004 package and a 1.2 package both come out
 * VALID with XSD validation passed. Negative paths reproduce the real-world
 * failures the tool exists to explain: folder-wrapped zip, missing referenced
 * file, broken manifest XML, case-only href mismatch, not-a-zip input.
 * Also exercises the CLI (`validate` command, exit codes, --json) and the MCP
 * tool surface (tools/list exposes scorm_validate; a call returns the report).
 */
import { buildPackage } from "../dist/converter.js";
import { validatePackage, formatReport } from "../dist/validate.js";
import JSZip from "jszip";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✗ FAIL: " + label + (detail ? " — " + detail : "")); }
};
const byId = (r, id) => r.checks.find((c) => c.id === id);

const SAMPLE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>V</title></head>
<body><section data-jalon="a" data-trigger="view"><h2>A</h2></section>
<section data-jalon="b" data-trigger="view"><h2>B</h2></section></body></html>`;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "validate-test-"));
const built2004 = await buildPackage({ html: SAMPLE, title: "Validate 2004" });
const built12 = await buildPackage({ html: SAMPLE, title: "Validate 12", scormVersion: "1.2" });
const p2004 = path.join(tmp, "ok-2004.zip");
const p12 = path.join(tmp, "ok-12.zip");
await fs.writeFile(p2004, built2004.zip);
await fs.writeFile(p12, built12.zip);

async function rezip(srcBuf, mutate) {
  const zin = await JSZip.loadAsync(srcBuf);
  const zout = new JSZip();
  for (const name of Object.keys(zin.files)) {
    if (zin.files[name].dir) { continue; }
    const data = await zin.file(name).async("nodebuffer");
    mutate(zout, name, data);
  }
  return zout.generateAsync({ type: "nodebuffer" });
}

console.log("1 — a package built by this tool is VALID (2004):");
{
  const r = await validatePackage({ zipPath: p2004 });
  check("ok === true", r.ok, JSON.stringify(r.errors));
  check("version 2004", r.scormVersion === "2004");
  check("title extracted", r.title === "Validate 2004", r.title);
  check("entry href index.html", r.entryHref === "index.html", r.entryHref);
  check("XSD validation passed", r.schemaValidation === "passed", r.schemaValidation);
  check("all checks ok", r.checks.every((c) => c.ok));
  check("formatReport says VALID", formatReport(r).startsWith("VALID"));
}

console.log("2 — a package built by this tool is VALID (1.2):");
{
  const r = await validatePackage({ zipPath: p12 });
  check("ok === true", r.ok, JSON.stringify(r.errors));
  check("version 1.2", r.scormVersion === "1.2");
  check("XSD validation passed (wrapper12)", r.schemaValidation === "passed", r.schemaValidation);
}

console.log("3 — folder-wrapped zip (the classic import failure) is explained:");
{
  const buf = await rezip(built2004.zip, (z, n, d) => z.file("MyCourse/" + n, d));
  const r = await validatePackage({ zipData: buf });
  check("ok === false", !r.ok);
  const c = byId(r, "manifest-at-root");
  check("manifest-at-root check failed", c && !c.ok);
  check("explanation names the nested path", /MyCourse\/imsmanifest\.xml/.test(c?.detail ?? ""), c?.detail);
  check("explanation says to re-zip the CONTENTS", /CONTENTS/.test(c?.detail ?? ""));
}

console.log("4 — manifest referencing a missing file is caught:");
{
  const buf = await rezip(built2004.zip, (z, n, d) => { if (n !== "index.html") { z.file(n, d); } });
  const r = await validatePackage({ zipData: buf });
  check("ok === false", !r.ok);
  check("entry-exists failed", byId(r, "entry-exists") && !byId(r, "entry-exists").ok);
  check("files-exist failed and names index.html", /index\.html/.test(byId(r, "files-exist")?.detail ?? ""));
}

console.log("5 — broken manifest XML fails XSD validation with the parser error surfaced:");
{
  const buf = await rezip(built2004.zip, (z, n, d) => {
    z.file(n, n === "imsmanifest.xml" ? Buffer.from(d.toString().replace("</manifest>", "</oops>")) : d);
  });
  const r = await validatePackage({ zipData: buf });
  check("ok === false", !r.ok);
  check("schemaValidation failed", r.schemaValidation === "failed", r.schemaValidation);
}

console.log("6 — case-only href mismatch is a warning (Linux LMS killer):");
{
  const buf = await rezip(built2004.zip, (z, n, d) => { z.file(n === "index.html" ? "Index.html" : n, d); });
  const r = await validatePackage({ zipData: buf });
  check("case mismatch produces a warning", r.warnings.some((w) => /Case-only/i.test(w)), JSON.stringify(r.warnings));
  check("entry-exists still ok (found case-insensitively)", byId(r, "entry-exists")?.ok === true);
}

console.log("7 — not a zip at all:");
{
  const p = path.join(tmp, "notazip.zip");
  await fs.writeFile(p, "hello");
  const r = await validatePackage({ zipPath: p });
  check("ok === false", !r.ok);
  check("zip-readable failed with a plain-language hint", /plain \.zip/.test(byId(r, "zip-readable")?.detail ?? ""));
  const r2 = await validatePackage({ zipPath: path.join(tmp, "does-not-exist.zip") });
  check("unreadable path handled without throwing", r2.ok === false);
}

console.log("8 — CLI: validate command, exit codes, --json:");
{
  const cli = path.resolve("dist/index.js");
  const run = (args) => new Promise((res) => {
    execFile("node", [cli, ...args], (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr }));
  });
  const ok = await run(["validate", p2004]);
  check("exit 0 on a valid package", ok.code === 0, String(ok.code));
  check("stdout starts with VALID", /^VALID/.test(ok.stdout));
  const bad = await run(["validate", path.join(tmp, "notazip.zip")]);
  check("exit 1 on an invalid package", bad.code === 1, String(bad.code));
  const js = await run(["validate", p2004, "--json"]);
  let parsed = null;
  try { parsed = JSON.parse(js.stdout); } catch { /* fail below */ }
  check("--json prints a parseable report", parsed !== null && parsed.ok === true);
  const missing = await run(["validate"]);
  check("missing argument → exit 1 + help", missing.code === 1);
}

console.log("9 — MCP surface: scorm_validate is exposed and callable:");
{
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  void McpServer; // sanity: SDK importable in the test env
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: "node", args: [path.resolve("dist/index.js")] });
  const client = new Client({ name: "validate-test", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check("three tools exposed", names.length === 3, JSON.stringify(names));
  check("scorm_validate listed", names.includes("scorm_validate"));
  const vt = tools.tools.find((t) => t.name === "scorm_validate");
  check("scorm_validate schema has input_path", !!vt.inputSchema?.properties?.input_path,
    JSON.stringify(vt.inputSchema ?? null));
  const res = await client.callTool({ name: "scorm_validate", arguments: { input_path: p2004 } });
  check("tool call returns VALID text", /^VALID/.test(res.content?.[0]?.text ?? ""), res.content?.[0]?.text?.slice(0, 80));
  check("structuredContent.ok === true", res.structuredContent?.ok === true);
  const res2 = await client.callTool({ name: "scorm_validate", arguments: { input_path: path.join(tmp, "notazip.zip") } });
  check("invalid package → report (not a tool error)", res2.isError !== true && res2.structuredContent?.ok === false);
  await client.close();
}

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log("\nVALIDATE: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
