#!/usr/bin/env python3
"""qc-code-review.py — Review corpus applications of a code for fit.

For a given code, loads all corpus applications, retrieves the code's
documentation from codebook.json, and uses an LLM to assess whether each
application genuinely fits the code definition. Outputs an HTML report with
flagged segments for review. Decisions saved as JSON can be applied back to
the corpus with --apply.

Usage (from project root):
    python3 qc-atelier/qc-code-review.py --code CODE_NAME [options]
    python3 qc-atelier/qc-code-review.py --apply REPORT_JSON [--dry-run]

Options:
    --code CODE_NAME     Code to review
    --model MODEL        LLM model (default: qwen3:35b)
    --no-thinking        Disable thinking mode (default: thinking off)
    --dry-run            Preview without writing anything
    --apply REPORT_JSON  Apply recode decisions from a saved report JSON
    --out PATH           Output path for HTML report (default: qc/code-review-CODE.html)

Files read:
    qc/codebook.json     — code documentation
    qc/json/*.json       — corpus segment exports

Files written:
    qc/code-review-CODE.html   — interactive HTML review report
    qc/code-review-CODE.json   — machine-readable decisions (for --apply)
    qc/json/*.json             — corpus files (only with --apply)
"""

import json
import sys
import urllib.request as _ur
from pathlib import Path
from collections import defaultdict

# ── Config ────────────────────────────────────────────────────────────────────

CODEBOOK_JSON = Path("qc/codebook.json")
CORPUS_DIR    = Path("qc/json")
LLM_URL       = "http://localhost:11434/v1/chat/completions"
DEFAULT_MODEL = "qwen3:35b"

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_codebook():
    if not CODEBOOK_JSON.exists():
        print(f"[error] {CODEBOOK_JSON} not found. Run from project root.")
        sys.exit(1)
    with open(CODEBOOK_JSON) as f:
        return json.load(f)

def load_corpus_files():
    if not CORPUS_DIR.exists():
        return {}
    result = {}
    for jf in sorted(CORPUS_DIR.glob("*.json")):
        try:
            with open(jf) as f:
                result[jf] = json.load(f)
        except Exception as e:
            print(f"[warn] Could not read {jf.name}: {e}", file=sys.stderr)
    return result

