/**
 * Teach on Mars export → HTML course bundle.
 *
 * A Teach on Mars "content export" is a zip (or folder) of Excel templates —
 * one .xlsx per activity, named "Course - Activity - LANG.xlsx" — plus a
 * media/ folder. There is no HTML inside. This module turns that export into
 * a self-contained interactive HTML course that the regular SCORM pipeline
 * (bundle path of buildPackage) can then wrap.
 *
 * Template structure (documented in the TOM Help Center):
 *   - every template has 3 tabs: Instructions / Configuration / Cards
 *   - Mobile Course "Cards": column A = card type (Info | Transition | Quiz | Flash)
 *       Info:       B front title, E front text
 *       Transition: E text
 *       Quiz:       Q question, T media, U correct, X + AA incorrect, AD correction
 *       Flash:      B front title, E front text, H button, K back title, N back text
 *   - Quiz Game "Cards": A question, D media, E correct, H/K/N incorrect,
 *       Q correction, T web link. Configuration: D10 intro title, D11 intro text.
 *   - text cells may embed media/layout codes: [media:file.ext,opt|label],
 *       [H1:..]..[H4:..], [quote:text|author], !!highlight, >><< centre, >>>> right.
 *
 * Parsing is deliberately tolerant: an unrecognised sheet degrades to plain
 * content cards with a warning, never to a hard failure.
 */
