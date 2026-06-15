#!/usr/bin/env python3
"""qc-overview.py — Analytical overview of the qualitative code system.

Usage:
    python3 qc-atelier/qc-overview.py [--dry-run] [--model NAME] [--out PATH]
"""

import json, re, sys, urllib.request
from collections import defaultdict, Counter
from pathlib import Path

# ── Config ─────────────────────────────────────────────────────────────────────
CODEBOOK_JSON = Path("qc/codebook.json")
CORPUS_DIR    = Path("qc/json")
EXCLUDE_DIR   = Path("qc/corpus/exclude")
LLM_URL       = "http://localhost:11434/v1/chat/completions"
MODEL         = "qwen3:32b"
TEMPERATURE   = 0.3

# Branches excluded from passage code display
EXCLUDED_BRANCHES = {
    "Meta", "Backgrounds", "Contexts", "Figuration_domain", "Concepts"
}
# Also exclude named individuals — detected as codes in the People branch
# with no underscore-separated prefix number and matching capitalized name pattern

CHECKPOINT = Path("qc/overview-checkpoint.json")

CONTEXT = """Qualitative research about data sharing practices in Canadian COVID-19 research infrastructure.
Corpus: semi-structured interviews with people who lead, support, and participate in the CITF Databank —
a data harmonization initiative coordinating distributed epidemiological studies.
Research focus: practical and situated experiences of data sharing — technical, administrative, social, and epistemic dimensions."""

RESEARCH_FOCUS = """This research investigates data sharing in epidemiological research, focusing on the CITF Databank — a COVID-19 data harmonization initiative. It examines how researchers, data managers, and administrators navigate the practical, technical, administrative, social, and epistemic dimensions of coordinating distributed datasets. The study articulates motivations for data harmonization, how value is ascertained, and the strategies, challenges, and lessons involved."""

BRANCH_COLORS = [
    ("#1a4a8a", "#dce6f7"),  # blue — Means
    ("#1a6a3a", "#d5f0e0"),  # green — People
    ("#7a3a8a", "#ede0f5"),  # violet — Challenges
    ("#8a5a1a", "#f5ebd5"),  # amber — Kinds_of_data
    ("#1a6a6a", "#d5f0f0"),  # teal — Kinds_of_relationships
    ("#8a1a3a", "#f5d5e0"),  # rose — Qualities
    ("#3a6a1a", "#e0f0d5"),  # lime — Stories
    ("#1a3a6a", "#d5e0f5"),  # navy — Comparisons
    ("#6a3a1a", "#f0e0d5"),  # brown — Outcomes
    ("#4a1a8a", "#e0d5f5"),  # purple
    ("#1a8a4a", "#d5f5e0"),  # emerald
]

# ── Data loading ───────────────────────────────────────────────────────────────
def load_codebook():
    d = json.load(open(CODEBOOK_JSON))
    return d.get("codes", {}), d.get("tree", [])

def load_corpus():
    excluded = set(f.stem for f in EXCLUDE_DIR.glob("*.txt")) if EXCLUDE_DIR.exists() else set()
    corpus = {}
    for jf in sorted(CORPUS_DIR.glob("*.json")):
        if any(ex in jf.stem for ex in excluded):
            continue
        try:
            corpus[jf.stem] = json.load(open(jf))
        except Exception:
            pass
    return corpus

# ── Checkpoint ────────────────────────────────────────────────────────────────
def load_checkpoint():
    if CHECKPOINT.exists():
        try:
            return json.load(open(CHECKPOINT))
        except Exception:
            pass
    return {}

