#!/usr/bin/env python3
"""qc-code-review.py — Review corpus applications for fit against code definitions.

For each code in scope, loads all corpus applications from qc/json/*.json,
retrieves the code's documentation from codebook.json, and uses an LLM to
assess whether each application fits the code definition. Outputs an HTML
report with verdicts and reasons per segment. Decisions saved from the HTML
report can be applied back to the corpus with --apply.

Usage (from project root):
    python3 qc-atelier/qc-code-review.py [--code CODE | --branch BRANCH] [options]
    python3 qc-atelier/qc-code-review.py --apply REPORT_JSON [--dry-run]

Options:
    --code CODE        Review a single code
    --branch BRANCH    Review all codes under a named top-level branch
    (neither)          Review all codes in the codebook
    --model NAME       Override model (default: qwen3:35b)
    --thinking         Enable thinking mode
    --no-thinking      Disable thinking mode (default)
    --dry-run          Preview without writing anything
    --apply JSON       Apply recode decisions from a saved report JSON

Output:
    qc/code-review-CODE.html   — interactive HTML report
    qc/code-review-CODE.json   — decisions file for --apply
"""

import json
import sys
import urllib.request
from pathlib import Path
from collections import defaultdict

# ── Config ────────────────────────────────────────────────────────────────────

CODEBOOK_JSON   = Path("qc/codebook.json")
CORPUS_DIR      = Path("qc/json")
LLM_URL         = "http://localhost:11434/v1/chat/completions"  # cluster tunnel
# LLM_URL       = "http://localhost:1234/v1/chat/completions"   # LM Studio local
MODEL           = "qwen3:35b"
TEMPERATURE     = 0.15
TIMEOUT         = 120
ENABLE_THINKING = False

SYSTEM_PROMPT = """You are a qualitative research methodologist reviewing corpus coding in an interview-based study.

For each segment, assess whether it is a genuine application of the given code based on the code's definition.

Respond with JSON only — no preamble, no markdown fences:
{
  "verdict": "good" | "weak" | "bad",
  "reason": "one sentence explanation"
}

good = segment clearly fits the code definition
weak = loosely related but fit is questionable
bad  = segment does not fit; likely a miscoding"""

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_codebook():
    if not CODEBOOK_JSON.exists():
        print(f"[error] {CODEBOOK_JSON} not found. Run from project root.")
        sys.exit(1)
    d = json.load(open(CODEBOOK_JSON))
    return d.get("codes", {}), d.get("tree", [])

def load_corpus_files():
    if not CORPUS_DIR.exists():
        return {}
    result = {}
    for jf in sorted(CORPUS_DIR.glob("*.json")):
        try:
            result[jf] = json.load(open(jf))
        except Exception as e:
            print(f"[warn] Could not read {jf.name}: {e}", file=sys.stderr)
    return result

