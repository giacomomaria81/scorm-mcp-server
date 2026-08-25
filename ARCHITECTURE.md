# Architecture

Design notes for contributors. What the pieces are, why they are shaped this
way, and which decisions should not be undone casually.

## What this is

An MCP server (plus CLI, local web UI and library API) that turns finished
e-learning content into a **SCORM 2004 4th Edition or SCORM 1.2** package
(`.zip` / PIF) importable into any LMS, and that can **validate** any existing
SCORM package. Three MCP tools: `scorm_package`, `scorm_validate`,
`scorm_selftest`.

**Core principle: WRAP, don't rewrite.** The author's HTML is never
restructured. The converter only (1) inlines every asset as data URIs so the
package runs 100% offline, (2) injects a small runtime that talks to the LMS,
and (3) generates the manifest and bundles the official ADL XSD schemas,
validating against them.

## Modules

| File | Role |
|---|---|
| `src/index.ts` | MCP server (stdio), tool registration, CLI (`pack` / `validate` / `selftest` / `ui`), `${HOME}` host-variable resolution, batch mode |
| `src/converter.ts` | The build pipeline: asset inlining (CSS, `@import`, fonts, JS, images, `srcset`, favicons), multi-file bundles, Claude Design `.dc` pipeline (CDN vendoring), manifest generation (2004 and 1.2), XSD bundling, security hardening (zip-slip, symlinks, `xs:ID` sanitisation, C0 chars, href encoding, size caps) |
| `src/runtime.ts` | The injected runtime. **Adaptive dialect**: speaks `API_1484_11` (2004) or `API` (1.2), whichever the hosting LMS exposes — the same content works in both worlds, only the manifest differs. Milestones (`data-jalon` + auto-generation), progress, completion, resume via `suspend_data`, score reporting, question-level `cmi.interactions` (v2.3), a CustomEvent contract (`scorm:progress|complete|score|interaction`), bfcache recovery, anti-downgrade guard for the 1.2 `lesson_status` |
| `src/validate.ts` | Standalone conformance checker (v2.3) for ANY SCORM zip: manifest-at-root (detects the folder-wrapped-zip mistake), well-formedness, edition detection, launch chain, referenced-files existence (case-mismatch flagged), XSD validation via `xmllint` — package XSDs first, embedded copies as fallback |
| `src/tom.ts` | Mobile-learning migration: a hand-rolled xlsx reader (an xlsx is a zip of XML — JSZip suffices, zero added dependency), activity-template parsing, layout codes, interactive HTML course generation with scored quizzes |
| `src/ui.ts` | Local drag-and-drop web UI (127.0.0.1:3117) |

## Decisions that should survive refactors

- **One SCO, no sequencing.** SCORM 2004 4th Edition, a single SCO per
  package. Sequencing is where SCORM complexity explodes and LMS support
  fragments; completion/progress/score cover the actual use cases.
- **Zod raw shapes for MCP `inputSchema`** — `{ x: z.string() }`, never
  `z.object({...})`. On SDK v1 the wrapped form silently published an empty
  schema and clients stripped every argument (see upstream issue
  modelcontextprotocol/typescript-sdk#2627, reported from this project).
- **stdout is pure JSON-RPC.** One stray `console.log` in server mode freezes
  the client. Logs go to `console.error`.
- **The runtime is dialect-adaptive at run time**, not build time. The
  `scorm_version` option only selects the manifest + schemas; the injected
  runtime always discovers whichever API the LMS exposes.
- **Interactions are best-effort by design.** Every `cmi.interactions.*` write
  goes through a guarded setter: an LMS that refuses them (some 1.2 players)
  gets a logged warning and the session continues. Optional data must never
  break tracking of completion or score.
- **`${HOME}` may arrive unexpanded from the MCP host** (Claude Desktop user
  config). `resolveOutputDir` expands host variables itself.
- **Tests define the contract.** `test/` (17 suites) pins behaviour: real
  `xmllint --schema` conformance, packaged runtime + quiz scripts replayed
  against mock LMSs in jsdom, a strict independent SCORM runtime
  (`scorm-again`) as a second opinion, batch CLI, fabricated OOXML exports for
  the migration. `npm test` must stay at zero failures.
- **cheerio serialises boolean attributes** as `data-x=""` — remember it when
  writing assertions.

## Data flow

```
input (html | folder | zip | .dc | xlsx export)
  → detect format (isTomExport / .dc signature)
  → [migration] xlsx → TomCourse → interactive HTML
  → inline assets (data URIs) · vendor CDN libs (.dc)
  → inject runtime (+ mastery config)
  → build manifest (2004 | 1.2) + bundle XSDs
  → validate manifest against bundled XSDs (xmllint)
  → zip (PIF) → output dir
```

Validation (`scorm_validate`) is the reverse path: open any zip, walk the
manifest, cross-check the archive, re-run the XSD validation.

## Testing locally

```bash
npm install && npm test        # 325 checks, 17 suites (xmllint required for 2)
node dist/index.js ui          # manual: drag & drop, play in scorm-test-harness.html
```

Real-LMS validation happens on SCORM Cloud (completion, success, score and
resume all verified there, including migrated quiz courses).
