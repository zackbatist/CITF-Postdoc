# qc-atelier Handoff — Session 11

## Completed this session

### Refactor fixes
- Queue item doc panel: `display:flex` → `display:block`
- Edit button: `async`/`await renderOpForm()` before `repopulateForm(op)`
- `saveQueue()` added to edit handler

### Scheme
- `refreshTreeFromServer` polling optimisation: server returns `mtime`, client skips re-render if unchanged

### AI documentation (qc-autodoc.py)
- Batch documentation script via Ollama endpoint
- Writes scope, rationale, usage_notes, ai_summary to codebook.json
- Status set to `experimental`; saves per-code; interrupt-safe
- Server stops/restarts around run
- Tested with qwen3:32b on GPU cluster (buckeridge-rtx6000, GPU 9, port 11434)
- SSH tunnel: `ssh -L 11434:localhost:11434 zack@<cluster>`
- Docker: `bash ~/launch_ollama.sh 9 qwen3:32b`
- `ai_summary` field added to scheme.js (read-only, model attribution)
- `/docs/save` merge fix in server: disk always wins over scheme in-memory state

### AI analysis (qc-analyze.py)
- Modes: `within`, `across`, `structure`, `cluster`
- `cluster` mode: nomic-embed-text embeddings + k-means + silhouette scoring + LLM naming
- Flags: `--model`, `--thinking`, `--no-thinking`, `--branch`
- HTML reports: interactive (filterable tables, decision dropdown, notes, CSV export) and printable (letter landscape)
- Strict merge prompt: only flags genuine redundancy, suggested_name must be existing code

### Maintenance (qc-maintain.py)
- `--delete CODE_NAME`: delete code and subtree with confirmation
- `--strip-prefixes`: strip numeric prefixes everywhere with conflict detection
- `--match-legacy`: embed legacy codes, find top-5 matches, generate JSON + HTML review tool
- `--apply-legacy`: apply approved mappings (map, create new code, skip)
- HTML review tool: candidate chips with similarity %, same-name create, write-in, parent selector with typable search

### Server
- `/docs/save` merge fix: `merged_codes = dict(data.get("codes", {})); merged_codes.update(existing_codes)` — disk always wins
- Post-execute hook: spawns `qc-pre-render.sh` after successful refactor operations

---

## Pending work

1. **Refactor:** make execute comment optional; add clear button to move selector
2. **Code system cleanup (in order):**
   - Run `--match-legacy`, review HTML tool, run `--apply-legacy`
   - `--delete "OLDER OPEN CODING STRUCTURE"`
   - `--delete 40_Abstractions` (empty branch)
   - `--strip-prefixes --dry-run` to check conflicts, then run for real
3. **qcLog** unified activity log (todo item 12)
4. **Snapshot** full implementation in reflect and viz (todo item 13)
5. **Status filter** in scheme (deferred)
6. **qc-analyze cluster mode** — test end to end, generate HTML report

---

## Key commands

```bash
# Server
nohup python3 qc-atelier/qc-atelier-server.py > /tmp/server.log 2>&1 &

# Cluster tunnel
ssh -L 11434:localhost:11434 zack@<cluster>

# Launch cluster container
bash ~/launch_ollama.sh 9 qwen3:32b

# Autodoc (stop server first, it handles this automatically)
python3 qc-atelier/qc-autodoc.py

# Analysis
python3 qc-atelier/qc-analyze.py --mode within --thinking
python3 qc-atelier/qc-analyze.py --mode cluster --thinking

# Maintenance
python3 qc-atelier/qc-maintain.py --match-legacy
python3 qc-atelier/qc-maintain.py --apply-legacy
python3 qc-atelier/qc-maintain.py --delete "OLDER OPEN CODING STRUCTURE"
python3 qc-atelier/qc-maintain.py --strip-prefixes --dry-run
```

---

## Files changed this session

| File | Change |
|---|---|
| `qc-atelier/qc-autodoc.py` | New — batch LLM documentation |
| `qc-atelier/qc-analyze.py` | New — codebook analysis (within, across, structure, cluster modes) |
| `qc-atelier/qc-maintain.py` | New — maintenance script (delete, strip-prefixes, match/apply-legacy) |
| `qc-atelier/qc-atelier-server.py` | /docs/save merge fix; post-execute pre-render hook |
| `qc-atelier/qc-scheme/qc-scheme.js` | ai_summary field; mtime polling optimisation |
| `qc-atelier/qc-refactor/qc-refactor.js` | edit button async fix; queue panel display:block |
| `qc-atelier/shared/launch_ollama.sh` | GPU UUID-based device assignment; ~/models bind mount |

---

## Uncommitted changes to commit

### qc-atelier repo
```
feat(atelier): add qc-autodoc.py, qc-analyze.py, qc-maintain.py

feat(server): /docs/save merge fix — disk always wins
feat(server): trigger pre-render after successful refactor execute
fix(refactor): edit button awaits renderOpForm; queue panel display:block
fix(scheme): skip refreshTreeFromServer re-render when codebook.yaml unchanged
feat(scheme): add ai_summary field; model/param attribution display
```

### qc/ submodule
```
chore: legacy code matching report and initial mappings
feat: AI-generated draft documentation for 861 codes
```
