#!/usr/bin/env python3
"""qc-autodoc.py — Generate and revise documentation for codebook codes.

Evidence source (required, pick one):
  --from-corpus     Use tagged corpus segments as evidence
  --from-tree       Use code name and tree position only (no corpus, no external lookup)
  --from-external   Use Wikidata lookup + LLM general knowledge

Scope (optional, default = all codes):
  --code NAME       Single named code
  --branch NAME     All descendants of a named node

Mode:
  --revise          Revise existing documentation, passing current docs as context
  --revise-fresh    Revise existing documentation, ignoring current docs (start fresh)
  (neither)         Only process undocumented codes

Other:
  --dry-run         Print what would be written without writing anything
  --limit N         Cap number of codes processed
  --model NAME      Override LLM model name

Output:
  Writes scope, rationale, usage_notes, ai_summary (corpus mode), provenance
  (external mode) to qc/codebook.json. Sets status to 'experimental'.
  Saves after each code (interrupt-safe).
"""

import json
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

CODEBOOK_JSON = Path("qc/codebook.json")
CODEBOOK_YAML = Path("qc/codebook.yaml")
CORPUS_DIR    = Path("qc/json")
LLM_URL       = "http://localhost:11434/v1/chat/completions"
MODEL         = "qwen2.5:7b"
MAX_SEGMENTS  = 20
MAX_CHARS     = 8000
TEMPERATURE   = 0.15
SERVER_SCRIPT = "qc-atelier/qc-atelier-server.py"

RESEARCH_CONTEXT = "interview-based research about data sharing practices in Canadian COVID-19 research infrastructure"

# ── Prompts ───────────────────────────────────────────────────────────────────

SYSTEM_PROMPT_BASE = f"""You are a qualitative research assistant helping document a codebook used in {RESEARCH_CONTEXT}.

Write concise, precise documentation for a single code. Documentation should be generalizable — not a summary of what specific participants said.

Respond with JSON only — no preamble, no markdown fences:
{{
  "scope": "...",
  "rationale": "...",
  "usage_notes": "..."
}}"""

CORPUS_USER_PROMPT = """Code: "{code}"
Tree position: {tree_context}

Interview segments tagged with this code:
{segments}

Write:
- scope: generalizable conceptual definition; what this code captures and where it ends (1-3 sentences)
- rationale: why this code exists; how to decide when to apply it vs. similar codes (1-3 sentences)
- usage_notes: edge cases, what to exclude, common confusions (1-3 sentences)
- ai_summary: how this code manifests in practice, grounded in these specific segments (2-4 sentences)

Respond with JSON only containing keys: scope, rationale, usage_notes, ai_summary"""

CORPUS_REVISE_PROMPT = """Code: "{code}"
Tree position: {tree_context}

Current documentation:
{existing_docs}

Interview segments tagged with this code:
{segments}

Revise the documentation above if needed. Improve precision, fix inaccuracies, or expand where the segments reveal something the current docs miss.

Respond with JSON only containing keys: scope, rationale, usage_notes, ai_summary"""

TREE_USER_PROMPT = """Code: "{code}"
Tree position: {tree_context}

Based only on the code name and its position in the codebook tree, write:
- scope: what this code likely captures; what counts as an instance of it (1-3 sentences)
- rationale: why this code exists; when to apply it vs. similar codes (1-3 sentences)
- usage_notes: likely edge cases, exclusions, common confusions (1-3 sentences)

Respond with JSON only containing keys: scope, rationale, usage_notes"""

TREE_REVISE_PROMPT = """Code: "{code}"
Tree position: {tree_context}

Current documentation:
{existing_docs}

Revise the documentation above if needed, based on the code name and tree position.

Respond with JSON only containing keys: scope, rationale, usage_notes"""

EXTERNAL_SYSTEM_PROMPT = f"""You are a qualitative research assistant helping document a codebook used in {RESEARCH_CONTEXT}.

Write documentation for a code based on its external definition and research context.

Respond with JSON only — no preamble, no markdown fences:
{{
  "scope": "...",
  "rationale": "...",
  "usage_notes": "..."
}}"""

WIKIDATA_PICK_PROMPT = """I am documenting a qualitative research codebook. The code "{code}" appears under: {tree_context}.

Here are Wikidata search results for "{code}":
{candidates}

Which candidate best matches the intended meaning of this code given its position in the codebook?

The candidate must be consistent with the meaning implied by the code's position: {tree_context}.
If no candidate is clearly consistent with that context, return null.

Respond with JSON only: {{"qid": "Q...", "reason": "one sentence"}}
If none match: {{"qid": null, "reason": "one sentence"}}"""

