// v1.3.0 feature contract (runs the REAL built package in jsdom):
//  1. SCORM2004.reach(id) on an UNDECLARED id declares it on the fly (counts in the total).
//  2. SCORM2004.declare(id) pre-registers a programmatic milestone (monotone reporting).
//  3. [data-scorm-success="on-completion"] => cmi.success_status = "passed" on completion.
//  3bis. Without opt-in, success_status is never written.
//  4. Resume: on-the-fly ids persisted in suspend_data are restored consistently
//     (in the total AND in reached — no false completion).
//  5. Converter: `language` is applied as <html lang> when the source has none.
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";
import { JSDOM } from "jsdom";

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log("  ✔ " + name); }
  else { failed++; console.log("  ✖ " + name + (extra ? " — " + extra : "")); }
}

function makeMockApi(initialCmi = {}) {
  const cmi = { ...initialCmi };
  return {
    cmi,
    api: {
      Initialize: () => "true",
      Terminate: () => "true",
      GetValue: (k) => (cmi[k] != null ? String(cmi[k]) : ""),
      SetValue: (k, v) => { cmi[k] = String(v); return "true"; },
      Commit: () => "true",
      GetLastError: () => "0", GetErrorString: () => "", GetDiagnostic: () => "",
    },
  };
}

async function buildIndex(html, opts = {}) {
  const res = await buildPackage({ html, title: opts.title || "Feat Test", language: opts.language });
  const zip = await JSZip.loadAsync(res.zip);
  return { indexHtml: await zip.file("index.html").async("string"), res };
}

function runSco(indexHtml, mock) {
  return new Promise((resolve) => {
    const dom = new JSDOM(indexHtml, {
      runScripts: "dangerously",
      beforeParse(window) {
        window.API_1484_11 = mock.api;
        // no IntersectionObserver on purpose for click-trigger tests
      },
    });
    dom.window.addEventListener("load", () => {
      // give the runtime's deferred start a tick
      setTimeout(() => resolve(dom.window), 30);
    });
  });
}

// ---------------------------------------------------------------- 1 + 2 + 3
{
  const { indexHtml } = await buildIndex(`<!DOCTYPE html><html><body data-scorm-success="on-completion">
    <button data-jalon="a" data-trigger="click">a</button>
    <button data-jalon="b" data-trigger="click">b</button>
  </body></html>`);
  const mock = makeMockApi();
  const w = await runSco(indexHtml, mock);
  const S = w.SCORM2004;

  console.log("1+2+3 — programmatic milestones + success opt-in:");
  S.reach("bonus"); // declared on the fly => total 3, reached 1
  check("reach(unknown) counts in progress (1/3)", Math.abs(S.progress() - 1 / 3) < 1e-6, "got " + S.progress());

  S.declare("c");   // total 4 => actual 0.25, reported must stay monotone
  check("declare(id) keeps reported progress monotone", S.progress() >= 1 / 3 - 1e-6, "got " + S.progress());

  S.reach("a"); S.reach("b"); S.reach("c");
  check("all reached => progress 1", S.progress() === 1, "got " + S.progress());
  check("completion_status completed", mock.cmi["cmi.completion_status"] === "completed", mock.cmi["cmi.completion_status"]);
  check("success_status passed (opt-in)", mock.cmi["cmi.success_status"] === "passed", mock.cmi["cmi.success_status"]);
}

// ---------------------------------------------------------------- 3bis
{
  const { indexHtml } = await buildIndex(`<!DOCTYPE html><html><body>
    <button data-jalon="only" data-trigger="click">x</button>
  </body></html>`);
  const mock = makeMockApi();
  const w = await runSco(indexHtml, mock);
  console.log("3bis — without opt-in, success_status untouched:");
  w.SCORM2004.reach("only");
  check("completed without success write",
    mock.cmi["cmi.completion_status"] === "completed" && mock.cmi["cmi.success_status"] == null,
    "success=" + mock.cmi["cmi.success_status"]);
}

// ---------------------------------------------------------------- 4
{
  const { indexHtml } = await buildIndex(`<!DOCTYPE html><html><body>
    <button data-jalon="a" data-trigger="click">a</button>
  </body></html>`);
  const mock = makeMockApi({ "cmi.suspend_data": JSON.stringify({ v: 1, reached: ["fly"] }) });
  const w = await runSco(indexHtml, mock);
  const S = w.SCORM2004;
  console.log("4 — resume restores on-the-fly ids consistently:");
  check("progress 0.5 after resume (not falsely completed)", Math.abs(S.progress() - 0.5) < 1e-6, "got " + S.progress());
  check("not completed yet", mock.cmi["cmi.completion_status"] !== "completed", mock.cmi["cmi.completion_status"]);
  S.reach("a");
  check("completes after reaching the declared one", mock.cmi["cmi.completion_status"] === "completed");
}

// ---------------------------------------------------------------- 5
{
  console.log("5 — converter applies language as <html lang>:");
  const { indexHtml } = await buildIndex(
    `<!DOCTYPE html><html><head><title>t</title></head><body><i data-jalon="a"></i></body></html>`,
    { language: "it-IT" });
  check('<html lang="it-IT"> injected', /<html[^>]*lang="it-IT"/.test(indexHtml));

  const { indexHtml: keep } = await buildIndex(
    `<!DOCTYPE html><html lang="de"><body><i data-jalon="a"></i></body></html>`,
    { language: "fr-FR" });
  check("existing lang preserved", /<html[^>]*lang="de"/.test(keep));
}

console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