def save_corpus_file(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def confirm(prompt):
    return input(prompt + " [y/n] ").strip().lower() == "y"

def get_code_doc(codes, code_name):
    entry = codes.get(code_name, {})
    parts = []
    for field, label in (("scope", "Scope"), ("rationale", "Rationale"), ("usage_notes", "Usage notes")):
        val = (entry.get(field) or "").strip()
        if val:
            parts.append(f"{label}: {val}")
    return "\n".join(parts) if parts else "(no documentation available)"

def build_branch_map(codes, tree):
    parent_map = {n["name"]: n.get("parent", "") for n in tree}

    def top_parent(name):
        visited = set()
        while name in parent_map and parent_map[name]:
            if name in visited:
                break
            visited.add(name)
            name = parent_map[name]
        return name

    branches = defaultdict(list)
    for n in tree:
        code_name = n["name"]
        if n.get("parent"):
            branch = top_parent(code_name)
            branches[branch].append(code_name)
    return branches

def call_llm(prompt):
    payload = {
        "model":       MODEL,
        "temperature": TEMPERATURE,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
        "chat_template_kwargs": {"enable_thinking": ENABLE_THINKING},
    }
    data = json.dumps(payload).encode("utf-8")
    req  = urllib.request.Request(
        LLM_URL, data=data,
        headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            result = json.loads(resp.read())
        content = result["choices"][0]["message"]["content"].strip()
        if content.startswith("```"):
            content = "\n".join(content.split("\n")[1:])
        if content.endswith("```"):
            content = "\n".join(content.split("\n")[:-1])
        content = content.strip()
        start = content.find("{")
        end   = content.rfind("}") + 1
        if start >= 0 and end > start:
            content = content[start:end]
        return json.loads(content)
    except Exception as e:
        print(f"  [error] {e}", file=sys.stderr)
        return None

# ── Review ────────────────────────────────────────────────────────────────────

def review_code(code_name, codes, corpus, dry_run):
    code_doc = get_code_doc(codes, code_name)
    applications = []
    for jf, entries in corpus.items():
        for entry in entries:
            if entry.get("code") == code_name:
                applications.append({
                    "document": entry.get("document", jf.name),
                    "line":     entry.get("line", "?"),
                    "text":     entry.get("text", ""),
                    "recode_to": None,
                })

    if not applications:
        return None

    print(f"  {code_name}: {len(applications)} application(s)...", end=" ", flush=True)

    results = []
    for app in applications:
        if dry_run:
            app["verdict"] = "dry-run"
            app["reason"]  = ""
        else:
            prompt = (
                f"Code: {code_name}\n"
                f"Code definition:\n{code_doc}\n\n"
                f"Segment (from {app['document']}, line {app['line']}):\n"
                f"{app['text'].strip()}"
            )
            result = call_llm(prompt)
            if result:
                app["verdict"] = result.get("verdict", "error")
                app["reason"]  = result.get("reason", "")
            else:
                app["verdict"] = "error"
                app["reason"]  = "LLM call failed"
        results.append(app)

    counts = defaultdict(int)
    for r in results: counts[r["verdict"]] += 1
    print(dict(counts))

    return {"code": code_name, "doc": code_doc, "results": results}

def op_review(code_names, codes, dry_run):
    corpus  = load_corpus_files()
    all_out = []

    print(f"\n[code-review] Reviewing {len(code_names)} code(s)...\n")
    for code_name in code_names:
        report = review_code(code_name, codes, corpus, dry_run)
        if report:
            all_out.append(report)

    if dry_run:
        print("\n[dry-run] No files written.")
        return

    if not all_out:
        print("[code-review] No corpus applications found.")
        return

    # One HTML + JSON per code
    for report in all_out:
        code_name = report["code"]
        json_path = Path(f"qc/code-review-{code_name}.json")
        html_path = Path(f"qc/code-review-{code_name}.html")
        with open(json_path, "w") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        html_path.write_text(build_html(report, codes), encoding="utf-8")
        print(f"  {code_name}: {json_path.name}, {html_path.name}")

    print(f"\n[code-review] Done. {len(all_out)} report(s) written.")

# ── Apply ─────────────────────────────────────────────────────────────────────

def op_apply(report_path, dry_run):
    with open(report_path) as f:
        report = json.load(f)

    code_name = report["code"]
    recodes   = [(r["document"], r["line"], r["recode_to"])
                 for r in report["results"] if r.get("recode_to")]

    if not recodes:
        print("[apply] No recode decisions in report.")
        return

    print(f"[apply] {len(recodes)} recode(s) for '{code_name}':")
    for doc, line, new_code in recodes:
        print(f"  {doc} line {line}  ->  {new_code}")

    if dry_run:
        print("[dry-run] No files written.")
        return

    if not confirm(f"\nApply {len(recodes)} recode(s)?"):
        print("[aborted]")
        return

    recode_map = {(r["document"], str(r["line"])): r["recode_to"]
                  for r in report["results"] if r.get("recode_to")}

    corpus   = load_corpus_files()
    modified = 0
    for jf, entries in corpus.items():
        changed     = False
        new_entries = []
        for entry in entries:
            new_entry = dict(entry)
            key = (entry.get("document", ""), str(entry.get("line", "")))
            if entry.get("code") == code_name and key in recode_map:
                new_entry["code"] = recode_map[key]
                changed = True
            new_entries.append(new_entry)
        if changed:
            save_corpus_file(jf, new_entries)
            modified += 1

    print(f"[apply] Updated {modified} corpus file(s).")
    print("[done]")

# ── HTML ──────────────────────────────────────────────────────────────────────

def build_html(report, codes):
    code_name  = report["code"]
    code_doc   = report["doc"]
    results    = report["results"]
    all_codes  = sorted(codes.keys())
    data_json  = json.dumps(results, ensure_ascii=False)
    codes_json = json.dumps(all_codes, ensure_ascii=False)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>qc-code-review: {code_name}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{{--bg:#0f1117;--surface:#1a1d27;--border:#2d3148;--text:#e2e4ed;--dim:#6b7280;
      --green:#22c55e;--yellow:#f59e0b;--red:#ef4444;--accent:#6366f1;}}
*{{box-sizing:border-box;margin:0;padding:0;}}
body{{font-family:"IBM Plex Sans",system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;max-width:960px;margin:0 auto;}}
h1{{font-size:1.2rem;margin-bottom:6px;font-weight:600;}}
.code-name{{font-family:"IBM Plex Mono",monospace;color:var(--accent);}}
.doc-block{{background:var(--surface);border:1px solid var(--border);border-radius:6px;
            padding:12px 16px;margin:12px 0 20px;font-size:0.83rem;white-space:pre-wrap;
            color:var(--dim);line-height:1.6;}}
.toolbar{{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;}}
input[type=search],select{{padding:6px 10px;border:1px solid var(--border);border-radius:4px;
  font-size:0.83rem;background:var(--surface);color:var(--text);}}
.summary{{font-size:0.82rem;color:var(--dim);margin-left:auto;}}
.save-btn{{padding:5px 14px;background:var(--accent);color:#fff;border:none;border-radius:4px;
           font-size:0.82rem;cursor:pointer;margin-left:8px;}}
.save-btn:hover{{opacity:0.85;}}
.cards{{display:flex;flex-direction:column;gap:8px;}}
.card{{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 16px;}}
.card.good{{border-left:3px solid var(--green);}}
.card.weak{{border-left:3px solid var(--yellow);}}
.card.bad{{border-left:3px solid var(--red);}}
.card.hidden{{display:none;}}
.card-meta{{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:0.78rem;color:var(--dim);}}
.badge{{padding:1px 7px;border-radius:3px;font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;}}
.badge.good{{background:#14532d;color:var(--green);}}
.badge.weak{{background:#451a03;color:var(--yellow);}}
.badge.bad{{background:#450a0a;color:var(--red);}}
.badge.error{{background:#1e1b4b;color:var(--dim);}}
.reason{{font-size:0.8rem;color:var(--dim);font-style:italic;margin-bottom:8px;}}
.seg-text{{font-size:0.84rem;line-height:1.65;border-left:3px solid var(--border);
           padding-left:10px;margin-bottom:10px;}}
.recode-row{{display:flex;align-items:center;gap:8px;font-size:0.8rem;}}
.recode-row label{{color:var(--dim);white-space:nowrap;}}
.recode-input{{padding:3px 8px;border:1px solid var(--border);border-radius:3px;
               font-family:"IBM Plex Mono",monospace;font-size:0.76rem;width:280px;
               background:var(--bg);color:var(--text);}}
.recode-input:focus{{outline:none;border-color:var(--accent);}}
</style>
</head>
<body>
<h1>qc-code-review: <span class="code-name">{code_name}</span></h1>
<div class="doc-block">{code_doc}</div>
<div class="toolbar">
  <input type="search" id="search" placeholder="Search text or document…">
  <select id="filter">
    <option value="all">All</option>
    <option value="good">Good</option>
    <option value="weak">Weak</option>
    <option value="bad">Bad</option>
    <option value="error">Error</option>
  </select>
  <span class="summary" id="summary"></span>
  <button class="save-btn" onclick="saveJSON()">Save decisions</button>
</div>
<div class="cards" id="cards"></div>
<datalist id="codes-list"></datalist>
<script>
const CODE_NAME = {json.dumps(code_name)};
const ALL_CODES = {codes_json};
const state = {data_json}.map(r => ({{...r, recode_to: r.recode_to || null}}));
const dl = document.getElementById("codes-list");
ALL_CODES.forEach(c => {{ const o = document.createElement("option"); o.value = c; dl.appendChild(o); }});

function render() {{
  const q      = document.getElementById("search").value.toLowerCase();
  const filter = document.getElementById("filter").value;
  const cards  = document.getElementById("cards");
  cards.innerHTML = "";
  let shown = 0;
  state.forEach((r, i) => {{
    const matchQ = !q || (r.text||"").toLowerCase().includes(q) || (r.document||"").toLowerCase().includes(q);
    const matchF = filter === "all" || r.verdict === filter;
    if (!matchQ || !matchF) return;
    shown++;
    const card = document.createElement("div");
    card.className = "card " + (r.verdict || "error");
    card.innerHTML = `
      <div class="card-meta">
        <span class="badge ${{r.verdict}}">${{r.verdict}}</span>
        <span>${{r.document}} — line ${{r.line}}</span>
      </div>
      <div class="reason">${{r.reason || ""}}</div>
      <div class="seg-text">${{(r.text||"").trim()}}</div>
      <div class="recode-row">
        <label>Recode to:</label>
        <input class="recode-input" list="codes-list"
               placeholder="leave blank to keep as ${{CODE_NAME}}"
               value="${{r.recode_to || ""}}"
               oninput="state[${{i}}].recode_to = this.value.trim() || null">
      </div>`;
    cards.appendChild(card);
  }});
  document.getElementById("summary").textContent = `${{shown}} of ${{state.length}} segments`;
}}

function saveJSON() {{
  const blob = new Blob([JSON.stringify({{code: CODE_NAME, results: state}}, null, 2)],
                        {{type: "application/json"}});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "code-review-" + CODE_NAME + ".json";
  a.click();
}}

document.getElementById("search").addEventListener("input", render);
document.getElementById("filter").addEventListener("change", render);
render();
</script>
</body>
</html>"""

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    args        = sys.argv[1:]
    dry_run     = "--dry-run" in args
    only_code   = None
    only_branch = None
    model       = None
    thinking    = None

    for i, arg in enumerate(args):
        if arg == "--code"   and i + 1 < len(args): only_code   = args[i + 1]
        if arg == "--branch" and i + 1 < len(args): only_branch = args[i + 1]
        if arg == "--model"  and i + 1 < len(args): model       = args[i + 1]
        if arg == "--thinking":    thinking = True
        if arg == "--no-thinking": thinking = False

    global MODEL, ENABLE_THINKING
    if model:    MODEL           = model
    if thinking is not None: ENABLE_THINKING = thinking

    if "--apply" in args:
        idx = args.index("--apply")
        if idx + 1 >= len(args):
            print("[error] --apply requires a JSON path.")
            sys.exit(1)
        if dry_run:
            print("[mode] DRY RUN — no files will be written.")
        op_apply(args[idx + 1], dry_run)
        return

    if dry_run:
        print("[mode] DRY RUN — no files will be written.")

    codes, tree = load_codebook()

    if only_code:
        if only_code not in codes:
            print(f"[warn] '{only_code}' not found in codebook.json.")
        code_names = [only_code]
    elif only_branch:
        branches = build_branch_map(codes, tree)
        if only_branch not in branches:
            print(f"[error] Branch '{only_branch}' not found.")
            sys.exit(1)
        code_names = branches[only_branch]
    else:
        code_names = [n["name"] for n in tree if n.get("parent")]

    op_review(code_names, codes, dry_run)

if __name__ == "__main__":
    main()