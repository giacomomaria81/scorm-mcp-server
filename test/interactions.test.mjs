/**
 * cmi.interactions test suite (v2.3) — question-level tracking.
 *
 * Three layers:
 *   1. Runtime API (SCORM 2004 mock): window.SCORM2004.interaction() and the
 *      scorm:interaction CustomEvent write a complete cmi.interactions.n.*
 *      record (id, type, learner_response, correct pattern, result,
 *      description, timestamp, latency) with sequential indexes, resuming
 *      after an existing _count.
 *   2. Runtime API (SCORM 1.2 mock): dialect-correct element names
 *      (student_response, time) and vocabulary ("wrong" instead of
 *      "incorrect"); no 2004-only elements are ever written.
 *   3. End to end: a migrated mobile-learning quiz page, played in jsdom by
 *      clicking answers, reports one interaction per question with the right
 *      result — and a bogus LMS that refuses interaction writes does not break
 *      the quiz (best-effort contract).
 */
import { buildPackage } from "../dist/converter.js";
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✗ FAIL: " + label + (detail !== undefined ? " — " + detail : "")); }
};

// -- mocks -------------------------------------------------------------------

function mock2004(initial = {}) {
  const cmi = { ...initial };
  const calls = [];
  return {
    cmi, calls,
    api: {
      Initialize: () => "true",
      Terminate: () => "true",
      GetValue: (k) => (cmi[k] != null ? String(cmi[k]) : ""),
      SetValue: (k, v) => { calls.push([k, v]); cmi[k] = v; return "true"; },
      Commit: () => "true",
      GetLastError: () => "0", GetErrorString: () => "", GetDiagnostic: () => "",
    },
  };
}

function mock12(opts = {}) {
  const cmi = {};
  const calls = [];
  return {
    cmi, calls,
    api: {
      LMSInitialize: () => "true",
      LMSFinish: () => "true",
      LMSGetValue: (k) => (cmi[k] != null ? String(cmi[k]) : ""),
      LMSSetValue: (k, v) => {
        if (opts.refuseInteractions && k.startsWith("cmi.interactions.")) { return "false"; }
        calls.push([k, v]); cmi[k] = v; return "true";
      },
      LMSCommit: () => "true",
      LMSGetLastError: () => "0", LMSGetErrorString: () => "", LMSGetDiagnostic: () => "",
    },
  };
}

function installIO(window) {
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { this.cb([{ isIntersecting: true, target: el }], this); }
    unobserve() {} disconnect() {}
  };
}

function runDom(html, { api2004, api12 } = {}) {
  return new Promise((resolve) => {
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(window) {
        if (api2004) { window.API_1484_11 = api2004; }
        if (api12) { window.API = api12; }
        installIO(window);
      },
    });
    const w = dom.window;
    w.addEventListener("load", () => { setTimeout(() => resolve({ window: w }), 40); });
  });
}

const wrote = (calls, key) => calls.find(([k]) => k === key);

