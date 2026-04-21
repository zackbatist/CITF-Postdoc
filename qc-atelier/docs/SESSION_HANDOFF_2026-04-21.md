# qc-atelier — Session Handoff
*2026-04-21 12:48*

## What was done this session

### Committed earlier today
- Unified documentation into single `qc-atelier-DOCUMENTATION.qmd`
- qc-refactor fully implemented (rename, merge, move, deprecate)
- Shared path resolution fixed across all active filters (pwd fallback)
- qc-viz meta_to_lua coercion bug fixed (deep_stringify)
- qc-scheme: snapshots as archives, unified History tab
- qc-scheme: localStorage migration shim (qccd.* → qc.scheme.*)
- qc-scheme: visibilitychange/pagehide flush added
- Dead code removed: buildChangelogPanel, getItemSnapshot
- Error boundary added to render()
- Nav bar: qc-atelier brand links to / in all filters
- qc-viz-filter: sections and code_tags sub-tables restored

### Committed later today
```
fix: nav brand as link, export pill button, sidebar height fix

- All filters: convert nav brand from <span> to <a href="/">
- qc-viz-filter.lua: restore sections and code_tags config stubs
- qc-scheme.css: sidebar max-width 800px, remove overflow: hidden
- qc-scheme.css: min-height: 0 on .split and .tree
- qc-scheme.css: max-height: calc(100vh - 110px) on .sidebar
- qc-scheme.css: .ep-export-btn, .topbar-snapshot-dirname, .rec-feed-dirname
- qc-scheme.js: restore wouldCycle and reparent
- qc-scheme.js: export pill button replaces actRow button
- qc-scheme.js: null guard in sidebar search onInput
```

### Uncommitted — directory restructure
Commit message:
```
refactor: consolidate assets/scripts/ into qc-atelier/

Move all tool scripts from assets/scripts/{tool}/ to qc-atelier/{tool}/.
Move shared scripts to qc-atelier/shared/.
Move qc-viz-pre-render.sh to qc-atelier/shared/qc-pre-render.sh.
Update all path references in filters, QMDs, server, and config.
Add qc-atelier/docs/ for documentation.
```

**To apply in your project:**
```bash
mkdir -p qc-atelier/shared qc-atelier/qc-scheme qc-atelier/qc-refactor qc-atelier/qc-viz qc-atelier/qc-reflect qc-atelier/docs

mv assets/scripts/shared/qc-shared.lua        qc-atelier/shared/
mv assets/scripts/shared/qc-shared.css        qc-atelier/shared/
mv assets/scripts/qc-viz/qc-viz-pre-render.sh qc-atelier/shared/qc-pre-render.sh

mv assets/scripts/qc-scheme/qc-scheme-filter.lua  qc-atelier/qc-scheme/
mv assets/scripts/qc-scheme/qc-scheme.js           qc-atelier/qc-scheme/
mv assets/scripts/qc-scheme/qc-scheme.css          qc-atelier/qc-scheme/

mv assets/scripts/qc-refactor/qc-refactor-filter.lua qc-atelier/qc-refactor/
mv assets/scripts/qc-refactor/qc-refactor.js          qc-atelier/qc-refactor/
mv assets/scripts/qc-refactor/qc-refactor.css         qc-atelier/qc-refactor/

mv assets/scripts/qc-viz/qc-viz-filter.lua qc-atelier/qc-viz/
mv assets/scripts/qc-viz/qc-viz.js         qc-atelier/qc-viz/
mv assets/scripts/qc-viz/qc-viz.css        qc-atelier/qc-viz/

mv assets/scripts/qc-reflect/qc-reflect-filter.lua qc-atelier/qc-reflect/
mv assets/scripts/qc-reflect/qc-reflect.js          qc-atelier/qc-reflect/
mv assets/scripts/qc-reflect/qc-reflect.css         qc-atelier/qc-reflect/

mv qc-atelier-DOCUMENTATION.qmd qc-atelier/docs/
mv SESSION_HANDOFF*.md qc-atelier/docs/

rm -rf assets/scripts/

# Replace source files with updated versions from the zip output, then:
quarto render qc-scheme.qmd
quarto render qc-refactor.qmd
quarto render qc-viz.qmd
```

## New directory structure
```
project root/
├── qc-atelier-config.yaml
├── qc-atelier-server.py
├── qc-scheme.qmd
├── qc-viz.qmd
├── qc-refactor.qmd
├── qc-reflect.qmd
├── qc-atelier/
│   ├── shared/
│   │   ├── qc-shared.lua
│   │   ├── qc-shared.css
│   │   └── qc-pre-render.sh
│   ├── qc-scheme/
│   │   ├── qc-scheme-filter.lua
│   │   ├── qc-scheme.js
│   │   └── qc-scheme.css
│   ├── qc-refactor/
│   │   ├── qc-refactor-filter.lua
│   │   ├── qc-refactor.js
│   │   └── qc-refactor.css
│   ├── qc-viz/
│   │   ├── qc-viz-filter.lua
│   │   ├── qc-viz.js
│   │   └── qc-viz.css
│   ├── qc-reflect/
│   │   ├── qc-reflect-filter.lua
│   │   ├── qc-reflect.js
│   │   └── qc-reflect.css
│   └── docs/
│       ├── qc-atelier-DOCUMENTATION.qmd
│       └── SESSION_HANDOFF_YYYY-MM-DD.md
└── qc/
    ├── codebook.yaml
    ├── codebook.json
    ├── index.html
    ├── corpus/
    ├── json/
    └── snapshots/
```

## Pending / deferred
- **Code audit** — dead: buildDocsJson, buildDocDiffPane, buildSnapshotsPanel
- **qc-refactor end-to-end test** — highest priority functional risk
- **Re-render after qc-refactor execution** — manual quarto render required
- **qc-reflect reintegration** — CSS tokens and Lua path not updated
- **qc-trace** — design sketched, not started
- **Sidebar height proper fix** — max-height calc is a workaround

## How to start next session

Upload from `qc-atelier/docs/`:
- `qc-atelier-DOCUMENTATION.qmd`
- `SESSION_HANDOFF_2026-04-21.md`

Upload source files relevant to the task. Full list:
```
qc-atelier-config.yaml
qc-atelier-server.py
qc-scheme.qmd / qc-refactor.qmd / qc-viz.qmd / qc-reflect.qmd
qc-atelier/shared/qc-shared.lua + qc-shared.css + qc-pre-render.sh
qc-atelier/qc-scheme/qc-scheme-filter.lua + qc-scheme.js + qc-scheme.css
qc-atelier/qc-refactor/qc-refactor-filter.lua + qc-refactor.js + qc-refactor.css
qc-atelier/qc-viz/qc-viz-filter.lua + qc-viz.js + qc-viz.css
qc-atelier/qc-reflect/qc-reflect-filter.lua + qc-reflect.js + qc-reflect.css
qc/index.html
```

## Known platform issues
- File download buttons may not render in long sessions → open new tab
- `git diff` opens pager → press `q`, or: `git diff > /tmp/diff.txt && cat /tmp/diff.txt`
