#!/usr/bin/env python3
"""qc-analyze.py — Analyze codebook for merge candidates and restructuring proposals.

Sends documented codes to a local LLM (Ollama or LM Studio) and collects
structured proposals for merging, splitting, or restructuring codes.

Usage (from project root):
    python3 qc-atelier/qc-analyze.py [--mode within|across|all] [--branch BRANCH]

Options:
    --mode within      Analyze within each branch for redundancy (default)
    --mode across      Analyze across branches for overlap
    --mode all         Run both analyses
    --mode structure   Suggest how to complete and extend the branching structure
    --mode cluster     Cluster codes semantically and propose a branch structure
    --branch NAME      Analyze only the named top-level branch
    --model NAME       Override model (e.g. qwen3:32b)
    --thinking         Enable thinking mode (Qwen3)
    --no-thinking      Disable thinking mode

Output:
    qc/analysis-report.md — Markdown report of proposals
"""

import json
import math
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from collections import defaultdict

# ── Config ────────────────────────────────────────────────────────────────────

CODEBOOK_JSON = Path("qc/codebook.json")
OUTPUT_PATH_WITHIN    = Path("qc/analysis-report-within.md")
OUTPUT_PATH_ACROSS    = Path("qc/analysis-report-across.md")
OUTPUT_PATH_STRUCTURE = Path("qc/analysis-report-structure.md")
OUTPUT_PATH_CLUSTER   = Path("qc/analysis-report-cluster.md")
LLM_URL       = "http://localhost:11434/v1/chat/completions"  # cluster tunnel
# LLM_URL     = "http://localhost:1234/v1/chat/completions"   # LM Studio local
MODEL         = "qwen3:32b"          # cluster
# MODEL       = "qwen/qwen3.6-35b-a3b"  # LM Studio local
TEMPERATURE   = 0.15
TIMEOUT       = 900
ENABLE_THINKING  = True  # set True for Qwen3 models
EMBED_MODEL      = "nomic-embed-text"
EMBED_URL        = "http://localhost:11434/v1/embeddings"  # same tunnel

SYSTEM_PROMPT = """You are a qualitative research methodologist reviewing a codebook used in interview-based research about data sharing practices in Canadian COVID-19 research infrastructure.

Your task is to identify genuine redundancy — codes that capture the same phenomenon and where one could be deleted without losing any analytical information.

STRICT RULES:
- Only flag codes as merge candidates if they are truly redundant: one is a subset of or identical to the other
- Do NOT suggest merging codes that are merely related, adjacent, or thematically connected
- Do NOT suggest a new code that combines two distinct phenomena ("X_and_Y" is always wrong)
- suggested_name must be one of the existing code names, not a new compound name
- If codes are distinct but related, leave them alone
- When in doubt, do not merge

Respond with JSON only — no preamble, no markdown fences. Format:
{
  "merge_candidates": [
    {
      "codes": ["code_a", "code_b"],
      "reason": "brief explanation of overlap",
      "suggested_name": "the name of the existing code to keep (must be one of the codes listed above, not a new name)"
    }
  ],
  "split_candidates": [
    {
      "code": "code_name",
      "reason": "why it should be split",
      "suggested_parts": ["part_a", "part_b"]
    }
  ],
  "structural_notes": "brief prose observations about the branch structure"
}"""

WITHIN_BRANCH_PROMPT = """Here are codes from the branch "{branch}" with their scope definitions.
Review for redundancy, overlap, or near-duplicate codes within this branch.

Codes:
{codes}"""

STRUCTURE_SYSTEM_PROMPT = """You are a qualitative research methodologist helping a researcher complete the branching structure of a codebook used in interview-based research about data sharing practices in Canadian COVID-19 research infrastructure.

The researcher has an existing set of top-level branches and wants suggestions on how to extend, refine, or complete the structure. Your job is to propose how to organize codes that are currently loosely placed, suggest missing branches that would improve coverage, and identify branches that could be subdivided.

Respond with JSON only — no preamble, no markdown fences. Format:
{
  "new_branches": [
    {
      "name": "proposed branch name",
      "rationale": "why this branch is needed",
      "codes_to_move": ["code_a", "code_b"]
    }
  ],
  "subdivide": [
    {
      "branch": "existing branch name",
      "rationale": "why it should be subdivided",
      "proposed_subbranches": ["subbranch_a", "subbranch_b"]
    }
  ],
  "observations": "brief prose assessment of the current structure and what is missing"
}"""

