#!/usr/bin/env python3
"""qc-maintain.py — Codebook maintenance operations.

Performs structural maintenance on the qc codebook: deleting codes and their
subtrees, and stripping numeric prefixes from all code names.

All operations require confirmation before writing. Use --dry-run to preview
changes without writing anything.

Usage (from project root):
    python3 qc-atelier/qc-maintain.py --delete CODE_NAME [--dry-run]
    python3 qc-atelier/qc-maintain.py --strip-prefixes [--dry-run]

Options:
    --delete CODE_NAME   Delete a code and all its descendants from codebook.yaml,
                         codebook.json, and corpus JSON files. Prompts for confirmation
                         showing the full list of affected codes.
    --strip-prefixes     Strip numeric prefixes (e.g. 41_01_) from all code names
                         in codebook.yaml, codebook.json, and corpus JSON files.
                         Detects and reports naming conflicts before proceeding.
    --match-legacy       Embed all legacy branch codes and find the closest match
                         in the current code system for each. Saves a mapping report
                         to qc/legacy-match-report.json for review. Run --apply-legacy
                         to apply approved mappings.
    --apply-legacy       Apply approved mappings from qc/legacy-match-report.json,
                         renaming legacy codes in corpus files to their matched codes.
    --purge-excluded     Delete all codes whose only corpus applications are in excluded
                         documents (qc/corpus/exclude/). Queries SQLite directly to find
                         codes with no active corpus applications, then removes them from
                         codebook.yaml and codebook.json. Does not modify SQLite or corpus
                         JSON files. Prompts for confirmation before writing.
    --dry-run            Show what would change without writing anything.

Files modified:
    qc/codebook.yaml     — code hierarchy
    qc/codebook.json     — documentation and status
    qc/json/*.json       — corpus segment files (code name references, --delete only)

Safety:
    - Always prompts for confirmation before writing
    - Reports conflicts (duplicate names after prefix stripping) and aborts
    - --dry-run shows full diff without touching any files
    - Run from project root
"""

import json
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from collections import defaultdict

# ── Config ────────────────────────────────────────────────────────────────────

CODEBOOK_YAML = Path("qc/codebook.yaml")
CODEBOOK_JSON = Path("qc/codebook.json")
CORPUS_DIR    = Path("qc/json")
MATCH_REPORT  = Path("qc/legacy-match-report.json")
CORPUS_EXCLUDE = Path("qc/corpus/exclude")
SQLITE_DB     = Path("qc/qualitative_coding.sqlite3")
CONFIG_FILE   = Path("qc-atelier-config.yaml")

def _get_qc_bin():
    """Read qc_bin from config, fall back to shutil.which."""
    try:
        for line in CONFIG_FILE.read_text().splitlines():
            line = line.strip()
            if line.startswith("qc_bin:"):
                val = line.split(":", 1)[1].strip().strip("'\"")
                if val:
                    return val
    except Exception:
        pass
    return shutil.which("qc") or "qc"

EMBED_URL     = "http://localhost:1234/v1/embeddings"   # LM Studio
EMBED_MODEL   = "text-embedding-nomic-embed-text-v1.5"  # LM Studio name
# EMBED_URL   = "http://localhost:11434/v1/embeddings"  # cluster tunnel
# EMBED_MODEL = "nomic-embed-text"                      # Ollama name

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_codebook():
    if not CODEBOOK_JSON.exists():
        print(f"[error] {CODEBOOK_JSON} not found. Run from project root.")
        sys.exit(1)
    with open(CODEBOOK_JSON) as f:
        return json.load(f)

