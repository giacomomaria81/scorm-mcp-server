/**
 * MCP smoke test: spawn the real server over stdio (exactly as Claude Desktop
 * would), perform the initialize handshake, list tools, and call scorm_package.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log("  ✔ " + label); } else { fail++; console.log("  ✗ FAIL: " + label); } };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scorm-mcp-test-"));

const transport = new StdioClientTransport({
  command: "node",
  args: [path.resolve("dist/index.js")],
  env: { ...process.env, SCORM_OUTPUT_DIR: tmp },
});

const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  console.log("Connected to server (handshake OK).");

  const { tools } = await client.listTools();
  check("server exposes exactly 1 tool", tools.length === 1);
  check("tool is named 'scorm_package'", tools[0]?.name === "scorm_package");
  check("tool has an inputSchema", Boolean(tools[0]?.inputSchema));
  // Regression guard: a ZodObject (instead of a raw shape) publishes an EMPTY
  // schema and schema-strict clients (Claude Desktop) strip all arguments.
  check("inputSchema exposes named properties (title)", Boolean(tools[0]?.inputSchema?.properties?.title));
  check("inputSchema exposes auto_milestones", Boolean(tools[0]?.inputSchema?.properties?.auto_milestones));

  const TINY = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>MCP</title></head>
<body><section data-jalon="s1" data-trigger="view">Un</section>
<section data-jalon="s2" data-trigger="view">Deux</section></body></html>`;

  const result = await client.callTool({
    name: "scorm_package",
    arguments: { html: TINY, title: "Test MCP", language: "fr-FR", output_dir: tmp },
  });

  const sc = result.structuredContent;
  check("tool call returned structuredContent", Boolean(sc));
  check("scorm_version is '2004 4th Edition'", sc?.scorm_version === "2004 4th Edition");
  check("milestone_count === 2", sc?.milestone_count === 2);
  check("milestone_ids === [s1,s2]", JSON.stringify(sc?.milestone_ids) === JSON.stringify(["s1", "s2"]));
  check("output_path ends with .zip", typeof sc?.output_path === "string" && sc.output_path.endsWith(".zip"));

  // verify the file actually exists on disk
  let exists = false, size = 0;
  try { const st = await fs.stat(sc.output_path); exists = true; size = st.size; } catch {}
  check("the .zip was written to disk", exists);
  check("the .zip is non-empty (" + size + " bytes)", size > 0);

  await client.close();
} catch (e) {
  fail++;
  console.log("  ✗ EXCEPTION: " + (e?.message || e));
  try { await client.close(); } catch {}
}

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
