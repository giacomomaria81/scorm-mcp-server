#!/usr/bin/env node
/**
 * scorm-mcp-server
 *
 * Exposes three tools: `scorm_package` converts a self-contained HTML document
 * (e.g. the HTML produced by Claude Design) or a mobile-learning export into a
 * SCORM 2004 / 1.2 package (assets inlined for offline use, a milestone runtime
 * injected for completion + progress + interactions tracking, everything zipped
 * into a valid PIF); `scorm_validate` conformance-checks ANY existing SCORM
 * zip and explains import failures; `scorm_selftest` is a 1-second diagnostic.
 *
 * Transport: stdio (for local use inside Claude Desktop / Claude Code).
 *
 * NOTE: the tool's inputSchema is passed as a Zod RAW SHAPE (not a z.object).
 * Passing a ZodObject makes the SDK publish an empty JSON schema, and schema-
 * strict clients (Claude Desktop / Cowork) then strip every argument.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { buildPackage } from "./converter.js";
// Public library API: lets pipelines/backends do
//   import { buildPackage } from "scorm-mcp-server";
export { buildPackage } from "./converter.js";
const SERVER_VERSION = "2.3.0";
const server = new McpServer({
    name: "scorm-mcp-server",
    version: SERVER_VERSION,
});
/**
 * Output directory resolution.
 *
 * A directory coming from the host (MCPB `user_config`, passed through
 * SCORM_OUTPUT_DIR) can arrive with its template variables UNEXPANDED — e.g. the
 * literal string "${HOME}/scorm-packages" when the user leaves an optional
 * directory field empty. Resolving that as a path makes the server try to create
 * a folder literally named "${HOME}" and fail with ENOENT, which surfaces to the
 * user as "the MCP is broken" even though nothing else is wrong.
 *
 * So: expand the variables the MCPB spec defines ourselves, and if anything is
 * still unexpanded afterwards, treat the value as "not configured" and fall back.
 */
