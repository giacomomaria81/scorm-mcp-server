#!/usr/bin/env node
/**
 * scorm-mcp-server
 *
 * Exposes a single tool, `scorm_package`, that converts a self-contained HTML
 * document (e.g. the HTML produced by Claude Design) into a SCORM 2004 4th
 * Edition package: assets inlined for offline use, a milestone runtime injected
 * for completion + progress tracking, and everything zipped into a valid PIF.
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
import { buildPackage } from "./converter.js";

const server = new McpServer({
  name: "scorm-mcp-server",
  version: "2.0.0",
});

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
    .describe("Course / module title. Used as the manifest, organization and item title shown in the LMS."),
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
};

server.registerTool(
  "scorm_package",
  {
    title: "Package HTML as SCORM 2004",
    description: `Convert a self-contained HTML document into a SCORM 2004 4th Edition package (.zip).

Use this to turn a finished learning module (for example HTML produced by Claude Design) into a file that any SCORM-compliant LMS can import. The conversion is faithful: the HTML is preserved, external assets are inlined as data URIs so the package runs 100% offline, and a small runtime is injected to report completion and progress.

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
  - title (string, required): course/module title shown in the LMS.
  - language (string, optional): BCP-47 tag, default 'fr-FR'.
  - identifier (string, optional): manifest id; auto-generated from title if omitted.
  - base_url (string, optional): base URL for resolving relative asset paths over the network.
  - output_dir (string, optional): where to write the .zip. Default: $SCORM_OUTPUT_DIR or ~/scorm-packages.
  - auto_milestones (boolean, optional, default true): auto-generate milestones when none are declared.
  - success_on_completion (boolean, optional, default false): also set cmi.success_status='passed' on completion.

Returns JSON:
  {
    "output_path": string,        // absolute path to the generated .zip
    "file_name": string,
    "scorm_version": "2004 4th Edition",
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
  },
  async (params) => {
    try {
      if (!params.html && !params.input_path) {
        return {
          content: [{ type: "text", text: "Error: provide either `html` (content string) or `input_path` (file on disk)." }],
          isError: true,
        };
      }

      const outDir = params.output_dir
        ? path.resolve(params.output_dir)
        : process.env.SCORM_OUTPUT_DIR
        ? path.resolve(process.env.SCORM_OUTPUT_DIR)
        : path.join(os.homedir(), "scorm-packages");

      await fs.mkdir(outDir, { recursive: true });

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
      });

      const outputPath = path.join(outDir, result.fileName);
      await fs.writeFile(outputPath, result.zip);

      const output = {
        output_path: outputPath,
        file_name: result.fileName,
        scorm_version: "2004 4th Edition",
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

      const human =
        "SCORM 2004 4th Edition package created.\n" +
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: "Error building SCORM package: " + msg }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("scorm-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
