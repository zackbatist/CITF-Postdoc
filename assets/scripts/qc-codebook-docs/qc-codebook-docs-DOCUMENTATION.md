# qc-codebook-docs — Project Documentation

*Last updated: 2026-03-23*

---

## Table of contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Architecture overview](#2-architecture-overview)
3. [File inventory](#3-file-inventory)
4. [Deployment and startup](#4-deployment-and-startup)
5. [Configuration](#5-configuration)
6. [Data model](#6-data-model)
7. [Application state](#7-application-state)
8. [UI structure and behaviour](#8-ui-structure-and-behaviour)
9. [History and diffing system](#9-history-and-diffing-system)
10. [Export system](#10-export-system)
11. [Server API](#11-server-api)
12. [Lua filter](#12-lua-filter)
13. [Versioning system (design — not yet implemented)](#13-versioning-system-design--not-yet-implemented)
14. [Relationship to qc-reflect](#14-relationship-to-qc-reflect)
15. [Known limitations and pending work](#15-known-limitations-and-pending-work)

---

## 1. Purpose and scope

qc-codebook-docs has two distinct but related purposes:

**Primary purpose — rich metadata for a structurally-constrained code system.** The `qc` tool stores code systems as bare YAML trees: code names and parent/child relationships, nothing else. qc-codebook-docs is a parallel documentation layer that adds the metadata `qc` cannot store: scope definitions, rationale, usage notes, provenance, status, and canonical corpus examples. This metadata travels alongside the YAML as a JSON sidecar and is never mixed into the YAML itself.

**Secondary purpose — reflexive code system development.** As a researcher works with a code system over time, codes are introduced, renamed in scope, deprecated, or reorganised. qc-codebook-docs provides tools to make this process deliberate: status tracking, per-code edit history, a document-level event log, and structural comparison between states of the code system. The goal is to support the kind of reflexive, audit-trailed codebook development that qualitative methodology requires.

**Downstream purpose — feeding qc-reflect.** The rich metadata produced here (especially scope, rationale, and usage notes) is intended as structured context for qc-reflect, a separate LLM-assisted system that analyses how codes are actually applied in the corpus and suggests refinements, mergers, or new codes. The pairing of *intended* use (from these docs) with *actual* use (from the corpus JSON files) is the core of that reflexive loop.

---

## 2. Architecture overview

```
project root/
├── qc-reflect-config.yaml          ← shared config for all qc tools
├── qc-reflect-server.py            ← local HTTP server (static files + API)
├── qc-codebook-docs.qmd            ← Quarto source; renders the HTML app
│
├── assets/scripts/qc-codebook-docs/
│   ├── qc-codebook-docs-filter.lua ← Pandoc/Quarto filter: bakes data into HTML
│   ├── qc-codebook-docs.js         ← full client-side application
│   └── qc-codebook-docs.css        ← styles (dark + light mode)
│
└── qc/
    ├── codebook.yaml               ← active qc codebook (source of tree structure)
    ├── codebook.docs.json          ← rich metadata sidecar (autosaved)
    ├── qc-codebook-docs.html       ← rendered app (output of quarto render)
    └── json/                       ← per-document corpus coding JSON files
```

**Render pipeline.** `quarto render qc-codebook-docs.qmd` invokes the Lua filter, which reads `codebook.yaml` and the corpus `json/` directory, serialises the tree and use-count data as JavaScript globals, inlines the CSS and JS, and writes a fully self-contained HTML file to `qc/qc-codebook-docs.html`. The HTML app is then served by the Python server.

**Runtime data flow.** On page load, the JS app calls `GET /docs/load` to fetch the current `codebook.docs.json` (rich metadata + history). Autosave writes back to the same file via `POST /docs/save` every 800 ms after any change. The tree structure (code names, parent/child relationships) is baked into the HTML at render time and is read-only at runtime; structural overrides (reparenting) are stored in `state.treeOverrides` and persisted in the JSON sidecar.

---

## 3. File inventory

### `qc-codebook-docs.qmd`
Minimal Quarto document. Its only function is to invoke the Lua filter. Contains no substantive content — the filter generates the entire HTML output.

### `assets/scripts/qc-codebook-docs/qc-codebook-docs-filter.lua`
Pandoc filter that runs at render time. Responsibilities:
- Reads `qc-reflect-config.yaml` to find paths
- Parses `codebook.yaml` into a flat node list with parent/depth fields
- Counts per-code corpus usage from all `qc/json/*.json` files
- Inlines CSS, JS, and the baked data into a standalone HTML file
- Writes the HTML to `qc/qc-codebook-docs.html`

### `assets/scripts/qc-codebook-docs/qc-codebook-docs.js`
The entire client-side application (~2400 lines). Single IIFE, no framework, no build step. Sections:
- State initialisation
- Index management (O(1) parent/child/depth lookups)
- Changelog helpers (`clDoc`, `clCode`)
- Save/load/import functions
- Export builders (YAML-qc, YAML-full, MD, QMD, HTML, CSV, PDF)
- Render functions (full render, surgical topbar/sidebar/editor updates)
- Topbar builder
- Sidebar (tree + export panel)
- Editor (doc tab, examples tab, history tab, multi-select editor)
- History and diff system (see §9)

### `assets/scripts/qc-codebook-docs/qc-codebook-docs.css`
All styles. IBM Plex Sans + IBM Plex Mono from Google Fonts. CSS custom properties for theming. Dark mode is default; light mode is applied via `body.light-mode`. No preprocessor.

### `qc-reflect-server.py`
Local HTTP server. Pure Python stdlib, no dependencies. Responsibilities:
- Serves static files from `qc/` (including the rendered HTML app)
- Proxies `/api/*` to Ollama at `localhost:11434`
- Handles docs persistence endpoints (`/docs/load`, `/docs/save`, `/docs/load-json`, `/docs/list-json`)
- Handles reflect log endpoints (`/logs/save`, `/logs/list`)
- Handles corpus excerpt fetching (`/excerpts/fetch`)

### `qc-codebook-docs.yaml`
Template/seed file documenting the intended YAML schema. Not read at runtime (the JSON sidecar is used instead). Kept for reference and as a fallback if no JSON sidecar exists yet.

### `qc-reflect-config.yaml`
Shared configuration file (not included in this repo — created by the user). Fields relevant to qc-codebook-docs:

```yaml
directories:
  output_dir: qc          # where HTML is served from; also where codebook.yaml lives
  json_dir:   qc/json     # per-document corpus coding JSON files

server:
  port: 8080
  url:  http://localhost:11434   # Ollama

```

---

## 4. Deployment and startup

**Prerequisites:**
- Quarto (for rendering the QMD)
- Python 3.9+ (stdlib only; no pip installs required)
- Pandoc (bundled with Quarto)
- Ollama running locally (optional; only needed for qc-reflect features)

**Steps:**

```bash
# 1. Render the HTML app (re-run whenever codebook.yaml changes)
quarto render qc-codebook-docs.qmd

# 2. Start the server (from project root)
python3 qc-reflect-server.py

# 3. Open in browser
open http://localhost:8080/qc/qc-codebook-docs.html
```

**When to re-render.** The Quarto render step bakes the codebook tree and corpus use counts into the HTML. Re-render whenever:
- `codebook.yaml` changes (codes added, removed, or renamed in the native qc tool)
- The corpus `qc/json/` files change substantially (use counts become stale)
- The Lua filter or JS/CSS files change

Rich metadata (documentation, history, status) does **not** require a re-render — it is fetched live from `codebook.docs.json` on every page load.

---

## 5. Configuration

All paths are resolved relative to `PROJECT_ROOT`, which the Lua filter determines from its own location (`PANDOC_SCRIPT_FILE`). The fallback is `pwd`.

| Config key | Default | Description |
|---|---|---|
| `directories.output_dir` | `qc` | Where HTML is served from; `codebook.yaml` must be here |
| `directories.json_dir` | `qc/json` | Corpus coding JSON files |
| `server.port` | `8080` | Port for the local server |
| `server.url` | `http://localhost:11434` | Ollama base URL |

The JavaScript app receives its configuration through the `DOCS_CONFIG` global injected by the Lua filter:

```javascript
const DOCS_CONFIG = {
  server_port:        8080,
  codebook_docs_path: "/absolute/path/to/qc/qc-codebook-docs.yaml",
  json_dir:           "/absolute/path/to/qc/json",
};
```

The `codebook_docs_path` is used to derive the JSON sidecar path (same path, `.json` suffix). This is the file autosave writes to and `loadDocs` reads from.

---

## 6. Data model

### `codebook.yaml` (read-only at runtime)

qc-compatible bare list format. Parsed at render time by the Lua filter. Example:

```yaml
- ThematiConcept:
  - SpecificCode
  - AnotherCode:
    - Subcode
- StandaloneCode
```

Tree nodes are flattened to a list of `{name, parent, depth, prefix, children}` objects and baked into the HTML as `CODEBOOK_TREE`.

### `codebook.docs.json` (live read/write)

The rich metadata sidecar. Full schema:

```json
{
  "saved": "2026-03-23T14:22:05.123Z",
  "codes": {
    "CodeName": {
      "status":      "active | experimental | deprecated | ''",
      "scope":       "What this code captures and where it ends",
      "rationale":   "Why this code exists; how it differs from siblings",
      "usage_notes": "Edge cases, exclusions, common confusions",
      "provenance":  "When created, split from, merged with",
      "examples":    [
        {"doc": "document-name", "line": 42, "note": "optional annotation"}
      ],
      "_log": [
        {"ts": "ISO8601", "field": "scope", "from": "old value", "to": "new value"}
      ],
      "_baseline": {
        "status": "", "scope": "", "rationale": "",
        "usage_notes": "", "provenance": "", "parent": ""
      }
    }
  },
  "tree": [...],
  "overrides": {
    "CodeName": "NewParentName"
  },
  "changelog": [
    {"ts": "ISO8601", "type": "open | save | move | bulk-status", "detail": "..."}
  ]
}
```

**`_log`** — append-only per-code edit history. Each entry records one field change with full before/after values (no truncation). Written by `clCode()` whenever `setDoc()` is called and the value differs from the current.

**`_baseline`** — snapshot of the code's field values and parent at the time the file was first loaded in the current session. Used as the "before everything" state in the history diff system. Written by `loadDocs()` and `importJson()` if not already present.

**`overrides`** — parent reassignments made within the app (reparenting via the parent selector in the doc tab). The original tree structure from `codebook.yaml` is never modified; overrides are layered on top.

**`changelog`** — document-level structural events. Field edits are recorded in each code's `_log`, not here.

### Corpus JSON files (`qc/json/*.json`)

Written by qc, read-only from this tool's perspective. Each file is a list of coding entries:

```json
[
  {"code": "CodeName", "document": "filename", "line": 42, "text": "..."},
  ...
]
```

Used for two purposes: building use counts (baked into HTML at render time) and fetching excerpts on demand (via `/excerpts/fetch`).

---

## 7. Application state

The full runtime state lives in a single `state` object. Key fields:

| Field | Type | Description |
|---|---|---|
| `docs` | object | `{codes: {...}}` — the live rich metadata, mirrors JSON sidecar |
| `selected` | string\|null | Currently selected code name |
| `multiSelected` | Set | Code names selected via Cmd/Ctrl+click or Shift+click |
| `tab` | string | Active editor tab: `'doc'`, `'examples'`, `'history'` |
| `expanded` | object | `{codeName: bool}` — which tree nodes are expanded |
| `search` | string | Current sidebar search query |
| `treeOverrides` | object | `{codeName: newParent}` — reparenting overrides |
| `exportSelected` | Set | Codes included in export (controlled via pip clicks) |
| `statusInclude` | Set | Status values included in export filter |
| `exportFormat` | string | Active export format chip |
| `changelog` | array | Document-level event log |
| `histSel` | array | Up to 2 selected history entry keys for diff |
| `histDiffMode` | string | `'fields'` or `'json'` |
| `docHistoryOpen` | bool | Whether the editor shows the doc history panel |
| `saveStatus` | string | `'saved'`, `'unsaved'`, `'saving'`, `'error'` |
| `lightMode` | bool | Whether light mode CSS class is applied |
| `importOpen` | bool | Whether the Open panel is visible |
| `saveOpen` | bool | Whether the Save JSON panel is visible |

**Index caches** (rebuilt by `rebuildIndices()` whenever `treeOverrides` changes):

| Variable | Description |
|---|---|
| `_childrenIdx` | `{name: [childName, ...]}` |
| `_parentIdx` | `{name: parentName\|''}` |
| `_depthIdx` | `{name: depth}` |
| `_subtreeCache` | `{name: [allDescendantNames]}` — invalidated on rebuild |

---

## 8. UI structure and behaviour

### Layout

```
┌─ topbar ──────────────────────────────────────────────────────────────┐
│ qc-codebook-docs  │  N codes · N documented  [History]   ☾  Saved  Open  Save JSON │
├─ [Open/Save panel, shown inline below topbar when active] ────────────┤
├─ sidebar ──────────────────────┬─ editor ──────────────────────────────┤
│ [search]                       │  [code name]                          │
│ [tree]                         │  [meta: depth, parent, uses]          │
│   ● CodeName ·                 │  [tabs: Documentation | Examples | History] │
│   ▶ ● ParentCode               │  [tab content]                        │
│     ● ChildCode                │                                       │
│ ─────────────────────────────  │                                       │
│ [export panel]                 │                                       │
└────────────────────────────────┴───────────────────────────────────────┘
```

### Topbar

Left to right: brand label, separator, stat summary (code count, documented count, moved count, multi-select count), History tab toggle, spacer, theme toggle (☾/☀), multi-select clear button (when active), save status indicator, Open button, Save JSON button.

The Open and Save JSON buttons toggle inline panels that appear below the topbar bar. Only one panel is open at a time.

The **History** button switches the editor panel to the document history view (unified event feed). Clicking it again returns to the normal code editor.

### Sidebar

**Tree.** Codes rendered as a collapsible hierarchy. Root-level nodes are expanded by default. Each row shows:
- A pip SVG (click to toggle export inclusion for the subtree; ring colour = status)
- Code name
- A faint red dot if the code has no documentation at all
- Use count (leaf codes) or `selected/total` subtree count (parent codes)

Clicking a row selects it and opens its documentation in the editor. Scroll position is preserved across selections. Cmd/Ctrl+click multi-selects; Shift+click selects a range within the visible tree.

Parent reassignment is done through the Parent selector in the Documentation tab, not by drag-and-drop (removed). Moves are recorded in both `changelog` and the code's `_log`.

**Export panel.** Below the tree. Shows status filter pills (click to include/exclude from export), format chips (YAML·qc, YAML·full, MD, QMD, HTML, CSV, PDF), and a download button. The download button pulses when there are unsaved changes.

### Editor — Documentation tab

Six fields per code: Status (dropdown), Parent (dropdown — lists all non-cycling candidates), Scope, Rationale, Usage notes, History/Provenance. All text fields autosave 800 ms after each keystroke via `setDoc()` → `clCode()` → `scheduleSave()`.

### Editor — Examples tab

Shows corpus excerpts for the selected code, fetched on demand from `/excerpts/fetch`. Up to 30 excerpts are displayed, with document name, line number, and text snippet. Users can pin excerpts as canonical examples (stored in `docs.codes[name].examples`).

### Editor — History tab (per-code)

Two-column layout. Left: list of log entries for this code, newest first, with the initial load state ("Before [date]") pinned at the bottom. Right: diff pane showing either a single version's full field state or a comparison between two selected versions.

Selection uses a teal/amber A/B system: the first clicked entry gets a teal left-border stripe and "A" badge; the second gets amber and "B". Clicking a selected entry deselects it.

### Editor — Document history (topbar History tab)

Full unified feed of all events across all codes: per-code field edits from every code's `_log`, plus structural changelog events (opens, saves, moves). Sorted newest first. Same A/B selection and diff system as the per-code history tab.

### Multi-select editor

When two or more codes are selected, the editor shows a bulk edit panel: bulk status change dropdown, bulk parent reassignment dropdown, and a view toggle (table / cards). The table view is sortable by any column. Clicking any row in table or cards view navigates to that code's individual editor.

---

## 9. History and diffing system

### Two separate logs

**Per-code `_log`** (in `docs.codes[name]._log`): append-only list of field edits. Written by `clCode(code, field, from, to)` called from `setDoc()`. Captures every change to any of the six documentation fields. Full values stored, no truncation.

**Document `changelog`** (in `state.changelog`): structural events only. Written by `clDoc(type, detail)`. Types:
- `open` — file loaded
- `save` — explicit JSON save
- `move` — code reparented (detail: `"CodeName: OldParent → NewParent"`)
- `bulk-status` — bulk status change

### `_baseline`

Snapshot of each code's field values at load time, stored in `_baseline`. Written once by `loadDocs()` or `importJson()` if absent. Serves as the "before any recorded changes" state for the history diff system. Labelled "Before [date of first log entry]" in the UI.

### History tab diff system

**`codeRecordAtIdx(rawLog, baseline, logIdx)`** — reconstructs the full six-field state of a code at a given log index by applying entries 0..logIdx over the baseline. `logIdx = -1` returns the baseline state.

**`fullDocSnapshotAtTs(ts)`** — reconstructs the full document state (all codes, all fields, all parents) at a given timestamp by replaying `_log` and `changelog` up to that point. Used for cross-event JSON diffs in the document history.

**`buildCodeJsonDiff(aStr, bStr)`** — plain full diff for code records (small, ~8 lines). No accordion. Uses iterative LCS with no size cap.

**`buildDocJsonDiff(aStr, bStr)`** — accordion diff for large overrides maps. Collapses runs of more than 30 unchanged context lines into clickable `@@ N unchanged lines` hunks. No size cap.

**`lcs(al, bl)`** — iterative LCS using `Uint16Array` DP table. No line-count limit.

### Selection and diff modes

In both the per-code History tab and the document history, clicking one entry shows its full field state. Clicking two entries shows a diff. The diff header shows "Earlier [timestamp] → Later [timestamp]" regardless of click order.

When both entries are from the same code, a Fields/JSON toggle is available. Fields view shows each field with red "A — before" and green "B — after" blocks for changed fields, dimmed single block for unchanged. JSON view shows the full serialised record diff.

When entries are from different codes or event types, only JSON view is offered, using `fullDocSnapshotAtTs` for both sides so the snapshots are structurally comparable.

---

## 10. Export system

All exports are generated client-side from the current in-memory state. The export selection (which codes to include) is controlled by the pip clicks in the sidebar and the status filter pills in the export panel.

| Format | Description |
|---|---|
| YAML·qc | qc-compatible bare list tree. No documentation fields. Applies `treeOverrides`. Intended as the new `codebook.yaml`. |
| YAML·full | Full YAML with all documentation fields. For archival or human reference. |
| MD | Markdown document with one section per code. |
| QMD | Quarto document (same as MD but with YAML front matter). |
| HTML | Standalone HTML page with formatted documentation. |
| CSV | One row per code, all fields as columns. |
| PDF | Landscape table using jsPDF + jsPDF-autotable (loaded from CDN). |

---

## 11. Server API

All endpoints are handled by `qc-reflect-server.py`. CORS headers are sent on every response.

### `GET /docs/load?path=<codebook_docs_path>`

Loads the JSON sidecar for the given path. The server derives the JSON path by replacing the file suffix with `.json`. Returns `{codes, overrides, changelog, ok}`. If no JSON exists but the YAML does, returns `{raw}`. If neither exists, returns `{codes: {}, overrides: {}, ok: true, new: true}`.

### `POST /docs/save`

Saves the current state to the JSON sidecar. Body:

```json
{
  "path":      "/absolute/path/to/codebook.docs.json",
  "data":      {"codes": {...}},
  "tree":      [...],
  "overrides": {...},
  "changelog": [...]
}
```

The `codes` object includes `_log` and `_baseline` for each code. The server writes a `saved` timestamp and logs the number of documented codes and moves.

### `GET /docs/load-json?path=<absolute_path>`

Loads any JSON file from an absolute path. Used by the Open panel to import a previously saved JSON file.

### `GET /docs/list-json?dir=<directory>`

Lists all JSON files in a directory that contain a `"codes"` key (i.e. are qc-codebook-docs format files). Returns `{files: [{path, name, mtime, size_kb}]}`, sorted by modification time descending.

### `GET /excerpts/fetch?code=<name>&json_dir=<path>`

Scans all `*.json` files in `json_dir` for entries matching `code`. Returns up to 30 excerpts as `{doc, line, text}` objects.

### `POST /logs/save`

Saves a reflect log. Body is a JSON object with an `id` field used to derive the filename.

### `GET /logs/list`

Returns all saved reflect logs as a JSON array.

### `ANY /api/*`

Proxies to Ollama at the configured URL. Used by qc-reflect.

---

## 12. Lua filter

The filter (`qc-codebook-docs-filter.lua`) runs once at `quarto render` time. It has no runtime role.

**`parse_codebook_yaml(text)`** — custom parser for qc's bare list format. Pandoc's built-in YAML parser mangles the indented list structure, so this handles it directly: walks lines, tracks indent level with a stack, produces a nested Lua table.

**`flatten_codebook(nodes, parent, depth)`** — converts the nested table into a flat list of `{name, parent, depth, prefix, children}` objects. This is what becomes `CODEBOOK_TREE` in the HTML.

**`build_use_counts(json_files)`** — reads all corpus JSON files and counts how many times each code appears, also tracking which documents it appears in. Becomes `CORPUS_COUNTS`.

**`to_json(v)`** — custom Lua→JSON serialiser. Handles strings, numbers, booleans, arrays, and objects. Escapes strings for safe embedding in a `<script>` block.

**`generate_html()`** — assembles the final HTML: inlines CSS and JS, emits the four JavaScript globals (`CODEBOOK_TREE`, `CORPUS_COUNTS`, `DOCS_DATA`, `DOCS_CONFIG`), and produces a self-contained file.

**Path resolution.** The filter locates the project root from `PANDOC_SCRIPT_FILE` (the filter's own absolute path), going up three directory levels. All other paths are resolved relative to this root.

---

## 13. Versioning system (design — not yet implemented)

### Motivation

The current system has a single active working pair: `codebook.yaml` (qc structure) and `codebook.docs.json` (rich metadata). This is sufficient for linear development but does not support:
- Deliberate versioning (marking stable states)
- Parallel development (e.g. exploring a thematic reorganisation without abandoning the current structure)
- Provenance (which version of which ancestor did this derive from?)

### Directory structure

Each named state of the code system lives in its own directory under `qc/versions/`:

```
qc/
  codebook.yaml              ← active version (what qc reads)
  codebook.docs.json         ← active version rich metadata (autosaved)
  versions/
    lineage.json             ← lookup table: directory → parent directory
    codebook_20260310-0900/
      codebook.yaml
      codebook.docs.json
      codebook.md            ← optional exported documentation
    codebook_20260312-1430/
    codebook-collaboration_20260316-1100_a3f9/
    codebook-collaboration_20260318-0930_7b2e/
    codebook-collaboration-datawork_20260321-1000_c81d/
```

### Naming convention

Every directory name follows the pattern:

```
[name-chain]_[YYYYMMDD-HHMM]_[hash4]
```

Where:
- **name-chain**: underscore-separated segments identifying the lineage path. Each segment is alphanumeric and hyphens only (no underscores within a segment). Case-preserved but case-insensitive for collision detection.
- **timestamp**: `YYYYMMDD-HHMM` of creation
- **hash4**: first 4 characters of the SHA1 of the parent directory's name. Present on all directories except root-line entries (which share an implicit common ancestor). Omitted on the very first directory in a name chain.

### Two acts, same mechanism

**Version** — continue the same name chain with a new timestamp:
```
codebook_20260310-0900
codebook_20260312-1430       ← same chain, new timestamp, no hash needed
                                (lineage.json records parent)
```

**Fork** — add a name segment:
```
codebook-collaboration_20260316-1100_a3f9   ← forked from codebook_20260312-1430
                                               hash a3f9 = SHA1("codebook_20260312-1430")[:4]
codebook-collaboration_20260318-0930_7b2e   ← forked from a different codebook_* state
                                               different hash signals different parent
```

The hash is a **hint** that two same-named directories have different parents. It is not a security mechanism — 4 characters is enough to distinguish siblings in a single project. The `lineage.json` provides the definitive record.

### `lineage.json`

```json
{
  "codebook_20260312-1430": {
    "parent": "codebook_20260310-0900",
    "note": ""
  },
  "codebook-collaboration_20260316-1100_a3f9": {
    "parent": "codebook_20260312-1430",
    "note": "Branching to foreground collaboration codes"
  },
  "codebook-collaboration_20260318-0930_7b2e": {
    "parent": "codebook_20260310-0900",
    "note": "Alternative branch from original"
  }
}
```

Full ancestry is recoverable by walking the `parent` chain. The hash in the directory name can be verified against `SHA1(parent_name)[:4]`.

### Terminology

| Term | Meaning |
|---|---|
| **Version** | A new directory in the same name chain (continuation). |
| **Fork** | A new directory with an additional name segment (divergence). |
| **Active** | The working pair (`codebook.yaml` + `codebook.docs.json`) that qc currently reads. |
| **Activate** | Updating `qc-reflect-config.yaml` (or qc's `settings.yaml`) to point to a different versioned directory. No symlinks. |

### Files per directory

Each versioned directory contains exactly:
- `codebook.yaml` — qc-compatible structure at that point in time
- `codebook.docs.json` — full rich metadata including `_log`, `_baseline`, `changelog`
- `codebook.md` — (optional) human-readable documentation export generated at version/fork time

### UI actions (not yet implemented)

The current Open/Save JSON panel would be replaced by a **Versions panel** with:
- **Version** — creates a new directory in the current name chain, copies current files, updates `lineage.json`
- **Fork** — prompts for a new name segment, creates child directory, computes hash, updates `lineage.json`
- **Browse** — lists all versioned directories with their lineage, creation date, and note
- **Activate** — updates config to point to the selected directory (no symlinks)

### Relationship to qc settings

qc reads its active codebook from the `codebook` key in `settings.yaml`. The Activate action in qc-codebook-docs should update this key to point to the chosen versioned directory's `codebook.yaml`. This means different researchers could have different local `settings.yaml` files pointing to their own forks, which is appropriate for collaborative qualitative work where different coders may be working with different versions of a code system simultaneously.

---

## 14. Relationship to qc-reflect

qc-reflect is a companion tool (separate from this codebase) that uses LLMs to support reflexive refinement of the code system. The intended data flow between the two tools:

**From qc-codebook-docs to qc-reflect:**
- `codebook.yaml` — the active code structure
- `codebook.docs.json` — the rich metadata, especially `scope`, `rationale`, and `usage_notes` for each code, which encode *intended* use
- The versioning history, which can show how the code system has evolved

**From qc-corpus (via qc) to qc-reflect:**
- `qc/json/*.json` — the corpus coding files, which encode *actual* use

**qc-reflect's core operation** is to compare intended use against actual use: does the scope of a code as documented match how it is actually applied in the corpus? It can then suggest mergers (two codes applied to similar passages), splits (one code applied to conceptually distinct passages), new codes (patterns in the corpus not covered by existing codes), and triangulations (codes that co-occur systematically).

The rich metadata produced by qc-codebook-docs — particularly `rationale` (why a code exists relative to its siblings) and `usage_notes` (what to exclude, common confusions) — is the primary semantic input to qc-reflect's comparison logic. A code with thorough documentation gives qc-reflect more to work with than a bare name.

---

## 15. Known limitations and pending work

**Versioning not implemented.** The design is complete (§13) but no server endpoints, UI, or file management code exists yet. The current Open/Save JSON panel is a temporary mechanism.

**Re-render required for structural changes.** Adding or renaming codes in `codebook.yaml` (via the native qc tool) requires a `quarto render` before the changes appear in qc-codebook-docs. There is no live reload or watch mode.

**Parent reassignment UI.** Reparenting is done through the Parent dropdown in the Documentation tab, which lists all non-cycling candidates. This works but is less ergonomic than the removed drag-and-drop for large trees. A future option could be a search-filtered parent selector.

**Export YAML does not update `codebook.yaml`.** The YAML·qc export produces a valid qc-compatible file, but the user must manually copy it to `codebook.yaml` and re-render. There is no "promote to active" action.

**`qc-codebook-docs.yaml` seed file.** This file documents a schema (including a `schemes` block for proposed operations) that is no longer used. The schemes system was removed in an early iteration. The file is kept as reference but is not read at runtime.

**jsPDF loaded from CDN.** The PDF export depends on jsPDF and jsPDF-autotable loaded from `cdnjs.cloudflare.com`. This requires a network connection at page load time, which may be unavailable in fully offline research environments.

**Single-file HTML.** The rendered app is a fully self-contained HTML file with inlined CSS and JS (~250 KB uncompressed). This is intentional for portability but means the file must be re-rendered to pick up JS/CSS changes.
