/**
 * A Claude Design (.dc) bundle is a state-driven app: screens are swapped in JS,
 * not laid out as document sections, so structural auto-milestoning finds nothing.
 *
 * Found on a real module (Dior "Collection Privée", 2026-07-25): the package built
 * cleanly — 17 files, React/ReactDOM/Babel vendored offline, 15 XSD, zero errors —
 * and reported NOTHING to the LMS. No progress, no completion, no score. Silently.
 *
 * These tests pin the detection that now turns that silence into a loud warning.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasTrackingSignal, buildPackage } from "../dist/converter.js";

let passed = 0, failed = 0;
const check = async (label, fn) => {
  try { await fn(); console.log("  ✔ " + label); passed++; }
  catch (e) { console.log("  ✘ " + label + " → " + e.message); failed++; }
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dc-signal-"));
const bundle = { root, files: ["m.dc.html", "support.js", "app.js"], entryRel: "m.dc.html" };
const write = (rel, body) => fs.writeFile(path.join(root, rel), body);
await write("m.dc.html", "<x-dc></x-dc>");
await write("support.js", "// dc runtime");
await write("app.js", "// nothing here");

console.log("1 — detection of a tracking signal:");

await check("a bundle with no signal anywhere returns false", async () => {
  assert.equal(hasTrackingSignal(bundle, "<x-dc></x-dc>", "// dc runtime"), false);
});

await check("data-jalon in the entry HTML counts", async () => {
  assert.equal(hasTrackingSignal(bundle, '<div data-jalon="a"></div>', "// dc runtime"), true);
});

await check("SCORM2004.reach() in the entry HTML counts", async () => {
  assert.equal(hasTrackingSignal(bundle, "<script>window.SCORM2004.reach('a')</script>", ""), true);
});

await check("SCORM2004.declare() and .score() count too", async () => {
  assert.equal(hasTrackingSignal(bundle, "<script>SCORM2004.declare('a')</script>", ""), true);
  assert.equal(hasTrackingSignal(bundle, "<script>SCORM2004.score(1,0,2)</script>", ""), true);
});

await check("a CustomEvent name counts, in scorm: and dc: flavours", async () => {
  assert.equal(hasTrackingSignal(bundle, "<script>dispatchEvent(new CustomEvent('scorm:complete'))</script>", ""), true);
  assert.equal(hasTrackingSignal(bundle, "<script>dispatchEvent(new CustomEvent('dc:score'))</script>", ""), true);
});

await check("a signal hidden in a sibling .js file is found", async () => {
  await write("app.js", "export const step = () => window.SCORM2004.reach('step-1');");
  assert.equal(hasTrackingSignal(bundle, "<x-dc></x-dc>", "// dc runtime"), true);
  await write("app.js", "// nothing here");
});

await check("a mention in a non-script file (e.g. readme) does NOT count", async () => {
  const b = { ...bundle, files: [...bundle.files, "readme.md"] };
  await write("readme.md", "call window.SCORM2004.reach() to report progress");
  assert.equal(hasTrackingSignal(b, "<x-dc></x-dc>", "// dc runtime"), false);
});

console.log("2 — the warning reaches the caller:");

await check("packaging a signal-less .dc bundle warns about AUCUN SUIVI", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-pkg-"));
  await fs.writeFile(path.join(dir, "m.dc.html"),
    '<!DOCTYPE html><html><body><x-dc></x-dc><script type="text/x-dc">const a=1;</script>' +
    '<script src="./support.js"></script></body></html>');
  await fs.writeFile(path.join(dir, "support.js"), "// dc runtime, no scorm calls");
  const r = await buildPackage({ inputPath: dir, title: "Signal-less", language: "fr-FR" });
  assert.equal(r.format, "claude-design", "expected the .dc pipeline");
  assert.ok(r.warnings.some((w) => w.includes("AUCUN SUIVI")), "missing the AUCUN SUIVI warning");
  assert.ok(r.warnings.some((w) => w.includes("SCORM2004.reach")), "warning must say what to add");
});

await check("packaging a .dc bundle WITH a signal stays silent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-pkg-ok-"));
  await fs.writeFile(path.join(dir, "m.dc.html"),
    '<!DOCTYPE html><html><body><x-dc></x-dc><script type="text/x-dc">' +
    "window.SCORM2004.reach('etape-1');</script><script src=\"./support.js\"></script></body></html>");
  await fs.writeFile(path.join(dir, "support.js"), "// dc runtime");
  const r = await buildPackage({ inputPath: dir, title: "With signal", language: "fr-FR" });
  assert.equal(r.format, "claude-design");
  assert.ok(!r.warnings.some((w) => w.includes("AUCUN SUIVI")), "should not warn when a signal exists");
});

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