STRUCTURE_PROMPT = """Here is the current top-level structure of a qualitative codebook about data sharing practices in Canadian COVID-19 research. Each branch is followed by its codes and their scope definitions.

Research context: interviews with researchers, data managers, and administrators involved in COVID-19 data sharing infrastructure in Canada.

Current branches and codes:
{structure}

Based on this structure:
1. Suggest any new top-level branches that would better organize codes that seem out of place or that represent underserved analytical territory
2. Identify any existing branches that are large or heterogeneous enough to warrant subdivision
3. Note any gaps in coverage given the research topic

Focus on the overall architecture, not individual codes."""

ACROSS_BRANCH_PROMPT = """Here are codes from two branches that may overlap conceptually.
Branch A: {branch_a}
Branch B: {branch_b}

Identify any codes that capture the same or highly similar phenomena across these two branches.

Codes from {branch_a}:
{codes_a}

Codes from {branch_b}:
{codes_b}"""

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_codebook():
    d = json.load(open(CODEBOOK_JSON))
    codes = d.get('codes', {})
    tree  = d.get('tree', [])
    return codes, tree

def build_branch_map(codes, tree):
    """Map top-level branch name -> list of (code_name, scope) for documented codes."""
    # Build parent chain
    parent_map = {n['name']: n.get('parent', '') for n in tree}

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
        code_name = n['name']
        doc = codes.get(code_name, {})
        scope = (doc.get('scope') or '').strip()
        if not scope:
            continue
        if n.get('parent'):  # skip top-level branch headers
            branch = top_parent(code_name)
            branches[branch].append((code_name, scope))

    return branches

def format_codes(code_list):
    lines = []
    for name, scope in code_list:
        lines.append(f"- {name}: {scope[:200]}")
    return "\n".join(lines)

def chunk_codes(code_list, max_chars=6000):
    chunks = []
    current = []
    current_len = 0
    for item in code_list:
        entry = f"- {item[0]}: {item[1][:200]}"
        if current_len + len(entry) > max_chars and current:
            chunks.append(current)
            current = [item]
            current_len = len(entry)
        else:
            current.append(item)
            current_len += len(entry)
    if current:
        chunks.append(current)
    return chunks

