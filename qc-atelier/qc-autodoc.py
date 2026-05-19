#!/usr/bin/env python3
"""qc-autodoc.py — Generate draft documentation for undocumented codes via LM Studio.

Usage (from project root):
    python3 qc-atelier/qc-autodoc.py [--dry-run] [--limit N] [--code CODE_NAME]

Options:
    --dry-run       List codes that would be processed; do not call LM Studio or write anything.
    --limit N       Process at most N codes (useful for testing).
    --code NAME     Process only the named code (exact match).

Output:
    Writes scope, rationale, usage_notes to qc/codebook.json in place.
    Sets status to 'experimental' for each processed code.
    Skips codes that are: deprecated, non-unset status, already documented, or in the legacy branch.
"""

import json
import os
import signal
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
LM_STUDIO_URL = "http://localhost:11434/v1/chat/completions"
MODEL         = "qwen2.5:7b"       # adjust to match your LM Studio model name exactly
MAX_SEGMENTS  = 20                 # max segments to send per code
MAX_CHARS     = 8000               # max total segment chars to send (context limit guard)
TEMPERATURE   = 0.15

LEGACY_BRANCH_MARKER = "OLDER OPEN CODING STRUCTURE"

SYSTEM_PROMPT = """You are a qualitative research assistant helping document a codebook used in interview-based research about data sharing practices in Canadian COVID-19 research infrastructure.

Your task is to write concise, precise documentation for a single code. Use the interview segments as evidence to understand what the code captures, but write documentation that would apply generally — not as a summary of what these specific participants said.

Respond with JSON only — no preamble, no markdown fences, no explanation. Format:
{
  "scope": "...",
  "rationale": "...",
  "usage_notes": "..."
}"""

USER_PROMPT_TEMPLATE = """Here are interview segments tagged with the code "{code}".

Based only on these segments, write:
- scope: a generalizable conceptual definition of what this code captures and where it ends. Write this as an abstract definition that would hold across any corpus — do not reference participants, quotes, or these specific segments (1-3 sentences)
- rationale: why this code exists; how to decide when to apply it vs. similar codes (1-3 sentences)
- usage_notes: edge cases, what to exclude, common confusions (1-3 sentences)
- ai_summary: a brief account of how this code manifests in practice, grounded in these specific segments — what participants said, themes that emerged, typical contexts of application (2-4 sentences)

Respond with JSON only containing keys: scope, rationale, usage_notes, ai_summary"""

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_codebook_json():
    if not CODEBOOK_JSON.exists():
        print(f"[error] {CODEBOOK_JSON} not found. Run from project root.")
        sys.exit(1)
    with open(CODEBOOK_JSON) as f:
        return json.load(f)