def save_corpus_file(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def confirm(prompt):
    return input(prompt + " [y/n] ").strip().lower() == "y"

def get_code_doc(codebook, code_name):
    entry = codebook.get("codes", {}).get(code_name, {})
    parts = []
    for field in ("scope", "rationale", "usage_notes"):
        val = entry.get(field, "").strip()
        if val:
            labels = {"scope": "Scope", "rationale": "Rationale", "usage_notes": "Usage notes"}
            parts.append(f"{labels[field]}: {val}")
    return "\n".join(parts) if parts else "(no documentation available)"

def llm_call(messages, model, thinking):
    payload = {
        "model":    model,
        "messages": messages,
        "stream":   False,
        "options":  {"think": thinking},
    }
    data = json.dumps(payload).encode("utf-8")
    req  = _ur.Request(LLM_URL, data=data,
                       headers={"Content-Type": "application/json"}, method="POST")
    try:
        with _ur.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
        return result["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"[error] LLM call failed: {e}", file=sys.stderr)
        return None

def assess_application(code_name, code_doc, segment_text, document, line, model, thinking):
    prompt = f"""You are reviewing corpus coding in a qualitative research project.

Code: {code_name}
Code definition:
{code_doc}

Segment (from {document}, line {line}):
{segment_text.strip()}

Is this a good application of the code "{code_name}" to this segment?

Respond with ONLY a JSON object, no preamble, no markdown:
{{
  "verdict": "good" | "weak" | "bad",
  "reason": "one sentence explanation"
}}

good = segment clearly fits the code definition
weak = loosely related but fit is questionable
bad  = segment does not fit; likely a miscoding"""

    response = llm_call([{"role": "user", "content": prompt}], model, thinking)
    if not response:
        return {"verdict": "error", "reason": "LLM call failed"}
    try:
        clean = response.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
        return json.loads(clean)
    except Exception:
        return {"verdict": "error", "reason": f"Could not parse: {response[:120]}"}

# ── Review operation ──────────────────────────────────────────────────────────

def op_review(code_name, model, thinking, dry_run, out_path):
    codebook = load_codebook()
    corpus   = load_corpus_files()

    code_doc = get_code_doc(codebook, code_name)
    print(f"\n[code-review] Code: {code_name}")
    print(f"[code-review] Documentation:\n{code_doc}\n")

    applications = []
    for jf, entries in corpus.items():
        for entry in entries:
            if entry.get("code") == code_name:
                applications.append({
                    "file":     jf,
                    "document": entry.get("document", jf.name),
                    "line":     entry.get("line", "?"),
                    "text":     entry.get("text", ""),
                })

    if not applications:
        print(f"[code-review] No corpus applications found for '{code_name}'.")
        return

    print(f"[code-review] {len(applications)} application(s) found. Assessing...\n")

    results = []
    for i, app in enumerate(applications):
        print(f"  [{i+1}/{len(applications)}] {app['document']} line {app['line']}...", end=" ", flush=True)
        if dry_run:
            assessment = {"verdict": "dry-run", "reason": "dry run"}
        else:
            assessment = assess_application(
                code_name, code_doc,
                app["text"], app["document"], app["line"],
                model, thinking
            )
        app["verdict"]   = assessment.get("verdict", "error")
        app["reason"]    = assessment.get("reason", "")
        app["recode_to"] = None
        results.append(app)
        print(app["verdict"])

    counts = defaultdict(int)
    for r in results: counts[r["verdict"]] += 1
    print(f"\n[code-review] Summary: {dict(counts)}")

    if dry_run:
        print("[dry-run] No files written.")
        return

    out_stem = out_path or Path(f"qc/code-review-{code_name}")
    json_path = out_stem.with_suffix(".json") if out_path else Path(f"qc/code-review-{code_name}.json")
    html_path = out_stem.with_suffix(".html") if out_path else Path(f"qc/code-review-{code_name}.html")

    report = {
        "code":    code_name,
        "doc":     code_doc,
        "results": [
            {k: v for k, v in r.items() if k != "file"}
            for r in results
        ],
    }

    with open(json_path, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"[code-review] JSON: {json_path}")

    html_path.write_text(build_html(report, codebook), encoding="utf-8")
    print(f"[code-review] HTML: {html_path}")

# ── Apply operation ───────────────────────────────────────────────────────────

def op_apply(report_path, dry_run):
    with open(report_path) as f:
        report = json.load(f)

    code_name = report["code"]
    recodes   = [(r["document"], r["line"], r["recode_to"])
                 for r in report["results"] if r.get("recode_to")]

    if not recodes:
        print("[apply] No recode decisions in report.")
        return

    print(f"[apply] {len(recodes)} recode(s):")
    for doc, line, new_code in recodes:
        print(f"  {doc} line {line}  {code_name} -> {new_code}")

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

def build_html(report, codebook):
    code_name  = report["code"]
    code_doc   = report["doc"]
    results    = report["results"]
    all_codes  = sorted(codebook.get("codes", {}).keys())
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
           padding-left:10px;margin-bottom:10px;color:var(--text);}}
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
    <option value="all">All verdicts</option>
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
    if (!matchQ || !matchF) {{
      const ghost = document.createElement("div");
      ghost.className = "card hidden";
      cards.appendChild(ghost);
      return;
    }}
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
    args     = sys.argv[1:]
    dry_run  = "--dry-run" in args
    thinking = "--no-thinking" not in args  # off by default per conventions

    model = DEFAULT_MODEL
    if "--model" in args:
        idx = args.index("--model")
        if idx + 1 < len(args):
            model = args[idx + 1]

    out_path = None
    if "--out" in args:
        idx = args.index("--out")
        if idx + 1 < len(args):
            out_path = Path(args[idx + 1])

    if "--apply" in args:
        idx = args.index("--apply")
        if idx + 1 >= len(args):
            print("[error] --apply requires a JSON path.")
            sys.exit(1)
        if dry_run:
            print("[mode] DRY RUN — no files will be written.")
        op_apply(args[idx + 1], dry_run)
        return

    code_name = None
    if "--code" in args:
        idx = args.index("--code")
        if idx + 1 < len(args):
            code_name = args[idx + 1]

    if not code_name:
        print(__doc__)
        sys.exit(0)

    if dry_run:
        print("[mode] DRY RUN — no files will be written.")

    op_review(code_name, model, thinking, dry_run, out_path)

if __name__ == "__main__":
    main()