def call_llm_with_system(system, prompt):
    payload = {
        "model": MODEL,
        "temperature": TEMPERATURE,
        "max_tokens": 2048,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": prompt},
        ],
    }
    data = json.dumps(payload).encode("utf-8")
    req  = urllib.request.Request(
        LLM_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
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
        print(f"  [error] {e}")
        return None

def call_llm(prompt):
    payload = {
        "model": MODEL,
        "temperature": TEMPERATURE,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
        "chat_template_kwargs": {"enable_thinking": ENABLE_THINKING},
    }
    data = json.dumps(payload).encode("utf-8")
    req  = urllib.request.Request(
        LLM_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            result = json.loads(resp.read())
        content = result["choices"][0]["message"]["content"].strip()
        # Strip markdown fences
        if content.startswith("```"):
            content = "\n".join(content.split("\n")[1:])
        if content.endswith("```"):
            content = "\n".join(content.split("\n")[:-1])
        content = content.strip()
        # Find JSON object boundaries
        start = content.find("{")
        end   = content.rfind("}") + 1
        if start >= 0 and end > start:
            content = content[start:end]
        return json.loads(content)
    except Exception as e:
        print(f"  [error] {e}")
        return None

def render_result(result, context):
    lines = [f"\n### {context}\n"]
    if not result:
        lines.append("*No response from LLM.*\n")
        return "\n".join(lines)

    merges = result.get('merge_candidates', [])
    splits = result.get('split_candidates', [])
    notes  = result.get('structural_notes', '')

    if merges:
        lines.append("**Merge candidates:**\n")
        for m in merges:
            codes = ", ".join([c for c in m.get('codes', []) if c])
            reason = m.get('reason', '')
            suggested = m.get('suggested_name', '')
            lines.append(f"- {codes}")
            lines.append(f"  - Reason: {reason}")
            if suggested:
                lines.append(f"  - Suggested name: {suggested}")
    else:
        lines.append("*No merge candidates identified.*\n")

    if splits:
        lines.append("\n**Split candidates:**\n")
        for s in splits:
            code = s.get('code', '')
            reason = s.get('reason', '')
            parts = ", ".join([p for p in (s.get('suggested_parts') or []) if p])
            lines.append(f"- {code}")
            lines.append(f"  - Reason: {reason}")
            lines.append(f"  - Suggested parts: {parts}")

    if notes:
        lines.append(f"\n**Notes:** {notes}\n")

    return "\n".join(lines)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    mode        = "within"
    only_branch = None
    model       = None
    thinking    = None

    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--mode" and i < len(sys.argv) - 1:
            mode = sys.argv[i + 1]
        if arg == "--branch" and i < len(sys.argv) - 1:
            only_branch = sys.argv[i + 1]
        if arg == "--model" and i < len(sys.argv) - 1:
            model = sys.argv[i + 1]
        if arg == "--thinking":
            thinking = True
        if arg == "--no-thinking":
            thinking = False

    global MODEL, ENABLE_THINKING
    if model:
        MODEL = model
    if thinking is not None:
        ENABLE_THINKING = thinking

    codes, tree = load_codebook()
    branches    = build_branch_map(codes, tree)

    branch_names = sorted(branches.keys())
    if only_branch:
        branch_names = [b for b in branch_names if b == only_branch]
        if not branch_names:
            print(f"[error] Branch '{only_branch}' not found.")
            sys.exit(1)

    # Skip legacy branch
    branch_names = [b for b in branch_names if 'OLDER' not in b]

    report_lines = [
        "# Codebook Analysis Report\n",
        f"Generated by qc-analyze.py\n",
        f"Branches analyzed: {len(branch_names)}\n",
        f"Mode: {mode}\n",
        "---\n",
    ]

    print(f"[analyze] Mode: {mode}, {len(branch_names)} branches")

    try:
        if mode in ("within", "all"):
            report_lines.append("\n## Within-Branch Analysis\n")
            for branch in branch_names:
                code_list = branches[branch]
                if len(code_list) < 2:
                    continue
                chunks = chunk_codes(code_list)
                print(f"  [{branch}] {len(code_list)} codes, {len(chunks)} chunk(s)...")
                for ci, chunk in enumerate(chunks):
                    label = branch if len(chunks) == 1 else f"{branch} (part {ci+1}/{len(chunks)})"
                    prompt = WITHIN_BRANCH_PROMPT.format(
                        branch=branch,
                        codes=format_codes(chunk)
                    )
                    result = call_llm(prompt)
                    report_lines.append(render_result(result, label))
                    OUTPUT_PATH_WITHIN.write_text("\n".join(report_lines), encoding="utf-8")
                    time.sleep(0.5)

        if mode in ("across", "all"):
            report_lines = [
                "# Codebook Analysis Report — Across-Branch\n",
                f"Mode: across\n",
                "---\n",
            ]
            report_lines.append("\n## Across-Branch Analysis\n")
            from itertools import combinations
            all_pairs = list(combinations(branch_names, 2))
            for branch_a, branch_b in all_pairs:
                if branch_a not in branches or branch_b not in branches:
                    continue
                chunks_a = chunk_codes(branches[branch_a], max_chars=3000)
                chunks_b = chunk_codes(branches[branch_b], max_chars=3000)
                print(f"  [{branch_a}] vs [{branch_b}] ({len(chunks_a)}x{len(chunks_b)} chunks)...")
                for ca_i, chunk_a in enumerate(chunks_a):
                    for cb_i, chunk_b in enumerate(chunks_b):
                        label = f"{branch_a} vs {branch_b}"
                        if len(chunks_a) > 1 or len(chunks_b) > 1:
                            label += f" ({ca_i+1}/{len(chunks_a)} x {cb_i+1}/{len(chunks_b)})"
                        prompt = ACROSS_BRANCH_PROMPT.format(
                            branch_a=branch_a,
                            branch_b=branch_b,
                            codes_a=format_codes(chunk_a),
                            codes_b=format_codes(chunk_b)
                        )
                        result = call_llm(prompt)
                        report_lines.append(render_result(result, label))
                        OUTPUT_PATH_ACROSS.write_text("\n".join(report_lines), encoding="utf-8")
                        time.sleep(0.5)

        if mode == "structure":
            # Build a summary of current structure: branch -> sample of codes
            struct_lines = []
            for branch in branch_names:
                code_list = branches[branch]
                struct_lines.append(f"\n## {branch} ({len(code_list)} codes)")
                for name, scope in code_list[:30]:  # cap per branch for context
                    struct_lines.append(f"- {name}: {scope[:150]}")
                if len(code_list) > 30:
                    struct_lines.append(f"  ... and {len(code_list)-30} more")
            structure_text = "\n".join(struct_lines)

            # Chunk if needed
            chunks = chunk_codes([(b, " ".join(s for _,s in branches[b])) for b in branch_names], max_chars=8000)
            report_lines = [
                "# Codebook Structure Report\n",
                "Generated by qc-analyze.py --mode structure\n",
                "---\n",
            ]
            print(f"  Sending structure summary to LLM...")
            payload_prompt = f"Here is my codebook structure:\n{structure_text}\n\nSuggest new branches, subdivisions, and observations as JSON: {{\"new_branches\": [], \"subdivide\": [], \"observations\": \"\"}}"
            result = call_llm_with_system(STRUCTURE_SYSTEM_PROMPT, payload_prompt)
            if result:
                report_lines.append("\n## Structural Proposals\n")
                new_branches = result.get('new_branches', [])
                subdivide = result.get('subdivide', [])
                observations = result.get('observations', '')
                if observations:
                    report_lines.append(f"**Overview:** {observations}\n")
                if new_branches:
                    report_lines.append("\n### New branches\n")
                    for b in new_branches:
                        report_lines.append(f"- **{b.get('name','')}**: {b.get('rationale','')}")
                        if b.get('codes_to_move'):
                            report_lines.append(f"  - Codes to move: {', '.join(b['codes_to_move'])}")
                if subdivide:
                    report_lines.append("\n### Branches to subdivide\n")
                    for s in subdivide:
                        report_lines.append(f"- **{s.get('branch','')}**: {s.get('rationale','')}")
                        if s.get('proposed_subbranches'):
                            report_lines.append(f"  - Proposed subbranches: {', '.join(s['proposed_subbranches'])}")
            else:
                report_lines.append("\n*No response from LLM.*\n")
            OUTPUT_PATH_STRUCTURE.write_text("\n".join(report_lines), encoding="utf-8")


        if mode == "cluster":
            print(f"  Embedding {sum(len(v) for v in branches.values())} codes...")
            all_codes_list = []
            for branch in branch_names:
                for name, scope in branches[branch]:
                    all_codes_list.append((name, scope, branch))

            embeddings = []
            batch_size = 32
            for i in range(0, len(all_codes_list), batch_size):
                batch = all_codes_list[i:i+batch_size]
                texts = [n + ": " + s for n, s, _ in batch]
                payload = {"model": EMBED_MODEL, "input": texts}
                data = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(
                    EMBED_URL, data=data,
                    headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=120) as resp:
                    result = json.loads(resp.read())
                for item in result["data"]:
                    embeddings.append(item["embedding"])
                print(f"  Embedded {min(i+batch_size, len(all_codes_list))}/{len(all_codes_list)}")

            def dot(a, b): return sum(x*y for x,y in zip(a,b))
            def vnorm(a): return math.sqrt(dot(a,a))
            def cosine_sim(a, b): return dot(a,b) / (vnorm(a)*vnorm(b)+1e-9)
            def vec_mean(vecs):
                n = len(vecs[0])
                return [sum(v[i] for v in vecs)/len(vecs) for i in range(n)]

            def kmeans(vecs, k, iters=20):
                import random
                centroids = random.sample(vecs, k)
                for _ in range(iters):
                    clusters = [[] for _ in range(k)]
                    labels = []
                    for v in vecs:
                        sims = [cosine_sim(v, c) for c in centroids]
                        best = sims.index(max(sims))
                        clusters[best].append(v)
                        labels.append(best)
                    centroids = [vec_mean(c) if c else centroids[i] for i, c in enumerate(clusters)]
                return labels, centroids

            def silhouette(vecs, labels, k):
                scores = []
                for i, v in enumerate(vecs):
                    same = [vecs[j] for j in range(len(vecs)) if labels[j]==labels[i] and j!=i]
                    if not same: continue
                    a = sum(1-cosine_sim(v,u) for u in same) / len(same)
                    other_dists = []
                    for c in range(k):
                        if c == labels[i]: continue
                        others = [vecs[j] for j in range(len(vecs)) if labels[j]==c]
                        if others:
                            other_dists.append(sum(1-cosine_sim(v,u) for u in others)/len(others))
                    if not other_dists: continue
                    b = min(other_dists)
                    scores.append((b-a)/max(a,b))
                return sum(scores)/len(scores) if scores else 0

            print("  Finding optimal k (5-20)...")
            best_k, best_score, best_labels = 5, -1, None
            for k in range(5, min(21, len(all_codes_list)//10 + 1)):
                labels, _ = kmeans(embeddings, k)
                score = silhouette(embeddings, labels, k)
                print(f"  k={k} silhouette={score:.3f}")
                if score > best_score:
                    best_score, best_k, best_labels = score, k, labels

            clusters_map = defaultdict(list)
            for i, (name, scope, branch) in enumerate(all_codes_list):
                clusters_map[best_labels[i]].append((name, scope, branch))

            print(f"  Naming {best_k} clusters via LLM...")
            report_lines = [
                "# Codebook Cluster Report\n",
                f"Codes: {len(all_codes_list)}, Clusters: {best_k}, Silhouette: {best_score:.3f}\n",
                "---\n",
                "\n## Proposed Branch Structure\n",
            ]

            for ci in sorted(clusters_map.keys()):
                cluster_codes = clusters_map[ci]
                existing_branches = list(set(b for _,_,b in cluster_codes))
                sample = cluster_codes[:15]
                sample_text = "\n".join("- " + n + ": " + s[:100] for n,s,_ in sample)
                if len(cluster_codes) > 15:
                    sample_text += "\n  ... and " + str(len(cluster_codes)-15) + " more"

                naming_sys = "You are a qualitative research methodologist. Respond with JSON only, no markdown fences."
                naming_user = (
                    "Here are " + str(len(cluster_codes)) + " codes that cluster together semantically.\n"
                    "These codes currently live in branches: " + ", ".join(existing_branches) + ".\n\n"
                    "Sample codes:\n" + sample_text + "\n\n"
                    "Suggest a concise branch name (2-5 words), a one-sentence rationale, "
                    "and whether this maps to an existing branch or is new.\n"
                    'Respond with JSON: {"name": "", "rationale": "", "maps_to": "existing branch name or null"}'
                )
                result = call_llm_with_system(naming_sys, naming_user)
                if result:
                    cname = result.get("name", "Cluster " + str(ci+1))
                    rationale = result.get("rationale", "")
                    maps_to = result.get("maps_to") or "New branch"
                    report_lines.append("\n### " + cname + "\n")
                    report_lines.append("**Rationale:** " + rationale + "\n")
                    report_lines.append("**Maps to:** " + str(maps_to) + "\n")
                    report_lines.append("**Codes (" + str(len(cluster_codes)) + "):**\n")
                    for n, s, b in cluster_codes:
                        report_lines.append("- `" + n + "` *(currently in " + b + ")*")
                else:
                    report_lines.append("\n### Cluster " + str(ci+1) + " (" + str(len(cluster_codes)) + " codes)\n")
                    for n, s, b in cluster_codes:
                        report_lines.append("- `" + n + "` *(currently in " + b + ")*")
                OUTPUT_PATH_CLUSTER.write_text("\n".join(report_lines), encoding="utf-8")

    except KeyboardInterrupt:
        print("\n[interrupted] Saving partial report...")

    if mode in ("within", "all"):
        OUTPUT_PATH_WITHIN.write_text("\n".join(report_lines), encoding="utf-8")
        print(f"\n[done] Within report written to {OUTPUT_PATH_WITHIN}")
    elif mode == "across":
        OUTPUT_PATH_ACROSS.write_text("\n".join(report_lines), encoding="utf-8")
        print(f"\n[done] Across report written to {OUTPUT_PATH_ACROSS}")
    elif mode == "structure":
        OUTPUT_PATH_STRUCTURE.write_text("\n".join(report_lines), encoding="utf-8")
        print(f"\n[done] Structure report written to {OUTPUT_PATH_STRUCTURE}")
    elif mode == "cluster":
        OUTPUT_PATH_CLUSTER.write_text("\n".join(report_lines), encoding="utf-8")
        print(f"\n[done] Cluster report written to {OUTPUT_PATH_CLUSTER}")

if __name__ == "__main__":
    main()