def save_checkpoint(data):
    with open(CHECKPOINT, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

# ── Tree helpers ───────────────────────────────────────────────────────────────
def build_tree(tree):
    parent_map   = {n["name"]: n.get("parent", "") for n in tree}
    children_map = defaultdict(list)
    for n in tree:
        if n.get("parent"):
            children_map[n["parent"]].append(n["name"])
    top = [n["name"] for n in tree if not n.get("parent")]
    return parent_map, children_map, top

def get_top_branch(code, parent_map, top_set):
    visited, c = set(), code
    while parent_map.get(c) and c not in visited:
        visited.add(c); c = parent_map[c]
    return c if c in top_set else None

def get_desc(name, children_map):
    result, queue = [], [name]
    while queue:
        cur = queue.pop()
        for child in children_map.get(cur, []):
            result.append(child); queue.append(child)
    return result

def is_named_individual(code, parent_map):
    """Check if code is under People > Individuals branch."""
    visited, c = set(), code
    while parent_map.get(c) and c not in visited:
        visited.add(c)
        c = parent_map[c]
        if c == "Individuals":
            return True
    return False

def should_show_code(code, branch, codes_meta, parent_map):
    if branch in EXCLUDED_BRANCHES:
        return False
    if is_named_individual(code, parent_map):
        return False
    return True

def filter_relevant_codes(codes, codes_meta, dry_run):
    """Use LLM to filter codes to those relevant to the research focus. Batched."""
    if dry_run or not codes:
        return set(codes)

    BATCH_SIZE = 80
    all_relevant = set()
    batches = [codes[i:i+BATCH_SIZE] for i in range(0, len(codes), BATCH_SIZE)]

    for batch_num, batch in enumerate(batches, 1):
        entries = []
        for c in batch:
            entry = codes_meta.get(c, {})
            scope = (entry.get("scope") or entry.get("ai_summary") or "").strip()[:60]
            entries.append(f"  {c}: {scope}" if scope else f"  {c}")

        prompt = (
            f"Research focus: {RESEARCH_FOCUS}\n\n"
            f"From the following codes, exclude ONLY codes that are clearly irrelevant — "
            f"specifically: personality traits or purely personal characteristics unrelated to professional practice, "
            f"and codes that describe interview logistics or transcription artifacts.\n\n"
            f"Keep everything else: work practices, roles, relationships, challenges, concepts, "
            f"tools, data types, organizational structures, decision-making, motivations, outcomes, "
            f"comparisons, and anything that could plausibly appear in an account of data sharing or research coordination.\n\n"
            f"Codes (batch {batch_num}/{len(batches)}):\n" + "\n".join(entries) + "\n\n"
            f"Return ONLY a JSON array of codes to KEEP. No other text."
        )

        result = llm(prompt, dry_run=False, model_override="qwen2.5:7b")
        try:
            start = result.find("["); end = result.rfind("]") + 1
            if start >= 0 and end > start:
                relevant = json.loads(result[start:end])
                all_relevant.update(relevant)
                print(f" batch {batch_num}: {len(relevant)}/{len(batch)}", end="", flush=True)
        except Exception as e:
            print(f" [batch {batch_num} error: {e}]", end="")
            all_relevant.update(batch)  # keep all on error

    print(f" → {len(all_relevant)}/{len(codes)} total relevant", end="")
    return all_relevant

def assign_branch_colors(top):
    return {b: BRANCH_COLORS[i % len(BRANCH_COLORS)] for i, b in enumerate(top)}

# ── Corpus analysis ────────────────────────────────────────────────────────────
def corpus_stats(corpus):
    by_line = defaultdict(set)
    by_doc  = defaultdict(set)
    counts  = Counter()
    for doc, entries in corpus.items():
        for e in entries:
            c = e.get("code", "")
            if c:
                counts[c] += 1
                by_line[(doc, e.get("line", 0))].add(c)
                by_doc[doc].add(c)
    return counts, by_line, by_doc

def select_passages(corpus, by_line, parent_map, top_set, codes_meta, relevant_codes, n=4):
    candidates = []
    for (doc, line), codes in by_line.items():
        # First pass: branch exclusions + individuals
        branch_filtered = [c for c in codes if should_show_code(c, get_top_branch(c, parent_map, top_set) or "", codes_meta, parent_map)]
        # Second pass: LLM relevance filter
        display = [c for c in branch_filtered if c in relevant_codes]
        if len(display) < 3:
            continue
        branches = {get_top_branch(c, parent_map, top_set) for c in display if get_top_branch(c, parent_map, top_set)}
        if len(branches) < 2:
            continue
        text = next((e.get("text","") for e in corpus.get(doc,[]) if e.get("line")==line and len(e.get("text",""))>60), "")
        if not text:
            continue
        candidates.append({
            "doc": doc, "line": line, "all_codes": sorted(codes),
            "display_codes": display,
            "branches": sorted(branches), "text": text.strip(),
            "score": len(display) * len(branches)
        })
    candidates.sort(key=lambda x: -x["score"])
    seen_pairs, seen_docs, selected = set(), set(), []
    for c in candidates:
        if c["doc"] in seen_docs:
            continue
        pair = tuple(sorted(c["branches"][:2]))
        seen_pairs.add(pair)
        seen_docs.add(c["doc"])
        selected.append(c)
        if len(selected) >= n:
            break
    return selected

def cross_branch_pairs(by_line, parent_map, top_set, codes_meta, n=5):
    counter = Counter()
    for codes in by_line.values():
        display = [c for c in codes if should_show_code(c, get_top_branch(c, parent_map, top_set) or "", codes_meta, parent_map)]
        branches = sorted({get_top_branch(c, parent_map, top_set) for c in display if get_top_branch(c, parent_map, top_set)})
        for i, b1 in enumerate(branches):
            for b2 in branches[i+1:]:
                counter[(b1, b2)] += 1
    return counter.most_common(n)

# ── Anonymize ──────────────────────────────────────────────────────────────────
def anonymize(text):
    """Strip speaker names from passage text."""
    return re.sub(r'^[A-Z][a-z]+:\s*', '', text.strip())

# ── LLM ────────────────────────────────────────────────────────────────────────
SYS = f"""You are an expert qualitative researcher analyzing data on {CONTEXT}
Write in a precise analytical register. Be specific and interpretive. Always respond in English only."""

def llm(prompt, dry_run=False, model_override=None):
    if dry_run:
        return "[placeholder]"
    model = model_override or MODEL
    payload = json.dumps({
        "model": model, "temperature": TEMPERATURE,
        "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": prompt}],
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    req = urllib.request.Request(LLM_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read())["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"[error: {e}]"

def gen_highlights(text, codes, codes_meta, dry_run):
    if dry_run:
        return {}
    defs = "\n".join(
        f"  {c}: {(codes_meta.get(c,{}).get('scope') or codes_meta.get(c,{}).get('ai_summary') or '')[:60]}"
        for c in codes
    )
    result = llm(
        f"Passage text:\n\"{text}\"\n\n"
        f"Codes applied to this passage:\n{defs}\n\n"
        f"For each code listed above, identify the exact verbatim substring of the passage that best exemplifies what the code captures. "
        f"Rules: copy exact words from the passage — do not paraphrase. 3-20 words per quote. "
        f"Include every code — pick the most representative phrase if the code applies broadly. "
        f"Return ONLY a valid JSON object mapping code name to verbatim substring. No other text."
    )
    print(f"\n  [highlight raw ({len(result)} chars): {result[:200]}]", end="", flush=True)
    try:
        start = result.find("{"); end = result.rfind("}") + 1
        if start >= 0 and end > start:
            parsed = json.loads(result[start:end])
            verified = {}
            for code, span in parsed.items():
                if isinstance(span, str) and span:
                    idx = text.find(span)
                    if idx < 0:
                        idx = text.lower().find(span.lower())
                        if idx >= 0:
                            span = text[idx:idx+len(span)]
                    if idx >= 0:
                        verified[code] = span
            print(f" → {len(verified)}/{len(parsed)} matched", end="")
            return verified
    except Exception as e:
        print(f" [highlight error: {e}]", end="")
    return {}

def gen_passage_bullets(text, codes, codes_meta, dry_run):
    defs = "\n".join(
        f"  {c}: {(codes_meta.get(c,{}).get('scope') or codes_meta.get(c,{}).get('ai_summary') or '')[:80]}"
        for c in codes[:12]
    )
    result = llm(
        f"Codes:\n{defs}\n\nSegment:\n{text}\n\n"
        f"Give 3 bullet points interpreting what this coding reveals analytically. "
        f"Each bullet: one specific observation about what the code combination shows. "
        f"Format: return only the bullets, one per line, starting with •",
        dry_run
    )
    return result

def gen_branch_bullets(name, top_codes, doc_text, dry_run):
    result = llm(
        f"Branch: {name}\nTop codes: {', '.join(top_codes[:6])}\nDocumentation: {doc_text}\n\n"
        f"Give 2 bullet points analytically characterizing what this branch captures in the context of data sharing research. "
        f"Format: return only the bullets, one per line, starting with •",
        dry_run, model_override="qwen2.5:7b"
    )
    return result

def gen_intersection_bullets(b1, b2, count, s1, s2, dry_run):
    result = llm(
        f"Branches co-occurring {count} times:\n{b1}: {s1}\n{b2}: {s2}\n\n"
        f"Give 2 bullet points interpreting what this intersection reveals analytically. "
        f"Format: bullets only, one per line, starting with •",
        dry_run, model_override="qwen2.5:7b"
    )
    return result

def gen_intro(branch_names, top_pairs, dry_run):
    pairs_str = "\n".join(f"  {b1} × {b2}: {n}" for (b1,b2),n in top_pairs[:3])
    return llm(
        f"Branches: {', '.join(branch_names)}\nTop co-occurrences:\n{pairs_str}\n\n"
        f"Write 2 sentences in English introducing this code system analytically — "
        f"what terrain it maps and what tensions are visible in its structure. "
        f"Use only English. Do not use any other language.",
        dry_run, model_override="qwen2.5:7b"
    )

# ── HTML helpers ───────────────────────────────────────────────────────────────
def apply_highlights(text, highlights, branch_colors, code_to_branch):
    import html as _html
    if not highlights:
        return _html.escape(text)

    raw_spans = []
    for code, span in highlights.items():
        if not span or not isinstance(span, str):
            continue
        idx = text.find(span)
        if idx < 0:
            idx = text.lower().find(span.lower())
            if idx >= 0:
                span = text[idx:idx+len(span)]
        if idx >= 0:
            branch = code_to_branch.get(code, "")
            fg, bg = branch_colors.get(branch, ("#444", "#eee"))
            raw_spans.append((idx, idx + len(span), code, fg, bg))

    if not raw_spans:
        return _html.escape(text)

    boundaries = sorted(set([0, len(text)] + [s[0] for s in raw_spans] + [s[1] for s in raw_spans]))

    result = []
    for i in range(len(boundaries) - 1):
        seg_start = boundaries[i]
        seg_end   = boundaries[i + 1]
        seg_text  = text[seg_start:seg_end]
        covering  = [s for s in raw_spans if s[0] <= seg_start and s[1] >= seg_end]

        if not covering:
            result.append(_html.escape(seg_text))
        elif len(covering) == 1:
            _, _, code, fg, bg = covering[0]
            result.append(
                f'<mark style="background:{bg};color:{fg};border-radius:2px;padding:1px 3px" title="{_html.escape(code)}">' +
                _html.escape(seg_text) + '</mark>'
            )
        else:
            colors = [s[4] for s in covering]
            fgs    = [s[3] for s in covering]
            titles = ", ".join(_html.escape(s[2]) for s in covering)
            step   = 6
            stops  = []
            for j, color in enumerate(colors):
                stops.append(f"{color} {j*step}px")
                stops.append(f"{color} {(j+1)*step}px")
            gradient = "repeating-linear-gradient(45deg, " + ", ".join(stops) + ")"
            result.append(
                f'<mark style="background:{gradient};color:{fgs[0]};border-radius:2px;padding:1px 3px" title="{titles}">' +
                _html.escape(seg_text) + '</mark>'
            )

    return "".join(result)


def bullets_to_html(text):
    """Convert bullet text (• ...) to HTML list, stripping markdown."""
    # Strip markdown bold/italic
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'\*([^*]+)\*', r'\1', text)
    text = re.sub(r'__([^_]+)__', r'\1', text)
    lines = [l.strip() for l in text.strip().splitlines() if l.strip()]
    items = []
    for line in lines:
        if line.startswith(("•", "-", "*")):
            items.append(f"<li>{line.lstrip('•-* ').strip()}</li>")
        elif items:
            items[-1] = items[-1][:-5] + " " + line + "</li>"
        else:
            items.append(f"<li>{line}</li>")
    return f"<ul>{''.join(items)}</ul>" if items else f"<p>{text}</p>"

# ── Build HTML ─────────────────────────────────────────────────────────────────
def build_html(report):
    branch_colors = report["branch_colors"]

    # Branch CSS
    branch_css = ""
    for branch, (fg, bg) in branch_colors.items():
        branch_css += f'.bc[data-b="{branch}"] {{ color: {fg}; background: {bg}; border-color: {fg}33; }}\n'
        branch_css += f'.bh[data-b="{branch}"] {{ color: {fg}; border-left-color: {fg}; }}\n'

    # Passages
    passages_html = ""
    for p in report["passages"]:
        groups_html = ""
        # Cap codes per passage — top 12
        display_codes = p["display_codes"][:12]
        groups = defaultdict(list)
        for c in display_codes:
            b = p["code_branches"].get(c, "")
            groups[b].append(c)

        for branch, codes in sorted(groups.items()):
            fg, bg = branch_colors.get(branch, ("#444", "#eee"))
            codes_html = "".join(f'<span class="bc" data-b="{branch}">{c}</span>' for c in codes)
            groups_html += f'<div class="bgroup"><div class="bh" data-b="{branch}">{branch}</div><div class="bcodes">{codes_html}</div></div>'

        highlighted = apply_highlights(p["text"], p.get("highlights", {}), branch_colors, p["code_branches"])
        bullets = bullets_to_html(p["interpretation"])
        anon_doc = re.sub(r'\d{4}-\d{2}-\d{2}-[A-Z][a-z]+', 'Participant', p["doc"])

        passages_html += f"""
<div class="passage">
  <div class="p-meta">{anon_doc} · line {p["line"]}</div>
  <div class="p-body">
    <div class="p-left">
      <blockquote class="p-text">{highlighted}</blockquote>
      <div class="p-interp">{bullets}</div>
    </div>
    <div class="p-right">{groups_html}</div>
  </div>
</div>"""

    # Intersections
    ix_html = ""
    for ix in report["intersections"]:
        ix_html += f"""
<div class="ix">
  <div class="ix-head">
    <span class="ix-b" style="color:{branch_colors.get(ix['b1'],('#444','#eee'))[0]}">{ix['b1']}</span>
    <span class="ix-x">×</span>
    <span class="ix-b" style="color:{branch_colors.get(ix['b2'],('#444','#eee'))[0]}">{ix['b2']}</span>
  </div>
  <div class="ix-body">{bullets_to_html(ix['commentary'])}</div>
</div>"""

    # Branches
    branches_html = ""
    for b in report["branches"]:
        fg, bg = branch_colors.get(b["name"], ("#444", "#eee"))
        # Filter named individuals from top codes display
        filtered_top = [(c, n) for c, n in b["top"] if not is_named_individual(c, report["parent_map"])]
        top_str = " · ".join(c for c,_ in filtered_top[:6])
        branches_html += f"""
<div class="branch">
  <div class="b-name" style="color:{fg}">{b["name"]}</div>
  <div class="b-body">
    <div class="b-summary">{bullets_to_html(b["summary"])}</div>
    <div class="b-codes">{top_str}</div>
  </div>
</div>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Code System Overview</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,300;0,400;0,500;1,300;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
:root {{
  --bg: #f5f3ee;
  --ink: #17150e;
  --mid: #6a6254;
  --rule: #ddd8ce;
  --mono: "IBM Plex Mono", monospace;
  --serif: "Spectral", Georgia, serif;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}}
body {{ font-family: var(--sans); background: var(--bg); color: var(--ink); line-height: 1.7; font-size: 17px; }}
.page {{ max-width: 1080px; margin: 0 auto; padding: 64px 48px; }}

header {{ padding-bottom: 40px; border-bottom: 1px solid var(--ink); margin-bottom: 56px; }}
header h1 {{ font-size: 1.6rem; font-weight: 300; letter-spacing: -0.01em; margin-bottom: 16px; }}
.intro {{ font-size: 0.9rem; line-height: 1.75; color: #2a2820; max-width: 640px; }}

.sec-title {{ font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--mid); margin-bottom: 6px; }}
.sec-note {{ font-size: 0.82rem; color: var(--mid); margin-bottom: 28px; font-style: italic; }}
section {{ margin-bottom: 64px; }}

/* Passages */
.passage {{ margin-bottom: 48px; padding-bottom: 48px; border-bottom: 1px solid var(--rule); }}
.passage:last-child {{ border-bottom: none; }}
.p-meta {{ font-family: var(--mono); font-size: 0.7rem; color: var(--mid); margin-bottom: 12px; }}
.p-body {{ display: grid; grid-template-columns: 1fr 200px; gap: 32px; }}
blockquote.p-text {{ font-family: var(--serif); font-size: 1rem; line-height: 1.85; font-style: italic; border-left: 2px solid var(--rule); padding-left: 16px; color: #2a2820; margin-bottom: 16px; }}
.p-interp ul {{ padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }}
.p-interp li {{ font-size: 0.88rem; line-height: 1.7; color: var(--mid); padding-left: 14px; position: relative; }}
.p-interp li::before {{ content: "—"; position: absolute; left: 0; color: var(--rule); }}
.p-right {{ padding-top: 4px; }}
.bgroup {{ margin-bottom: 14px; }}
.bh {{ font-family: var(--mono); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 0 4px 6px; border-left: 2px solid; margin-bottom: 5px; }}
.bcodes {{ display: flex; flex-direction: column; gap: 3px; padding-left: 8px; }}
.bc {{ font-family: var(--mono); font-size: 0.68rem; padding: 2px 6px; border-radius: 2px; border: 1px solid transparent; display: block; }}

/* Intersections */
.ix {{ display: grid; grid-template-columns: 200px 1fr; gap: 24px; padding: 18px 0; border-bottom: 1px solid var(--rule); align-items: start; }}
.ix:first-child {{ border-top: 1px solid var(--rule); }}
.ix-head {{ display: flex; flex-direction: column; gap: 4px; padding-top: 2px; }}
.ix-b {{ font-family: var(--mono); font-size: 0.78rem; font-weight: 500; }}
.ix-x {{ color: var(--rule); font-size: 0.8rem; }}
.ix-body ul {{ padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }}
.ix-body li {{ font-size: 0.88rem; line-height: 1.7; color: #2a2820; padding-left: 14px; position: relative; }}
.ix-body li::before {{ content: "—"; position: absolute; left: 0; color: var(--rule); }}

/* Branches */
.branch {{ display: grid; grid-template-columns: 180px 1fr; gap: 24px; padding: 16px 0; border-bottom: 1px solid var(--rule); }}
.branch:first-child {{ border-top: 1px solid var(--rule); }}
.b-name {{ font-family: var(--mono); font-size: 0.78rem; font-weight: 500; padding-top: 2px; }}
.b-summary ul {{ padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }}
.b-summary li {{ font-size: 0.88rem; line-height: 1.7; color: #2a2820; padding-left: 14px; position: relative; }}
.b-summary li::before {{ content: "—"; position: absolute; left: 0; color: var(--rule); }}
.b-codes {{ font-family: var(--mono); font-size: 0.68rem; color: var(--mid); }}

{branch_css}
@media print {{ body {{ background: white; }} .page {{ padding: 32px; }} }}
</style>
</head>
<body>
<div class="page">
<header>
  <h1>Data Sharing in Canadian COVID-19 Research Infrastructure — Code System Overview</h1>
  <p class="intro">{report["intro"]}</p>
</header>

<section>
  <div class="sec-title">Annotated passages</div>
  <p class="sec-note">A selection of interview segments coded across multiple analytical branches. Highlights indicate which spans each code applies to; colours correspond to branches shown in the right column. Illustrative sample only.</p>
  {passages_html}
</section>

<section>
  <div class="sec-title">Cross-branch intersections</div>
  <p class="sec-note">Branches that most frequently co-occur within the same coded segments, suggesting analytical entanglement. Top 5 pairs shown.</p>
  {ix_html}
</section>

<section>
  <div class="sec-title">Branch summaries</div>
  <p class="sec-note">All analytical branches with their most applied codes and a brief characterization of what each captures in the context of this research.</p>
  {branches_html}
</section>
</div>
</body>
</html>"""

# ── Checkpoint ────────────────────────────────────────────────────────────────
CKPT_FILE = Path("qc/overview-checkpoint.json")

def load_checkpoint():
    if CKPT_FILE.exists():
        try:
            return json.load(open(CKPT_FILE))
        except Exception:
            pass
    return {}

def save_checkpoint(ckpt):
    with open(CKPT_FILE, "w") as f:
        json.dump(ckpt, f, indent=2, ensure_ascii=False)

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    args    = sys.argv[1:]
    dry_run = "--dry-run" in args
    out     = Path("qc/overview.html")
    global MODEL
    for flag, target in [("--model", "MODEL"), ("--out", "out")]:
        if flag in args:
            i = args.index(flag)
            if i + 1 < len(args):
                if flag == "--model": MODEL = args[i+1]
                elif flag == "--out": out = Path(args[i+1])

    print("[overview] Loading...")
    codes_meta, tree = load_codebook()
    corpus = load_corpus()
    parent_map, children_map, top = build_tree(tree)
    top_set = set(top)
    counts, by_line, by_doc = corpus_stats(corpus)
    branch_colors = assign_branch_colors(top)
    print(f"  {len(tree)} codes · {len(corpus)} docs · {sum(counts.values())} applications")

    # Load checkpoint
    ckpt = load_checkpoint()
    if ckpt:
        print(f"[overview] Resuming from checkpoint ({len(ckpt)} cached items)")

    # Compute relevant codes for passages (branch exclusions + LLM relevance filter)
    all_branch_filtered = [
        c for c in counts.keys()
        if should_show_code(c, get_top_branch(c, parent_map, top_set) or "", codes_meta, parent_map)
    ]
    ck_rel = "relevant_codes"
    if ck_rel in ckpt:
        relevant_codes = set(ckpt[ck_rel])
        print(f"[overview] Relevant codes: {len(relevant_codes)} [cached]")
    else:
        print(f"[overview] Filtering {len(all_branch_filtered)} codes for relevance...", end=" ", flush=True)
        relevant_codes = filter_relevant_codes(all_branch_filtered, codes_meta, dry_run)
        print(f" done")
        if not dry_run:
            ckpt[ck_rel] = list(relevant_codes)
            save_checkpoint(ckpt)

    def write_html(branch_data, intersections, passages, intro):
        report = {
            "intro": intro or "[generating…]",
            "branches": branch_data,
            "intersections": intersections,
            "passages": passages,
            "branch_colors": branch_colors,
            "parent_map": parent_map,
        }
        html = build_html(report)
        out.write_text(html, encoding="utf-8")

    branch_data, branch_summaries = [], {}
    intersections, passages, intro = [], [], ""

    try:
        # Passages first — fastest feedback loop
        print("[overview] Passages...")
        passages_raw = select_passages(corpus, by_line, parent_map, top_set, codes_meta, relevant_codes, n=4)
        for p in passages_raw:
            ck_h = f"highlights:{p['doc']}:{p['line']}"
            ck_i = f"interp:{p['doc']}:{p['line']}"
            anon_text     = anonymize(p["text"])
            code_branches = {c: (get_top_branch(c, parent_map, top_set) or "") for c in p["display_codes"]}
            if ck_h in ckpt:
                highlights = ckpt[ck_h]; print(f"  {p['doc']}:{p['line']} highlights [cached]")
            else:
                print(f"  {p['doc']}:{p['line']} highlights...", end=" ", flush=True)
                highlights = gen_highlights(anon_text, p["display_codes"], codes_meta, dry_run)
                print("ok")
                if not dry_run:
                    ckpt[ck_h] = highlights; save_checkpoint(ckpt)
            if ck_i in ckpt:
                interp = ckpt[ck_i]; print(f"  {p['doc']}:{p['line']} interp [cached]")
            else:
                print(f"  {p['doc']}:{p['line']} interp...", end=" ", flush=True)
                interp = gen_passage_bullets(anon_text, p["display_codes"], codes_meta, dry_run)
                print("ok")
                if not dry_run:
                    ckpt[ck_i] = interp; save_checkpoint(ckpt)
            passages.append({
                "doc": p["doc"], "line": p["line"], "text": anon_text,
                "display_codes": p["display_codes"], "branches": p["branches"],
                "code_branches": code_branches, "highlights": highlights,
                "interpretation": interp,
            })
            write_html([], [], passages, "")

        # Branch summaries
        print("[overview] Branch summaries...")
        for b in top:
            descs = get_desc(b, children_map)
            apps  = sum(counts.get(d,0) for d in descs) + counts.get(b,0)
            top_c = sorted([(c, counts.get(c,0)) for c in descs if counts.get(c,0)>0 and not is_named_individual(c, parent_map)], key=lambda x:-x[1])
            entry = codes_meta.get(b, {})
            doc   = " ".join(filter(None,[entry.get("scope",""),entry.get("rationale","")]))[:200]
            ck = f"branch:{b}"
            if ck in ckpt:
                summ = ckpt[ck]
                print(f"  {b} [cached]")
            else:
                print(f"  {b}...", end=" ", flush=True)
                summ = gen_branch_bullets(b, [c for c,_ in top_c[:6]], doc, dry_run)
                print("ok")
                if not dry_run:
                    ckpt[ck] = summ; save_checkpoint(ckpt)
            branch_summaries[b] = summ
            branch_data.append({"name":b,"apps":apps,"top":top_c[:6],"summary":summ})
        branch_data.sort(key=lambda x: -x["apps"])
        write_html(branch_data, [], passages, "")

        # Intersections
        print("[overview] Intersections...")
        pairs = cross_branch_pairs(by_line, parent_map, top_set, codes_meta, n=5)
        for (b1,b2),n in pairs:
            ck = f"ix:{b1}:{b2}"
            if ck in ckpt:
                comm = ckpt[ck]; print(f"  {b1}×{b2} [cached]")
            else:
                print(f"  {b1}×{b2}...", end=" ", flush=True)
                comm = gen_intersection_bullets(b1, b2, n, branch_summaries.get(b1,""), branch_summaries.get(b2,""), dry_run)
                print("ok")
                if not dry_run:
                    ckpt[ck] = comm; save_checkpoint(ckpt)
            intersections.append({"b1":b1,"b2":b2,"n":n,"commentary":comm})
        write_html(branch_data, intersections, passages, "")

        # Intro
        print("[overview] Intro...")
        ck = "intro"
        if ck in ckpt:
            intro = ckpt[ck]; print("  [cached]")
        else:
            intro = gen_intro([b["name"] for b in branch_data], pairs, dry_run)
            if not dry_run:
                ckpt[ck] = intro; save_checkpoint(ckpt)

    except KeyboardInterrupt:
        print(f"\n[interrupted] Saving progress to {out}...")

    write_html(branch_data, intersections, passages, intro)
    print(f"[overview] Written to {out}")

if __name__ == "__main__":
    main()