// v1.4.0 contract — automatic milestones + success_on_completion option:
//  1. HTML with sections and NO data-jalon => milestones auto-generated (one per section).
//  2. Explicit data-jalon always wins (no auto-tagging).
//  3. autoMilestones:false => no milestones + legacy "no milestone" warning.
//  4. Many sections => capped at 8.
//  5. No sections => falls back to h2 headings.
//  6. successOnCompletion:true => data-scorm-success added on <body>.
//  7. Author's own data-scorm-success is never overridden.
//  8. Nothing taggable => no milestones, legacy warning (auto stays false).
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log("  ✔ " + name); }
  else { failed++; console.log("  ✖ " + name + (extra ? " — " + extra : "")); }
}
async function indexOf(res) {
  const zip = await JSZip.loadAsync(res.zip);
  return zip.file("index.html").async("string");
}
const sec = (n) => Array.from({ length: n }, (_, i) => `<section><h2>Partie ${i + 1}</h2><p>contenu</p></section>`).join("");

console.log("1 — auto milestones from sections:");
{
  const res = await buildPackage({ html: `<!DOCTYPE html><html><body>${sec(6)}</body></html>`, title: "Auto 6" });
  check("6 milestones generated", res.milestoneCount === 6, "got " + res.milestoneCount);
  check("milestonesAuto === true", res.milestonesAuto === true);
  check("ids are etape-1..6", JSON.stringify(res.milestoneIds) === JSON.stringify(["etape-1","etape-2","etape-3","etape-4","etape-5","etape-6"]), JSON.stringify(res.milestoneIds));
  check("no 'no milestone' warning", !res.warnings.some(w => w.includes("Aucun jalon")), JSON.stringify(res.warnings));
}

console.log("2 — explicit data-jalon wins:");
{
  const res = await buildPackage({
    html: `<!DOCTYPE html><html><body><section data-jalon="mine" data-trigger="click">x</section>${sec(4)}</body></html>`,
    title: "Explicit",
  });
  check("only the declared milestone", res.milestoneCount === 1 && res.milestoneIds[0] === "mine", JSON.stringify(res.milestoneIds));
  check("milestonesAuto === false", res.milestonesAuto === false);
}

console.log("3 — autoMilestones disabled:");
{
  const res = await buildPackage({ html: `<!DOCTYPE html><html><body>${sec(4)}</body></html>`, title: "Off", autoMilestones: false });
  check("0 milestones", res.milestoneCount === 0, "got " + res.milestoneCount);
  check("legacy warning present", res.warnings.some(w => w.includes("Aucun jalon")), JSON.stringify(res.warnings));
}

console.log("4 — capped at 8:");
{
  const res = await buildPackage({ html: `<!DOCTYPE html><html><body>${sec(20)}</body></html>`, title: "Cap" });
  check("capped to 8", res.milestoneCount === 8, "got " + res.milestoneCount);
}

console.log("5 — h2 fallback when no sections:");
{
  const res = await buildPackage({
    html: `<!DOCTYPE html><html><body><div><h2>A</h2><p>x</p><h2>B</h2><p>y</p><h2>C</h2><p>z</p></div></body></html>`,
    title: "H2",
  });
  check("3 milestones from h2", res.milestoneCount === 3 && res.milestonesAuto === true, "got " + res.milestoneCount);
}

console.log("6 — successOnCompletion adds the body attribute:");
{
  const res = await buildPackage({ html: `<!DOCTYPE html><html><body>${sec(3)}</body></html>`, title: "Succ", successOnCompletion: true });
  const out = await indexOf(res);
  check("data-scorm-success on body", /<body[^>]*data-scorm-success="on-completion"/.test(out));
}

console.log("7 — author's data-scorm-success preserved:");
{
  const res = await buildPackage({
    html: `<!DOCTYPE html><html><body><div data-scorm-success="true">${sec(3)}</div></body></html>`,
    title: "Keep", successOnCompletion: true,
  });
  const out = await indexOf(res);
  check("author value untouched", out.includes('data-scorm-success="true"') && !/<body[^>]*data-scorm-success/.test(out));
}

console.log("8 — nothing taggable:");
{
  const res = await buildPackage({ html: `<!DOCTYPE html><html><body><p>juste un paragraphe</p></body></html>`, title: "Bare" });
  check("0 milestones + warning", res.milestoneCount === 0 && res.milestonesAuto === false && res.warnings.some(w => w.includes("Aucun jalon")), JSON.stringify(res.warnings));
}

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