const HOST_VARS = {
    HOME: os.homedir(),
    DESKTOP: path.join(os.homedir(), "Desktop"),
    DOCUMENTS: path.join(os.homedir(), "Documents"),
    DOWNLOADS: path.join(os.homedir(), "Downloads"),
    pathSeparator: path.sep,
    "/": path.sep,
};
export function resolveOutputDir(explicit, env) {
    for (const candidate of [explicit, env]) {
        const raw = candidate?.trim();
        if (!raw)
            continue;
        const expanded = raw.replace(/\$\{([^}]*)\}/g, (whole, name) => Object.prototype.hasOwnProperty.call(HOST_VARS, name) ? HOST_VARS[name] : whole);
        if (/\$\{[^}]*\}/.test(expanded))
            continue; // still templated → unusable
        return path.resolve(expanded);
    }
    return path.join(os.homedir(), "scorm-packages");
}
// Zod RAW SHAPE (see note above).
const InputShape = {
    html: z
        .string()
        .optional()
        .describe("Raw HTML content to convert (e.g. the output of Claude Design). Provide this OR input_path."),
    input_path: z
        .string()
        .optional()
        .describe("Absolute path to an HTML file on disk. Its folder is used to resolve relative assets. Provide this OR html."),
    title: z
        .string()
        .min(1, "title must not be empty")
        .max(250)
        .optional()
        .describe("Course / module title, used as the manifest, organization and item title shown in the LMS. Required for HTML inputs; optional for a mobile-learning Excel export, where it is derived from the template file names."),
    language: z
        .string()
        .optional()
        .describe("Content language tag (BCP-47), e.g. 'fr-FR', 'en-US', 'it-IT'. Default: 'fr-FR'. Applied as <html lang> when the source declares none."),
    identifier: z
        .string()
        .optional()
        .describe("Manifest identifier. Auto-generated from the title if omitted."),
    base_url: z
        .string()
        .url()
        .optional()
        .describe("Base URL to resolve relative/root-relative asset references over the network (only needed if the HTML uses relative URLs and no input_path is given)."),
    output_dir: z
        .string()
        .optional()
        .describe("Directory to write the .zip package into. Defaults to $SCORM_OUTPUT_DIR or ~/scorm-packages."),
    auto_milestones: z
        .boolean()
        .optional()
        .describe("When the HTML declares no [data-jalon] milestone, auto-generate 'view' milestones from the document structure (sections, then articles, then headings; max 8). Default: true."),
    success_on_completion: z
        .boolean()
        .optional()
        .describe("Also report cmi.success_status='passed' when the module completes (equivalent to adding data-scorm-success=\"on-completion\"). Default: false."),
    mastery_score: z
        .number()
        .min(0).max(1)
        .optional()
        .describe("Pass threshold 0..1. Enables score-based success (passed/failed from cmi.score.scaled) and adds sequencing objectives to the manifest. Content reports the score via window.SCORM2004.score(raw,min,max) or a 'scorm:score' CustomEvent."),
    vendor_cdn: z
        .boolean()
        .optional()
        .describe("For Claude Design (.dc) bundles: download CDN libs (React/Babel…) into the package so it runs offline (via window.__resources, no source patch). Default: true."),
    format: z
        .enum(["auto", "self-contained-html", "claude-design"])
        .optional()
        .describe("Input format. 'auto' (default) detects Claude Design .dc bundles by signature; override to force a pipeline."),
    scorm_version: z
        .enum(["2004", "1.2"])
        .optional()
        .describe("SCORM edition of the produced package. '2004' (default, 4th Edition) or '1.2' for legacy LMSs. The injected runtime is adaptive and works with both LMS APIs; this choice controls the manifest and bundled schemas."),
    batch: z
        .boolean()
        .optional()
        .describe("Treat input_path as a DIRECTORY containing several courses (each sub-directory, .zip or .html file = one course). Produces one package per course plus a consolidated report. Course titles default to the folder/file name; `title` is used as a prefix."),
};
server.registerTool("scorm_package", {
    title: "Package HTML as SCORM (2004 or 1.2)",
    description: `Convert a self-contained HTML document, a folder, a .zip, a Claude Design (.dc) bundle OR a mobile-learning platform content export (Excel activity templates + media) into a SCORM package (.zip) — SCORM 2004 4th Edition by default, or SCORM 1.2 for legacy LMSs.

Use this to turn a finished learning module (for example HTML produced by Claude Design) into a file that any SCORM-compliant LMS can import. The conversion is faithful: the HTML is preserved, external assets are inlined as data URIs so the package runs 100% offline, and a small runtime is injected to report completion and progress.

MIGRATION FROM MOBILE-LEARNING PLATFORMS: if the input zip/folder contains Excel activity templates (mobile course cards, quiz games...) plus a media folder — the format produced by the platform's content export — the tool rebuilds an interactive HTML course from them (info/transition/flash cards, scored quizzes reporting cmi.score, media embedded, the platform's layout codes rendered) and packages it. No title needed: it is derived from the template file names. Combined with batch mode this migrates a whole course catalogue in one call.

PROGRESS / COMPLETION MODEL (milestones):
The author can mark meaningful steps with data-jalon + optional data-trigger:
  - <section data-jalon="histoire-produit" data-trigger="view"> ... </section>   (counts when scrolled into view; "view" is the default)
  - <button  data-jalon="argumentaire" data-trigger="click">J'ai lu</button>      (counts on click)
  - <video   data-jalon="geste" data-trigger="ended"> ... </video>                (counts when playback ends)
AUTOMATIC FALLBACK: if the HTML declares NO milestone, they are generated automatically from the document structure (sections → articles → h2 → h3, capped at 8, trigger "view"). So plain HTML "just works" with meaningful progress — you do NOT need to ask the author to add attributes first. Explicit data-jalon attributes always take precedence (recommended for click/video steps).
The runtime reports cmi.progress_measure = milestones_reached / total, and sets cmi.completion_status = "completed" once all milestones are reached. Progress and scroll position resume across sessions via cmi.suspend_data / cmi.location. Content can also call window.SCORM2004.reach(id) / declare(id).

Args:
  - html (string, optional): HTML content. Provide this OR input_path.
  - input_path (string, optional): path to an HTML file on disk. Provide this OR html.
  - title (string): course/module title shown in the LMS. Required for HTML inputs; optional for a mobile-learning Excel export (derived from the templates).
  - language (string, optional): BCP-47 tag, default 'fr-FR'.
  - identifier (string, optional): manifest id; auto-generated from title if omitted.
  - base_url (string, optional): base URL for resolving relative asset paths over the network.
  - output_dir (string, optional): where to write the .zip. Default: $SCORM_OUTPUT_DIR or ~/scorm-packages.
  - auto_milestones (boolean, optional, default true): auto-generate milestones when none are declared.
  - success_on_completion (boolean, optional, default false): also set cmi.success_status='passed' on completion.
  - scorm_version ('2004' or '1.2', optional, default '2004'): SCORM edition of the package. Choose '1.2' for older LMSs that reject 2004. The injected runtime is adaptive and works with both LMS APIs either way; this controls the manifest and bundled schemas.
  - mastery_score (number 0..1, optional): pass threshold; enables score-based success.
  - batch (boolean, optional): treat input_path as a DIRECTORY of courses (each sub-directory, .zip or .html = one course). Produces one package per course plus a consolidated batch-report.json; a broken course never blocks the others. The title argument becomes a prefix.

Returns JSON:
  {
    "output_path": string,        // absolute path to the generated .zip
    "file_name": string,
    "scorm_version": "2004 4th Edition" or "1.2",
    "milestone_count": number,    // milestones in the package
    "milestone_ids": string[],
    "milestones_auto": boolean,   // true if they were auto-generated
    "size_bytes": number,
    "warnings": string[]
  }

Notes:
  - Validate the resulting package on SCORM Cloud (cloud.scorm.com) before production rollout.
  - Offline completion that syncs later is provided by the LMS mobile app downloading this package; verify your target LMS apps support offline SCORM.`,
    inputSchema: InputShape,
    annotations: {
        readOnlyHint: false,
        // Honest safety annotation for directory review: the tool WRITES files
        // (and overwrites a .zip that shares the same title slug in output_dir).
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true, // may fetch remote assets to inline them
    },
}, async (params) => {
    try {
        if (!params.html && !params.input_path) {
            return {
                content: [{ type: "text", text: "Error: provide either `html` (content string) or `input_path` (file on disk)." }],
                isError: true,
            };
        }
        const outDir = resolveOutputDir(params.output_dir, process.env.SCORM_OUTPUT_DIR);
        await fs.mkdir(outDir, { recursive: true });
        // ---------- batch mode: input_path is a directory of courses ----------
        if (params.batch) {
            if (!params.input_path) {
                return { content: [{ type: "text", text: "Error: `batch` requires `input_path` (a directory of courses)." }], isError: true };
            }
            const report = await packBatch(params, outDir);
            const human = "Batch: " + report.succeeded.length + "/" + report.total + " package(s) créés dans " + outDir + "\n" +
                report.succeeded.map((r) => " ✓ " + r.course + " → " + r.file_name + (r.warnings.length ? "  (" + r.warnings.length + " warning(s))" : "")).join("\n") +
                (report.failed.length ? "\nÉchecs:\n" + report.failed.map((f) => " ✗ " + f.course + " : " + f.error).join("\n") : "") +
                "\nRapport détaillé: " + report.report_path;
            return { content: [{ type: "text", text: human }], structuredContent: report };
        }
        const result = await buildPackage({
            html: params.html,
            inputPath: params.input_path,
            baseUrl: params.base_url,
            title: params.title,
            identifier: params.identifier,
            language: params.language ?? "fr-FR",
            autoMilestones: params.auto_milestones !== false,
            successOnCompletion: params.success_on_completion === true,
            masteryScore: params.mastery_score,
            vendorCdn: params.vendor_cdn,
            format: params.format,
            scormVersion: params.scorm_version,
        });
        const outputPath = path.join(outDir, result.fileName);
        await fs.writeFile(outputPath, result.zip);
        const output = {
            output_path: outputPath,
            file_name: result.fileName,
            scorm_version: result.scormVersion === "1.2" ? "1.2" : "2004 4th Edition",
            milestone_count: result.milestoneCount,
            milestone_ids: result.milestoneIds,
            milestones_auto: result.milestonesAuto,
            format: result.format,
            files_count: result.filesCount,
            vendored: result.vendored,
            schemas_bundled: result.schemasBundled,
            size_bytes: result.zip.length,
            warnings: result.warnings,
        };
        const human = "SCORM " + (result.scormVersion === "1.2" ? "1.2" : "2004 4th Edition") + " package created.\n" +
            "File: " + outputPath + "\n" +
            "Size: " + (result.zip.length / 1024).toFixed(1) + " Ko\n" +
            "ADL XSD schemas bundled: " + result.schemasBundled + "\n" +
            "Input format: " + result.format + " (" + result.filesCount + " file(s)" + (result.vendored.length ? ", " + result.vendored.length + " CDN lib(s) vendored" : "") + ")\n" +
            "Milestones: " + result.milestoneCount +
            (result.milestonesAuto ? " (auto-générés depuis la structure du document)" : "") +
            (result.milestoneCount ? " — " + result.milestoneIds.join(", ") : "") +
            "\n" +
            (result.warnings.length ? "Warnings:\n - " + result.warnings.join("\n - ") : "No warnings.") +
            "\nNext: upload to SCORM Cloud (cloud.scorm.com) to validate before LMS rollout.";
        return {
            content: [{ type: "text", text: human }],
            structuredContent: output,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: "Error building SCORM package: " + msg }],
            isError: true,
        };
    }
});
function titleFromEntry(name) {
    return name
        .replace(/\.(zip|html?)$/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase()) || name;
}
async function packBatch(params, outDir) {
    const root = path.resolve(String(params.input_path));
    const entries = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => !e.name.startsWith("."))
        .filter((e) => e.isDirectory() || /\.(zip|html?)$/i.test(e.name))
        .map((e) => e.name)
        .sort();
    const prefix = typeof params.title === "string" && params.title.trim() ? params.title.trim() + " — " : "";
    const succeeded = [];
    const failed = [];
    for (const name of entries) {
        try {
            const result = await buildPackage({
                inputPath: path.join(root, name),
                title: prefix + titleFromEntry(name),
                language: params.language ?? "fr-FR",
                autoMilestones: params.auto_milestones !== false,
                successOnCompletion: params.success_on_completion === true,
                masteryScore: params.mastery_score,
                vendorCdn: params.vendor_cdn,
                format: params.format,
                scormVersion: params.scorm_version,
            });
            const outputPath = path.join(outDir, result.fileName);
            await fs.writeFile(outputPath, result.zip);
            succeeded.push({
                course: name, file_name: result.fileName, output_path: outputPath,
                scorm_version: result.scormVersion, milestone_count: result.milestoneCount,
                format: result.format, size_bytes: result.zip.length, warnings: result.warnings,
            });
        }
        catch (err) {
            // one broken course must never sink the other 199
            failed.push({ course: name, error: err instanceof Error ? err.message : String(err) });
        }
    }
    const report = { total: entries.length, succeeded, failed, report_path: path.join(outDir, "batch-report.json") };
    await fs.writeFile(report.report_path, JSON.stringify(report, null, 2));
    return report;
}
// --------------------------------------------------------------------------
// scorm_validate: standalone conformance check of ANY existing SCORM zip
// --------------------------------------------------------------------------
server.registerTool("scorm_validate", {
    title: "Validate an existing SCORM package",
    description: `Check whether an EXISTING SCORM .zip (made by this tool or by ANY other authoring tool) is conformant and will import into an LMS — and if not, explain exactly why.

Use this when an LMS rejects a package, before uploading a package to production, or to audit a batch of courses received from a vendor. The input is never modified.

Checks performed:
  - the archive is a readable zip with imsmanifest.xml at its ROOT (detects the classic "zipped the folder instead of its contents" mistake and says how to fix it)
  - the manifest is well-formed XML and the SCORM edition is identified (2004 or 1.2)
  - an <organization> with a launchable <item> exists, resolving to a scormType="sco" <resource> with an href
  - the launch file and every <file href> listed in the manifest actually exist in the archive (case-only mismatches are flagged: they work on Windows but fail on the Linux servers most LMSs run on)
  - the manifest validates against the official ADL XSD schemas (XSDs bundled in the package are used first; missing ones are supplied from the copies embedded in this tool, so packages that ship without schemas can still be validated). Requires xmllint; skipped with a warning otherwise.

Args:
  - input_path (string, required): path to the .zip to validate.

Returns JSON: { ok, scorm_version, title, entry_href, files_in_zip, checks: [{id, label, ok, detail}], errors, warnings, schema_validation }`,
    inputSchema: {
        input_path: z.string().describe("Path to the SCORM .zip file to validate."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async (params) => {
    try {
        const { validatePackage, formatReport } = await import("./validate.js");
        const r = await validatePackage({ zipPath: params.input_path });
        const output = {
            ok: r.ok,
            scorm_version: r.scormVersion,
            title: r.title,
            entry_href: r.entryHref,
            files_in_zip: r.filesInZip,
            checks: r.checks,
            errors: r.errors,
            warnings: r.warnings,
            schema_validation: r.schemaValidation,
        };
        return {
            content: [{ type: "text", text: formatReport(r) }],
            structuredContent: output,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: "Validation could not run: " + msg }], isError: true };
    }
});
// --------------------------------------------------------------------------
// scorm_selftest: instant "is the server alive and sane?" diagnostic
// --------------------------------------------------------------------------
const SELFTEST_HTML = "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Selftest</title></head>" +
    "<body><section><h2>Section A</h2><p>selftest</p></section><section><h2>Section B</h2><p>selftest</p></section></body></html>";
server.registerTool("scorm_selftest", {
    title: "SCORM packager self-test",
    description: "Diagnostic tool with NO arguments: packages a constant built-in HTML and reports version, duration and output path. Distinguishes 'server broken' from 'input problem' in one second. Writes one small file (selftest-scorm2004.zip) into the output directory.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
    try {
        const t0 = Date.now();
        const outDir = resolveOutputDir(undefined, process.env.SCORM_OUTPUT_DIR);
        await fs.mkdir(outDir, { recursive: true });
        const result = await buildPackage({ html: SELFTEST_HTML, title: "Selftest" });
        const outputPath = path.join(outDir, result.fileName);
        await fs.writeFile(outputPath, result.zip);
        const output = {
            ok: true,
            server_version: SERVER_VERSION,
            duration_ms: Date.now() - t0,
            output_dir: outDir,
            output_path: outputPath,
            schemas_bundled: result.schemasBundled,
            milestones_auto: result.milestoneCount,
            node: process.version,
        };
        return {
            content: [{ type: "text", text: "Selftest OK — v" + SERVER_VERSION + ", " + output.duration_ms + " ms, " + result.schemasBundled + " XSD, output: " + outputPath }],
            structuredContent: output,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: "Selftest FAILED: " + msg }], isError: true };
    }
});
// --------------------------------------------------------------------------
// CLI: `scorm-mcp-server pack <input> [options]` — no MCP client required
// --------------------------------------------------------------------------
const CLI_HELP = `scorm-mcp-server — HTML / Claude Design / mobile-learning exports -> SCORM packager

Usage:
  scorm-mcp-server                      start the MCP server (stdio)
  scorm-mcp-server ui [--port 3117]     open the local drag & drop web UI
  scorm-mcp-server pack <input> [opts]  package a file/folder/zip from the CLI
  scorm-mcp-server validate <file.zip>  check an existing SCORM package (any tool's) and explain failures
  scorm-mcp-server selftest             build a constant test package

Inputs: a self-contained .html, a folder or .zip bundle, a Claude Design .dc
bundle, or a mobile-learning platform content export (Excel activity templates + media —
rebuilt into an interactive HTML course automatically).

Options for pack:
  --title <t>          course title (default: derived from the file name)
  --out <dir>          output directory (default: $SCORM_OUTPUT_DIR or ~/scorm-packages)
  --scorm-version <v>  2004 (default) | 1.2
  --mastery <0..1>     pass threshold; enables score-based success
  --language <tag>     BCP-47 tag, default fr-FR
  --batch              treat <input> as a directory of courses (one package each)
  --no-auto-milestones disable structural milestone auto-generation
  --success-on-completion  report success=passed on completion
`;
function cliArg(args, name) {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
export async function runCli(argv) {
    const [cmd, ...args] = argv;
    if (cmd === "ui") {
        const { startUi } = await import("./ui.js");
        const port = cliArg(args, "--port") ? Number(cliArg(args, "--port")) : 3117;
        const outDir = resolveOutputDir(cliArg(args, "--out"), process.env.SCORM_OUTPUT_DIR);
        await startUi({ port, outDir, version: SERVER_VERSION });
        const url = "http://127.0.0.1:" + port;
        console.log("SCORM Packager UI: " + url + "  (packages land in " + outDir + ")");
        // best-effort: open the default browser (mac/win/linux), never fail on error
        try {
            const { exec } = await import("node:child_process");
            const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
            exec(opener + " " + url, () => { });
        }
        catch { /* user can click the printed URL */ }
        return new Promise(() => { }); // serve until Ctrl-C
    }
    if (cmd === "validate") {
        const target = args.find((a) => !a.startsWith("--"));
        if (!target) {
            console.error("validate: missing <file.zip>\n");
            console.log(CLI_HELP);
            return 1;
        }
        const { validatePackage, formatReport } = await import("./validate.js");
        const r = await validatePackage({ zipPath: target });
        if (args.includes("--json")) {
            console.log(JSON.stringify(r, null, 2));
        }
        else {
            console.log(formatReport(r));
        }
        return r.ok ? 0 : 1;
    }
    if (cmd === "selftest") {
        const t0 = Date.now();
        const outDir = resolveOutputDir(cliArg(args, "--out"), process.env.SCORM_OUTPUT_DIR);
        await fs.mkdir(outDir, { recursive: true });
        const result = await buildPackage({ html: SELFTEST_HTML, title: "Selftest" });
        await fs.writeFile(path.join(outDir, result.fileName), result.zip);
        console.log("Selftest OK — v" + SERVER_VERSION + ", " + (Date.now() - t0) + " ms, " + result.schemasBundled + " XSD, output: " + path.join(outDir, result.fileName));
        return 0;
    }
    if (cmd !== "pack") {
        console.log(CLI_HELP);
        return cmd && cmd !== "--help" && cmd !== "-h" ? 1 : 0;
    }
    // <input> = first token that is neither an option nor an option's value
    const VALUED = new Set(["--title", "--out", "--scorm-version", "--mastery", "--language"]);
    let input;
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--")) {
            if (VALUED.has(args[i])) {
                i++;
            }
            continue;
        }
        input = args[i];
        break;
    }
    if (!input) {
        console.error("pack: missing <input>\n");
        console.log(CLI_HELP);
        return 1;
    }
    const outDir = resolveOutputDir(cliArg(args, "--out"), process.env.SCORM_OUTPUT_DIR);
    await fs.mkdir(outDir, { recursive: true });
    const common = {
        language: cliArg(args, "--language") ?? "fr-FR",
        autoMilestones: !args.includes("--no-auto-milestones"),
        successOnCompletion: args.includes("--success-on-completion"),
        masteryScore: cliArg(args, "--mastery") !== undefined ? Number(cliArg(args, "--mastery")) : undefined,
        scormVersion: (cliArg(args, "--scorm-version") === "1.2" ? "1.2" : "2004"),
    };
    if (args.includes("--batch")) {
        const report = await packBatch({ input_path: input, title: cliArg(args, "--title"), scorm_version: common.scormVersion, mastery_score: common.masteryScore, language: common.language, auto_milestones: common.autoMilestones, success_on_completion: common.successOnCompletion }, outDir);
        for (const r of report.succeeded) {
            console.log(" ✓ " + r.course + " → " + r.output_path);
        }
        for (const f of report.failed) {
            console.error(" ✗ " + f.course + " : " + f.error);
        }
        console.log(report.succeeded.length + "/" + report.total + " packages — report: " + report.report_path);
        return report.failed.length ? 1 : 0;
    }
    const title = cliArg(args, "--title") ?? titleFromEntry(path.basename(input));
    const result = await buildPackage({ inputPath: input, title, ...common });
    const outputPath = path.join(outDir, result.fileName);
    await fs.writeFile(outputPath, result.zip);
    console.log("SCORM " + (result.scormVersion === "1.2" ? "1.2" : "2004") + " package: " + outputPath);
    if (result.warnings.length) {
        for (const w of result.warnings) {
            console.error(" ! " + w);
        }
    }
    return 0;
}
async function main() {
    const sub = process.argv[2];
    if (sub === "pack" || sub === "validate" || sub === "selftest" || sub === "ui" || sub === "--help" || sub === "-h") {
        process.exit(await runCli(process.argv.slice(2)));
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("scorm-mcp-server running on stdio");
}
// Only start the transport when this file is the process entry point, so tests
// (and any other consumer) can import helpers from here without spawning a server.
const isEntryPoint = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
    main().catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}