import JSZip from "jszip";
function xmlDecode(s) {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function textOf(xmlFragment) {
    // concatenate every <t> run (rich text = several <r><t> runs)
    let out = "";
    const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
    let m;
    while ((m = re.exec(xmlFragment))) {
        out += xmlDecode(m[1]);
    }
    return out;
}
function attr(attrs, name) {
    const m = attrs.match(new RegExp("(?:^|\\s)(?:\\w+:)?" + name + "=\"([^\"]*)\""));
    return m ? m[1] : null;
}
/** Parse one worksheet XML into a cell map. */
function parseSheetXml(xml, shared) {
    const cells = new Map();
    const re = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let m;
    while ((m = re.exec(xml))) {
        const ref = attr(m[1], "r");
        if (!ref) {
            continue;
        }
        const t = attr(m[1], "t") ?? "n";
        const body = m[2] ?? "";
        let value = "";
        if (t === "inlineStr") {
            value = textOf(body);
        }
        else {
            const v = body.match(/<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/);
            if (!v) {
                continue;
            }
            const rawV = xmlDecode(v[1]);
            if (t === "s") {
                const idx = parseInt(rawV, 10);
                value = Number.isInteger(idx) && shared[idx] !== undefined ? shared[idx] : "";
            }
            else if (t === "b") {
                value = rawV === "1" ? "true" : "false";
            }
            else {
                value = rawV; // n / str
            }
        }
        const trimmed = value.trim();
        if (trimmed !== "") {
            cells.set(ref.toUpperCase(), trimmed);
        }
    }
    return cells;
}
/** Read an .xlsx buffer into named sheets of cell maps. */
export async function readXlsx(buf) {
    const zip = await JSZip.loadAsync(buf);
    const get = async (p) => {
        const f = zip.file(p) ?? zip.file(p.replace(/^\//, ""));
        return f ? f.async("string") : null;
    };
    const wbXml = await get("xl/workbook.xml");
    if (!wbXml) {
        throw new Error("xlsx: xl/workbook.xml missing");
    }
    const relsXml = (await get("xl/_rels/workbook.xml.rels")) ?? "";
    const ssXml = await get("xl/sharedStrings.xml");
    const shared = [];
    if (ssXml) {
        const re = /<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g;
        let m;
        while ((m = re.exec(ssXml))) {
            shared.push(textOf(m[1]));
        }
    }
    const rels = new Map();
    {
        const re = /<Relationship\b([^>]*)\/?>/g;
        let m;
        while ((m = re.exec(relsXml))) {
            const id = attr(m[1], "Id");
            const target = attr(m[1], "Target");
            if (id && target) {
                rels.set(id, target.replace(/^\//, "").replace(/^(?!xl\/)/, "xl/"));
            }
        }
    }
    const sheets = [];
    {
        const re = /<(?:\w+:)?sheet\b([^>]*)\/?>/g;
        let m;
        let fallbackIndex = 1;
        while ((m = re.exec(wbXml))) {
            const name = attr(m[1], "name") ?? `Sheet${fallbackIndex}`;
            const rid = attr(m[1], "id"); // matches r:id via prefix-tolerant attr()
            let target = rid ? rels.get(rid) : undefined;
            if (!target) {
                target = `xl/worksheets/sheet${fallbackIndex}.xml`;
            }
            const xml = await get(target);
            if (xml !== null) {
                sheets.push({ name, cells: parseSheetXml(xml, shared) });
            }
            fallbackIndex++;
        }
    }
    return { sheets };
}
const COL = (letters) => {
    let n = 0;
    for (const ch of letters) {
        n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
};
function cellRowCol(ref) {
    const m = ref.match(/^([A-Z]+)(\d+)$/);
    return m ? { row: parseInt(m[2], 10), col: COL(m[1]) } : null;
}
/** rows as sparse arrays indexed by column, 1-based row keys preserved. */
function sheetRows(cells) {
    const rows = new Map();
    for (const [ref, val] of cells) {
        const rc = cellRowCol(ref);
        if (!rc) {
            continue;
        }
        let row = rows.get(rc.row);
        if (!row) {
            row = new Map();
            rows.set(rc.row, row);
        }
        row.set(rc.col, val);
    }
    return rows;
}
const norm = (s) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const CARD_TYPES = new Set(["info", "transition", "quiz", "flash"]);
const HEADER_WORDS = new Set(["type", "card type", "type de carte", "question", "questions", "statement"]);
function findSheet(wb, patterns, fallbackIndex) {
    for (const p of patterns) {
        const s = wb.sheets.find((sh) => p.test(norm(sh.name)));
        if (s) {
            return s.cells;
        }
    }
    if (fallbackIndex !== null && wb.sheets[fallbackIndex]) {
        return wb.sheets[fallbackIndex].cells;
    }
    return null;
}
/** Parse the file name "Course - Activity - EN.xlsx" (tolerant). */
export function parseTomName(base) {
    const stem = base.replace(/\.xlsx$/i, "");
    const parts = stem.split(/\s+-\s+/);
    if (parts.length === 1) {
        return { activity: stem };
    }
    let language;
    if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[parts.length - 1])) {
        language = parts.pop().toLowerCase();
    }
    const activity = parts.pop();
    const course = parts.length ? parts.join(" - ") : undefined;
    return { course, activity, language };
}
/** Parse one activity workbook into the model. */
export function parseTomActivity(wb, name, warnings) {
    const meta = parseTomName(name);
    const title = meta.activity || name.replace(/\.xlsx$/i, "");
    const cards = findSheet(wb, [/^cards?$/, /^cartes?$/], wb.sheets.length > 2 ? 2 : wb.sheets.length - 1);
    const config = findSheet(wb, [/^configuration$/, /^config/], wb.sheets.length > 1 ? 1 : null);
    const act = { title, type: "content", cards: [] };
    if (config) {
        // Quiz Game: D10/D11 intro; Mobile Course: D4/D5 conclusion. Read loosely.
        act.introTitle = config.get("D10") ?? undefined;
        act.introText = config.get("D11") ?? undefined;
    }
    if (!cards) {
        warnings.push(`TOM: "${name}" has no Cards sheet - activity skipped.`);
        return act;
    }
    const rows = sheetRows(cards);
    const sorted = [...rows.keys()].sort((a, b) => a - b);
    // ---- detection --------------------------------------------------------
    let mcVotes = 0, qgVotes = 0, considered = 0;
    for (const r of sorted) {
        const row = rows.get(r);
        const a = norm(row.get(COL("A")));
        if (!a || HEADER_WORDS.has(a)) {
            continue;
        }
        considered++;
        if (CARD_TYPES.has(a)) {
            mcVotes++;
        }
        else if (row.get(COL("E")) && (row.get(COL("H")) || row.get(COL("K")))) {
            qgVotes++;
        }
    }
    if (considered > 0 && mcVotes >= Math.max(1, considered / 2)) {
        act.type = "mobile-course";
        for (const r of sorted) {
            const row = rows.get(r);
            const kind = norm(row.get(COL("A")));
            if (!CARD_TYPES.has(kind)) {
                continue;
            }
            if (kind === "info") {
                const text = row.get(COL("E")) ?? "";
                if (text || row.get(COL("B"))) {
                    act.cards.push({ kind: "info", title: row.get(COL("B")), text });
                }
            }
            else if (kind === "transition") {
                const text = row.get(COL("E")) ?? "";
                if (text) {
                    act.cards.push({ kind: "transition", text });
                }
            }
            else if (kind === "flash") {
                act.cards.push({
                    kind: "flash",
                    frontTitle: row.get(COL("B")), front: row.get(COL("E")) ?? "",
                    button: row.get(COL("H")), backTitle: row.get(COL("K")), back: row.get(COL("N")) ?? "",
                });
            }
            else { // quiz card inside a Mobile Course
                const q = {
                    question: row.get(COL("Q")) ?? "", media: row.get(COL("T")),
                    answers: [], correction: row.get(COL("AD")),
                };
                const ans = (colLetters, correct) => {
                    const t = row.get(COL(colLetters));
                    if (t) {
                        q.answers.push({ text: t, correct });
                    }
                };
                ans("U", true);
                ans("X", false);
                ans("AA", false);
                if (q.question && q.answers.length >= 2) {
                    act.cards.push({ kind: "quiz", q });
                }
            }
        }
    }
    else if (qgVotes > 0) {
        act.type = "quiz-game";
        for (const r of sorted) {
            const row = rows.get(r);
            const question = row.get(COL("A"));
            if (!question || HEADER_WORDS.has(norm(question))) {
                continue;
            }
            const q = {
                question, media: row.get(COL("D")),
                answers: [], correction: row.get(COL("Q")),
            };
            const ans = (colLetters, correct) => {
                const t = row.get(COL(colLetters));
                if (t && !/^(answer|reponse)\b/.test(norm(t))) {
                    q.answers.push({ text: t, correct });
                }
            };
            ans("E", true);
            ans("H", false);
            ans("K", false);
            ans("N", false);
            if (q.answers.length >= 2) {
                act.cards.push({ kind: "quiz", q });
            }
        }
    }
    else {
        // generic fallback: keep every text cell as content, row by row
        warnings.push(`TOM: "${name}" does not match a known template - imported as plain content.`);
        for (const r of sorted) {
            const row = rows.get(r);
            const parts = [...row.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v);
            const text = parts.join(" - ");
            if (text && !HEADER_WORDS.has(norm(parts[0]))) {
                act.cards.push({ kind: "info", text });
            }
        }
    }
    if (act.cards.length === 0) {
        warnings.push(`TOM: "${name}" produced no cards (empty or example-only template).`);
    }
    return act;
}
// --------------------------------------------------------------------------
// TOM text codes → HTML
// --------------------------------------------------------------------------
function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** Resolve a media file name against the export's file list (case-insensitive basename). */
function mediaHref(name, mediaIndex) {
    const key = name.trim().toLowerCase().split("/").pop() ?? "";
    return mediaIndex.get(key) ?? null;
}
function renderMedia(name, opts, label, mediaIndex, warnings) {
    const href = mediaHref(name, mediaIndex);
    if (!href) {
        warnings.push(`TOM: media "${name}" referenced but not found in the export - placeholder inserted.`);
        return `<p class="media-missing">[missing media: ${escapeHtml(name)}]</p>`;
    }
    const h = escapeHtml(href);
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
        const cls = opts && /full/i.test(opts) ? "media-img full" : "media-img";
        return `<img class="${cls}" src="${h}" alt="">`;
    }
    if (ext === "mp4") {
        return `<video class="media-video" src="${h}" controls playsinline></video>`;
    }
    if (ext === "mp3") {
        return `<audio class="media-audio" src="${h}" controls></audio>`;
    }
    if (ext === "pdf") {
        return `<p><a class="media-pdf" href="${h}" target="_blank" rel="noopener">${escapeHtml(label || "Open document")}</a></p>`;
    }
    return `<p><a href="${h}" target="_blank" rel="noopener">${escapeHtml(label || name)}</a></p>`;
}
/** Convert one text cell (with TOM codes) to safe HTML. */
export function tomTextToHtml(text, mediaIndex, warnings) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (const rawLine of lines) {
        let line = rawLine.trim();
        if (!line) {
            continue;
        }
        // whole-line media / quote codes
        const media = line.match(/^\[media:([^,\]|]+)(?:,([^\]|]+))?(?:\|([^\]]+))?\]$/i);
        if (media) {
            out.push(renderMedia(media[1], media[2], media[3], mediaIndex, warnings));
            continue;
        }
        const quote = line.match(/^\[quote:([^\]|]+)(?:\|([^\]]+))?\]$/i);
        if (quote) {
            out.push(`<blockquote>${escapeHtml(quote[1].trim())}${quote[2] ? `<cite>${escapeHtml(quote[2].trim())}</cite>` : ""}</blockquote>`);
            continue;
        }
        const heading = line.match(/^\[H([1-4]):([\s\S]+)\]$/i);
        if (heading) {
            const level = Math.min(6, parseInt(heading[1], 10) + 2); // H1 code -> h3 in page hierarchy
            let inner = heading[2].trim();
            let cls = "";
            if (inner.startsWith(">><<")) {
                cls = " class=\"center\"";
                inner = inner.slice(4).trim();
            }
            out.push(`<h${level}${cls}>${escapeHtml(inner)}</h${level}>`);
            continue;
        }
        // alignment / highlight prefixes
        let cls = "";
        if (line.startsWith(">><<")) {
            cls = "center";
            line = line.slice(4).trim();
        }
        else if (line.startsWith(">>>>")) {
            cls = "right";
            line = line.slice(4).trim();
        }
        else if (line.startsWith("<<<<")) {
            cls = "left";
            line = line.slice(4).trim();
        }
        else if (line.startsWith("!!")) {
            cls = "highlight";
            line = line.slice(2).trim();
        }
        // inline [media:...] inside a sentence
        let html = escapeHtml(line);
        html = html.replace(/\[media:([^,\]|]+)(?:,([^\]|]+))?(?:\|([^\]]+))?\]/gi, (_m, n, o, l) => renderMedia(xmlDecode(n), o, l ? xmlDecode(l) : undefined, mediaIndex, warnings));
        // [training:...] has no meaning outside the TOM app
        html = html.replace(/\[training:[^\]]+\]/gi, "");
        out.push(cls ? `<p class="${cls}">${html}</p>` : `<p>${html}</p>`);
    }
    return out.join("\n");
}
// --------------------------------------------------------------------------
// Course HTML generation
// --------------------------------------------------------------------------
export function renderTomCourseHtml(course, mediaIndex) {
    const w = course.warnings;
    const sections = [];
    let quizCount = 0;
    course.activities.forEach((act, ai) => {
        const secId = `tom-act-${ai + 1}`;
        const parts = [];
        parts.push(`<header class="act-head"><p class="act-kicker">${escapeHtml(actLabel(act.type))}</p><h2>${escapeHtml(act.title)}</h2>`);
        if (act.introTitle || act.introText) {
            parts.push(`<div class="intro">${act.introTitle ? `<h3>${escapeHtml(act.introTitle)}</h3>` : ""}${act.introText ? tomTextToHtml(act.introText, mediaIndex, w) : ""}</div>`);
        }
        parts.push("</header>");
        for (const card of act.cards) {
            if (card.kind === "info") {
                parts.push(`<article class="card info">${card.title ? `<h3>${escapeHtml(card.title)}</h3>` : ""}${tomTextToHtml(card.text, mediaIndex, w)}</article>`);
            }
            else if (card.kind === "transition") {
                parts.push(`<div class="card transition"><p>${escapeHtml(card.text)}</p></div>`);
            }
            else if (card.kind === "flash") {
                parts.push(`<article class="card flash" data-flash>` +
                    `<div class="flash-front"><h3>${escapeHtml(card.frontTitle ?? "")}</h3>${tomTextToHtml(card.front, mediaIndex, w)}` +
                    `<button type="button" class="flash-btn" data-flash-btn>${escapeHtml(card.button || "See the solution")}</button></div>` +
                    `<div class="flash-back" hidden><h3>${escapeHtml(card.backTitle ?? "")}</h3>${tomTextToHtml(card.back, mediaIndex, w)}</div>` +
                    `</article>`);
            }
            else {
                quizCount++;
                const q = card.q;
                const answers = shuffleDeterministic(q.answers, quizCount)
                    .map((a) => `<button type="button" class="answer" data-answer data-correct="${a.correct ? "1" : "0"}">${escapeHtml(a.text)}</button>`)
                    .join("");
                parts.push(`<article class="card quiz" data-quiz>` +
                    (q.media ? renderMedia(q.media, undefined, undefined, mediaIndex, w) : "") +
                    `<h3 class="question">${escapeHtml(q.question)}</h3>` +
                    `<div class="answers">${answers}</div>` +
                    (q.correction ? `<div class="correction" hidden>${tomTextToHtml(q.correction, mediaIndex, w)}</div>` : `<div class="correction" hidden></div>`) +
                    `</article>`);
            }
        }
        // non-scored sections auto-reach on scroll via data-jalon; quiz sections
        // are declared/reached from the quiz script instead.
        const hasQuiz = act.cards.some((c) => c.kind === "quiz");
        sections.push(`<section id="${secId}"${hasQuiz ? "" : ` data-jalon="${secId}" data-title="${escapeHtml(act.title)}"`} data-has-quiz="${hasQuiz ? "1" : "0"}">${parts.join("\n")}</section>`);
    });
    return `<!doctype html>
<html lang="${escapeHtml(course.language ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(course.title)}</title>
<style>
  :root { --ink: #1d1d1f; --muted: #6e6e73; --bg: #f5f5f7; --card: #ffffff; --accent: #0066cc; --ok: #1a7f37; --ko: #b3261e; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--ink); line-height: 1.55; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 96px; }
  h1 { font-size: 34px; letter-spacing: -0.02em; margin: 8px 0 4px; }
  .course-sub { color: var(--muted); margin: 0 0 28px; }
  section { margin: 40px 0; }
  .act-kicker { text-transform: uppercase; font-size: 12px; letter-spacing: 0.08em; color: var(--accent); margin: 0 0 2px; font-weight: 600; }
  .act-head h2 { font-size: 24px; margin: 0 0 12px; letter-spacing: -0.01em; }
  .intro { color: var(--muted); }
  .card { background: var(--card); border-radius: 14px; padding: 20px 22px; margin: 14px 0; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .card h3 { margin: 0 0 8px; font-size: 17px; }
  .card p { margin: 8px 0; }
  .transition { background: transparent; box-shadow: none; text-align: center; color: var(--muted); font-style: italic; padding: 8px; }
  .center { text-align: center; } .right { text-align: right; } .left { text-align: left; }
  .highlight { background: #fff8e1; border-left: 3px solid #f2b21c; padding: 8px 12px; border-radius: 6px; }
  blockquote { margin: 12px 0; padding: 10px 16px; border-left: 3px solid var(--accent); color: var(--muted); }
  blockquote cite { display: block; margin-top: 6px; font-size: 13px; }
  .media-img { max-width: 100%; border-radius: 10px; display: block; margin: 10px auto; }
  .media-video, .media-audio { width: 100%; margin: 10px 0; border-radius: 10px; }
  .media-missing { color: var(--ko); font-size: 13px; }
  .answers { display: grid; gap: 8px; margin: 12px 0 4px; }
  .answer { font: inherit; text-align: left; padding: 12px 14px; border-radius: 10px; border: 1px solid #d2d2d7; background: #fbfbfd; cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease; }
  .answer:hover { border-color: var(--accent); }
  .answer.ok { border-color: var(--ok); background: #e9f6ee; font-weight: 600; }
  .answer.ko { border-color: var(--ko); background: #fdecea; }
  .answer[disabled] { cursor: default; opacity: 0.9; }
  .correction { margin-top: 10px; padding: 10px 14px; background: #f0f6ff; border-radius: 10px; font-size: 14px; }
  .flash-btn { font: inherit; margin-top: 8px; padding: 9px 16px; border-radius: 999px; border: none; background: var(--accent); color: #fff; cursor: pointer; }
  .flash-btn:hover { filter: brightness(1.07); }
  .score-banner { position: sticky; bottom: 16px; margin-top: 40px; background: var(--ink); color: #fff; padding: 14px 20px; border-radius: 12px; display: none; justify-content: space-between; align-items: center; }
  .score-banner.on { display: flex; }
  footer { color: var(--muted); font-size: 12px; margin-top: 48px; text-align: center; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(course.title)}</h1>
  <p class="course-sub">${course.activities.length} ${course.activities.length > 1 ? "activities" : "activity"}${quizCount ? ` - ${quizCount} scored ${quizCount > 1 ? "questions" : "question"}` : ""}</p>
  ${sections.join("\n")}
  <div class="score-banner" id="score-banner"><span id="score-text"></span></div>
  <footer>Converted from a Teach on Mars content export.</footer>
</main>
<script>
(function () {
  "use strict";
  function api() { return window.SCORM2004 || null; }

  // flash cards ------------------------------------------------------------
  var flashes = document.querySelectorAll("[data-flash]");
  for (var i = 0; i < flashes.length; i++) {
    (function (card) {
      var btn = card.querySelector("[data-flash-btn]");
      if (!btn) { return; }
      btn.addEventListener("click", function () {
        card.querySelector(".flash-front").hidden = true;
        card.querySelector(".flash-back").hidden = false;
      });
    })(flashes[i]);
  }

  // quizzes ----------------------------------------------------------------
  var quizzes = document.querySelectorAll("[data-quiz]");
  var total = quizzes.length, answered = 0, correct = 0;
  var quizSections = document.querySelectorAll("section[data-has-quiz='1']");

  function declareQuizMilestones() {
    var a = api();
    if (!a || !a.declare) { return; }
    for (var s = 0; s < quizSections.length; s++) { a.declare(quizSections[s].id); }
  }
  function sectionDone(section) {
    var qs = section.querySelectorAll("[data-quiz]");
    for (var k = 0; k < qs.length; k++) { if (!qs[k].getAttribute("data-done")) { return false; } }
    return true;
  }
  function onAllAnswered() {
    var a = api();
    if (a && a.score) { a.score(correct, 0, total); }
    var banner = document.getElementById("score-banner");
    var text = document.getElementById("score-text");
    if (banner && text) {
      text.textContent = "Score: " + correct + " / " + total + " (" + Math.round((correct / total) * 100) + "%)";
      banner.classList.add("on");
    }
  }
  for (var j = 0; j < quizzes.length; j++) {
    (function (quiz) {
      var buttons = quiz.querySelectorAll("[data-answer]");
      function lock(chosen) {
        var isCorrect = chosen.getAttribute("data-correct") === "1";
        if (isCorrect) { correct++; }
        answered++;
        quiz.setAttribute("data-done", isCorrect ? "correct" : "incorrect");
        for (var b = 0; b < buttons.length; b++) {
          buttons[b].disabled = true;
          if (buttons[b].getAttribute("data-correct") === "1") { buttons[b].classList.add("ok"); }
          else if (buttons[b] === chosen) { buttons[b].classList.add("ko"); }
        }
        var corr = quiz.querySelector(".correction");
        if (corr && corr.innerHTML.trim() !== "") { corr.hidden = false; }
        var section = quiz.closest("section");
        var a = api();
        if (section && a && a.reach && sectionDone(section)) { a.reach(section.id); }
        if (answered === total) { onAllAnswered(); }
      }
      for (var b = 0; b < buttons.length; b++) {
        buttons[b].addEventListener("click", function (ev) { lock(ev.currentTarget); });
      }
    })(quizzes[j]);
  }

  if (api()) { declareQuizMilestones(); }
  else { window.addEventListener("load", declareQuizMilestones); }
})();
</script>
</body>
</html>
`;
}
function actLabel(t) {
    if (t === "quiz-game") {
        return "Quiz";
    }
    if (t === "mobile-course") {
        return "Course";
    }
    return "Content";
}
/** Stable pseudo-shuffle so the correct answer is not always first (seeded, testable). */
function shuffleDeterministic(arr, seed) {
    const a = arr.slice();
    let s = seed * 2654435761 % 4294967296;
    for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) % 2147483648;
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
// --------------------------------------------------------------------------
// Entry points used by the converter
// --------------------------------------------------------------------------
const isXlsx = (f) => /\.xlsx$/i.test(f) && !f.split("/").pop().startsWith("~$");
/** A TOM export: at least one activity template, and no HTML page at all. */
export function isTomExport(files) {
    return files.some(isXlsx) && !files.some((f) => /\.html?$/i.test(f));
}
/** Parse every template of the export into a course model. */
export async function parseTomExport(files, read, fallbackTitle) {
    const warnings = [];
    const xlsx = files.filter(isXlsx).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const activities = [];
    let course;
    let language;
    for (const rel of xlsx) {
        const base = rel.split("/").pop();
        const meta = parseTomName(base);
        if (!course && meta.course) {
            course = meta.course;
        }
        if (!language && meta.language) {
            language = meta.language;
        }
        try {
            const wb = await readXlsx(await read(rel));
            activities.push(parseTomActivity(wb, base, warnings));
        }
        catch (e) {
            warnings.push(`TOM: cannot read "${base}" (${e.message}) - skipped.`);
        }
    }
    return { title: course ?? fallbackTitle, language, activities: activities.filter((a) => a.cards.length > 0), warnings };
}
/** Index every non-xlsx file by lowercase basename for media resolution. */
export function buildMediaIndex(files) {
    const idx = new Map();
    for (const f of files) {
        if (isXlsx(f)) {
            continue;
        }
        const base = f.split("/").pop().toLowerCase();
        if (!idx.has(base)) {
            idx.set(base, f);
        }
    }
    return idx;
}
