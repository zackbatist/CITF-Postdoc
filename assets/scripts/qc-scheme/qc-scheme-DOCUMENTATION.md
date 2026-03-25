# qc-scheme — Project Documentation

*Last updated: 2026-03-24*

---

## Table of contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [System context](#2-system-context)
3. [Architecture overview](#3-architecture-overview)
4. [File inventory](#4-file-inventory)
5. [Deployment and startup](#5-deployment-and-startup)
6. [Configuration](#6-configuration)
7. [Data model](#7-data-model)
8. [Application state](#8-application-state)
9. [UI reference](#9-ui-reference)
10. [Versioning system](#10-versioning-system)
11. [History and diffing system](#11-history-and-diffing-system)
12. [Export system](#12-export-system)
13. [Server API](#13-server-api)
14. [Lua filter](#14-lua-filter)
15. [Relationship to qc-reflect](#15-relationship-to-qc-reflect)
16. [Known limitations and pending work](#16-known-limitations-and-pending-work)

---

## 1. Purpose and scope

qc-scheme serves two related purposes within a broader qualitative coding workflow.

**Rich metadata for a structurally-constrained code system.** The `qc` tool stores code systems as bare YAML trees — code names and parent/child relationships, nothing more. qc-scheme is a parallel documentation layer that adds what `qc` cannot store: scope definitions, rationale, usage notes, provenance, status, and canonical corpus examples. This metadata is kept in a JSON sidecar file and never mixed into the YAML itself, preserving full qc compatibility.

**Reflexive code system development.** As a researcher works with a code system, codes are introduced, their scope shifts, some are deprecated, others are reorganised. qc-scheme makes this process deliberate and auditable: per-code edit history, a unified document-level event feed, structural diffs between states, and a versioning system that captures named snapshots and named divergent lines of development.

**Feeding qc-reflect.** The rich metadata produced here — especially `scope`, `rationale`, and `usage_notes` — is structured input for qc-reflect, an LLM-assisted companion tool that compares *intended* code use (as documented here) against *actual* use (from the corpus coding files). This comparison drives reflexive suggestions: mergers, splits, new codes, triangulations.

---

## 2. System context

```
┌─────────────────────────────────────────────────────────────────┐
│                        qc ecosystem                             │
│                                                                 │
│  ┌──────────────┐    codebook.yaml    ┌──────────────────────┐  │
│  │     qc       │ ──────────────────► │  qc-scheme   │  │
│  │  (CLI tool)  │                     │  (this tool)         │  │
│  │              │ ◄────────────────── │                      │  │
│  └──────────────┘   YAML export (opt) │  codebook.docs.json  │  │
│        │                              └──────────┬───────────┘  │
│        │ qc/json/*.json                          │              │
│        ▼                                         │ scope,       │
│  ┌──────────────┐                                │ rationale,   │
│  │  corpus      │                                │ usage_notes  │
│  │  coding      │                                ▼              │
│  │  files       │                     ┌──────────────────────┐  │
│  └──────────────┘                     │     qc-reflect       │  │
│        │ actual use                   │  (LLM-assisted)      │  │
│        └─────────────────────────────►│  intended vs actual  │  │
│                                       └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

qc-scheme sits between qc (which owns the code structure) and qc-reflect (which reasons about it). It enriches the code system with documentation and maintains a versioned history of how that documentation and structure evolve over time.

---

## 3. Architecture overview

### File layout

```
project root/
├── qc-reflect-config.yaml              ← shared config (port, paths)
├── qc-reflect-server.py                ← local HTTP server + API
├── qc-scheme.qmd                ← Quarto source (invokes Lua filter)
│
├── assets/scripts/qc-scheme/
│   ├── qc-scheme-filter.lua     ← bakes data into HTML at render time
│   ├── qc-scheme.js             ← entire client-side application (~2650 lines)
│   └── qc-scheme.css            ← styles (dark + light mode)
│
└── qc/
    ├── codebook.yaml                   ← active qc codebook (tree structure)
    ├── codebook.docs.json              ← rich metadata sidecar (autosaved)
    ├── .working_parent                 ← tracks which versioned dir is open
    ├── qc-scheme.html           ← rendered app (output of quarto render)
    ├── json/                           ← per-document corpus coding files
    └── versions/                       ← named snapshots and forks
        ├── lineage.json
        ├── codebook_20260310-0900/
        ├── codebook_20260312-1430/
        ├── codebook-collaboration_20260316-1100_a3f9/
        └── …
```

### Two-phase operation

```
RENDER TIME                              RUNTIME
───────────                              ───────
quarto render                            browser loads HTML
     │                                        │
     ▼                                        ▼
Lua filter reads:                        JS app calls GET /docs/load
  codebook.yaml        ──bakes──►            │
  qc/json/*.json       into HTML         loads codebook.docs.json
  qc-scheme.js                        │
  qc-scheme.css                       ▼
     │                                   user edits docs
     ▼                                        │
qc/qc-scheme.html                 scheduleSave() 800ms
                                              │
                                         POST /docs/save
                                              │
                                         codebook.docs.json updated
```

**What requires re-render vs what does not:**

| Change | Re-render needed? |
|---|---|
| Codes added/removed/renamed in `codebook.yaml` | Yes |
| Corpus `qc/json/` files updated | Yes (use counts stale) |
| JS or CSS source files changed | Yes |
| Documentation fields edited (scope, rationale, etc.) | No |
| Status changes | No |
| Parent moves via UI | No |
| Version or fork created | No |

---

## 4. File inventory

### `qc-scheme.qmd`
Minimal Quarto document. Its only purpose is to invoke the Lua filter. Contains `execute: enabled: false` to prevent Quarto from running any pre-render code execution steps for this file.

### `assets/scripts/qc-scheme/qc-scheme-filter.lua`
Pandoc filter, runs once at render time. Parses `codebook.yaml` into a flat node list, counts per-code corpus usage from `qc/json/`, inlines CSS and JS, and writes a self-contained HTML file to `qc/qc-scheme.html`.

### `assets/scripts/qc-scheme/qc-scheme.js`
The entire client-side application. Single IIFE, no framework, no build step. Key sections:

- State initialisation and O(1) index management
- Changelog helpers (`clDoc`, `clCode`)
- Save / load / import functions
- Versioning functions (`loadVersions`, `createVersion`)
- Export builders (YAML, MD, QMD, HTML, CSV, PDF)
- Surgical render functions (preserve sidebar scroll across code selection)
- Topbar, sidebar, editor builders
- Versions panel and Open panel
- History and diff system

### `assets/scripts/qc-scheme/qc-scheme.css`
All styles. IBM Plex Sans + IBM Plex Mono from Google Fonts. CSS custom properties for theming. Dark mode is default; `body.light-mode` activates the light theme. No preprocessor.

### `qc-reflect-server.py`
Local HTTP server. Pure Python stdlib, no external dependencies. Serves static files from `qc/`; proxies `/api/*` to Ollama; handles all persistence and versioning endpoints. Creates `qc/versions/` on startup if absent.

### `qc-reflect-config.yaml`
Shared configuration file (user-created). Relevant fields:

```yaml
directories:
  output_dir: qc        # where codebook.yaml and codebook.docs.json live
  json_dir:   qc/json   # corpus coding JSON files

server:
  port: 8080
  url:  http://localhost:11434   # Ollama base URL
```

---

## 5. Deployment and startup

**Prerequisites:** Quarto, Python 3.9+ (stdlib only), Pandoc (bundled with Quarto). Ollama optional (only needed for qc-reflect features).

```bash
# First time, or after codebook.yaml changes:
quarto render qc-scheme.qmd

# Start the server (from project root):
python3 qc-reflect-server.py

# Open in browser:
open http://localhost:8080/qc-scheme.html
```

**Migrating from a previous install** — if you have an existing `qc/qc-scheme.json`, copy it to the current canonical path before starting:

```bash
cp qc/qc-scheme.json qc/codebook.docs.json
```

---

## 6. Configuration

The Lua filter resolves the project root from `PANDOC_SCRIPT_FILE` (its own absolute path, ascending three directory levels). The JS app receives its configuration via the `DOCS_CONFIG` global injected at render time:

```javascript
const DOCS_CONFIG = {
  server_port:        8080,
  scheme_path: "/absolute/path/to/qc/codebook.docs.json",
  json_dir:           "/absolute/path/to/qc/json",
};
```

---

## 7. Data model

### `codebook.yaml` — read-only at runtime

qc-compatible bare list format. Parsed at render time; baked into the HTML as `CODEBOOK_TREE`. Never written by this tool.

```yaml
- ThematicConcept:
  - SpecificCode
  - AnotherCode:
    - Subcode
- StandaloneCode
```

### `codebook.docs.json` — live read/write

The rich metadata sidecar. Autosaved every 800 ms after any change.

```json
{
  "saved": "2026-03-24T14:22:05.123Z",
  "codes": {
    "CodeName": {
      "status":      "active | experimental | deprecated | ''",
      "scope":       "What this code captures",
      "rationale":   "Why this code exists; how it differs from siblings",
      "usage_notes": "Edge cases, exclusions, confusions",
      "provenance":  "When created, split from, merged with",
      "examples":    [{"doc": "filename", "line": 42, "note": "annotation"}],
      "_log": [
        {"ts": "ISO8601", "field": "scope", "from": "old value", "to": "new value"}
      ],
      "_baseline": {
        "status": "", "scope": "", "rationale": "",
        "usage_notes": "", "provenance": "", "parent": ""
      }
    }
  },
  "tree":      [...],
  "overrides": {"CodeName": "NewParentName"},
  "changelog": [
    {"ts": "ISO8601", "type": "open|save|move|bulk-status", "detail": "…"}
  ]
}
```

**`_log`** — append-only per-code edit history. Full values stored, no truncation. Written by `clCode()` on every field change via `setDoc()`.

**`_baseline`** — snapshot of field values at the time a file is first loaded. Serves as the "before everything" reference for history diffs. Written once when a file is loaded if not already present.

**`overrides`** — parent reassignments made within the app. Layered over the baked `CODEBOOK_TREE` without modifying the original YAML.

**`changelog`** — document-level structural events (opens, saves, parent moves, bulk status changes).

### Corpus JSON files (`qc/json/*.json`) — read-only

Written by qc. Each file is a list of coding entries used for use-count baking (at render time) and excerpt display (fetched on demand from the server).

```json
[{"code": "CodeName", "document": "filename", "line": 42, "text": "…"}]
```

### Versioned directories (`qc/versions/*/`)

Each snapshot directory contains:
- `codebook.yaml` — qc-compatible structure, copied from live working file at snapshot time
- `codebook.docs.json` — full rich metadata including `_log`, `_baseline`, `changelog`
- `codebook.md` — human-readable tree outline generated at version/fork time

### `qc/versions/lineage.json`

Maps each versioned directory name to its parent directory and an optional prose note:

```json
{
  "codebook_20260312-1430": {
    "parent": "codebook_20260310-0900",
    "note": ""
  },
  "codebook-collaboration_20260316-1100_f2b8": {
    "parent": "codebook_20260312-1430",
    "note": "Foregrounding collaboration codes"
  }
}
```

### `qc/.working_parent`

Plain text file containing the directory name of the most recently loaded or created versioned directory. Used by the server to determine the parent chain for the next version or fork without any client-side state dependency.

---

## 8. Application state

Key runtime state fields:

| Field | Type | Description |
|---|---|---|
| `docs` | object | `{codes: {...}}` — live rich metadata |
| `selected` | string\|null | Currently selected code name |
| `multiSelected` | Set | Codes selected via Cmd/Ctrl or Shift+click |
| `tab` | string | Active editor tab: `doc`, `examples`, `history` |
| `expanded` | object | `{name: bool}` — which tree nodes are expanded |
| `treeOverrides` | object | Parent reassignments: `{name: newParent}` |
| `exportSelected` | Set | Codes included in export (pip click controls) |
| `statusInclude` | Set | Status values included in export filter |
| `changelog` | array | Document-level event log |
| `histSel` | array | Up to 2 selected history entry keys for diff |
| `histDiffMode` | string | `fields` or `json` |
| `docHistoryOpen` | bool | Whether editor shows unified history feed |
| `saveStatus` | string | `saved`, `unsaved`, `saving`, `error` |
| `lightMode` | bool | Light mode CSS class active |
| `openedDocsPath` | string | Absolute path of currently loaded docs JSON |
| `openedVersionDir` | string | Directory name of currently open versioned state |
| `versionsData` | object\|null | Cached `/versions/list` response |
| `versionLog` | array | Session log of version/fork actions `[{ts, msg, ok}]` |
| `openSearch` | string | Current search query in the Open panel |

**O(1) index caches** — rebuilt by `rebuildIndices()` whenever `treeOverrides` changes:

| Variable | Description |
|---|---|
| `_childrenIdx` | `{name: [childName, …]}` |
| `_parentIdx` | `{name: parentName\|''}` |
| `_depthIdx` | `{name: depth}` |
| `_subtreeCache` | `{name: [allDescendants]}` — invalidated on rebuild |

---

## 9. UI reference

### Overall layout

```
┌─ topbar ──────────────────────────────────────────────────────────────────┐
│ qc-scheme │ N codes · N documented  [chain-name]  [History]        │
│                                            ☾  Saved  [Open]  [Versions]   │
├─ [Open panel or Versions panel — shown inline below topbar when active] ───┤
├─ sidebar ─────────────────────┬─ editor ──────────────────────────────────┤
│ [search]                      │  CodeName                                  │
│                               │  depth N · under Parent · N uses           │
│ ● CodeName ·                  ├────────────┬──────────┬────────────────────┤
│ ▶ ● ParentCode                │ Doc tab    │ Examples │ History (N)        │
│     ● ChildCode ·             ├────────────┴──────────┴────────────────────┤
│ ● AnotherCode                 │  [tab content]                             │
│ ─────────────────────────     │                                            │
│ [export panel]                │                                            │
└───────────────────────────────┴────────────────────────────────────────────┘
```

### Topbar (left to right)

| Element | Description |
|---|---|
| Brand | `qc-scheme` |
| Stat | `N codes · N documented · N moved · N selected` |
| Version badge | Chain name of currently open version (e.g. `codebook-collaboration`); only shown when a versioned file is open |
| History | Toggles unified history feed in editor panel |
| ☾ / ☀ | Dark/light mode toggle |
| Save status | `Saved` / `Unsaved` / `Saving…` / `Save error` |
| Open | Opens the Open panel |
| Versions | Opens the Versions panel |

### Sidebar tree

Each row: pip SVG (click to toggle export inclusion; ring colour = status) · code name · faint red dot if undocumented · use count (leaf) or selected/total count (parent).

- **Click**: selects code, opens editor. Sidebar scroll position preserved.
- **Click on expandable node**: also toggles expand/collapse.
- **⌘/Ctrl+click**: adds to multi-selection.
- **Shift+click**: range select within visible tree.

### Export panel (sidebar footer)

Status filter pills (click to include/exclude from export) → format chips → Export button. The Export button pulses when there are unsaved changes.

### Documentation tab

Six fields: Status (dropdown), Parent (dropdown, all non-cycling candidates), Scope, Rationale, Usage notes, History/Provenance. All text fields autosave 800 ms after each keystroke via `setDoc()` → `clCode()` → `scheduleSave()`.

### Examples tab

Up to 30 corpus excerpts for the selected code, fetched on demand from the server. Excerpts can be pinned as canonical examples stored in `docs.codes[name].examples`.

### History tab (per-code)

```
┌─ list (newest first) ──────────┬─ diff pane ──────────────────────────┐
│                                │                                       │
│ [teal A] 2026-03-10 14:22      │  Earlier 2026-03-10 14:20  →         │
│   Scope  old text → new text…  │  Later   2026-03-10 14:22            │
│                                │  [Fields] [JSON]                     │
│ [amber B] 2026-03-10 14:20     │                                      │
│   Status  '' → active          │  Scope                               │
│                                │  A — before  ░░░░░░░░ (red)         │
│ Before 2026-03-10              │  B — after   ░░░░░░░░ (green)       │
│   state when first loaded      │                                      │
└────────────────────────────────┴───────────────────────────────────────┘
```

Click one entry to inspect its full field state. Click two to diff. Teal = A (earlier), amber = B (later) — ordered by timestamp regardless of click order.

### Document History (topbar History button)

Unified feed merging all per-code `_log` entries and all `changelog` events, sorted newest first. Each entry shows the code name (for field edits) or event type (for structural events), with a from→to preview. Selecting two entries diffs full document snapshots at those timestamps.

### Versions panel

```
┌─ Save version row ─────────────────────────────────────────────────────┐
│ [Save version]  [note textarea…                                      ] │
├─ Fork row ─────────────────────────────────────────────────────────────┤
│ Fork into new line:  [name input          ] [Fork]                     │
├─ Session log ──────────────────────────────────────────────────────────┤
│ 14:32  Saved: codebook_20260324-1432                                   │
│ 14:28  Forked: codebook-collaboration_20260324-1428_a3f9               │
├─ Version table (scrollable) ───────────────────────────────────────────┤
│ Name chain               Timestamp      Hash  Parent  Note  [Action]  │
│ codebook-collaboration   20260324-1428  a3f9  …1430         [✓ open]  │
│ codebook                 20260312-1430  —     …0900         [Open]    │
│ codebook                 20260310-0900  —     —             [Open]    │
└────────────────────────────────────────────────────────────────────────┘
```

**Save version** — creates a new directory in the current name chain. Note text is optional.

**Fork** — creates a new name chain. Requires a name segment (e.g. `collaboration` → `codebook-collaboration_…`).

**Open** button in the table — loads that version's `codebook.docs.json` into the editor. The autosave immediately copies the loaded content to the live working `codebook.docs.json`. `.working_parent` is updated so the next save/fork chains from that version.

### Open panel

```
┌─ search ───────────────────────────────────────────────────────────────┐
│ [Filter by name, timestamp, or note…                                 ] │
├────────────────────────────────────────────────────────────────────────┤
│ [Load]  codebook-collaboration  20260324-1428  a3f9                    │
│ [✓   ]  codebook                20260312-1430       currently open    │
│ [Load]  codebook                20260310-0900                          │
└────────────────────────────────────────────────────────────────────────┘
```

Type to filter by any part of the name chain, timestamp, hash, or note. Load button is on the left. The `✓` indicator marks the currently loaded version.

### Multi-select editor

Triggered when two or more codes are selected. Provides bulk status change, bulk parent reassignment, and a view toggle (table / cards). Table view is sortable by any column; clicking any row navigates to that code's individual editor.

---

## 10. Versioning system

### Core concept

The versioning system captures named states of the code system — both as linear continuations (versions) and as divergent lines of development (forks). All saves and forks always snapshot the live working files (`qc/codebook.docs.json` and `qc/codebook.yaml`), regardless of which past version is currently loaded in the editor.

### The working cycle

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   Edit in the app                                                   │
│          │                                                          │
│          ▼  (every 800ms)                                           │
│   qc/codebook.docs.json  ◄──── always the live autosave target      │
│          │                                                          │
│          ├── [Save version] ──────────────────────────────────────► │
│          │   snapshot → qc/versions/codebook_TIMESTAMP/             │
│          │   .working_parent ← codebook_TIMESTAMP                   │
│          │   next save chains from here                             │
│          │                                                          │
│          └── [Fork "name"] ───────────────────────────────────────► │
│              snapshot → qc/versions/codebook-name_TIMESTAMP_HASH/   │
│              .working_parent ← codebook-name_TIMESTAMP_HASH         │
│              next save chains from this fork                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Directory naming

```
Versions (same chain):
  codebook_20260310-0900
  codebook_20260312-1430
  codebook_20260315-0800

Forks (new chain segment + hash):
  codebook-collaboration_20260316-1100_f2b8
  codebook-collaboration_20260320-1445_9c1d   ← version of fork
  codebook-collaboration-datawork_20260321-1000_7a3f  ← fork of fork

  codebook-theory_20260313-0900_a3f9   ← different fork from codebook_20260312-1430
```

| Component | Meaning |
|---|---|
| name-chain | Hyphen-joined segments. `codebook` is the root. Each fork appends a segment. |
| timestamp | `YYYYMMDD-HHMM` — creation time |
| hash4 | First 4 hex chars of `SHA1(parent_directory_name)`. Only on forks. Two fork directories with different hashes came from different parent states. |

### Example lineage tree

```
codebook_20260310-0900
    │
    ├── codebook_20260312-1430          ← version
    │       │
    │       ├── codebook_20260315-0800  ← version
    │       │
    │       ├── codebook-collaboration_20260316-1100_f2b8   ← fork
    │       │       │
    │       │       └── codebook-collaboration_20260320-1445_9c1d  ← version of fork
    │       │               │
    │       │               └── codebook-collaboration-datawork_20260321-1000_7a3f
    │       │
    │       └── codebook-theory_20260313-0900_a3f9   ← separate fork from same parent
    │
    └── codebook_20260318-0800          ← version (from original)
```

Directories sharing a hash4 were forked from the same parent state. Directories with different hash4 values — even if they have the same name chain — came from different parents. The `lineage.json` file provides the prose record; the hash provides the visual hint in the directory listing.

### `.working_parent` pointer

The server writes `qc/.working_parent` in two situations:

1. **When `GET /docs/load-json` detects the loaded file is inside `qc/versions/`** — sets it to that version's directory name.
2. **When `POST /versions/create` succeeds** — sets it to the newly created directory name.

When `POST /versions/create` runs, it reads `.working_parent` to determine the parent for naming the new directory. This means the chain advances correctly through both the Open panel (load an older version → chain from there) and the Versions panel (save/fork → chain continues automatically).

### Switching lines of development

Open the Open panel → filter the list → click **Load** on any past version. The app loads that version's `codebook.docs.json` into the editor. The 800 ms autosave writes this content to `qc/codebook.docs.json`. `.working_parent` is updated. All subsequent saves and forks chain from that version.

Important: `CODEBOOK_TREE` is baked at render time and does not change when you load a different version. Parent overrides from the loaded file are applied immediately. If the loaded version has a structurally different `codebook.yaml` (different codes or hierarchy), a `quarto render` is required to reflect those structural differences in the tree.

---

## 11. History and diffing system

### Two logs, one feed

```
Per-code edits (_log)          Document events (changelog)
─────────────────────          ───────────────────────────
setDoc() → clCode()            clDoc() writes:
writes per field change:         - open
  {ts, field, from, to}          - save
                                 - move
                                 - bulk-status

          Both merged into the unified History feed
          ──────────────────────────────────────────
          sorted newest-first; any two entries selectable for diff
```

### Per-code History tab

Each code has its own log visible in its History tab. The bottom entry is "Before [date]" — the `_baseline` snapshot written when the file was first loaded. New entries appear at the top as fields are edited.

### Unified history feed (topbar History)

All per-code `_log` entries from all codes, plus all `changelog` events, merged and sorted newest first. Clicking one entry inspects the full field state or event detail at that point. Clicking two entries diffs them using `fullDocSnapshotAtTs()` — a complete reconstruction of every code's fields and parent assignments at each timestamp.

### Diff display

**A/B colour coding:** first clicked entry = teal (A), second = amber (B). The diff always orders earlier → later by timestamp regardless of click order.

**Fields view** (same-code or same-type pairs):

```
Scope
  A — before  ░░░░░░░░░░░░░░░░  (red background)
  B — after   ░░░░░░░░░░░░░░░░  (green background)

Rationale
  unchanged text  (dimmed)
```

**JSON view** (all pairs): full serialised document state diff. Accordion collapses long unchanged runs (triggered when unchanged context lines exceed 30). No size limit on the LCS algorithm.

### Key functions

| Function | Description |
|---|---|
| `clCode(code, field, from, to)` | Append field edit to `_log`. Full values, no truncation. |
| `clDoc(type, detail)` | Append structural event to `changelog`. |
| `codeRecordAtIdx(rawLog, baseline, logIdx)` | Reconstruct full field state at a log index. |
| `fullDocSnapshotAtTs(ts)` | Reconstruct complete document state at a timestamp. |
| `buildCodeJsonDiff(a, b)` | Plain full diff for small records (no accordion). |
| `buildDocJsonDiff(a, b)` | Accordion diff for large overrides maps. |
| `lcs(al, bl)` | Iterative LCS using `Uint16Array`. No line-count limit. |

---

## 12. Export system

All exports are generated client-side from the current in-memory state. Export selection is controlled by pip clicks in the sidebar tree (per-code or per-subtree) and the status filter pills.

| Format | Description |
|---|---|
| YAML | Full YAML with all documentation fields. For archival or human reference. |
| MD | Markdown document, one section per code. |
| QMD | Quarto document (MD with YAML front matter). |
| HTML | Standalone HTML page with formatted documentation. |
| CSV | One row per code, all fields as columns. Sortable on import. |
| PDF | Landscape table via jsPDF + jsPDF-autotable (loaded from CDN). |

The qc-compatible bare-list YAML export (previously "YAML·qc") has been removed — versioned snapshots already provide `codebook.yaml` at every meaningful state.

---

## 13. Server API

All endpoints are in `qc-reflect-server.py`. CORS headers on every response. `SERVE_DIR` = resolved `qc/` directory. `VERSIONS_DIR` = `SERVE_DIR/versions/` (created on startup).

### Docs persistence

| Endpoint | Description |
|---|---|
| `GET /docs/load?path=X` | Load `codebook.docs.json`; returns `{codes, overrides, changelog, ok}` |
| `POST /docs/save` | Save to `codebook.docs.json`; body: `{path, data, tree, overrides, changelog}` |
| `GET /docs/load-json?path=X` | Load any JSON by absolute path; if inside `VERSIONS_DIR`, writes `.working_parent` and returns `active_dir` |
| `GET /docs/list-json?dir=X` | List `codebook.docs.json` files in a directory |

### Versioning

| Endpoint | Description |
|---|---|
| `GET /versions/list` | Scan `VERSIONS_DIR`; parse names; read `lineage.json`; return `{versions, docs_paths, ok}` |
| `GET /versions/lineage` | Return `lineage.json` directly |
| `POST /versions/create` | Create a new versioned directory; always copies from live working files; reads `.working_parent` for chain; writes `.working_parent` to new dir on success |

**`/versions/create` naming logic:**

```
.working_parent absent:
  version → codebook_TIMESTAMP
  fork    → codebook-{segment}_TIMESTAMP

.working_parent = "codebook_X":
  version → codebook_TIMESTAMP             (same chain, no hash)
  fork    → codebook-{segment}_TIMESTAMP_HASH4   (new chain + hash of parent name)
```

### Other

| Endpoint | Description |
|---|---|
| `GET /excerpts/fetch?code=X&json_dir=Y` | Up to 30 corpus excerpts for a code |
| `POST /logs/save` | Save a reflect log JSON |
| `GET /logs/list` | List all reflect logs |
| `ANY /api/*` | Proxy to Ollama |

---

## 14. Lua filter

Runs once at `quarto render` time. No runtime role.

**Key functions:**

`parse_codebook_yaml(text)` — custom parser for qc's bare list YAML format (Pandoc's built-in parser mangles it). Produces a nested Lua table.

`flatten_codebook(nodes, parent, depth)` — converts to a flat list of `{name, parent, depth, prefix, children}` objects. Becomes `CODEBOOK_TREE`.

`build_use_counts(json_files)` — counts per-code occurrences across all corpus JSON files. Becomes `CORPUS_COUNTS`.

`to_json(v)` — custom Lua→JSON serialiser safe for embedding in `<script>` blocks.

`generate_html()` — assembles the final HTML: inlines CSS and JS, emits `CODEBOOK_TREE`, `CORPUS_COUNTS`, `DOCS_DATA`, `DOCS_CONFIG`.

**Path resolution:** `SCHEME_JSON` is derived from `{output_dir}/codebook.docs.json`. Project root is resolved from `PANDOC_SCRIPT_FILE`, ascending three directory levels.

---

## 15. Relationship to qc-reflect

```
qc-scheme                         qc-reflect
────────────────                         ──────────
codebook.yaml           ──────────────►  tree structure
codebook.docs.json
  ├── scope             ──────────────►  intended use
  ├── rationale                          of each code
  └── usage_notes                              │
                                               │  compare
qc/json/*.json          ──────────────►  actual use ──►  suggestions:
  (corpus coding)                        from corpus      merge, split,
                                                          new codes,
versions/               ──────────────►  evolution of    triangulations
  lineage.json                           code system
```

**Intended vs actual use** is the core comparison: does the scope and rationale of a code match how it is applied in the corpus? Codes with thorough documentation — especially `rationale` (why a code exists relative to its siblings) and `usage_notes` (what to exclude, common confusions) — give qc-reflect more precise signal.

**Version history** provides a temporal dimension: qc-reflect can examine how code boundaries shifted across named versions, which is itself evidence about the analytical process and useful context for reflexive interpretation.

---

## 16. Known limitations and pending work

**Structural changes require re-render.** Adding, removing, or renaming codes in `codebook.yaml` via the qc CLI requires `quarto render` before the changes appear. No live reload or watch mode.

**Loading a version with a different tree structure.** When a loaded version's `codebook.yaml` has a different set of codes or hierarchy than the currently baked HTML, documentation loads correctly but the tree display reflects the baked structure. Parent overrides apply immediately; a re-render is required for full structural synchronisation.

**YAML export does not update `codebook.yaml`.** The YAML export reflects current `treeOverrides` but the user must manually copy it to `codebook.yaml` and re-render to make structural moves durable in qc.

**Parent reassignment UX.** Reparenting is done through the Parent dropdown in the Documentation tab. For large trees with many codes, scanning the full list is slow. A search-filtered parent selector would improve this.

**jsPDF loaded from CDN.** PDF export requires a network connection at page load time for `cdnjs.cloudflare.com`. Unavailable in fully offline research environments.

**Single-file HTML.** The rendered app inlines all CSS and JS (~260 KB uncompressed). Intentional for portability, but means a re-render is required for any code or style change.

**Double JSON generation during render.** If the project-level `_quarto.yml` has a pre-render script that runs `qc`, it may execute twice when rendering this QMD. The `execute: enabled: false` flag in the QMD suppresses Quarto's own code execution, but project-level pre-render hooks are outside its control. The pre-render script should check which file is being rendered and skip if it is `qc-scheme.qmd`.
