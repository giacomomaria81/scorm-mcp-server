/**
 * validate.ts — standalone SCORM package validation.
 *
 * Answers the question every LMS admin ends up asking: "why does my LMS reject
 * this package?" — for ANY SCORM zip, not only the ones this tool produced.
 *
 * Checks performed (each yields a named check in the report):
 *   1. zip-readable        the input is a readable zip archive
 *   2. manifest-at-root    imsmanifest.xml exists at the ROOT of the zip (PIF rule).
 *                          The single most common import failure is zipping the
 *                          course FOLDER instead of its CONTENTS — detected and
 *                          explained explicitly.
 *   3. manifest-parses     the manifest is well-formed XML
 *   4. version-detected    SCORM edition identified (2004 vs 1.2) from
 *                          <schemaversion> and the adlcp namespace
 *   5. organization        at least one <organization> with a launchable <item>
 *   6. launch-resource     the item's identifierref resolves to a <resource>
 *                          marked scormType/scormtype="sco" with an href
 *   7. entry-exists        the launch href exists in the zip (a case-only
 *                          mismatch is flagged: it works on Windows, breaks on
 *                          the Linux servers most LMSs run on)
 *   8. files-exist         every <file href> listed in the manifest exists
 *   9. schema-valid        the manifest validates against the official ADL XSD
 *                          schemas (xmllint). XSDs bundled in the package are
 *                          used first; any missing ones are supplied from the
 *                          copies this tool embeds — so packages from OTHER
 *                          authoring tools (which rarely bundle schemas) can be
 *                          validated too. Skipped with a warning when xmllint
 *                          is not installed.
 *
 * The report is machine-readable (checks + errors + warnings) and the module is
 * exported as a documented library API alongside buildPackage().
 */

import JSZip from "jszip";
import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const V_SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schemas");
const V_SCHEMA_DIR_12 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schemas12");

/** Validation wrapper for SCORM 1.2 (imports both namespaces; never shipped in a PIF). */
const WRAPPER_12 =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
  '  <xsd:import namespace="http://www.imsproject.org/xsd/imscp_rootv1p1p2" schemaLocation="imscp_rootv1p1p2.xsd"/>\n' +
  '  <xsd:import namespace="http://www.adlnet.org/xsd/adlcp_rootv1p2" schemaLocation="adlcp_rootv1p2.xsd"/>\n' +
  "</xsd:schema>";

export interface ValidationCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ValidateReport {
  ok: boolean;
  scormVersion: "2004" | "1.2" | "unknown";
  title?: string;
  entryHref?: string;
  filesInZip: number;
  checks: ValidationCheck[];
  errors: string[];
  warnings: string[];
  /** "passed" | "failed" | "skipped" (xmllint unavailable) | "not-run" (earlier fatal error) */
  schemaValidation: "passed" | "failed" | "skipped" | "not-run";
}

export interface ValidateOptions {
  /** Path to a .zip on disk. Provide this OR zipData. */
  zipPath?: string;
  /** Raw zip bytes. Provide this OR zipPath. */
  zipData?: Buffer | Uint8Array;
}

function pexec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(Object.assign(err, { stdout, stderr })); } else { resolve({ stdout, stderr }); }
    });
  });
}

function decodeHref(href: string): string {
  try {
    return href.split("/").map(decodeURIComponent).join("/");
  } catch {
    return href; // malformed percent-encoding: compare as-is
  }
}

