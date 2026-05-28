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
    --dry-run            Show what would change without writing anything.

Files modified:
    qc/codebook.yaml     — code hierarchy
    qc/codebook.json     — documentation and status
    qc/json/*.json       — corpus segment files (code name references)

Safety:
    - Always prompts for confirmation before writing
    - Reports conflicts (duplicate names after prefix stripping) and aborts
    - --dry-run shows full diff without touching any files
    - Run from project root
"""

import json
import re
import sys
from pathlib import Path
from collections import defaultdict

# ── Config ────────────────────────────────────────────────────────────────────

CODEBOOK_YAML = Path("qc/codebook.yaml")
CODEBOOK_JSON = Path("qc/codebook.json")
CORPUS_DIR    = Path("qc/json")

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
    rename_map = {}
    for name in all_names:
        new_name = strip_prefix(name)
        if new_name != name:
            rename_map[name] = new_name

    if not rename_map:
        print("[strip-prefixes] No prefixes to strip.")
        return

    # Check for conflicts: two different codes mapping to the same new name
    new_names = list(rename_map.values())
    # Also include names that don't change
    unchanged = [n for n in all_names if n not in rename_map]
    all_new_names = new_names + unchanged
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
        print(f"  {old}  →  {new}")
    if len(rename_map) > 20:
        print(f"  ... and {len(rename_map)-20} more")

    # Count corpus applications affected
    corpus = load_corpus_files()
    corpus_hits = sum(
        1 for entries in corpus.values()
        for entry in entries
        if entry.get("code") in rename_map
    )
    print(f"\n[strip-prefixes] {corpus_hits} corpus application(s) will be updated.")

    if dry_run:
        print("\n[dry-run] No changes written.")
        return

    if not confirm(f"\nRename {len(rename_map)} code(s) and update {corpus_hits} corpus applications?"):
        print("[aborted]")
        return

    # 1. Update codebook.yaml — rename all occurrences
    yaml_text = load_yaml()
    for old, new in rename_map.items():
        # Match as a yaml list item: "- old_name" or "- old_name:"
        yaml_text = re.sub(
            r"^(\s*-\s+)" + re.escape(old) + r"(\s*:?\s*)$",
            r"\g<1>" + new + r"\2",
            yaml_text,
            flags=re.MULTILINE
        )
    save_yaml(yaml_text)
    print(f"[strip-prefixes] Updated {CODEBOOK_YAML}")

    # 2. Update codebook.json — rename keys, parent references, tree names
    codes = codebook.get("codes", {})
    new_codes = {}
    for name, doc in codes.items():
        new_name = rename_map.get(name, name)
        new_doc = dict(doc)
        if "parent" in new_doc and new_doc["parent"] in rename_map:
            new_doc["parent"] = rename_map[new_doc["parent"]]
        new_codes[new_name] = new_doc
    codebook["codes"] = new_codes

    new_tree = []
    for node in tree:
        new_node = dict(node)
        new_node["name"] = rename_map.get(node["name"], node["name"])
        if node.get("parent") in rename_map:
            new_node["parent"] = rename_map[node["parent"]]
        new_tree.append(new_node)
    codebook["tree"] = new_tree
    save_codebook(codebook)
    print(f"[strip-prefixes] Updated {CODEBOOK_JSON}")

    # 3. Update corpus JSON files
    modified = 0
    for jf, entries in corpus.items():
        changed = False
        new_entries = []
        for entry in entries:
            new_entry = dict(entry)
            if entry.get("code") in rename_map:
                new_entry["code"] = rename_map[entry["code"]]
                changed = True
            new_entries.append(new_entry)
        if changed:
            save_corpus_file(jf, new_entries)
            modified += 1
    print(f"[strip-prefixes] Updated {modified} corpus file(s)")
    print(f"[done] Renamed {len(rename_map)} code(s).")

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

    if delete:
        op_delete(delete, dry_run)
    elif strip:
        op_strip_prefixes(dry_run)
    else:
        print(__doc__)
        sys.exit(0)

if __name__ == "__main__":
    main()