def save_codebook_json(data):
    with open(CODEBOOK_JSON, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def load_legacy_codes():
    """Parse codebook.yaml to find all codes under the legacy branch."""
    if not CODEBOOK_YAML.exists():
        return set()
    text = CODEBOOK_YAML.read_text()
    legacy_codes = set()
    in_legacy = False
    legacy_indent = None
    for line in text.splitlines():
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(stripped)
        if LEGACY_BRANCH_MARKER in line:
            in_legacy = True
            legacy_indent = indent
            continue
        if in_legacy:
            # Stop if we're back to the same or lower indent as the legacy branch header
            if indent <= legacy_indent and stripped.startswith("-"):
                in_legacy = False
            else:
                # Extract the code name
                name = stripped.lstrip("-").strip().rstrip(":")
                if name:
                    legacy_codes.add(name)
    return legacy_codes

def build_corpus_index():
    """Build a dict: code_name -> list of segment texts, from all corpus JSON files."""
    index = {}
    if not CORPUS_DIR.exists():
        print(f"[error] Corpus dir {CORPUS_DIR} not found.")
        sys.exit(1)
    files = sorted(CORPUS_DIR.glob("*.json"))
    print(f"[corpus] Reading {len(files)} corpus files...")
    for jf in files:
        try:
            with open(jf) as f:
                entries = json.load(f)
            for entry in entries:
                code = entry.get("code", "").strip()
                text = (entry.get("text") or "").strip()
                if code and text:
                    if code not in index:
                        index[code] = []
                    index[code].append({
                        "doc":  Path(entry.get("document", jf.stem)).stem,
                        "line": entry.get("line", 0),
                        "text": text,
                    })
        except Exception as e:
            print(f"[warn] Could not read {jf.name}: {e}")
    print(f"[corpus] Indexed {len(index)} codes across all files.")
    return index

def format_segments(segments):
    """Format segments for the prompt, respecting MAX_SEGMENTS and MAX_CHARS."""
    lines = []
    total_chars = 0
    for i, seg in enumerate(segments[:MAX_SEGMENTS]):
        entry = f"[{seg['doc']}, line {seg['line']}]\n{seg['text']}"
        if total_chars + len(entry) > MAX_CHARS:
            lines.append(f"[... {len(segments) - i} further segments omitted]")
            break
        lines.append(entry)
        total_chars += len(entry)
    return "\n\n".join(lines)

def call_lm_studio(code, segments_text):
    """Send prompt to LM Studio and return parsed JSON dict or None."""
    payload = {
        "model": MODEL,
        "temperature": TEMPERATURE,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": USER_PROMPT_TEMPLATE.format(
                code=code, segments=segments_text
            )},
        ],
        # Qwen3: disable thinking for concise output
        "chat_template_kwargs": {"enable_thinking": False},
    }
    data = json.dumps(payload).encode("utf-8")
    req  = urllib.request.Request(
        LM_STUDIO_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
        content = result["choices"][0]["message"]["content"].strip()
        # Strip markdown fences if present
        if content.startswith("```"):
            content = "\n".join(content.split("\n")[1:])
        if content.endswith("```"):
            content = "\n".join(content.split("\n")[:-1])
        content = content.strip()
        return json.loads(content)
    except urllib.error.URLError as e:
        print(f"  [error] LM Studio connection failed: {e}")
        return None
    except (json.JSONDecodeError, KeyError) as e:
        print(f"  [error] Could not parse LM Studio response: {e}")
        return None

def is_documented(entry):
    """Return True if any of scope/rationale/usage_notes is non-empty."""
    return any([
        (entry.get("scope")       or "").strip(),
        (entry.get("rationale")   or "").strip(),
        (entry.get("usage_notes") or "").strip(),
    ])

# ── Main ──────────────────────────────────────────────────────────────────────

SERVER_SCRIPT = "qc-atelier/qc-atelier-server.py"
RENDER_CMD    = ["quarto", "render", "qc-atelier/qc-scheme/qc-scheme.qmd"]

def server_is_running():
    try:
        result = subprocess.run(
            ["pgrep", "-f", SERVER_SCRIPT],
            capture_output=True
        )
        return result.returncode == 0
    except Exception:
        return False

def stop_server():
    try:
        subprocess.run(["pkill", "-f", SERVER_SCRIPT], capture_output=True)
        time.sleep(1)  # Give it a moment to stop
        print("[server] Stopped.")
    except Exception as e:
        print(f"[server] Could not stop: {e}")

def start_server():
    try:
        subprocess.Popen(
            ["python3", SERVER_SCRIPT],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print("[server] Restarted.")
    except Exception as e:
        print(f"[server] Could not restart: {e}")

def rerender_scheme():
    print("[render] Re-rendering qc-scheme...")
    try:
        result = subprocess.run(RENDER_CMD, capture_output=True, text=True)
        if result.returncode == 0:
            print("[render] Done.")
        else:
            print(f"[render] Failed: {result.stderr.strip()}")
    except Exception as e:
        print(f"[render] Error: {e}")

def main():
    dry_run    = "--dry-run" in sys.argv
    limit      = None
    only_code  = None

    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--limit" and i < len(sys.argv) - 1:
            limit = int(sys.argv[i + 1])
        if arg == "--code" and i < len(sys.argv) - 1:
            only_code = sys.argv[i + 1]

    if dry_run:
        print("[mode] DRY RUN — no LM Studio calls, no writes.")

    # Load data
    codebook   = load_codebook_json()
    legacy     = load_legacy_codes()
    corpus     = build_corpus_index()

    codes_entry = codebook.setdefault("codes", {})
    tree        = codebook.get("tree", [])

    # Derive full code list from tree (all nodes), falling back to codes keys
    all_codes = [node["name"] for node in tree] if tree else list(codes_entry.keys())

    # Identify codes to process
    to_process = []
    skipped    = {"deprecated": 0, "non_unset": 0, "documented": 0,
                  "legacy": 0, "no_segments": 0, "only_code": 0}

    for code_name in all_codes:
        if only_code and code_name != only_code:
            skipped["only_code"] += 1
            continue
        entry  = codes_entry.get(code_name, {})
        status = (entry.get("status") or "").strip().lower()
        if status == "deprecated":
            skipped["deprecated"] += 1
            continue
        if status not in ("", "unset"):
            skipped["non_unset"] += 1
            continue
        if is_documented(entry):
            skipped["documented"] += 1
            continue
        if code_name in legacy:
            skipped["legacy"] += 1
            continue
        if code_name not in corpus:
            skipped["no_segments"] += 1
            continue
        to_process.append(code_name)

    print(f"\n[summary] {len(to_process)} codes to process.")
    print(f"  Skipped — deprecated: {skipped['deprecated']}, non-unset status: {skipped['non_unset']}, "
          f"already documented: {skipped['documented']}, legacy branch: {skipped['legacy']}, "
          f"no corpus segments: {skipped['no_segments']}")
    if only_code:
        print(f"  Filtered to --code '{only_code}' ({skipped['only_code']} others skipped)")

    if dry_run:
        print("\n[dry-run] Codes that would be processed:")
        for name in to_process:
            n = len(corpus.get(name, []))
            print(f"  {name}  ({n} segments)")
        return  # No server stop/start for dry runs

    if not to_process:
        print("[done] Nothing to process.")
        return

    if limit:
        to_process = to_process[:limit]
        print(f"[limit] Processing at most {limit} codes.")

    # Process
    processed = 0
    failed    = 0

    for i, code_name in enumerate(to_process, 1):
        segments      = corpus[code_name]
        segments_text = format_segments(segments)
        n_segs        = min(len(segments), MAX_SEGMENTS)
        print(f"\n[{i}/{len(to_process)}] {code_name}  ({n_segs} segments)")

        result = call_lm_studio(code_name, segments_text)

        if result and isinstance(result, dict):
            entry = codes_entry.setdefault(code_name, {})
            entry["scope"]       = result.get("scope",       "").strip()
            entry["rationale"]   = result.get("rationale",   "").strip()
            entry["usage_notes"] = result.get("usage_notes", "").strip()
            entry["ai_summary"]  = result.get("ai_summary",  "").strip()
            entry["status"]      = "experimental"
            print(f"  scope:       {entry['scope'][:80]}...")
            print(f"  rationale:   {entry['rationale'][:80]}...")
            print(f"  usage_notes: {entry['usage_notes'][:80]}...")
            processed += 1
        else:
            print(f"  [warn] Skipping {code_name} — no valid response.")
            failed += 1

        # Brief pause between calls to avoid overwhelming LM Studio
        if i < len(to_process):
            time.sleep(0.5)

    print(f"\n[done] Processed: {processed}, failed: {failed}.")

    if processed > 0:
        save_codebook_json(codebook)
        print(f"[saved] codebook.json updated. Re-render scheme and restart server manually.")

    print(f"Codes with status 'experimental' are ready for review in qc-scheme.")

if __name__ == "__main__":
    main()