/** Validate a SCORM package (2004 or 1.2). Never throws: every failure lands in the report. */
export async function validatePackage(opts: ValidateOptions): Promise<ValidateReport> {
  const checks: ValidationCheck[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const push = (id: string, label: string, ok: boolean, detail?: string) => {
    checks.push({ id, label, ok, ...(detail ? { detail } : {}) });
    if (!ok) { errors.push(label + (detail ? " — " + detail : "")); }
    return ok;
  };
  const report = (extra: Partial<ValidateReport>): ValidateReport => ({
    ok: errors.length === 0,
    scormVersion: "unknown",
    filesInZip: 0,
    checks, errors, warnings,
    schemaValidation: "not-run",
    ...extra,
  });

  // -- 1. load the zip --------------------------------------------------------
  let data: Buffer | Uint8Array;
  try {
    data = opts.zipData ?? (await fs.readFile(opts.zipPath!));
  } catch (e) {
    push("zip-readable", "Input file could not be read", false, String((e as Error).message ?? e));
    return report({});
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
    push("zip-readable", "Input is a readable zip archive", true);
  } catch {
    push("zip-readable", "Input is not a valid zip archive", false,
      "The file could not be opened as a zip. SCORM packages must be plain .zip files (no rar/7z, no password).");
    return report({});
  }
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const filesInZip = names.length;

  // -- 2. manifest at the root ------------------------------------------------
  const nested = names.find((n) => /^[^/]+\/imsmanifest\.xml$/i.test(n));
  const rootManifestName = names.find((n) => n.toLowerCase() === "imsmanifest.xml");
  if (!rootManifestName) {
    if (nested) {
      push("manifest-at-root", "imsmanifest.xml is not at the ROOT of the zip", false,
        `Found "${nested}" instead. The course folder itself was zipped. Re-zip the CONTENTS of the folder ` +
        "(imsmanifest.xml must be the first thing an LMS sees when it opens the archive).");
    } else {
      push("manifest-at-root", "imsmanifest.xml is missing", false,
        "No manifest anywhere in the archive: this is not a SCORM package (or the export is incomplete).");
    }
    return report({ filesInZip });
  }
  push("manifest-at-root", "imsmanifest.xml present at the zip root", true);

  // -- 3. parse the manifest --------------------------------------------------
  const manifestXml = await zip.file(rootManifestName)!.async("string");
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(manifestXml, { xml: true });
    if ($("manifest").length === 0) { throw new Error("no <manifest> root element"); }
    push("manifest-parses", "imsmanifest.xml is well-formed XML with a <manifest> root", true);
  } catch (e) {
    push("manifest-parses", "imsmanifest.xml could not be parsed", false, String((e as Error).message ?? e));
    return report({ filesInZip });
  }

  // -- 4. SCORM edition -------------------------------------------------------
  const schemaversion = $("schemaversion").first().text().trim();
  const ns2004 = /adlcp_v1p3/.test(manifestXml);
  const ns12 = /adlcp_rootv1p2|imscp_rootv1p1p2/.test(manifestXml);
  let scormVersion: "2004" | "1.2" | "unknown" = "unknown";
  if (/2004|CAM 1\.3/i.test(schemaversion) || (ns2004 && !ns12)) { scormVersion = "2004"; }
  else if (/^1\.2$/.test(schemaversion) || (ns12 && !ns2004)) { scormVersion = "1.2"; }
  push("version-detected", "SCORM edition identified", scormVersion !== "unknown",
    scormVersion !== "unknown"
      ? `SCORM ${scormVersion}` + (schemaversion ? ` (schemaversion: "${schemaversion}")` : " (from namespaces)")
      : `schemaversion is "${schemaversion || "(absent)"}" and the adlcp namespace is missing or ambiguous.`);

  // -- 5. organization & launchable item -------------------------------------
  const org = $("organizations > organization").first();
  const item = org.find("item[identifierref]").first();
  const title = (org.find("> title").first().text() || item.find("> title").first().text() || "").trim() || undefined;
  push("organization", "An <organization> with a launchable <item identifierref=…> exists",
    org.length > 0 && item.length > 0,
    org.length === 0 ? "No <organization> found." : item.length === 0 ? "No <item> carries an identifierref." : undefined);

  // -- 6. launch resource -----------------------------------------------------
  let entryHref: string | undefined;
  if (item.length > 0) {
    const ref = item.attr("identifierref")!;
    const resource = $(`resources > resource[identifier="${ref}"]`).first();
    const scormType = (resource.attr("adlcp:scormType") ?? resource.attr("adlcp:scormtype") ?? "").toLowerCase();
    entryHref = resource.attr("href") ?? undefined;
    const ok = resource.length > 0 && !!entryHref;
    push("launch-resource", "The item's identifierref resolves to a launchable <resource href=…>", ok,
      resource.length === 0 ? `No <resource identifier="${ref}"> found.` :
      !entryHref ? "The resource has no href (nothing to launch)." :
      undefined);
    if (ok && scormType !== "sco") {
      warnings.push(`The launch resource is declared "${scormType || "(none)"}" instead of scormType="sco": most LMSs will import it but track nothing.`);
    }
  }

  // -- 7 & 8. referenced files exist ------------------------------------------
  const zipSet = new Set(names);
  const zipLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const missing: string[] = [];
  const caseMismatch: string[] = [];
  const seen = new Set<string>();
  const fileHrefs: string[] = [];
  if (entryHref) { fileHrefs.push(entryHref); }
  $("resources > resource > file[href]").each((_i, el) => { fileHrefs.push($(el).attr("href")!); });
  for (const raw of fileHrefs) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) { continue; } // absolute URL (http:, https:, data:) — not in the zip
    const decoded = decodeHref(raw.split("?")[0].split("#")[0]);
    if (seen.has(decoded)) { continue; }
    seen.add(decoded);
    if (zipSet.has(decoded)) { continue; }
    const ci = zipLower.get(decoded.toLowerCase());
    if (ci) { caseMismatch.push(`${decoded} (zip has "${ci}")`); } else { missing.push(decoded); }
  }
  if (entryHref) {
    const decodedEntry = decodeHref(entryHref.split("?")[0].split("#")[0]);
    push("entry-exists", "The launch file exists in the zip",
      zipSet.has(decodedEntry) || zipLower.has(decodedEntry.toLowerCase()),
      zipSet.has(decodedEntry) ? undefined : `"${decodedEntry}" not found in the archive.`);
  }
  const shown = missing.slice(0, 8).join(", ") + (missing.length > 8 ? ` … (+${missing.length - 8} more)` : "");
  push("files-exist", "Every <file href> listed in the manifest exists in the zip",
    missing.length === 0, missing.length ? "Missing: " + shown : undefined);
  if (caseMismatch.length) {
    warnings.push("Case-only filename mismatch (works on Windows, FAILS on the Linux servers most LMSs run on): " +
      caseMismatch.slice(0, 5).join(", "));
  }

  // -- 9. XSD schema validation (xmllint) -------------------------------------
  let schemaValidation: ValidateReport["schemaValidation"] = "not-run";
  if (scormVersion !== "unknown") {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scorm-validate-"));
    try {
      await fs.writeFile(path.join(tmp, "imsmanifest.xml"), manifestXml);
      // XSDs from the package first, then fall back to our embedded copies.
      const xsdInZip = names.filter((n) => !n.includes("/") && n.toLowerCase().endsWith(".xsd"));
      for (const n of xsdInZip) {
        await fs.writeFile(path.join(tmp, n), await zip.file(n)!.async("nodebuffer"));
      }
      const fallbackDir = scormVersion === "1.2" ? V_SCHEMA_DIR_12 : V_SCHEMA_DIR;
      try {
        for (const n of await fs.readdir(fallbackDir)) {
          if (!n.toLowerCase().endsWith(".xsd")) { continue; }
          try { await fs.access(path.join(tmp, n)); } catch { await fs.copyFile(path.join(fallbackDir, n), path.join(tmp, n)); }
        }
      } catch { /* embedded schemas unavailable: rely on the package's own XSDs */ }
      const schemaRoot = scormVersion === "1.2" ? "wrapper12.xsd" : "imscp_v1p1.xsd";
      if (scormVersion === "1.2") { await fs.writeFile(path.join(tmp, "wrapper12.xsd"), WRAPPER_12); }
      try {
        await fs.access(path.join(tmp, schemaRoot === "wrapper12.xsd" ? "imscp_rootv1p1p2.xsd" : schemaRoot));
        try {
          await pexec("xmllint", ["--noout", "--schema", path.join(tmp, schemaRoot), path.join(tmp, "imsmanifest.xml")]);
          schemaValidation = "passed";
          push("schema-valid", "imsmanifest.xml validates against the official ADL XSD schemas", true);
        } catch (e: unknown) {
          const err = e as NodeJS.ErrnoException & { stderr?: string };
          if (err.code === "ENOENT") {
            schemaValidation = "skipped";
            warnings.push("xmllint is not installed: XSD schema validation skipped (install libxml2 to enable it).");
          } else {
            schemaValidation = "failed";
            const firstLines = String(err.stderr ?? err.message ?? e).split("\n").slice(0, 6).join("\n");
            push("schema-valid", "imsmanifest.xml does NOT validate against the ADL XSD schemas", false, firstLines);
          }
        }
      } catch {
        schemaValidation = "skipped";
        warnings.push("Required XSD schemas unavailable (neither bundled in the package nor embedded locally): schema validation skipped.");
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  return report({ scormVersion, title, entryHref, filesInZip, schemaValidation });
}

/** Human-readable, one-screen summary of a report (used by the CLI and the MCP tool). */
export function formatReport(r: ValidateReport): string {
  const lines: string[] = [];
  lines.push((r.ok ? "VALID" : "INVALID") +
    " — SCORM " + (r.scormVersion === "unknown" ? "(version unknown)" : r.scormVersion) +
    (r.title ? ` — "${r.title}"` : "") +
    ` — ${r.filesInZip} file(s) in the archive`);
  for (const c of r.checks) {
    lines.push(`  ${c.ok ? "✔" : "✗"} ${c.label}` + (c.detail ? ` — ${c.detail}` : ""));
  }
  for (const w of r.warnings) { lines.push(`  ! ${w}`); }
  if (r.schemaValidation === "skipped") { lines.push("  (XSD validation skipped)"); }
  return lines.join("\n");
}
