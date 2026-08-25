# v2.3.0 — Validate any SCORM package · question-level tracking

Two capabilities this release, both aimed at the same goal: making SCORM
*accountable* — you can now prove a package is conformant before it reaches an
LMS, and see exactly which questions a learner missed once it does.

## New: `scorm_validate` — "why does my LMS reject this zip?"

A third MCP tool (also `npx scorm-mcp-server validate pkg.zip` on the CLI, and
`validatePackage()` in the library API). It checks **any** SCORM package — not
only those produced by this tool — and explains every failure in plain
language:

- `imsmanifest.xml` at the **root** of the zip, with explicit detection of the
  single most common import failure: *the course folder was zipped instead of
  its contents* — the report says so, and says how to fix it.
- Well-formed manifest, SCORM edition detection (2004 / 1.2).
- Launch chain: organization → item → `scormType="sco"` resource → href.
- The launch file and every `<file href>` actually present in the archive;
  case-only mismatches flagged (they work on Windows, fail on the Linux
  servers most LMSs run on).
- Full **XSD validation against the official ADL schemas** (xmllint), using
  the package's own XSDs first and falling back to the embedded copies — so
  packages that ship without schemas validate too.

Exit code 0/1 and a `--json` mode make it drop into CI pipelines.

## New: question-level tracking (`cmi.interactions`)

Quizzes now report **each answer**, not just the total score: question text,
the learner's answer, the expected answer, correct/incorrect, timestamp and
latency — so the LMS gradebook shows *which* questions were missed.

- Automatic for courses migrated from mobile-learning Excel exports.
- One line for any other content: `window.SCORM2004.interaction({...})` or a
  `scorm:interaction` CustomEvent — no SCORM knowledge required.
- Dialect-aware: 2004 (`learner_response`, `timestamp`, `incorrect`) and 1.2
  (`student_response`, `time`, `wrong`) element names and vocabularies.
- **Best-effort by design**: an LMS that refuses interaction writes gets a
  logged warning and completion/score tracking carries on untouched.
- Resumes numbering after an existing `cmi.interactions._count` on re-entry.

## Documentation

- New `ARCHITECTURE.md` (English): modules, data flow, and the design
  decisions that should survive refactors.
- README: validation section, interactions examples, updated badges.
- The French working notes (`PASSATION.md`) are retired.

## Tests

**325/325 checks across 17 suites** (previously 256): +35 validation
(including folder-wrapped zips, missing files, case mismatches, CLI exit
codes, MCP surface) and +33 interactions (2004 + 1.2 dialects, event contract,
count resume, refusing-LMS resilience, end-to-end migrated-quiz clicks in a
mock LMS).

No breaking changes. Packages produced by 2.2.x remain identical except for
the added interactions reporting in migrated quizzes.