EXTERNAL_DOC_PROMPT_WIKIDATA = """Code: "{code}"
Tree position: {tree_context}
Wikidata: {wikidata_description} ({wikidata_url})

Write documentation for this code as used in this research context:
- scope: what this code captures; what counts as an instance (1-3 sentences)
- rationale: why this code exists; when to apply it vs. similar codes (1-3 sentences)
- usage_notes: edge cases, exclusions, common confusions (1-3 sentences)

Respond with JSON only containing keys: scope, rationale, usage_notes"""

EXTERNAL_DOC_PROMPT_LLM = """Code: "{code}"
Tree position: {tree_context}

Using general knowledge of what "{code}" means, write documentation for this code as used in this research context:
- scope: what this code captures; what counts as an instance (1-3 sentences)
- rationale: why this code exists; when to apply it vs. similar codes (1-3 sentences)
- usage_notes: edge cases, exclusions, common confusions (1-3 sentences)

Respond with JSON only containing keys: scope, rationale, usage_notes"""

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_codebook():
    if not CODEBOOK_JSON.exists():
        print(f"[error] {CODEBOOK_JSON} not found. Run from project root.")
        sys.exit(1)
    return json.load(open(CODEBOOK_JSON))

def save_codebook(data):
    with open(CODEBOOK_JSON, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def is_documented(entry):
    return any((entry.get(f) or "").strip() for f in ("scope", "rationale", "usage_notes"))

def format_existing_docs(entry):
    parts = []
    for field, label in (("scope", "Scope"), ("rationale", "Rationale"), ("usage_notes", "Usage notes")):
        val = (entry.get(field) or "").strip()
        if val:
            parts.append(f"{label}: {val}")
    return "\n".join(parts) if parts else "(none)"

def build_tree_context(code_name, tree):
    parent_map   = {n["name"]: n.get("parent", "") for n in tree}
    children_map = {}
    for n in tree:
        p = n.get("parent", "")
        if p:
            children_map.setdefault(p, []).append(n["name"])
    parent      = parent_map.get(code_name, "")
    grandparent = parent_map.get(parent, "") if parent else ""
    siblings    = [s for s in children_map.get(parent, []) if s != code_name][:5]
    parts = []
    if grandparent: parts.append(grandparent)
    if parent:      parts.append(parent)
    ctx = " > ".join(parts) if parts else "(top level)"
    if siblings:    ctx += f"; siblings: {', '.join(siblings)}"
    return ctx

def get_descendants(branch_name, tree):
    children_map = {}
    for n in tree:
        p = n.get("parent", "")
        if p:
            children_map.setdefault(p, []).append(n["name"])
    result, queue = [], [branch_name]
    while queue:
        cur = queue.pop()
        for child in children_map.get(cur, []):
            result.append(child)
            queue.append(child)
    return result

def build_corpus_index():
    index = {}
    if not CORPUS_DIR.exists():
        print(f"[error] Corpus dir {CORPUS_DIR} not found.")
        sys.exit(1)
    files = sorted(CORPUS_DIR.glob("*.json"))
    print(f"[corpus] Reading {len(files)} file(s)...")
    for jf in files:
        try:
            for entry in json.load(open(jf)):
                code = entry.get("code", "").strip()
                text = (entry.get("text") or "").strip()
                if code and text:
                    index.setdefault(code, []).append({
                        "doc":  Path(entry.get("document", jf.stem)).stem,
                        "line": entry.get("line", 0),
                        "text": text,
                    })
        except Exception as e:
            print(f"[warn] Could not read {jf.name}: {e}")
    print(f"[corpus] {len(index)} coded codes.")
    return index

def format_segments(segments):
    lines, total_chars = [], 0
    for i, seg in enumerate(segments[:MAX_SEGMENTS]):
        entry = f"[{seg['doc']}, line {seg['line']}]\n{seg['text']}"
        if total_chars + len(entry) > MAX_CHARS:
            lines.append(f"[... {len(segments) - i} further segments omitted]")
            break
        lines.append(entry)
        total_chars += len(entry)
    return "\n\n".join(lines)

def call_llm(messages, timeout=120):
    payload = {
        "model":       MODEL,
        "temperature": TEMPERATURE,
        "messages":    messages,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    data = json.dumps(payload).encode("utf-8")
    req  = urllib.request.Request(
        LLM_URL, data=data,
        headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read())
        content = result["choices"][0]["message"]["content"].strip()
        if content.startswith("```"):
            content = "\n".join(content.split("\n")[1:])
        if content.endswith("```"):
            content = "\n".join(content.split("\n")[:-1])
        content = content.strip()
        start = content.find("{"); end = content.rfind("}") + 1
        if start >= 0 and end > start:
            content = content[start:end]
        return json.loads(content)
    except Exception as e:
        print(f"  [error] LLM call failed: {e}")
        return None

# ── Wikidata ──────────────────────────────────────────────────────────────────

def wikidata_search(query, limit=5):
    import urllib.parse
    time.sleep(1.5)
    params = urllib.parse.urlencode({
        "action": "wbsearchentities", "search": query,
        "language": "en", "limit": limit, "format": "json",
    })
    req = urllib.request.Request(
        f"https://www.wikidata.org/w/api.php?{params}",
        headers={"User-Agent": "qc-autodoc/1.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        return [{"qid": i.get("id",""), "label": i.get("label",""),
                 "description": i.get("description",""),
                 "url": f"https://www.wikidata.org/wiki/{i.get('id','')}"}
                for i in data.get("search", [])]
    except Exception as e:
        print(f"  [warn] Wikidata search failed: {e}")
        return []

def pick_wikidata_candidate(search_term, tree_context, candidates):
    if not candidates:
        return None, "no candidates"
    candidate_text = "\n".join(f"  {c['qid']}: {c['label']} — {c['description']}" for c in candidates)
    result = call_llm([{"role": "user", "content": WIKIDATA_PICK_PROMPT.format(
        code=search_term, tree_context=tree_context, candidates=candidate_text
    )}], timeout=60)
    if not result:
        return None, "LLM pick failed"
    qid = result.get("qid")
    reason = result.get("reason", "")
    if qid:
        match = next((c for c in candidates if c["qid"] == qid), None)
        return match, reason
    return None, reason

# ── Server helpers ─────────────────────────────────────────────────────────────

def server_is_running():
    try:
        return subprocess.run(["pgrep", "-f", SERVER_SCRIPT], capture_output=True).returncode == 0
    except Exception:
        return False

def stop_server():
    try:
        subprocess.run(["pkill", "-f", SERVER_SCRIPT], capture_output=True)
        time.sleep(1)
        print("[server] Stopped.")
    except Exception as e:
        print(f"[server] Could not stop: {e}")

def start_server():
    try:
        subprocess.Popen(["python3", SERVER_SCRIPT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("[server] Restarted.")
    except Exception as e:
        print(f"[server] Could not restart: {e}")

# ── Core processing ────────────────────────────────────────────────────────────

def get_scope(only_code, only_branch, tree):
    if only_code:
        return [only_code]
    elif only_branch:
        codes = get_descendants(only_branch, tree)
        if not codes:
            print(f"[error] Branch '{only_branch}' not found or has no descendants.")
            sys.exit(1)
        return codes
    else:
        return [n["name"] for n in tree if n.get("parent")]

def filter_to_process(scope, codes_entry, revise, revise_fresh, source):
    to_process = []
    for code_name in scope:
        entry  = codes_entry.get(code_name, {})
        status = (entry.get("status") or "").strip().lower()
        if status == "deprecated":
            continue
        if revise or revise_fresh:
            # --revise: only process already-documented codes
            if not is_documented(entry):
                continue
        else:
            # Normal mode: only process undocumented codes
            if is_documented(entry):
                continue
            if status not in ("", "unset", "experimental"):
                continue
        to_process.append(code_name)
    return to_process

def process_one(code_name, codes_entry, tree, source, corpus, revise, revise_fresh, dry_run):
    entry        = codes_entry.get(code_name, {})
    tree_context = build_tree_context(code_name, tree)

    print(f"  context: {tree_context}")

    if source == "corpus":
        segs = corpus.get(code_name, [])
        if not segs:
            print(f"  [skip] no corpus segments")
            return False
        segments_text = format_segments(segs)
        print(f"  segments: {min(len(segs), MAX_SEGMENTS)}")

        if revise and not revise_fresh:
            prompt = CORPUS_REVISE_PROMPT.format(
                code=code_name, tree_context=tree_context,
                existing_docs=format_existing_docs(entry),
                segments=segments_text,
            )
        else:
            prompt = CORPUS_USER_PROMPT.format(
                code=code_name, tree_context=tree_context, segments=segments_text,
            )
        result = call_llm([
            {"role": "system", "content": SYSTEM_PROMPT_BASE},
            {"role": "user",   "content": prompt},
        ])
        provenance = None
        ai_summary = result.get("ai_summary", "").strip() if result else ""

    elif source == "tree":
        if revise and not revise_fresh:
            prompt = TREE_REVISE_PROMPT.format(
                code=code_name, tree_context=tree_context,
                existing_docs=format_existing_docs(entry),
            )
        else:
            prompt = TREE_USER_PROMPT.format(code=code_name, tree_context=tree_context)
        result = call_llm([
            {"role": "system", "content": SYSTEM_PROMPT_BASE},
            {"role": "user",   "content": prompt},
        ])
        provenance = "Auto-documented from tree position"
        ai_summary = None

    elif source == "external":
        search_term = re.sub(r'^[0-9]+_[0-9]*_?', '', code_name).replace('_', ' ').strip() or code_name
        print(f"  search: '{search_term}'")
        wd_results = wikidata_search(search_term)
        match = None
        if wd_results:
            print(f"  wikidata: {len(wd_results)} candidate(s)")
            match, pick_reason = pick_wikidata_candidate(search_term, tree_context, wd_results)
            if match:
                print(f"  picked: {match['qid']} — {match['label']}: {match['description']}")
            else:
                print(f"  no match: {pick_reason} — falling back to LLM")

        if match:
            prompt = EXTERNAL_DOC_PROMPT_WIKIDATA.format(
                code=code_name, tree_context=tree_context,
                wikidata_description=f"{match['label']}: {match['description']}",
                wikidata_url=match["url"],
            )
            provenance = f"Auto-documented from: {match['url']}"
        else:
            prompt = EXTERNAL_DOC_PROMPT_LLM.format(code=code_name, tree_context=tree_context)
            provenance = "Auto-documented from: LLM general knowledge"

        result = call_llm([
            {"role": "system", "content": EXTERNAL_SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ])
        ai_summary = None

    if not result:
        print(f"  [warn] No valid response — skipping.")
        return False

    scope_text   = result.get("scope",       "").strip()
    rationale    = result.get("rationale",   "").strip()
    usage_notes  = result.get("usage_notes", "").strip()

    print(f"  scope:       {scope_text[:80]}...")
    print(f"  rationale:   {rationale[:80]}...")
    print(f"  usage_notes: {usage_notes[:80]}...")

    if dry_run:
        print(f"  [dry-run] not written")
        return True

    entry = codes_entry.setdefault(code_name, {})
    entry["scope"]       = scope_text
    entry["rationale"]   = rationale
    entry["usage_notes"] = usage_notes
    entry["status"]      = "experimental"
    if ai_summary is not None:
        entry["ai_summary"] = ai_summary
    if provenance is not None:
        entry["provenance"] = provenance
    return True

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    args         = sys.argv[1:]
    dry_run      = "--dry-run"      in args
    revise       = "--revise"       in args
    revise_fresh = "--revise-fresh" in args
    only_code    = None
    only_branch  = None
    source       = None
    limit        = None

    for i, arg in enumerate(args):
        if arg == "--from-corpus":   source      = "corpus"
        if arg == "--from-tree":     source      = "tree"
        if arg == "--from-external": source      = "external"
        if arg == "--code"   and i + 1 < len(args): only_code   = args[i + 1]
        if arg == "--branch" and i + 1 < len(args): only_branch = args[i + 1]
        if arg == "--limit"  and i + 1 < len(args): limit       = int(args[i + 1])
        if arg == "--model"  and i + 1 < len(args):
            global MODEL
            MODEL = args[i + 1]

    if not source:
        print("[error] Specify an evidence source: --from-corpus, --from-tree, or --from-external")
        print(__doc__)
        sys.exit(1)

    if revise and revise_fresh:
        print("[error] --revise and --revise-fresh are mutually exclusive.")
        sys.exit(1)

    if dry_run:
        print("[mode] DRY RUN — no writes.")

    # Stop server for corpus mode (writes directly to codebook.json)
    was_running = server_is_running()
    if was_running and not dry_run and source == "corpus":
        print("[server] Stopping server...")
        stop_server()

    codebook    = load_codebook()
    codes_entry = codebook.setdefault("codes", {})
    tree        = codebook.get("tree", [])

    scope       = get_scope(only_code, only_branch, tree)
    to_process  = filter_to_process(scope, codes_entry, revise, revise_fresh, source)

    if limit:
        to_process = to_process[:limit]

    mode_label = "revise" if (revise or revise_fresh) else "document"
    print(f"\n[autodoc] {len(to_process)} code(s) to {mode_label} ({source}).\n")

    if dry_run:
        for name in to_process:
            print(f"  {name}")
        if was_running and source == "corpus":
            start_server()
        return

    if not to_process:
        print("[done] Nothing to process.")
        if was_running and source == "corpus":
            start_server()
        return

    corpus = build_corpus_index() if source == "corpus" else {}

    processed = 0
    failed    = 0

    try:
        for i, code_name in enumerate(to_process, 1):
            print(f"\n[{i}/{len(to_process)}] {code_name}")
            ok = process_one(code_name, codes_entry, tree, source, corpus,
                             revise, revise_fresh, dry_run)
            if ok and not dry_run:
                save_codebook(codebook)
                processed += 1
            elif not ok:
                failed += 1
            if i < len(to_process):
                time.sleep(0.3)

    except KeyboardInterrupt:
        print(f"\n[interrupted] Progress saved up to this point.")

    print(f"\n[done] Processed: {processed}, failed: {failed}.")

    if was_running and source == "corpus":
        start_server()

if __name__ == "__main__":
    main()