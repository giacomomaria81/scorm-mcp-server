/**
 * Regression tests for output directory resolution.
 *
 * Bug found on 2026-07-25 with a real Claude Desktop install: the MCPB
 * `user_config.output_dir` default ("${HOME}/scorm-packages") reached the server
 * UNEXPANDED because the user had left the optional directory field empty. The
 * server resolved it as a path and died with:
 *
 *   ENOENT: no such file or directory, mkdir '/${HOME}'
 *
 * Every tool call failed. From the user's side it looked like a dead server.
 */
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { resolveOutputDir } from "../dist/index.js";

let passed = 0, failed = 0;
const check = (label, fn) => {
  try { fn(); console.log("  ✔ " + label); passed++; }
  catch (e) { console.log("  ✘ " + label + " → " + e.message); failed++; }
};

const HOME = os.homedir();
const FALLBACK = path.join(HOME, "scorm-packages");

console.log("1 — unexpanded host variables never become a literal directory:");

check('env "${HOME}/scorm-packages" is expanded, not taken literally', () => {
  const out = resolveOutputDir(undefined, "${HOME}/scorm-packages");
  assert.equal(out, path.join(HOME, "scorm-packages"));
  assert.ok(!out.includes("${"), "output still contains a template placeholder");
});

check("the exact production failure mode no longer yields /${HOME}", () => {
  const out = resolveOutputDir(undefined, "${HOME}/scorm-packages");
  assert.notEqual(out, path.resolve("${HOME}/scorm-packages"));
});

check("${DOCUMENTS} / ${DESKTOP} / ${DOWNLOADS} are expanded too", () => {
  assert.equal(resolveOutputDir(undefined, "${DOCUMENTS}/x"), path.join(HOME, "Documents", "x"));
  assert.equal(resolveOutputDir(undefined, "${DESKTOP}/x"), path.join(HOME, "Desktop", "x"));
  assert.equal(resolveOutputDir(undefined, "${DOWNLOADS}/x"), path.join(HOME, "Downloads", "x"));
});

check("an UNKNOWN placeholder falls back instead of creating a junk folder", () => {
  const out = resolveOutputDir(undefined, "${NOPE}/scorm");
  assert.equal(out, FALLBACK);
});

check("a placeholder anywhere in the path is caught, not just at the start", () => {
  assert.equal(resolveOutputDir(undefined, "/tmp/${NOPE}/out"), FALLBACK);
});

console.log("2 — normal values still behave:");

check("an explicit absolute path wins over the env var", () => {
  assert.equal(resolveOutputDir("/tmp/explicit", "/tmp/from-env"), path.resolve("/tmp/explicit"));
});

check("the env var is used when no explicit path is given", () => {
  assert.equal(resolveOutputDir(undefined, "/tmp/from-env"), path.resolve("/tmp/from-env"));
});

check("nothing configured → ~/scorm-packages", () => {
  assert.equal(resolveOutputDir(undefined, undefined), FALLBACK);
});

check("empty / whitespace-only values are treated as unset", () => {
  assert.equal(resolveOutputDir("", "   "), FALLBACK);
});

check("a bad explicit path falls through to the env var rather than failing", () => {
  assert.equal(resolveOutputDir("${NOPE}", "/tmp/from-env"), path.resolve("/tmp/from-env"));
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