def save_codebook(data):
    with open(CODEBOOK_JSON, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def load_yaml():
    if not CODEBOOK_YAML.exists():
        print(f"[error] {CODEBOOK_YAML} not found. Run from project root.")
        sys.exit(1)
    return CODEBOOK_YAML.read_text(encoding="utf-8")

def save_yaml(text):
    CODEBOOK_YAML.write_text(text, encoding="utf-8")

def load_corpus_files():
    if not CORPUS_DIR.exists():
        return {}
    result = {}
    for jf in sorted(CORPUS_DIR.glob("*.json")):
        try:
            with open(jf) as f:
                result[jf] = json.load(f)
        except Exception as e:
            print(f"[warn] Could not read {jf.name}: {e}")
    return result

def save_corpus_file(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def build_subtree(tree, root_name):
    """Return root_name and all its descendants."""
    children = defaultdict(list)
    for n in tree:
        if n.get("parent"):
            children[n["parent"]].append(n["name"])

    result = []
    queue = [root_name]
    while queue:
        name = queue.pop()
        result.append(name)
        queue.extend(children.get(name, []))
    return result

def confirm(prompt):
    """Ask for y/n confirmation. Returns True if confirmed."""
    while True:
        resp = input(prompt + " [y/n] ").strip().lower()
        if resp in ("y", "yes"):
            return True
        if resp in ("n", "no"):
            return False

def strip_prefix(name):
    """Strip leading numeric prefix like 41_01_ or 41_ from a code name."""
    return re.sub(r"^\d+(_\d+)*_", "", name)

# ── Delete operation ──────────────────────────────────────────────────────────

def op_delete(code_name, dry_run):
    print(f"\n[delete] Target: {code_name}")

    codebook = load_codebook()
    tree = codebook.get("tree", [])
    tree_names = {n["name"] for n in tree}

    if code_name not in tree_names:
        print(f"[error] Code '{code_name}' not found in codebook.")
        sys.exit(1)

    # Find full subtree
    to_delete = build_subtree(tree, code_name)
    print(f"\n[delete] The following {len(to_delete)} code(s) will be deleted:")
    for name in to_delete:
        doc = codebook.get("codes", {}).get(name, {})
        status = doc.get("status", "")
        scope_preview = (doc.get("scope") or "")[:60]
        tag = f"  [{status}]" if status else ""
        preview = f"  — {scope_preview}…" if scope_preview else ""
        print(f"  - {name}{tag}{preview}")

    # Check corpus applications
    corpus = load_corpus_files()
    apps = defaultdict(int)
    for jf, entries in corpus.items():
        for entry in entries:
            if entry.get("code") in to_delete:
                apps[entry["code"]] += 1

    if apps:
        print(f"\n[warn] {sum(apps.values())} corpus application(s) will also be deleted:")
        for code, count in sorted(apps.items()):
            print(f"  - {code}: {count} segment(s)")

    if dry_run:
        print("\n[dry-run] No changes written.")
        return

    if not confirm(f"\nDelete {len(to_delete)} code(s) and {sum(apps.values())} corpus application(s)?"):
        print("[aborted]")
        return

    to_delete_set = set(to_delete)

    # 1. Remove from codebook.yaml
    yaml_text = load_yaml()
    new_yaml_lines = []
    skip_until_dedent = None
    for line in yaml_text.splitlines():
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        name = stripped.lstrip("- ").rstrip(":").strip() if stripped.startswith("-") else None

        if skip_until_dedent is not None:
            if indent > skip_until_dedent:
                continue  # skip child lines
            else:
                skip_until_dedent = None

        if name and name in to_delete_set:
            skip_until_dedent = indent
            continue

        new_yaml_lines.append(line)

    save_yaml("\n".join(new_yaml_lines) + "\n")
    print(f"[delete] Removed from {CODEBOOK_YAML}")

    # 2. Remove from codebook.json
    codes = codebook.get("codes", {})
    for name in to_delete:
        codes.pop(name, None)
    codebook["tree"] = [n for n in tree if n["name"] not in to_delete_set]
    save_codebook(codebook)
    print(f"[delete] Removed from {CODEBOOK_JSON}")

    # 3. Remove from corpus JSON files
    modified = 0
    for jf, entries in corpus.items():
        new_entries = [e for e in entries if e.get("code") not in to_delete_set]
        if len(new_entries) != len(entries):
            save_corpus_file(jf, new_entries)
            modified += 1
    print(f"[delete] Updated {modified} corpus file(s)")
    print(f"[done] Deleted {len(to_delete)} code(s).")

# ── Strip prefixes operation ──────────────────────────────────────────────────

def op_strip_prefixes(dry_run):
    print("\n[strip-prefixes] Scanning all code names...")

    codebook = load_codebook()
    tree = codebook.get("tree", [])
    all_names = [n["name"] for n in tree]

    # Build rename map: old_name -> new_name
    # Guard: skip codes where stripping produces an empty name
    rename_map = {}
    skipped_empty = []
    for name in all_names:
        new_name = strip_prefix(name)
        if not new_name:
            skipped_empty.append(name)
        elif new_name != name:
            rename_map[name] = new_name

    if skipped_empty:
        print(f"[strip-prefixes] Skipping {len(skipped_empty)} code(s) that would produce empty names:")
        for name in skipped_empty:
            print(f"  {name}")

    if not rename_map:
        print("[strip-prefixes] No prefixes to strip.")
        return

    # Check for conflicts
    unchanged = [n for n in all_names if n not in rename_map]
    seen = defaultdict(list)
    for old, new in rename_map.items():
        seen[new].append(old)
    for name in unchanged:
        seen[name].append(name)

    conflicts = {new: olds for new, olds in seen.items() if len(olds) > 1}
    if conflicts:
        print(f"\n[error] {len(conflicts)} naming conflict(s) detected — cannot strip prefixes:")
        for new, olds in sorted(conflicts.items()):
            print(f"  '{new}' would be produced by: {', '.join(olds)}")
        print("\nResolve these conflicts in refactor before stripping prefixes.")
        sys.exit(1)

    print(f"\n[strip-prefixes] {len(rename_map)} code(s) will be renamed:")
    for old, new in sorted(rename_map.items())[:20]:
        print(f"  {old}  ->  {new}")
    if len(rename_map) > 20:
        print(f"  ... and {len(rename_map)-20} more")

    if dry_run:
        print("\n[dry-run] No changes written.")
        return

    if not confirm(f"\nRename {len(rename_map)} code(s) via qc CLI + update codebook.yaml and codebook.json?"):
        print("[aborted]")
        return

    qc_bin = _get_qc_bin()
    print(f"[strip-prefixes] Using qc: {qc_bin}")

    # 1. Call qc codes rename for each code (updates SQLite + codebook.yaml)
    failed = []
    for i, (old, new) in enumerate(rename_map.items(), 1):
        print(f"  [{i}/{len(rename_map)}] {old}  ->  {new}...", end=" ", flush=True)
        try:
            r = subprocess.run(
                [qc_bin, "codes", "rename", old, new],
                capture_output=True, text=True, timeout=30
            )
            if r.returncode == 0:
                print("ok")
            else:
                print(f"failed: {r.stderr.strip()}")
                failed.append(old)
        except Exception as e:
            print(f"error: {e}")
            failed.append(old)

    if failed:
        print(f"\n[warn] {len(failed)} rename(s) failed: {failed}")

    successful = {old: new for old, new in rename_map.items() if old not in failed}

    # 2. Update codebook.json — rename keys, parent refs, tree
    # (codebook.yaml already updated by qc codes rename)
    codebook = load_codebook()
    codes = codebook.get("codes", {})
    new_codes = {}
    for name, doc in codes.items():
        new_name = successful.get(name, name)
        new_doc = dict(doc)
        if "parent" in new_doc and new_doc["parent"] in successful:
            new_doc["parent"] = successful[new_doc["parent"]]
        new_codes[new_name] = new_doc
    codebook["codes"] = new_codes

    new_tree = []
    for node in codebook.get("tree", []):
        new_node = dict(node)
        new_node["name"] = successful.get(node["name"], node["name"])
        if node.get("parent") in successful:
            new_node["parent"] = successful[node["parent"]]
        new_tree.append(new_node)
    codebook["tree"] = new_tree
    save_codebook(codebook)
    print(f"[strip-prefixes] Updated {CODEBOOK_JSON}")
    print(f"[done] Renamed {len(successful)} code(s). Run pre-render to regenerate corpus JSON from SQLite.")

# ── Legacy matching ──────────────────────────────────────────────────────────

def get_embedding(text):
    import urllib.request as _ur
    payload = {"model": EMBED_MODEL, "input": [text]}
    data = json.dumps(payload).encode("utf-8")
    req = _ur.Request(EMBED_URL, data=data,
                      headers={"Content-Type": "application/json"}, method="POST")
    with _ur.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
    return result["data"][0]["embedding"]

def cosine_sim(a, b):
    import math
    dot = sum(x*y for x,y in zip(a,b))
    na = math.sqrt(sum(x*x for x in a))
    nb = math.sqrt(sum(x*x for x in b))
    return dot / (na * nb + 1e-9)

def _build_match_html(data_json, tree_json):
    return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Legacy Code Mapping</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{--bg:#f8f9fa;--surface:#fff;--border:#dee2e6;--text:#212529;--dim:#6c757d;--accent:#4361ee;--green:#198754;--red:#dc3545;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:"IBM Plex Sans",system-ui,sans-serif;background:var(--bg);color:var(--text);padding:20px;}
h1{font-size:1.3rem;margin-bottom:4px;}
.meta{font-size:0.85rem;color:var(--dim);margin-bottom:16px;}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;}
input[type=search]{padding:6px 10px;border:1px solid var(--border);border-radius:4px;font-size:0.85rem;width:240px;}
select.filter{padding:6px 10px;border:1px solid var(--border);border-radius:4px;font-size:0.85rem;}
.count{color:var(--dim);font-size:0.85rem;margin-left:auto;}
.btn{padding:6px 14px;border-radius:4px;font-size:0.85rem;cursor:pointer;border:1px solid var(--border);background:var(--surface);}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent);}
.btn-primary:hover{background:#3451d1;}
.cards{display:flex;flex-direction:column;gap:8px;}
.card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 14px;}
.card.mapped{border-left:3px solid var(--green);}
.card.created{border-left:3px solid var(--accent);}
.card.skipped{border-left:3px solid var(--dim);opacity:0.65;}
.card.hidden{display:none;}
.card-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.legacy-name{font-family:"IBM Plex Mono",monospace;font-size:0.88rem;font-weight:600;}
.badge{font-size:0.72rem;padding:1px 6px;border-radius:3px;border:1px solid var(--border);color:var(--dim);background:var(--bg);}
.badge.mapped{background:#d1e7dd;color:var(--green);border-color:#a3cfbb;}
.badge.created{background:#dbeafe;color:var(--accent);border-color:#93c5fd;}
.badge.skipped{background:#e9ecef;}
.controls{display:flex;flex-wrap:wrap;gap:5px;align-items:center;}
.chip{padding:3px 8px;border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:0.78rem;background:var(--surface);display:flex;gap:4px;align-items:center;white-space:nowrap;}
.chip:hover{border-color:var(--accent);background:#f0f4ff;}
.chip.selected{border-color:var(--green);background:#d1e7dd;font-weight:500;}
.chip-name{font-family:"IBM Plex Mono",monospace;font-size:0.75rem;}
.chip-sim{font-size:0.7rem;color:var(--dim);}
.chip-same{background:#e8f4fd;border-color:#93c5fd;color:var(--accent);}
.chip-same:hover{background:#dbeafe;}
.chip-same.selected{border-color:var(--accent);background:#bfdbfe;}
.sep{color:var(--border);font-size:0.9rem;align-self:center;}
.skip-btn{font-size:0.78rem;padding:3px 8px;color:var(--dim);background:none;border:1px solid var(--border);border-radius:3px;cursor:pointer;}
.skip-btn:hover{background:var(--bg);}
.clear-btn{font-size:0.78rem;padding:3px 8px;color:var(--red);background:none;border:1px solid var(--border);border-radius:3px;cursor:pointer;border-color:var(--red);}
.create-row{display:flex;gap:5px;align-items:center;margin-top:6px;flex-wrap:wrap;}
.create-row.hidden{display:none;}
input.name-input{padding:3px 7px;border:1px solid var(--border);border-radius:3px;font-size:0.8rem;font-family:"IBM Plex Mono",monospace;width:220px;}
input.name-input:focus{outline:none;border-color:var(--accent);}
.parent-wrap{position:relative;}
input.parent-input{padding:3px 7px;border:1px solid var(--border);border-radius:3px;font-size:0.8rem;width:200px;}
input.parent-input:focus{outline:none;border-color:var(--accent);}
.parent-drop{position:absolute;top:100%;left:0;background:var(--surface);border:1px solid var(--border);border-radius:4px;max-height:180px;overflow-y:auto;z-index:100;min-width:200px;display:none;}
.parent-drop.open{display:block;}
.parent-opt{padding:4px 8px;font-size:0.8rem;cursor:pointer;font-family:"IBM Plex Mono",monospace;}
.parent-opt:hover,.parent-opt.active{background:#f0f4ff;}
.confirm-btn{padding:3px 8px;border-radius:3px;font-size:0.78rem;cursor:pointer;background:var(--accent);color:#fff;border:none;}
.confirm-btn:disabled{background:var(--dim);cursor:default;}
.result-label{font-size:0.78rem;color:var(--dim);font-family:"IBM Plex Mono",monospace;margin-left:4px;}
.summary-bar{position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--border);padding:10px 0;margin-top:16px;display:flex;gap:16px;align-items:center;}
.summary-stat{font-size:0.85rem;color:var(--dim);}
.summary-stat strong{color:var(--text);}
</style>
</head>
<body>
<h1>Legacy Code Mapping</h1>
<p class="meta">Map each legacy code to an existing code, create a new one, or skip. Click Execute when done.</p>
<div class="toolbar">
  <input type="search" id="search" placeholder="Search legacy codes..." oninput="filterCards()">
  <select class="filter" id="filter-status" onchange="filterCards()">
    <option value="">All</option>
    <option value="unmapped">Unmapped</option>
    <option value="mapped">Mapped</option>
    <option value="created">Create new</option>
    <option value="skipped">Skipped</option>
  </select>
  <span class="count" id="count"></span>
  <button class="btn btn-primary" onclick="execute()">Execute</button>
  <button class="btn" onclick="skipAll()">Skip all unmapped</button>
</div>
<div class="cards" id="cards"></div>
<div class="summary-bar">
  <span class="summary-stat">Mapped: <strong id="n-mapped">0</strong></span>
  <span class="summary-stat">New: <strong id="n-created">0</strong></span>
  <span class="summary-stat">Skipped: <strong id="n-skipped">0</strong></span>
  <span class="summary-stat">Unmapped: <strong id="n-unmapped">0</strong></span>
  <button class="btn btn-primary" style="margin-left:auto" onclick="execute()">Execute</button>
</div>
<script>
const DATA=""" + data_json + """;
const TREE=""" + tree_json + """;
const BRANCHES=TREE.filter(n=>!n.parent).map(n=>n.name);
const ALL_NODES=TREE.map(n=>n.name);
const state={};
DATA.forEach(e=>{
  state[e.legacy_code]={
    action: e.approved ? "map" : e.new_code ? "create" : null,
    target: e.approved||null,
    new_code: e.new_code||null,
    new_parent: e.new_parent||null
  };
});

function renderCards(){
  const container=document.getElementById("cards");
  container.innerHTML="";
  DATA.forEach(entry=>{
    const s=state[entry.legacy_code];
    const statusClass=s.action==="map"?" mapped":s.action==="create"?" created":s.action==="skip"?" skipped":"";
    const card=document.createElement("div");
    card.className="card"+statusClass;
    card.dataset.code=entry.legacy_code;
    card.dataset.status=s.action||"unmapped";

    // Header
    const hdr=document.createElement("div");hdr.className="card-header";
    const nm=document.createElement("span");nm.className="legacy-name";nm.textContent=entry.legacy_code;
    const badge=document.createElement("span");
    badge.className="badge"+(s.action?" "+s.action:"");
    badge.textContent=s.action==="map"?"mapped":s.action==="create"?"create new":s.action==="skip"?"skip":"unmapped";
    hdr.appendChild(nm);hdr.appendChild(badge);
    if(s.action==="map"&&s.target){
      const rl=document.createElement("span");rl.className="result-label";rl.textContent="-> "+s.target;hdr.appendChild(rl);
    }
    if(s.action==="create"&&s.new_code){
      const rl=document.createElement("span");rl.className="result-label";rl.textContent="+ "+s.new_code+(s.new_parent?" under "+s.new_parent:"");hdr.appendChild(rl);
    }
    card.appendChild(hdr);

    // Controls row
    const controls=document.createElement("div");controls.className="controls";

    // 5 candidates
    entry.top_matches.forEach(m=>{
      const chip=document.createElement("div");
      chip.className="chip"+(s.target===m.code&&s.action==="map"?" selected":"");
      chip.innerHTML='<span class="chip-name">'+m.code+'</span><span class="chip-sim">'+(m.similarity*100).toFixed(0)+'%</span>';
      chip.onclick=()=>{state[entry.legacy_code]={action:"map",target:m.code,new_code:null,new_parent:null};renderCards();};
      controls.appendChild(chip);
    });

    // Separator
    const sep=document.createElement("span");sep.className="sep";sep.textContent="|";controls.appendChild(sep);

    // Same-name create button
    const sameBtn=document.createElement("div");
    sameBtn.className="chip chip-same"+(s.action==="create"&&s.new_code===entry.legacy_code?" selected":"");
    sameBtn.innerHTML='<span class="chip-name">+ '+entry.legacy_code+'</span>';
    sameBtn.onclick=()=>{
      state[entry.legacy_code]={action:"create",target:null,new_code:entry.legacy_code,new_parent:s.new_parent||""};
      renderCards();
    };
    controls.appendChild(sameBtn);

    // Skip
    const skipBtn=document.createElement("button");skipBtn.className="skip-btn";skipBtn.textContent="Skip";
    skipBtn.onclick=()=>{state[entry.legacy_code]={action:"skip",target:null,new_code:null,new_parent:null};renderCards();};
    controls.appendChild(skipBtn);

    // Clear
    if(s.action){
      const clearBtn=document.createElement("button");clearBtn.className="clear-btn";clearBtn.textContent="Clear";
      clearBtn.onclick=()=>{state[entry.legacy_code]={action:null,target:null,new_code:null,new_parent:null};renderCards();};
      controls.appendChild(clearBtn);
    }
    card.appendChild(controls);

    // Create row (write-in + parent)
    const createRow=document.createElement("div");
    createRow.className="create-row"+(s.action==="create"||(!s.action)?" ":" hidden");
    // Actually only show if action is create or user is typing
    createRow.className="create-row"+(s.action==="create"?"":" hidden");

    const nameInput=document.createElement("input");
    nameInput.type="text";nameInput.className="name-input";nameInput.placeholder="Write-in code name...";
    nameInput.value=s.action==="create"&&s.new_code!==entry.legacy_code?s.new_code:"";
    nameInput.oninput=()=>{
      if(nameInput.value.trim()){
        state[entry.legacy_code]={action:"create",target:null,new_code:nameInput.value.trim(),new_parent:state[entry.legacy_code].new_parent||""};
      }
    };
    createRow.appendChild(nameInput);

    // Parent searchable input
    const parentWrap=document.createElement("div");parentWrap.className="parent-wrap";
    const parentInput=document.createElement("input");
    parentInput.type="text";parentInput.className="parent-input";parentInput.placeholder="Parent branch...";
    parentInput.value=s.new_parent||"";
    const parentDrop=document.createElement("div");parentDrop.className="parent-drop";
    let dropActive=0;

    function updateDrop(filter){
      parentDrop.innerHTML="";
      const matches=ALL_NODES.filter(n=>n.toLowerCase().includes(filter.toLowerCase())).slice(0,20);
      matches.forEach((n,i)=>{
        const opt=document.createElement("div");opt.className="parent-opt"+(i===dropActive?" active":"");
        opt.textContent=n;
        opt.onmousedown=(e)=>{e.preventDefault();parentInput.value=n;state[entry.legacy_code].new_parent=n;parentDrop.classList.remove("open");};
        parentDrop.appendChild(opt);
      });
      if(matches.length) parentDrop.classList.add("open");
      else parentDrop.classList.remove("open");
    }
    parentInput.oninput=()=>{dropActive=0;updateDrop(parentInput.value);state[entry.legacy_code].new_parent=parentInput.value;};
    parentInput.onfocus=()=>updateDrop(parentInput.value);
    parentInput.onblur=()=>setTimeout(()=>parentDrop.classList.remove("open"),150);
    parentInput.onkeydown=(e)=>{
      const opts=parentDrop.querySelectorAll(".parent-opt");
      if(e.key==="ArrowDown"){dropActive=Math.min(dropActive+1,opts.length-1);}
      else if(e.key==="ArrowUp"){dropActive=Math.max(dropActive-1,0);}
      else if(e.key==="Enter"&&opts[dropActive]){parentInput.value=opts[dropActive].textContent;state[entry.legacy_code].new_parent=parentInput.value;parentDrop.classList.remove("open");e.preventDefault();}
      opts.forEach((o,i)=>o.classList.toggle("active",i===dropActive));
    };
    parentWrap.appendChild(parentInput);parentWrap.appendChild(parentDrop);
    createRow.appendChild(parentWrap);
    card.appendChild(createRow);

    // Show create row when same-name btn clicked or write-in focused
    sameBtn.addEventListener("click",()=>{createRow.classList.remove("hidden");});

    container.appendChild(card);
  });
  updateSummary();filterCards();
}

function updateSummary(){
  let mapped=0,created=0,skipped=0,unmapped=0;
  DATA.forEach(e=>{
    const s=state[e.legacy_code];
    if(s.action==="map")mapped++;
    else if(s.action==="create")created++;
    else if(s.action==="skip")skipped++;
    else unmapped++;
  });
  document.getElementById("n-mapped").textContent=mapped;
  document.getElementById("n-created").textContent=created;
  document.getElementById("n-skipped").textContent=skipped;
  document.getElementById("n-unmapped").textContent=unmapped;
}

function filterCards(){
  const search=document.getElementById("search").value.toLowerCase();
  const status=document.getElementById("filter-status").value;
  let visible=0;
  document.querySelectorAll(".card").forEach(card=>{
    const match=(!search||card.dataset.code.toLowerCase().includes(search))&&(!status||card.dataset.status===status);
    card.classList.toggle("hidden",!match);if(match)visible++;
  });
  document.getElementById("count").textContent=visible+" showing";
}

function skipAll(){DATA.forEach(e=>{if(!state[e.legacy_code].action)state[e.legacy_code]={action:"skip",target:null,new_code:null,new_parent:null};});renderCards();}

function execute(){
  const result=DATA.map(e=>{
    const s=state[e.legacy_code];
    return {
      legacy_code:e.legacy_code,
      top_matches:e.top_matches,
      approved:s.action==="map"?s.target:null,
      new_code:s.action==="create"?s.new_code:null,
      new_parent:s.action==="create"?s.new_parent:null
    };
  });
  const blob=new Blob([JSON.stringify(result,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="legacy-match-report.json";a.click();
}

renderCards();
</script>
</body></html>"""

def op_match_legacy(dry_run):
    print("\n[match-legacy] Loading codebook...")
    codebook = load_codebook()
    tree = codebook.get("tree", [])
    codes = codebook.get("codes", {})

    # Find legacy codes (in OLDER OPEN CODING STRUCTURE subtree)
    legacy_set = set(build_subtree(tree, "OLDER OPEN CODING STRUCTURE"))
    legacy_set.discard("OLDER OPEN CODING STRUCTURE")

    # Find current codes (not legacy, not deprecated, has corpus applications)
    corpus = load_corpus_files()
    corpus_codes = set()
    for entries in corpus.values():
        for e in entries:
            corpus_codes.add(e.get("code", ""))

    legacy_in_corpus = legacy_set & corpus_codes
    if not legacy_in_corpus:
        print("[match-legacy] No legacy codes found in corpus. Nothing to match.")
        return

    current_codes = [
        n["name"] for n in tree
        if n["name"] not in legacy_set
        and n.get("parent")  # skip top-level branches
        and (codes.get(n["name"], {}).get("status", "") or "") != "deprecated"
        and n["name"] in corpus_codes
    ]

    print(f"[match-legacy] {len(legacy_in_corpus)} legacy codes in corpus, {len(current_codes)} current codes to match against.")
    print("[match-legacy] Embedding current codes...")

    current_embeddings = []
    for i, name in enumerate(current_codes):
        doc = codes.get(name, {})
        scope = (doc.get("scope") or "").strip()
        text = name + (": " + scope[:200] if scope else "")
        emb = get_embedding(text)
        current_embeddings.append(emb)
        if (i+1) % 50 == 0:
            print(f"  {i+1}/{len(current_codes)}")

    print(f"[match-legacy] Embedding {len(legacy_in_corpus)} legacy codes...")
    mappings = []
    for name in sorted(legacy_in_corpus):
        doc = codes.get(name, {})
        scope = (doc.get("scope") or "").strip()
        text = name + (": " + scope[:200] if scope else "")
        emb = get_embedding(text)
        sims = [cosine_sim(emb, ce) for ce in current_embeddings]
        top5_idx = sorted(range(len(sims)), key=lambda i: sims[i], reverse=True)[:5]
        mappings.append({
            "legacy_code": name,
            "top_matches": [
                {"code": current_codes[i], "similarity": round(sims[i], 4)}
                for i in top5_idx
            ],
            "approved": None,  # to be filled in by user: set to the code name to map to, or null to skip
        })
        print(f"  {name} -> {current_codes[top5_idx[0]]} ({sims[top5_idx[0]]:.3f})")

    if dry_run:
        print("\n[dry-run] Report not written.")
        return

    MATCH_REPORT.write_text(json.dumps(mappings, indent=2, ensure_ascii=False))
    print(f"[done] Report written to {MATCH_REPORT}")

    # Generate HTML review tool
    html_path = MATCH_REPORT.parent / "legacy-match.html"
    data_json = json.dumps(mappings, ensure_ascii=False)
    tree_json = json.dumps(tree, ensure_ascii=False)
    html = _build_match_html(data_json, tree_json)
    html_path.write_text(html, encoding="utf-8")
    print(f"[done] HTML tool written to {html_path}")
    print("Open legacy-match.html in your browser, make selections, click Execute to download updated JSON.")
    print("Then copy the downloaded file to qc/legacy-match-report.json and run --apply-legacy.")

def op_apply_legacy(dry_run):
    if not MATCH_REPORT.exists():
        print(f"[error] {MATCH_REPORT} not found. Run --match-legacy first.")
        sys.exit(1)

    mappings = json.loads(MATCH_REPORT.read_text())
    # Build rename map (map action) and create list (create action)
    rename_map = {m["legacy_code"]: m["approved"] for m in mappings if m.get("approved")}
    create_list = [m for m in mappings if m.get("new_code") and not m.get("approved")]

    if not rename_map and not create_list:
        print("[apply-legacy] No approved mappings or new codes found in report.")
        return

    print(f"\n[apply-legacy] {len(rename_map)} remap(s), {len(create_list)} new code(s) to create:")
    for old_c, new_c in sorted(rename_map.items()):
        print(f"  {old_c}  ->  {new_c}")
    for m in create_list:
        print(f"  {m['legacy_code']}  ->  + {m['new_code']} (under {m.get('new_parent','?')})")

    corpus = load_corpus_files()
    all_renames = dict(rename_map)
    for m in create_list:
        all_renames[m["legacy_code"]] = m["new_code"]

    hits = sum(
        1 for entries in corpus.values()
        for e in entries if e.get("code") in all_renames
    )
    print(f"  {hits} corpus application(s) will be updated.")

    if dry_run:
        print("\n[dry-run] No changes written.")
        return

    if not confirm(f"\nApply {len(all_renames)} mapping(s) to {hits} corpus applications?"):
        print("[aborted]")
        return

    # Add new codes to codebook.yaml and codebook.json
    if create_list:
        codebook = load_codebook()
        yaml_text = load_yaml()
        for m in create_list:
            new_code = m["new_code"]
            parent = m.get("new_parent", "")
            # Add to yaml under parent
            if parent:
                # Find the parent line and append after it
                lines = yaml_text.splitlines()
                new_lines = []
                parent_indent = None
                for line in lines:
                    new_lines.append(line)
                    stripped = line.lstrip()
                    name = stripped.lstrip("- ").rstrip(":").strip() if stripped.startswith("-") else None
                    if name == parent:
                        parent_indent = len(line) - len(stripped)
                        new_lines.append(" " * (parent_indent + 2) + "- " + new_code)
                yaml_text = "\n".join(new_lines) + "\n"
            else:
                yaml_text += "- " + new_code + "\n"
            # Add to codebook.json tree and codes
            codebook["tree"].append({"name": new_code, "parent": parent, "depth": 1, "prefix": "", "children": []})
            codebook["codes"][new_code] = {"status": ""}
        save_yaml(yaml_text)
        save_codebook(codebook)
        print(f"[apply-legacy] Added {len(create_list)} new code(s) to codebook")

    # Update corpus files
    modified = 0
    for jf, entries in corpus.items():
        changed = False
        new_entries = []
        for entry in entries:
            new_entry = dict(entry)
            if entry.get("code") in all_renames:
                new_entry["code"] = all_renames[entry["code"]]
                changed = True
            new_entries.append(new_entry)
        if changed:
            save_corpus_file(jf, new_entries)
            modified += 1

    print(f"[apply-legacy] Updated {modified} corpus file(s).")
    print("[done] Legacy codes remapped. You can now run --delete 'OLDER OPEN CODING STRUCTURE'.")

def op_purge_excluded(dry_run):
    """Delete codes whose only corpus applications are in excluded documents."""
    if not SQLITE_DB.exists():
        print(f"[error] SQLite database not found: {SQLITE_DB}")
        sys.exit(1)
    if not CORPUS_EXCLUDE.exists():
        print(f"[error] Exclude directory not found: {CORPUS_EXCLUDE}")
        sys.exit(1)

    excluded_docs = set(f.stem for f in CORPUS_EXCLUDE.glob("*.txt"))
    if not excluded_docs:
        print("[purge-excluded] No excluded documents found.")
        return

    print(f"[purge-excluded] Excluded documents: {excluded_docs}")

    conn = sqlite3.connect(str(SQLITE_DB))
    like_conditions = " OR ".join(f"di.document_id LIKE '%{doc}%'" for doc in excluded_docs)

    excluded_codes = set(r[0] for r in conn.execute(f"""
        SELECT DISTINCT cl.code_id
        FROM coded_line cl
        JOIN coded_line_location_association clla ON cl.id = clla.coded_line_id
        JOIN location l ON clla.location_id = l.id
        JOIN document_index di ON l.document_index_id = di.id
        WHERE {like_conditions}
    """).fetchall())

    other_codes = set(r[0] for r in conn.execute(f"""
        SELECT DISTINCT cl.code_id
        FROM coded_line cl
        JOIN coded_line_location_association clla ON cl.id = clla.coded_line_id
        JOIN location l ON clla.location_id = l.id
        JOIN document_index di ON l.document_index_id = di.id
        WHERE NOT ({like_conditions})
    """).fetchall())

    to_delete = sorted(excluded_codes - other_codes)

    if not to_delete:
        print("[purge-excluded] No codes to delete.")
        return

    print(f"[purge-excluded] {len(to_delete)} code(s) to delete:")
    for c in to_delete:
        print(f"  {c}")

    if dry_run:
        print("[dry-run] No files written.")
        return

    if not confirm(f"\nDelete {len(to_delete)} code(s) from codebook.yaml and codebook.json?"):
        print("[aborted]")
        return

    # Remove from codebook.yaml
    yaml_text = load_yaml()
    to_delete_set = set(to_delete)
    new_lines = []
    skip_indent = None

    for line in yaml_text.splitlines(keepends=True):
        stripped = line.lstrip()
        if not stripped or stripped.startswith('#'):
            if skip_indent is None:
                new_lines.append(line)
            continue
        indent = len(line) - len(line.lstrip())
        if skip_indent is not None:
            if indent <= skip_indent:
                skip_indent = None
            else:
                continue
        if stripped.startswith('- '):
            name = stripped[2:].rstrip().rstrip(':')
            if name in to_delete_set:
                skip_indent = indent
                continue
        new_lines.append(line)

    save_yaml("".join(new_lines))
    print(f"[purge-excluded] Updated codebook.yaml.")

    # Remove from codebook.json
    codebook = load_codebook()
    codes = codebook.get("codes", {})
    removed = 0
    for name in to_delete:
        if name in codes:
            del codes[name]
            removed += 1
    tree = codebook.get("tree", [])
    codebook["tree"] = [n for n in tree if n.get("name") not in to_delete_set]
    codebook["codes"] = codes
    save_codebook(codebook)
    print(f"[purge-excluded] Updated codebook.json — removed {removed} documented entries.")
    print(f"[done] Purged {len(to_delete)} codes. Run pre-render and re-render scheme/refactor.")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    dry_run   = "--dry-run" in sys.argv
    delete    = None
    strip     = "--strip-prefixes" in sys.argv

    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--delete" and i < len(sys.argv) - 1:
            delete = sys.argv[i + 1]

    if dry_run:
        print("[mode] DRY RUN — no files will be written.")

    match_legacy    = "--match-legacy"    in sys.argv
    apply_legacy    = "--apply-legacy"    in sys.argv
    purge_excluded  = "--purge-excluded"  in sys.argv

    if delete:
        op_delete(delete, dry_run)
    elif strip:
        op_strip_prefixes(dry_run)
    elif match_legacy:
        op_match_legacy(dry_run)
    elif apply_legacy:
        op_apply_legacy(dry_run)
    elif purge_excluded:
        op_purge_excluded(dry_run)
    else:
        print(__doc__)
        sys.exit(0)

if __name__ == "__main__":
    main()