const PLAIN = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>I</title></head>
<body><section data-jalon="s1"><h2>One</h2></section></body></html>`;

// -- 1. runtime API against a 2004 mock --------------------------------------

console.log("1 — window.SCORM2004.interaction() writes a full 2004 record:");
{
  const r = await buildPackage({ html: PLAIN, title: "Interactions 2004" });
  const zip = await JSZip.loadAsync(r.zip);
  const html = await zip.file("index.html").async("string");
  const m = mock2004();
  const { window } = await runDom(html, { api2004: m.api });
  window.SCORM2004.interaction({
    id: "sec-1 q1 (weird id!)",
    type: "choice",
    description: "Which colour?",
    learnerResponse: "Blue",
    correctResponse: "Red",
    result: false,
    latencyMs: 65_000,
    weighting: 1,
  });
  check("id written and sanitised", m.cmi["cmi.interactions.0.id"] === "sec-1_q1__weird_id__", m.cmi["cmi.interactions.0.id"]);
  check("type=choice", m.cmi["cmi.interactions.0.type"] === "choice");
  check("learner_response (2004 name)", m.cmi["cmi.interactions.0.learner_response"] === "Blue");
  check("correct_responses.0.pattern", m.cmi["cmi.interactions.0.correct_responses.0.pattern"] === "Red");
  check("result=incorrect (2004 vocabulary)", m.cmi["cmi.interactions.0.result"] === "incorrect");
  check("description written", m.cmi["cmi.interactions.0.description"] === "Which colour?");
  check("timestamp is ISO-ish", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(m.cmi["cmi.interactions.0.timestamp"] ?? ""), m.cmi["cmi.interactions.0.timestamp"]);
  check("latency ISO 8601 duration", m.cmi["cmi.interactions.0.latency"] === "PT65S", m.cmi["cmi.interactions.0.latency"]);
  check("weighting written", m.cmi["cmi.interactions.0.weighting"] === "1");

  window.SCORM2004.interaction({ id: "q2", result: true });
  check("second interaction gets index 1", m.cmi["cmi.interactions.1.id"] === "q2");
  check("result=correct", m.cmi["cmi.interactions.1.result"] === "correct");

  window.dispatchEvent(new window.CustomEvent("scorm:interaction", {
    detail: { id: "q3", type: "true-false", learnerResponse: "true", result: "neutral" },
  }));
  check("scorm:interaction event → index 2", m.cmi["cmi.interactions.2.id"] === "q3");
  check("string result passed through", m.cmi["cmi.interactions.2.result"] === "neutral");
  check("no student_response (1.2 name) ever written", !wrote(m.calls, "cmi.interactions.0.student_response"));
}

console.log("2 — resumes numbering after an existing cmi.interactions._count:");
{
  const r = await buildPackage({ html: PLAIN, title: "Interactions resume" });
  const zip = await JSZip.loadAsync(r.zip);
  const html = await zip.file("index.html").async("string");
  const m = mock2004({ "cmi.interactions._count": "3" });
  const { window } = await runDom(html, { api2004: m.api });
  window.SCORM2004.interaction({ id: "after-resume", result: true });
  check("first new interaction lands at index 3", m.cmi["cmi.interactions.3.id"] === "after-resume", JSON.stringify(Object.keys(m.cmi).filter((k) => k.includes("interactions"))));
}

// -- 3. SCORM 1.2 dialect ----------------------------------------------------

console.log("3 — SCORM 1.2 dialect: element names and vocabulary:");
{
  const r = await buildPackage({ html: PLAIN, title: "Interactions 12", scormVersion: "1.2" });
  const zip = await JSZip.loadAsync(r.zip);
  const html = await zip.file("index.html").async("string");
  const m = mock12();
  const { window } = await runDom(html, { api12: m.api });
  window.SCORM2004.interaction({ id: "q1", learnerResponse: "Paris", correctResponse: "Rome", result: false, latencyMs: 61_000 });
  check("student_response (1.2 name)", m.cmi["cmi.interactions.0.student_response"] === "Paris");
  check("result=wrong (1.2 vocabulary)", m.cmi["cmi.interactions.0.result"] === "wrong");
  check("time HH:MM:SS (1.2 name)", /^\d{2}:\d{2}:\d{2}$/.test(m.cmi["cmi.interactions.0.time"] ?? ""), m.cmi["cmi.interactions.0.time"]);
  check("latency HH:MM:SS", m.cmi["cmi.interactions.0.latency"] === "00:01:01", m.cmi["cmi.interactions.0.latency"]);
  check("no learner_response (2004 name) ever written", !wrote(m.calls, "cmi.interactions.0.learner_response"));
  check("no description (2004-only) ever written", !wrote(m.calls, "cmi.interactions.0.description"));
  check("no timestamp (2004-only) ever written", !wrote(m.calls, "cmi.interactions.0.timestamp"));
}

// -- 4. end to end: migrated quiz clicks report interactions ------------------

console.log("4 — migrated mobile-learning quiz reports one interaction per answered question:");
{
  // Reuse the packaged TOM fixture already exercised by tom.test.mjs — build a
  // minimal quiz page through the real pipeline instead of duplicating the
  // OOXML generator: a plain HTML page with the SAME quiz markup + script the
  // migration emits, obtained by generating it from the real module.
  const { renderTomCourseHtml } = await import("../dist/tom.js");
  const course = {
    title: "Quiz E2E",
    language: "en",
    activities: [{
      title: "Final quiz", type: "quiz-game", intro: "",
      cards: [
        { kind: "quiz", q: { question: "What is 2 + 2?", answers: [{ text: "4", correct: true }, { text: "3", correct: false }], correction: "" } },
        { kind: "quiz", q: { question: "Capital of France?", answers: [{ text: "Paris", correct: true }, { text: "Rome", correct: false }], correction: "" } },
      ],
    }],
  };
  const pageHtml = renderTomCourseHtml(course, new Map(), []);
  const r = await buildPackage({ html: pageHtml, title: "Quiz E2E" });
  const zip = await JSZip.loadAsync(r.zip);
  const html = await zip.file("index.html").async("string");
  const m = mock2004();
  const { window } = await runDom(html, { api2004: m.api });
  const doc = window.document;
  const quizzes = doc.querySelectorAll("[data-quiz]");
  check("two quiz cards rendered", quizzes.length === 2, quizzes.length);
  // answer Q1 wrong, Q2 right
  const q1wrong = quizzes[0].querySelector('[data-answer][data-correct="0"]');
  const q2right = quizzes[1].querySelector('[data-answer][data-correct="1"]');
  q1wrong.click();
  q2right.click();
  await new Promise((res) => setTimeout(res, 30));
  check("interaction 0 recorded", typeof m.cmi["cmi.interactions.0.id"] === "string", m.cmi["cmi.interactions.0.id"]);
  check("interaction 0 result=incorrect", m.cmi["cmi.interactions.0.result"] === "incorrect");
  check("interaction 0 learner_response is the clicked answer", m.cmi["cmi.interactions.0.learner_response"] === q1wrong.textContent.trim(), m.cmi["cmi.interactions.0.learner_response"]);
  check("interaction 0 correct pattern is the right answer", m.cmi["cmi.interactions.0.correct_responses.0.pattern"] === "4");
  check("interaction 0 description = question text", m.cmi["cmi.interactions.0.description"] === "What is 2 + 2?", m.cmi["cmi.interactions.0.description"]);
  check("interaction 1 result=correct", m.cmi["cmi.interactions.1.result"] === "correct");
  check("score still reported after quiz completion", m.cmi["cmi.score.raw"] === "1" && m.cmi["cmi.score.max"] === "2",
    JSON.stringify({ raw: m.cmi["cmi.score.raw"], max: m.cmi["cmi.score.max"] }));
}

console.log("5 — an LMS that refuses interaction writes does not break the quiz:");
{
  const { renderTomCourseHtml } = await import("../dist/tom.js");
  const course = {
    title: "Refusal", language: "en",
    activities: [{ title: "Q", type: "quiz-game", intro: "", cards: [
      { kind: "quiz", q: { question: "1+1?", answers: [{ text: "2", correct: true }, { text: "5", correct: false }], correction: "" } },
    ] }],
  };
  const pageHtml = renderTomCourseHtml(course, new Map(), []);
  const r = await buildPackage({ html: pageHtml, title: "Refusal", scormVersion: "1.2" });
  const zip = await JSZip.loadAsync(r.zip);
  const html = await zip.file("index.html").async("string");
  const m = mock12({ refuseInteractions: true });
  const { window } = await runDom(html, { api12: m.api });
  window.document.querySelector('[data-answer][data-correct="1"]').click();
  await new Promise((res) => setTimeout(res, 30));
  check("no interaction stored (refused)", !Object.keys(m.cmi).some((k) => k.startsWith("cmi.interactions.")));
  check("quiz still marks itself done", window.document.querySelector("[data-quiz]").getAttribute("data-done") === "correct");
  check("score still reported (1.2 percentage)", m.cmi["cmi.core.score.raw"] === "100", m.cmi["cmi.core.score.raw"]);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ix-"));
await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log("\nINTERACTIONS: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
