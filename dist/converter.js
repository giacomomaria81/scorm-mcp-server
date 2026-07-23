/**
 * Core converter (production-hardened): turns a self-contained HTML document
 * into a SCORM 2004 4th Edition package (a .zip / PIF) with the milestone
 * runtime injected.
 *
 * Principle: WRAP, don't rewrite. The author's HTML is preserved; only
 *   1. external assets are inlined as data URIs (full offline), and
 *   2. the SCORM 2004 + milestone runtime <script> is appended.
 *
 * Offline coverage hardened to: <link rel=stylesheet>, <style>, inline style=""
 * url(), @import (recursive), <script src>, img/source/video/audio/poster src,
 * img/source srcset, favicons and rel=preload/prefetch links. A charset and a
 * mobile viewport meta are guaranteed. Assets are fetched in parallel, cached
 * (deduped) and retried once on failure.
 */
import * as cheerio from "cheerio";
import JSZip from "jszip";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { SCORM_RUNTIME } from "./runtime.js";
const MAX_ASSET_BYTES = 5 * 1024 * 1024; // per-asset warning threshold
const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // package size warning threshold
const FETCH_TIMEOUT_MS = 20000;
const FETCH_CONCURRENCY = 6;
const MAX_IMPORT_DEPTH = 5;
// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
function slugify(input) {
    return (input
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "module");
}
function escapeXml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function mimeFromExt(ref) {
    const ext = ref.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase() || "";
    const map = {
        css: "text/css", js: "application/javascript", mjs: "application/javascript",
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
        webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
        woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
        mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", oga: "audio/ogg",
        json: "application/json",
    };
    return map[ext] || "application/octet-stream";
}
function resolveRef(ref, baseUrl, baseDir, warnings) {
    const r = ref.trim();
    if (!r || r.startsWith("data:") || r.startsWith("#") || r.startsWith("blob:") || r.startsWith("mailto:") || r.startsWith("javascript:") || r.startsWith("tel:")) {
        return { kind: "skip" };
    }
    if (/^https?:\/\//i.test(r)) {
        return { kind: "url", url: r, key: "u:" + r };
    }
    if (r.startsWith("//")) {
        const u = "https:" + r;
        return { kind: "url", url: u, key: "u:" + u };
    }
    if (baseUrl) {
        try {
            const u = new URL(r, baseUrl).toString();
            return { kind: "url", url: u, key: "u:" + u };
        }
        catch {
            return { kind: "skip" };
        }
    }
    if (baseDir) {
        const root = path.resolve(baseDir);
        const file = path.resolve(root, r.replace(/^\//, ""));
        const rel = path.relative(root, file);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
            // Security: never inline files outside the module folder (prevents a
            // malicious HTML from exfiltrating local files into the package).
            if (warnings) {
                warnings.push("Référence hors du dossier du module (non inlinée): " + r);
            }
            return { kind: "skip" };
        }
        return { kind: "file", file, key: "f:" + file };
    }
    return { kind: "skip" };
}
function refLabel(resolved) {
    return resolved.kind === "url" ? resolved.url : resolved.kind === "file" ? resolved.file : "(inline)";
}
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = [];
    const n = Math.min(limit, items.length);
    for (let w = 0; w < n; w++) {
        workers.push((async () => { while (i < items.length) {
            const idx = i++;
            out[idx] = await fn(items[idx]);
        } })());
    }
    await Promise.all(workers);
    return out;
}
// low-level fetch with timeout + one retry
async function fetchBuffer(resolved) {
    if (resolved.kind === "skip") {
        return null;
    }
    if (resolved.kind === "file") {
        try {
            const data = await fs.readFile(resolved.file);
            return { data, contentType: mimeFromExt(resolved.file) };
        }
        catch {
            return null;
        }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
            const res = await fetch(resolved.url, { signal: ctrl.signal, redirect: "follow" });
            clearTimeout(t);
            if (!res.ok) {
                return null;
            }
            const data = Buffer.from(await res.arrayBuffer());
            const ct = res.headers.get("content-type")?.split(";")[0].trim() || mimeFromExt(resolved.url);
            return { data, contentType: ct };
        }
        catch {
            if (attempt === 1) {
                return null;
            }
            await new Promise((r) => setTimeout(r, 250));
        }
    }
    return null;
}
// cached data URI for a binary asset
async function dataUriFor(resolved, ctx) {
    if (resolved.kind === "skip") {
        return null;
    }
    if (ctx.cache.has(resolved.key)) {
        return ctx.cache.get(resolved.key) ?? null;
    }
    const asset = await fetchBuffer(resolved);
    if (!asset) {
        ctx.cache.set(resolved.key, null);
        return null;
    }
    if (asset.data.length > MAX_ASSET_BYTES) {
        ctx.warnings.push("Asset volumineux inliné (" + Math.round(asset.data.length / 1024) + " Ko): " + refLabel(resolved));
    }
    ctx.bytes += asset.data.length;
    const uri = "data:" + asset.contentType + ";base64," + asset.data.toString("base64");
    ctx.cache.set(resolved.key, uri);
    return uri;
}
async function fetchText(resolved) {
    const asset = await fetchBuffer(resolved);
    return asset ? asset.data.toString("utf8") : null;
}
// --------------------------------------------------------------------------
// CSS processing: @import (recursive) then url() inlining
// --------------------------------------------------------------------------
const IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/g;
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
async function inlineCssUrls(css, baseUrl, baseDir, ctx) {
    const refs = new Set();
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(css)) !== null) {
        if (m[2] && !m[2].startsWith("data:")) {
            refs.add(m[2]);
        }
    }
    const list = Array.from(refs);
    const pairs = await mapLimit(list, FETCH_CONCURRENCY, async (ref) => {
        const resolved = resolveRef(ref, baseUrl, baseDir, ctx.warnings);
        if (resolved.kind === "skip") {
            return [ref, null];
        }
        const uri = await dataUriFor(resolved, ctx);
        if (!uri) {
            ctx.warnings.push("CSS url() non inliné: " + refLabel(resolved));
        }
        return [ref, uri];
    });
    const map = new Map(pairs);
    URL_RE.lastIndex = 0;
    return css.replace(URL_RE, (full, _q, ref) => { const uri = map.get(ref); return uri ? "url(" + uri + ")" : full; });
}
async function processCss(css, baseUrl, baseDir, ctx, depth, visited) {
    // 1. resolve @import recursively
    if (depth < MAX_IMPORT_DEPTH) {
        const imports = [];
        let m;
        IMPORT_RE.lastIndex = 0;
        while ((m = IMPORT_RE.exec(css)) !== null) {
            const ref = m[2] || m[4];
            if (ref && !ref.startsWith("data:")) {
                imports.push({ full: m[0], ref });
            }
        }
        for (const imp of imports) {
            const resolved = resolveRef(imp.ref, baseUrl, baseDir, ctx.warnings);
            if (resolved.kind === "skip" || visited.has(resolved.key)) {
                css = css.replace(imp.full, "");
                continue;
            }
            visited.add(resolved.key);
            const importedRaw = await fetchText(resolved);
            if (importedRaw == null) {
                ctx.warnings.push("@import non inliné: " + refLabel(resolved));
                css = css.replace(imp.full, "");
                continue;
            }
            let childBaseUrl = baseUrl, childBaseDir = baseDir;
            if (resolved.kind === "url") {
                childBaseUrl = resolved.url;
                childBaseDir = undefined;
            }
            else if (resolved.kind === "file") {
                childBaseDir = path.dirname(resolved.file);
                childBaseUrl = undefined;
            }
            const imported = await processCss(importedRaw, childBaseUrl, childBaseDir, ctx, depth + 1, visited);
            css = css.replace(imp.full, imported);
        }
    }
    // 2. inline url()
    return inlineCssUrls(css, baseUrl, baseDir, ctx);
}
// --------------------------------------------------------------------------
// srcset parsing
// --------------------------------------------------------------------------
async function inlineSrcset(srcset, ctx) {
    const parts = srcset.split(",").map((s) => s.trim()).filter(Boolean);
    const rebuilt = await mapLimit(parts, FETCH_CONCURRENCY, async (part) => {
        const seg = part.split(/\s+/);
        const url = seg[0];
        const descriptor = seg.slice(1).join(" ");
        const resolved = resolveRef(url, ctx.baseUrl, ctx.baseDir, ctx.warnings);
        if (resolved.kind === "skip") {
            return part;
        }
        const uri = await dataUriFor(resolved, ctx);
        if (!uri) {
            ctx.warnings.push("srcset non inliné: " + refLabel(resolved));
            return part;
        }
        return descriptor ? uri + " " + descriptor : uri;
    });
    return rebuilt.join(", ");
}
async function inlineAssets(html, ctx) {
    const $ = cheerio.load(html);
    // ensure <head>, charset and a mobile-first viewport
    if ($("head").length === 0) {
        if ($("html").length) {
            $("html").prepend("<head></head>");
        }
        else {
            $.root().prepend("<head></head>");
        }
    }
    if ($("head meta[charset]").length === 0 && $('head meta[http-equiv="Content-Type" i]').length === 0) {
        $("head").prepend('<meta charset="utf-8">');
    }
    if ($('meta[name="viewport" i]').length === 0) {
        $("head").append('<meta name="viewport" content="width=device-width, initial-scale=1">');
    }
    // 1. <link rel="stylesheet"> -> <style> (with @import + url() inlined)
    const linkEls = $('link[rel~="stylesheet"][href]').toArray();
    await mapLimit(linkEls, FETCH_CONCURRENCY, async (el) => {
        const href = $(el).attr("href");
        if (!href) {
            return;
        }
        const resolved = resolveRef(href, ctx.baseUrl, ctx.baseDir, ctx.warnings);
        const cssRaw = await fetchText(resolved);
        if (cssRaw == null) {
            ctx.warnings.push("Feuille de style non inlinée: " + href);
            return;
        }
        let cssBaseUrl = ctx.baseUrl, cssBaseDir = ctx.baseDir;
        if (resolved.kind === "url") {
            cssBaseUrl = resolved.url;
            cssBaseDir = undefined;
        }
        else if (resolved.kind === "file") {
            cssBaseDir = path.dirname(resolved.file);
            cssBaseUrl = undefined;
        }
        const cssText = await processCss(cssRaw, cssBaseUrl, cssBaseDir, ctx, 0, new Set());
        const media = $(el).attr("media");
        $(el).replaceWith("<style" + (media ? ' media="' + escapeXml(media) + '"' : "") + ">\n" + cssText + "\n</style>");
    });
    // 2. existing <style> blocks -> inline @import + url()
    const styleEls = $("style").toArray();
    for (const el of styleEls) {
        const cssText = $(el).html() || "";
        if (cssText.includes("url(") || cssText.includes("@import")) {
            $(el).text(await processCss(cssText, ctx.baseUrl, ctx.baseDir, ctx, 0, new Set()));
        }
    }
    // 3. inline style="" attributes containing url()
    const styledEls = $("[style]").toArray().filter((el) => ($(el).attr("style") || "").includes("url("));
    await mapLimit(styledEls, FETCH_CONCURRENCY, async (el) => {
        const val = $(el).attr("style") || "";
        $(el).attr("style", await inlineCssUrls(val, ctx.baseUrl, ctx.baseDir, ctx));
    });
    // 4. <script src> -> inline content (preserve type)
    const scriptEls = $("script[src]").toArray();
    await mapLimit(scriptEls, FETCH_CONCURRENCY, async (el) => {
        const src = $(el).attr("src");
        if (!src) {
            return;
        }
        const resolved = resolveRef(src, ctx.baseUrl, ctx.baseDir, ctx.warnings);
        const jsText = await fetchText(resolved);
        if (jsText == null) {
            ctx.warnings.push("Script non inliné: " + src);
            return;
        }
        $(el).removeAttr("src");
        $(el).removeAttr("integrity");
        $(el).removeAttr("crossorigin");
        $(el).text("\n" + jsText + "\n");
    });
    // 5. media src + poster
    for (const sel of ["img[src]", "source[src]", "video[src]", "audio[src]", "[poster]"]) {
        const isPoster = sel === "[poster]";
        const attr = isPoster ? "poster" : "src";
        const nodes = $(sel).toArray();
        await mapLimit(nodes, FETCH_CONCURRENCY, async (el) => {
            const val = $(el).attr(attr);
            if (!val || val.startsWith("data:")) {
                return;
            }
            const resolved = resolveRef(val, ctx.baseUrl, ctx.baseDir, ctx.warnings);
            if (resolved.kind === "skip") {
                return;
            }
            const uri = await dataUriFor(resolved, ctx);
            if (!uri) {
                ctx.warnings.push("Média non inliné (" + attr + "): " + refLabel(resolved));
                return;
            }
            $(el).attr(attr, uri);
        });
    }
    // 6. srcset (img + source)
    const srcsetEls = $("img[srcset], source[srcset]").toArray();
    await mapLimit(srcsetEls, FETCH_CONCURRENCY, async (el) => {
        const val = $(el).attr("srcset");
        if (!val) {
            return;
        }
        $(el).attr("srcset", await inlineSrcset(val, ctx));
    });
    // 7. favicons -> inline as data URI (kept); network-hint links -> removed.
    //    preload/modulepreload/prefetch/preconnect/dns-prefetch only help an online
    //    fetch; inside an offline SCO they trigger failed requests, so we drop them.
    const iconEls = $('link[rel~="icon"][href], link[rel~="apple-touch-icon"][href], link[rel~="mask-icon"][href]').toArray();
    await mapLimit(iconEls, FETCH_CONCURRENCY, async (el) => {
        const href = $(el).attr("href");
        if (!href || href.startsWith("data:")) {
            return;
        }
        const resolved = resolveRef(href, ctx.baseUrl, ctx.baseDir, ctx.warnings);
        if (resolved.kind === "skip") {
            return;
        }
        const uri = await dataUriFor(resolved, ctx);
        if (uri) {
            $(el).attr("href", uri);
        }
    });
    $('link[rel~="preload"], link[rel~="modulepreload"], link[rel~="prefetch"], link[rel~="preconnect"], link[rel~="dns-prefetch"]').remove();
    // 8. ES module graphs are NOT bundled — make it visible instead of failing silently offline.
    const moduleRe = /(^|[\s;{(])import\s{0,8}[^;]{0,200}['"](\.{1,2}\/|\/)/;
    const fromRe = /from\s{0,8}['"](\.{1,2}\/|\/)/;
    let moduleWarned = false;
    for (const el of $('script[type="module" i]').toArray()) {
        const body = $(el).html() || "";
        if (!moduleWarned && (moduleRe.test(body) || fromRe.test(body))) {
            ctx.warnings.push("Script <script type=\"module\"> avec imports relatifs: le graphe d'imports n'est pas résolu/inliné — bundler le module en un seul fichier en amont.");
            moduleWarned = true;
        }
    }
    if ($('script[type="importmap" i]').length > 0) {
        ctx.warnings.push("importmap détecté: les imports mappés ne sont pas résolus dans un paquet offline.");
    }
    if (ctx.bytes > MAX_TOTAL_BYTES) {
        ctx.warnings.push("Paquet volumineux (~" + Math.round(ctx.bytes / 1024 / 1024) + " Mo embarqués) : pense à optimiser images/vidéos pour le téléchargement offline en boutique.");
    }
    return $.html();
}
// --------------------------------------------------------------------------
// runtime injection + milestone discovery
// --------------------------------------------------------------------------
const AUTO_MILESTONES_MAX = 8;
/**
 * When the author declared no [data-jalon], derive 'view' milestones from the
 * document structure: sections, then articles, then h2, then h3 — capped at
 * AUTO_MILESTONES_MAX (evenly sampled, keeping first and last).
 */
function autoTagMilestones(html) {
    const $ = cheerio.load(html);
    if ($("[data-jalon]").length > 0) {
        return { html, applied: false };
    }
    let candidates = $("section").toArray();
    if (candidates.length === 0) {
        candidates = $("article").toArray();
    }
    if (candidates.length === 0) {
        candidates = $("h2").toArray();
    }
    if (candidates.length === 0) {
        candidates = $("h3").toArray();
    }
    candidates = candidates.filter((el) => $(el).text().trim().length > 0);
    if (candidates.length === 0) {
        return { html, applied: false };
    }
    let chosen = candidates;
    if (candidates.length > AUTO_MILESTONES_MAX) {
        const n = candidates.length;
        const picked = new Set();
        for (let i = 0; i < AUTO_MILESTONES_MAX; i++) {
            picked.add(Math.round((i * (n - 1)) / (AUTO_MILESTONES_MAX - 1)));
        }
        chosen = Array.from(picked).sort((x, y) => x - y).map((i) => candidates[i]);
    }
    chosen.forEach((el, i) => { $(el).attr("data-jalon", "etape-" + (i + 1)); $(el).attr("data-trigger", "view"); });
    return { html: $.html(), applied: true };
}
function injectRuntime(html, language, successOnCompletion, masteryScore) {
    const $ = cheerio.load(html);
    // Use the declared course language on the content itself (the IMS CP schema
    // does not allow xml:lang on manifest titles, so <html lang> is the real home).
    if (language && $("html").length && !$("html").attr("lang")) {
        $("html").attr("lang", language);
    }
    if (successOnCompletion && $("[data-scorm-success]").length === 0 && $("body").length) {
        $("body").attr("data-scorm-success", "on-completion");
    }
    const ids = [];
    const seen = new Set();
    $("[data-jalon]").each((_, el) => {
        const id = $(el).attr("data-jalon");
        if (id && !seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    });
    const masteryTag = typeof masteryScore === "number" ? '<script id="scorm-mastery">window.__SCORM_MASTERY=' + masteryScore + "</script>" : "";
    const tag = masteryTag + '<script id="scorm-jalons-runtime">' + SCORM_RUNTIME + "</script>";
    if ($("body").length) {
        $("body").append(tag);
    }
    else {
        $.root().append(tag);
    }
    return { html: $.html(), milestoneIds: ids };
}
// --------------------------------------------------------------------------
// SCORM 2004 4th Edition manifest (single SCO, no sequencing)
// --------------------------------------------------------------------------
function buildManifest(identifier, title, _language, entryHref = "index.html", extraFiles = [], masteryScore) {
    const t = escapeXml(title);
    const id = escapeXml(identifier);
    const withMastery = typeof masteryScore === "number";
    const nsExtra = withMastery
        ? `\n  xmlns:imsss="http://www.imsglobal.org/xsd/imsss"`
        : "";
    const slExtra = withMastery
        ? " http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd"
        : "";
    const measure = String(Math.round(masteryScore * 10000) / 10000);
    const itemExtras = withMastery
        ? `\n        <adlcp:completionThreshold completedByMeasure="true" minProgressMeasure="${measure}"/>
        <imsss:sequencing>
          <imsss:objectives>
            <imsss:primaryObjective objectiveID="PRIMARY-OBJ" satisfiedByMeasure="true">
              <imsss:minNormalizedMeasure>${measure}</imsss:minNormalizedMeasure>
            </imsss:primaryObjective>
          </imsss:objectives>
          <imsss:deliveryControls completionSetByContent="true" objectiveSetByContent="true"/>
        </imsss:sequencing>`
        : "";
    const fileLines = [entryHref, ...extraFiles]
        .map((f) => `      <file href="${escapeXml(encodeURI(f))}"/>`)
        .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${id}" version="1.0"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"${nsExtra}
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd${slExtra}">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
  </metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>${t}</title>
      <item identifier="ITEM-1" identifierref="RES-1" isvisible="true">
        <title>${t}</title>${itemExtras}
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormType="sco" href="${escapeXml(encodeURI(entryHref))}">
${fileLines}
    </resource>
  </resources>
</manifest>
`;
}
// --------------------------------------------------------------------------
// ADL XSD schema bundling (offline conformance: xsi:schemaLocation resolves
// to these sibling files inside the package)
// --------------------------------------------------------------------------
const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schemas");
async function bundleSchemas(zip, ctx) {
    let entries;
    try {
        entries = await fs.readdir(SCHEMA_DIR);
    }
    catch {
        ctx.warnings.push("Schémas ADL introuvables (dossier schemas/ absent): paquet livré sans XSD embarqués.");
        return 0;
    }
    const xsds = entries.filter((f) => f.toLowerCase().endsWith(".xsd")).sort();
    let count = 0;
    for (const name of xsds) {
        try {
            const data = await fs.readFile(path.join(SCHEMA_DIR, name));
            zip.file(path.basename(name), data); // bundled at package root
            count++;
        }
        catch {
            ctx.warnings.push("XSD non embarqué: " + name);
        }
    }
    return count;
}
const SKIP_FILES = new Set([".ds_store", "thumbs.db", ".thumbnail"]);
function keepBundleFile(rel) {
    const parts = rel.split("/");
    for (const p of parts) {
        const low = p.toLowerCase();
        if (SKIP_FILES.has(low) || low === ".git" || low === "node_modules" || p.startsWith("._")) {
            return false;
        }
    }
    return true;
}
async function walkDir(root, base = "") {
    const out = [];
    const entries = await fs.readdir(path.join(root, base), { withFileTypes: true });
    for (const e of entries) {
        const rel = base ? base + "/" + e.name : e.name;
        if (!keepBundleFile(rel)) {
            continue;
        }
        if (e.isDirectory()) {
            out.push(...(await walkDir(root, rel)));
        }
        else if (e.isFile()) {
            out.push(rel);
        }
    }
    return out;
}
function pickEntry(files) {
    const dc = files.filter((f) => f.toLowerCase().endsWith(".dc.html"));
    if (dc.length) {
        return dc.sort((x, y) => x.split("/").length - y.split("/").length)[0];
    }
    if (files.includes("index.html")) {
        return "index.html";
    }
    const html = files.filter((f) => /\.html?$/i.test(f));
    if (html.length === 1) {
        return html[0];
    }
    if (html.length > 1) {
        const roots = html.filter((f) => !f.includes("/"));
        if (roots.length === 1) {
            return roots[0];
        }
    }
    throw new Error("Bundle: no entry HTML found (expected a .dc.html, an index.html, or a single .html file).");
}
async function loadBundle(inputPath) {
    const st = await fs.stat(inputPath);
    if (st.isDirectory()) {
        const files = await walkDir(path.resolve(inputPath));
        return { root: path.resolve(inputPath), files, entryRel: pickEntry(files), cleanup: false };
    }
    // .zip: extract to a temp dir (with zip-slip guard)
    const buf = await fs.readFile(inputPath);
    const zin = await JSZip.loadAsync(buf);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scorm-in-"));
    for (const [name, entry] of Object.entries(zin.files)) {
        if (entry.dir) {
            continue;
        }
        const clean = name.replace(/\\/g, "/");
        if (!keepBundleFile(clean)) {
            continue;
        }
        const dest = path.join(root, clean);
        if (!path.resolve(dest).startsWith(root + path.sep) && path.resolve(dest) !== root) {
            continue;
        } // zip-slip
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, await entry.async("nodebuffer"));
    }
    const files = await walkDir(root);
    return { root, files, entryRel: pickEntry(files), cleanup: true };
}
/** Claude Design signature: <x-dc> + <script type="text/x-dc"> + support.js. */
function detectFormat(html) {
    const hasXdc = /<x-dc[\s>/]/i.test(html);
    const hasLogic = /<script[^>]*type\s*=\s*["']text\/x-dc["']/i.test(html);
    const hasSupport = /<script[^>]*src\s*=\s*["'][^"']*support\.js(\?[^"']*)?["']/i.test(html);
    return hasXdc && hasLogic && hasSupport ? "claude-design" : "html";
}
const CDN_URL_RE = /https:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\/[^"'\s)]+?\.(?:js|mjs)(?:\?[^"'\s)]*)?/g;
/** Download the CDN libs referenced by support.js and map them via window.__resources. */
async function vendorCdnLibs(supportJs, ctx) {
    const urls = Array.from(new Set(supportJs.match(CDN_URL_RE) || []));
    const mapping = {};
    const vendorFiles = new Map();
    const vendored = [];
    const used = new Set();
    for (const url of urls) {
        const asset = await fetchBuffer({ kind: "url", url, key: "u:" + url });
        if (!asset) {
            ctx.warnings.push("Lib CDN non vendorisée (téléchargement impossible): " + url);
            continue;
        }
        let name = (url.split("?")[0].split("/").pop() || "lib.js").replace(/[^A-Za-z0-9._-]/g, "_");
        while (used.has(name)) {
            name = "_" + name;
        }
        used.add(name);
        vendorFiles.set("vendor/" + name, asset.data);
        mapping[url] = "vendor/" + name;
        vendored.push(url);
        ctx.bytes += asset.data.length;
    }
    return { mapping, vendorFiles, vendored };
}
/** Build the injection block placed BEFORE support.js: __resources + mastery + runtime. */
function buildInjection(mapping, masteryScore) {
    let block = "";
    if (mapping && Object.keys(mapping).length) {
        // Returning plain strings from __resources also disables SRI checks — intended.
        block += '<script id="scorm-vendor-resources">window.__resources = ' + JSON.stringify(mapping) + ";</script>\n";
    }
    if (typeof masteryScore === "number") {
        block += '<script id="scorm-mastery">window.__SCORM_MASTERY=' + masteryScore + ";</script>\n";
    }
    block += '<script id="scorm-jalons-runtime">' + SCORM_RUNTIME + "</script>\n";
    return block;
}
/** Insert the injection before the support.js script tag (fallback: end of head / prepend). */
function injectIntoDcHtml(html, injection) {
    const m = html.match(/<script[^>]*src\s*=\s*["'][^"']*support\.js(?:\?[^"']*)?["'][^>]*>/i);
    if (m && m.index != null) {
        return html.slice(0, m.index) + injection + html.slice(m.index);
    }
    const head = html.search(/<\/head>/i);
    if (head >= 0) {
        return html.slice(0, head) + injection + html.slice(head);
    }
    return injection + html;
}
// --------------------------------------------------------------------------
// public entry point
// --------------------------------------------------------------------------
export async function buildPackage(opts) {
    const ctx = { warnings: [], bytes: 0, cache: new Map(), baseUrl: opts.baseUrl, baseDir: undefined };
    const title = opts.title?.trim();
    if (!title) {
        throw new Error("`title` is required (used as the course and item title in the manifest).");
    }
    const language = opts.language?.trim() || "fr-FR";
    const identifier = opts.identifier?.trim() || "COURSE-" + slugify(title).toUpperCase();
    const mastery = typeof opts.masteryScore === "number" && opts.masteryScore >= 0 && opts.masteryScore <= 1 ? opts.masteryScore : undefined;
    // Detect a bundle input (directory or .zip on disk).
    let bundle = null;
    if (opts.inputPath) {
        const st = await fs.stat(opts.inputPath).catch(() => null);
        if (st && (st.isDirectory() || /\.zip$/i.test(opts.inputPath))) {
            bundle = await loadBundle(opts.inputPath);
        }
    }
    // ---------- Path A: multi-file bundle (Claude Design .dc or generic) ----------
    if (bundle) {
        try {
            const entryAbs = path.join(bundle.root, bundle.entryRel);
            const entryHtml = await fs.readFile(entryAbs, "utf8");
            const fmt = opts.format && opts.format !== "auto" ? opts.format : (detectFormat(entryHtml) === "claude-design" ? "claude-design" : "self-contained-html");
            if (fmt === "claude-design") {
                // Vendorise CDN libs referenced by support.js, then inject __resources + runtime.
                let mapping = null;
                const vendorFiles = new Map();
                const vendored = [];
                const supRel = bundle.files.find((f) => /(^|\/)support\.js$/i.test(f));
                const supJs = supRel ? await fs.readFile(path.join(bundle.root, supRel), "utf8") : entryHtml;
                const cdnUrls = Array.from(new Set(supJs.match(CDN_URL_RE) || []));
                if (opts.vendorCdn === false) {
                    if (cdnUrls.length) {
                        ctx.warnings.push("Vendorisation désactivée : " + cdnUrls.length + " lib(s) CDN non embarquée(s) — en LMS à réseau filtré, le module pourrait ne pas démarrer.");
                    }
                }
                else if (cdnUrls.length) {
                    const v = await vendorCdnLibs(supJs, ctx);
                    mapping = Object.keys(v.mapping).length ? v.mapping : null;
                    for (const [k, b] of v.vendorFiles) {
                        vendorFiles.set(k, b);
                    }
                    vendored.push(...v.vendored);
                    if (!mapping) {
                        ctx.warnings.push("Libs CDN détectées mais non vendorisées (réseau de build ?) : en LMS à réseau filtré, le module pourrait ne pas démarrer.");
                    }
                }
                const injection = buildInjection(mapping, mastery);
                let outEntry = injectIntoDcHtml(entryHtml, injection);
                if (!/^\s*<!doctype/i.test(outEntry)) {
                    outEntry = "<!DOCTYPE html>\n" + outEntry;
                }
                const zip = new JSZip();
                // preserve the whole tree
                for (const rel of bundle.files) {
                    zip.file(rel, await fs.readFile(path.join(bundle.root, rel)));
                }
                zip.file(bundle.entryRel, outEntry); // overwrite entry with injected version
                for (const [rel, buf] of vendorFiles) {
                    zip.file(rel, buf);
                }
                zip.file("imsmanifest.xml", buildManifest(identifier, title, language, bundle.entryRel, [...bundle.files.filter((f) => f !== bundle.entryRel), ...vendorFiles.keys()], mastery));
                const schemasBundled = await bundleSchemas(zip, ctx);
                const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
                if (ctx.bytes > MAX_TOTAL_BYTES) {
                    ctx.warnings.push("Paquet volumineux (~" + Math.round(ctx.bytes / 1024 / 1024) + " Mo).");
                }
                return {
                    zip: zipBuffer, fileName: slugify(title) + "-scorm2004.zip",
                    milestoneCount: 0, milestoneIds: [], warnings: ctx.warnings, inlinedBytes: ctx.bytes,
                    schemasBundled, milestonesAuto: false, format: "claude-design",
                    filesCount: bundle.files.length + vendorFiles.size, vendored,
                };
            }
            // Generic multi-file bundle: inline the entry, keep siblings, preserve tree.
            ctx.baseDir = path.dirname(entryAbs);
            const inlined = await inlineAssets(entryHtml, ctx);
            let working = inlined;
            let milestonesAuto = false;
            if (opts.autoMilestones !== false) {
                const auto = autoTagMilestones(working);
                working = auto.html;
                milestonesAuto = auto.applied;
            }
            const { html: finalHtml, milestoneIds } = injectRuntime(working, language, opts.successOnCompletion === true, mastery);
            let outEntry = finalHtml;
            if (!/^\s*<!doctype/i.test(outEntry)) {
                outEntry = "<!DOCTYPE html>\n" + outEntry;
            }
            const zip = new JSZip();
            for (const rel of bundle.files) {
                zip.file(rel, await fs.readFile(path.join(bundle.root, rel)));
            }
            zip.file(bundle.entryRel, outEntry);
            zip.file("imsmanifest.xml", buildManifest(identifier, title, language, bundle.entryRel, bundle.files.filter((f) => f !== bundle.entryRel), mastery));
            const schemasBundled = await bundleSchemas(zip, ctx);
            const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
            return {
                zip: zipBuffer, fileName: slugify(title) + "-scorm2004.zip",
                milestoneCount: milestoneIds.length, milestoneIds, warnings: ctx.warnings, inlinedBytes: ctx.bytes,
                schemasBundled, milestonesAuto, format: "html", filesCount: bundle.files.length, vendored: [],
            };
        }
        finally {
            if (bundle.cleanup) {
                await fs.rm(bundle.root, { recursive: true, force: true }).catch(() => { });
            }
        }
    }
    // ---------- Path B: single self-contained HTML (v1 behaviour) ----------
    let rawHtml = opts.html;
    if (opts.inputPath) {
        rawHtml = await fs.readFile(opts.inputPath, "utf8");
        ctx.baseDir = path.dirname(path.resolve(opts.inputPath));
    }
    if (!rawHtml || !rawHtml.trim()) {
        throw new Error("No HTML provided. Pass either `html` (content string) or `inputPath` (file/dir/zip on disk).");
    }
    // A .dc.html passed as a single file can't work (needs support.js siblings).
    if (detectFormat(rawHtml) === "claude-design" && !opts.inputPath) {
        ctx.warnings.push("HTML de type Claude Design (.dc) fourni sans ses fichiers voisins (support.js, _ds/…) : passe le .zip ou le dossier du module, pas seulement le HTML.");
    }
    const inlined = await inlineAssets(rawHtml, ctx);
    let working = inlined;
    let milestonesAuto = false;
    if (opts.autoMilestones !== false) {
        const auto = autoTagMilestones(working);
        working = auto.html;
        milestonesAuto = auto.applied;
    }
    const { html: finalHtml, milestoneIds } = injectRuntime(working, language, opts.successOnCompletion === true, mastery);
    if (milestoneIds.length === 0) {
        ctx.warnings.push("Aucun jalon [data-jalon] détecté : le module sera marqué 'completed' au chargement (pas de progression mesurée).");
    }
    const manifest = buildManifest(identifier, title, language, "index.html", [], mastery);
    let outHtml = finalHtml;
    if (!/^\s*<!doctype/i.test(outHtml)) {
        outHtml = "<!DOCTYPE html>\n" + outHtml;
    }
    const zip = new JSZip();
    zip.file("imsmanifest.xml", manifest);
    zip.file("index.html", outHtml);
    const schemasBundled = await bundleSchemas(zip, ctx);
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    return {
        zip: zipBuffer, fileName: slugify(title) + "-scorm2004.zip",
        milestoneCount: milestoneIds.length, milestoneIds, warnings: ctx.warnings, inlinedBytes: ctx.bytes,
        schemasBundled, milestonesAuto, format: "html", filesCount: 1, vendored: [],
    };
}
