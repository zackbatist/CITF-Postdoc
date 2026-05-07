#!/usr/bin/env python3
"""
qc-reflect-server.py
Companion server for qc-reflect.html and qc-scheme.html.

Routes:
  Static files        GET  /*              → serves qc/ directory
  Ollama proxy        ANY  /api/*          → http://localhost:11434
  Reflect logs        POST /logs/save      → save report log to disk
                      GET  /logs/list      → list all saved logs
  Docs persistence    POST /docs/save      → write codebook.json
                      GET  /docs/load      → read codebook.json

Usage (from project root):
    python3 qc-reflect-server.py [port]

Opens:
    http://localhost:8080/qc-reflect.html
    http://localhost:8080/qc-scheme.html
"""

import http.server
import json
import os
import re
import shutil
import sys
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path


# ── Config ─────────────────────────────────────────────────────────────────────

def load_config():
    config_path = os.environ.get("QC_ATELIER_CONFIG", "qc-atelier/qc-atelier-config.yaml")
    defaults = {
        "port":       8080,
        "serve_dir":  "qc-atelier",
            "data_dir":   "qc",
        "logs_dir":   "qc/reflect-logs",
        "ollama_url": "http://localhost:11434",
        "qc_bin":     "",
    }
    try:
        with open(config_path) as f:
            raw = f.read()

        def get(key, default):
            pat = r"^\s*" + re.escape(key) + r"\s*:\s*\"?([^\"#\n]+?)\"?\s*(?:#.*)?$"
            m = re.search(pat, raw, re.MULTILINE)
            return m.group(1).strip() if m else default

        output_dir = get("output_dir", "qc")
        logs_dir_r = get("logs_dir",   "reflect-logs")
        port_str   = get("port",       str(defaults["port"]))
        ollama_url = get("url",        defaults["ollama_url"])
        qc_bin     = get("qc_bin",     "")
        logs_dir   = logs_dir_r if os.path.isabs(logs_dir_r) \
                     else os.path.join(output_dir, logs_dir_r)

        return {
            "port":       int(port_str),
            "serve_dir":  "qc-atelier",
            "data_dir":   "qc",  # filters write HTML here; serve from same dir
            "logs_dir":   logs_dir,
            "ollama_url": ollama_url.rstrip("/"),
            "qc_bin":     qc_bin,
        }
    except Exception as e:
        print(f"[config] Could not parse {config_path}: {e}  — using defaults")
        return defaults


CONFIG       = load_config()
PROJECT_ROOT = Path.cwd()
SERVE_DIR    = Path(CONFIG["serve_dir"]).resolve()
DATA_DIR     = Path(CONFIG.get("data_dir", "qc")).resolve()
LOGS_DIR     = Path(CONFIG["logs_dir"]).resolve()
SNAPSHOTS_DIR = (DATA_DIR / "snapshots").resolve()
PORT         = CONFIG["port"]
OLLAMA       = CONFIG["ollama_url"]

LOGS_DIR.mkdir(parents=True, exist_ok=True)
SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)

print(f"[qc-server] Serving   http://localhost:{PORT}/qc-reflect.html")
print(f"[qc-server]           http://localhost:{PORT}/qc-scheme.html")
print(f"[qc-server] Files     {SERVE_DIR}")
print(f"[qc-server] Logs      {LOGS_DIR}")
print(f"[qc-server] Ollama    {OLLAMA}  (proxied at /api/*)")

# Diagnostic: show what HTML files are visible at startup
_html = sorted(SERVE_DIR.glob("*.html"))
if _html:
    print(f"[qc-server] HTML files found:")
    for _f in _html:
        print(f"[qc-server]   {_f.name}")
else:
    print(f"[qc-server] WARNING: no .html files found in {SERVE_DIR}")
    print(f"[qc-server] Run: quarto render qc-reflect.qmd && quarto render qc-scheme.qmd")


# ── YAML serialiser ────────────────────────────────────────────────────────────
# Minimal pretty-printer: produces human-readable YAML from a Python dict/list.
# No external dependencies.

def to_yaml(obj, indent=0):
    pad  = "  " * indent
    pad1 = "  " * (indent + 1)
    if obj is None:
        return "null"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, (int, float)):
        return str(obj)
    if isinstance(obj, str):
        # Quote strings that need it
        needs_quote = any(c in obj for c in ':#{}[]|>&*!,?"\'\n\r\t') or \
                      obj.startswith(' ') or obj.endswith(' ') or \
                      obj in ('true','false','null','~','yes','no') or \
                      re.match(r'^[\d.]+$', obj)
        if '\n' in obj:
            # Block scalar
            lines = obj.split('\n')
            block = '|\n' + '\n'.join(pad1 + l for l in lines)
            return block
        if needs_quote:
            escaped = obj.replace('\\', '\\\\').replace('"', '\\"')
            return f'"{escaped}"'
        return obj
    if isinstance(obj, list):
        if len(obj) == 0:
            return "[]"
        lines = []
        for item in obj:
            rendered = to_yaml(item, indent + 1)
            if isinstance(item, dict):
                # Dict in list: first key on same line as dash
                lines.append(f"{pad}- {rendered.lstrip()}")
            else:
                lines.append(f"{pad}- {rendered}")
        return "\n" + "\n".join(lines)
    if isinstance(obj, dict):
        if len(obj) == 0:
            return "{}"
        lines = []
        for k, v in obj.items():
            rendered = to_yaml(v, indent + 1)
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}{k}:{rendered if isinstance(v, list) else ''}")
                if isinstance(v, dict):
                    lines.append(rendered)
            else:
                lines.append(f"{pad}{k}: {rendered}")
        return "\n".join(lines)
    return str(obj)


def to_qc_yaml(tree, overrides=None):
    """Produce a qc-compatible bare-list codebook YAML from the tree.

    Format matches what qc's parse_codebook_yaml expects:
        - RootCode:
          - ChildCode
          - ParentWithKids:
            - Grandchild
        - AnotherRoot

    This is the only YAML written — it is purely for qc consumption.
    All documentation lives in the JSON sidecar.
    """
    overrides = overrides or {}
    lines = [
        "# codebook.yaml — generated by qc-scheme",
        "# qc-compatible format: bare list, no documentation fields.",
        "# Edit documentation in qc-scheme; do not hand-edit structure here.",
        "",
    ]

    # Build effective parent/children from tree + overrides
    children = {}   # parent -> [child, ...]
    roots    = []
    for node in tree:
        name   = node.get("name", "")
        parent = overrides.get(name, node.get("parent", "")) or ""
        if not parent:
            roots.append(name)
        else:
            children.setdefault(parent, []).append(name)

    def write_node(name, depth):
        pad = "  " * depth
        kids = children.get(name, [])
        if kids:
            lines.append(f"{pad}- {name}:")
            for kid in kids:
                write_node(kid, depth + 1)
        else:
            lines.append(f"{pad}- {name}")

    for root in roots:
        write_node(root, 0)

    lines.append("")
    return "\n".join(lines)



# ── Request handler ────────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_DIR), **kwargs)

    def log_message(self, fmt, *args):
        # Only print our API routes; suppress 404s and other noise.
        # When called from log_request, args[0] is the request line string.
        # When called from log_error, args[0] is an HTTPStatus enum — skip it.
        if not args or not isinstance(args[0], str):
            return
        req = args[0]  # e.g. "GET /api/generate HTTP/1.1"
        parts = req.split()
        path = parts[1] if len(parts) >= 2 else ""
        if any(path.startswith(p) for p in ("/logs/", "/docs/", "/api/", "/excerpts/", "/refactor/", "/snapshots/")):
            ts = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts}] {fmt % args}")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            index_path = PROJECT_ROOT / 'qc-atelier' / 'index.html'
            if index_path.exists():
                content = index_path.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            else:
                self.send_error(404, 'index.html not found')
        elif self.path == "/logs/list":
            self._logs_list()
        elif self.path == "/snapshots/list":
            self._snapshots_list()
        elif self.path == "/snapshots/lineage":
            self._snapshots_lineage()
        elif self.path.startswith("/snapshots/read"):
            self._snapshots_read()
        elif self.path.startswith("/snapshots/tree"):
            self._snapshots_tree()
        elif self.path.startswith("/docs/list-json"):
            self._docs_list_json()
        elif self.path.startswith("/docs/load-json"):
            self._docs_load_json()
        elif self.path.startswith("/docs/load"):
            self._docs_load()
        elif self.path.startswith("/excerpts/fetch"):
            self._excerpts_fetch()
        elif self.path.startswith("/refactor/history"):
            self._refactor_history()
        elif self.path.startswith("/refactor/tree"):
            self._refactor_tree()
        elif self.path == "/align/log":
            self._align_log_get()
        elif self.path.startswith("/align/responses"):
            self._align_responses_list()
        elif self.path.startswith("/api/"):
            self._proxy("GET", b"")
        else:
            super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length) if length else b""
        if self.path == "/logs/save":
            self._logs_save(body)
        elif self.path == "/docs/save":
            self._docs_save(body)
        elif self.path == "/snapshots/create":
            self._snapshots_create(body)
        elif self.path == "/snapshots/load":
            self._snapshots_load(body)
        elif self.path == "/refactor/execute":
            self._refactor_execute(body)
        elif self.path == "/refactor/move":
            self._refactor_move(body)
        elif self.path == "/refactor/queue":
            self._refactor_queue(body)
        elif self.path == "/align/log":
            self._align_log_post(body)
        elif self.path == "/align/responses/save":
            self._align_responses_save(body)
        elif self.path.startswith("/api/"):
            self._proxy("POST", body)
        else:
            self.send_error(404)

    # ── GET /logs/list ─────────────────────────────────────────────────────────

    def _logs_list(self):
        logs = []
        for path in sorted(LOGS_DIR.glob("*.json")):
            try:
                with open(path) as f:
                    logs.append(json.load(f))
            except Exception:
                pass
        self._json(200, logs)

    # ── POST /logs/save ────────────────────────────────────────────────────────

    def _logs_save(self, body):
        try:
            data      = json.loads(body)
            report_id = data.get("id", "unknown")
            safe      = re.sub(r'[^\w\-.]', '_', report_id)[:120]
            path      = LOGS_DIR / f"{safe}.json"
            with open(path, "w") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            self._json(200, {"ok": True})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── GET /excerpts/fetch?code=X&json_dir=Y ─────────────────────────────────
    # Returns up to 30 excerpts for a single code, read from qc/json/ on demand.

    def _excerpts_fetch(self):
        qs     = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        code   = params.get("code", "").replace("%20", " ").replace("+", " ")
        # Decode common URL encoding
        import urllib.parse
        code     = urllib.parse.unquote(code)
        json_dir = urllib.parse.unquote(params.get("json_dir", "qc/json"))

        if not code:
            self._json(400, {"error": "code param required"})
            return

        excerpts = []
        try:
            json_path = Path(json_dir)
            for jf in sorted(json_path.glob("*.json")):
                try:
                    with open(jf) as f:
                        data = json.load(f)
                    for entry in data:
                        if entry.get("code") == code:
                            doc = entry.get("document", jf.stem)
                            doc = Path(doc).stem  # strip path and extension
                            text = entry.get("text") or " ".join(entry.get("text_lines", []))
                            excerpts.append({
                                "doc":  doc,
                                "line": entry.get("line", 0),
                                "text": text[:500],
                            })
                            if len(excerpts) >= 30:
                                break
                except Exception:
                    pass
                if len(excerpts) >= 30:
                    break
        except Exception as e:
            self._json(500, {"error": str(e)})
            return

        self._json(200, {"code": code, "excerpts": excerpts})

    # ── GET /docs/load ─────────────────────────────────────────────────────────

    def _docs_load(self):
        import urllib.parse
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        docs_path = Path(urllib.parse.unquote(params.get("path", "qc/codebook.json")))
        json_path = docs_path
        try:
            if json_path.exists():
                with open(json_path) as f:
                    data = json.load(f)

                codes   = data.get("codes", {})
                changed = False

                # ── Migration: strip _baseline from all code entries ────────
                for code_data in codes.values():
                    if "_baseline" in code_data:
                        del code_data["_baseline"]
                        changed = True

                # ── Migration: ensure all codes have full records ────────────
                yaml_path = json_path.parent / "codebook.yaml"
                if yaml_path.exists():
                    try:
                        yaml_tree    = self._parse_codebook_flat(yaml_path.read_text())
                        yaml_parents = {n["name"]: n["parent"] for n in yaml_tree}
                        for code_name in yaml_parents:
                            rec = codes.setdefault(code_name, {})
                            dirty = False
                            for field, default in [
                                ("name",            code_name),
                                ("parent",          yaml_parents[code_name]),
                                ("scope",           ""),
                                ("rationale",       ""),
                                ("usage_notes",     ""),
                                ("provenance",      ""),
                                ("status",          ""),
                                ("pinned_examples", []),
                                ("_log",            []),
                            ]:
                                if field not in rec:
                                    rec[field] = default
                                    dirty = True
                            # Always keep name and parent in sync with yaml
                            if rec.get("name") != code_name:
                                rec["name"] = code_name
                                dirty = True
                            if rec.get("parent") != yaml_parents[code_name] and "parent" not in rec:
                                rec["parent"] = yaml_parents[code_name]
                                dirty = True
                            if dirty:
                                changed = True
                    except Exception as e:
                        ts_log = datetime.now().strftime("%H:%M:%S")
                        print(f"[{ts_log}] docs/load: WARNING — could not normalize records: {e}")

                # ── Sync check: compare parents in codebook.yaml vs codebook.json ──
                yaml_path = json_path.parent / "codebook.yaml"
                mismatches = []
                if yaml_path.exists():
                    try:
                        yaml_tree = self._parse_codebook_flat(yaml_path.read_text())
                        yaml_parents = {n["name"]: n["parent"] for n in yaml_tree}
                        for code_name, code_data in codes.items():
                            if "parent" in code_data:
                                yaml_parent = yaml_parents.get(code_name)
                                if yaml_parent is not None and code_data["parent"] != yaml_parent:
                                    mismatches.append({
                                        "code":       code_name,
                                        "json_parent": code_data["parent"],
                                        "yaml_parent": yaml_parent,
                                    })
                    except Exception as e:
                        ts_log = datetime.now().strftime("%H:%M:%S")
                        print(f"[{ts_log}] docs/load: WARNING — could not check parent sync: {e}")

                if changed:
                    data["codes"] = codes
                    with open(json_path, "w") as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)
                    ts_log = datetime.now().strftime("%H:%M:%S")
                    print(f"[{ts_log}] docs/load: migrated — stripped _baseline from {json_path.name}")

                self._json(200, {
                    "codes":      codes,
                    "overrides":  data.get("overrides", {}),
                    "mismatches": mismatches,
                    "ok": True,
                })
            elif docs_path.exists():
                with open(docs_path) as f:
                    raw = f.read()
                self._json(200, {"raw": raw, "ok": True})
            else:
                self._json(200, {"codes": {}, "overrides": {}, "mismatches": [], "ok": True, "new": True})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── GET /docs/list-json?dir=X ──────────────────────────────────────────
    # Lists qc-scheme JSON files in a directory, newest first.

    def _docs_list_json(self):
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        raw_dir  = urllib.parse.unquote(params.get("dir", ""))
        scan_dir = Path(raw_dir).resolve() if raw_dir else SERVE_DIR
        try:
            files = []
            if scan_dir.is_dir():
                for f in sorted(scan_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
                    try:
                        stat = f.stat()
                        with open(f) as fh:
                            head = fh.read(256)
                        if '"codes"' not in head:
                            continue
                        files.append({
                            "path":    str(f),
                            "name":    f.name,
                            "mtime":   datetime.fromtimestamp(stat.st_mtime).isoformat(),
                            "size_kb": round(stat.st_size / 1024, 1),
                        })
                    except Exception:
                        pass
            self._json(200, {"files": files, "dir": str(scan_dir), "ok": True})
        except Exception as e:
            self._json(500, {"error": str(e)})

    
    # ── GET /docs/load-json?path=X ─────────────────────────────────────────────
    # Loads any qc-scheme JSON from an arbitrary absolute path.
    # Used by the "Import JSON" feature to switch canonical files.

    def _docs_load_json(self):
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        raw_path = urllib.parse.unquote(params.get("path", ""))
        if not raw_path:
            self._json(400, {"error": "path param required"})
            return
        target = Path(raw_path).resolve()
        if target.suffix != ".json":
            target = target.with_suffix(".json")
        try:
            if not target.exists():
                self._json(404, {"error": f"File not found: {target}"})
                return
            with open(target) as f:
                data = json.load(f)

            # If this file lives inside a snapshot directory, record it as active
            active_dir = ""
            try:
                rel = target.relative_to(SNAPSHOTS_DIR)
                # rel is like  codebook-collab_20260323-1510_a3f9/codebook.json
                dir_name = rel.parts[0]
                if (SNAPSHOTS_DIR / dir_name).is_dir():
                    active_dir = dir_name
                    ts_log = datetime.now().strftime("%H:%M:%S")
                    print(f"[{ts_log}] load-json: detected snapshot dir = {active_dir}")
                    # Record this as the working parent for next snapshot/fork
                    (DATA_DIR / ".working_parent").write_text(dir_name)
            except ValueError:
                pass  # not inside SNAPSHOTS_DIR

            codes    = data.get("codes", {})
            changed  = False

            # ── Migration: strip _baseline ──────────────────────────────────
            for code_data in codes.values():
                if "_baseline" in code_data:
                    del code_data["_baseline"]
                    changed = True

            # ── Migration: ensure all codes have full records ────────────────
            sibling_yaml = target.parent / "codebook.yaml"
            if sibling_yaml.exists():
                try:
                    yaml_tree    = self._parse_codebook_flat(sibling_yaml.read_text())
                    yaml_parents = {n["name"]: n["parent"] for n in yaml_tree}
                    for code_name in yaml_parents:
                        rec = codes.setdefault(code_name, {})
                        dirty = False
                        for field, default in [
                            ("name",            code_name),
                            ("parent",          yaml_parents[code_name]),
                            ("scope",           ""),
                            ("rationale",       ""),
                            ("usage_notes",     ""),
                            ("provenance",      ""),
                            ("status",          ""),
                            ("pinned_examples", []),
                            ("_log",            []),
                        ]:
                            if field not in rec:
                                rec[field] = default
                                dirty = True
                        if rec.get("name") != code_name:
                            rec["name"] = code_name
                            dirty = True
                        if dirty:
                            changed = True
                except Exception as e:
                    ts_log = datetime.now().strftime("%H:%M:%S")
                    print(f"[{ts_log}] load-json: WARNING — could not normalize records: {e}")

            if changed:
                data["codes"] = codes
                with open(target, "w") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                ts_log = datetime.now().strftime("%H:%M:%S")
                print(f"[{ts_log}] load-json: migrated {target.name}")

            ts = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts}] opened {target}" + (f"  (active: {active_dir})" if active_dir else ""))
            self._json(200, {
                "codes":      codes,
                "overrides":  data.get("overrides", {}),
                "changelog":  data.get("changelog", []),
                "saved":      data.get("saved", ""),
                "active_dir": active_dir,
                "ok": True,
            })
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── POST /docs/save ────────────────────────────────────────────────────────

    def _docs_save(self, body):
        try:
            payload   = json.loads(body)
            docs_path = Path(payload.get("path", "qc/codebook.json"))
            data      = payload.get("data", {})
            tree      = payload.get("tree", [])
            overrides = payload.get("overrides", {})
            changelog = payload.get("changelog", [])

            if isinstance(data.get("codes"), list):
                data["codes"] = {}

            abs_path = docs_path.resolve()  # path is already .json; resolve to absolute
            abs_path.parent.mkdir(parents=True, exist_ok=True)

            json_payload = {
                "saved":     datetime.now().isoformat(),
                "codes":     data.get("codes", {}),
                "tree":      tree,
                "overrides": overrides,
            }
            if changelog:
                json_payload["changelog"] = changelog

            with open(abs_path, "w") as f:
                json.dump(json_payload, f, ensure_ascii=False, indent=2)

            ts = datetime.now().strftime("%H:%M:%S")
            n  = len([v for v in data.get("codes", {}).values()
                      if isinstance(v, dict) and any(v.get(f) for f in
                         ("scope","rationale","usage_notes","provenance","status"))])
            print(f"[{ts}] saved {abs_path}  ({n} documented, {len(overrides)} moves)")

            self._json(200, {"ok": True})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── GET /align/responses ───────────────────────────────────────────────────
    def _align_responses_list(self):
        try:
            responses_dir = SERVE_DIR / "align-responses"
            responses_dir.mkdir(exist_ok=True)
            files = sorted(responses_dir.glob("*.json"), reverse=True)
            entries = []
            for f in files:
                try:
                    data = json.loads(f.read_text())
                    entries.append({
                        "filename": f.name,
                        "ts":       data.get("ts", ""),
                        "mode":     data.get("mode", ""),
                        "codes":    data.get("codes", []),
                        "n_suggestions": len(data.get("suggestions", [])),
                    })
                except Exception:
                    pass
            self._json(200, {"ok": True, "responses": entries})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── POST /align/responses/save ─────────────────────────────────────────────
    def _align_responses_save(self, body):
        try:
            payload = json.loads(body)
            responses_dir = SERVE_DIR / "align-responses"
            responses_dir.mkdir(exist_ok=True)
            ts       = datetime.now().strftime("%Y%m%d-%H%M%S")
            mode     = payload.get("mode", "unknown")
            filename = f"align_{mode}_{ts}.json"
            filepath = responses_dir / filename
            with open(filepath, "w") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            ts_log = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts_log}] align/responses/save: {filename}")
            self._json(200, {"ok": True, "filename": filename})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── GET /align/log ─────────────────────────────────────────────────────────
    def _align_log_get(self):
        log_path = SERVE_DIR / "align-log.json"
        try:
            if not log_path.exists():
                self._json(200, {"entries": [], "ok": True})
                return
            with open(log_path) as f:
                data = json.load(f)
            self._json(200, {"entries": data.get("entries", []), "ok": True})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── POST /align/log ─────────────────────────────────────────────────────────
    def _align_log_post(self, body):
        log_path = SERVE_DIR / "align-log.json"
        try:
            entry = json.loads(body)
            data  = {"entries": []}
            if log_path.exists():
                with open(log_path) as f:
                    data = json.load(f)
            data.setdefault("entries", []).append(entry)
            with open(log_path, "w") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            self._json(200, {"ok": True})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── POST /refactor/queue ────────────────────────────────────────────────────
    # Pre-populates the refactor queue from qc-align suggestions.
    # Stores pending ops in a sidecar file; qc-refactor reads on load.
    def _refactor_queue(self, body):
        queue_path = SERVE_DIR / "refactor-queue.json"
        try:
            payload = json.loads(body)
            ops     = payload.get("ops", [])
            data    = {"ops": []}
            if queue_path.exists():
                with open(queue_path) as f:
                    data = json.load(f)
            data["ops"].extend(ops)
            with open(queue_path, "w") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            ts_log = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts_log}] refactor/queue: {len(ops)} op(s) queued from qc-align")
            self._json(200, {"ok": True, "queued": len(ops)})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── POST /refactor/execute ─────────────────────────────────────────────────
    # Body: { operations, summary, script, scheme_path, docs_edits }

    def _refactor_execute(self, body):
        import subprocess
        try:
            payload     = json.loads(body)
            operations  = payload.get("operations", [])
            summary     = payload.get("summary", "")
            scheme_path = Path(payload.get("scheme_path", ""))
            docs_edits  = payload.get("docs_edits", {})

            working_yaml = SERVE_DIR / "codebook.yaml"
            working_docs = SERVE_DIR / "codebook.json"
            project_root = str(SERVE_DIR)
            qc_bin       = CONFIG.get("qc_bin") or shutil.which("qc") or "qc"

            # Ensure pipx/local bin is on PATH for subprocess
            _env = os.environ.copy()
            _local_bin = str(Path.home() / ".local" / "bin")
            if _local_bin not in _env.get("PATH", ""):
                _env["PATH"] = _local_bin + ":" + _env.get("PATH", "")

            ts_log = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts_log}] refactor/execute: {len(operations)} ops — {summary[:60]}")

            # ── Run operations ──────────────────────────────────────────────────
            results = []

            for op in operations:
                op_type = op.get("type")
                sources = op.get("sources", [])
                target  = op.get("target", "")

                if op_type in ("rename", "merge"):
                    cmd = [qc_bin, "codes", "rename"] + sources + ([target] if target else [])
                    try:
                        r = subprocess.run(
                            cmd, cwd=project_root,
                            capture_output=True, text=True, timeout=30,
                            env=_env
                        )
                        ok  = r.returncode == 0
                        out = (r.stdout + r.stderr).strip()
                        results.append({"cmd": " ".join(cmd), "ok": ok, "output": out})
                        if ok:
                            # Verify which source codes are now orphans before removing
                            try:
                                stats = subprocess.run(
                                    [qc_bin, "codes", "stats", "-zu", "0"],
                                    cwd=project_root, capture_output=True, text=True,
                                    timeout=30, env=_env
                                )
                                orphan_lines = stats.stdout.splitlines()
                                # Output is a table; code names appear in the first column
                                orphan_codes = set()
                                for line in orphan_lines:
                                    # Skip header and separator lines
                                    stripped = line.strip()
                                    if not stripped or stripped.startswith('-') or stripped.startswith('Code'):
                                        continue
                                    # Count is the last whitespace-separated token
                                    # Code name is everything before it
                                    parts = stripped.rsplit(None, 1)
                                    if len(parts) == 2 and parts[1].lstrip('-').isdigit():
                                        orphan_codes.add(parts[0].strip())
                                to_remove = [s for s in sources if s in orphan_codes]
                                for src in to_remove:
                                    try:
                                        self._do_remove(src, working_yaml)
                                    except Exception as rm_err:
                                        ts_log = datetime.now().strftime("%H:%M:%S")
                                        print(f"[{ts_log}] refactor/execute: WARNING — could not remove {src} from yaml: {rm_err}")
                                skipped = [s for s in sources if s not in orphan_codes]
                                if skipped:
                                    ts_log = datetime.now().strftime("%H:%M:%S")
                                    print(f"[{ts_log}] refactor/execute: skipped removal of {skipped} — still have corpus applications")
                            except Exception as ve:
                                ts_log = datetime.now().strftime("%H:%M:%S")
                                print(f"[{ts_log}] refactor/execute: WARNING — could not verify orphans: {ve}")
                    except Exception as e:
                        results.append({"cmd": " ".join(cmd), "ok": False, "output": str(e)})

                elif op_type == "move":
                    try:
                        self._do_move(sources[0] if sources else "", target, working_yaml)
                        results.append({"cmd": f"move {sources[0]} → {target or '(top level)'}", "ok": True, "output": ""})
                    except Exception as e:
                        results.append({"cmd": f"move {sources[0] if sources else '?'} → {target}", "ok": False, "output": str(e)})

                elif op_type == "deprecate":
                    try:
                        if working_docs.exists():
                            with open(working_docs) as f:
                                docs = json.load(f)
                            for src in sources:
                                if src not in docs.setdefault("codes", {}):
                                    docs["codes"][src] = {}
                                docs["codes"][src]["status"] = "deprecated"
                            with open(working_docs, "w") as f:
                                json.dump(docs, f, ensure_ascii=False, indent=2)
                        results.append({"cmd": f"deprecate {', '.join(sources)}", "ok": True, "output": ""})
                    except Exception as e:
                        results.append({"cmd": f"deprecate {', '.join(sources)}", "ok": False, "output": str(e)})

                elif op_type == "stub":
                    stub_name   = sources[0] if sources else ""
                    stub_parent = target or ""
                    try:
                        # 1. Add to codebook.yaml under parent (or at top level)
                        self._do_create_stub(stub_name, stub_parent, working_yaml)
                        # 2. Add to codebook.json with status "stub"
                        if working_docs.exists():
                            with open(working_docs) as f:
                                docs = json.load(f)
                            if stub_name not in docs.setdefault("codes", {}):
                                docs["codes"][stub_name] = {}
                            docs["codes"][stub_name]["status"]  = "stub"
                            docs["codes"][stub_name]["created"] = datetime.now().isoformat()[:10]
                            if stub_parent:
                                docs["codes"][stub_name]["parent"] = stub_parent
                            with open(working_docs, "w") as f:
                                json.dump(docs, f, ensure_ascii=False, indent=2)
                        ts_log = datetime.now().strftime("%H:%M:%S")
                        print(f"[{ts_log}] refactor/execute: created stub {stub_name}" + (f" under {stub_parent}" if stub_parent else ""))
                        results.append({"cmd": f"create stub {stub_name}", "ok": True, "output": ""})
                    except Exception as e:
                        results.append({"cmd": f"create stub {stub_name}", "ok": False, "output": str(e)})

            # ── Update codebook.json — provenance, docs_edits, changelog ───────
            if working_docs.exists():
                try:
                    with open(working_docs) as f:
                        docs = json.load(f)

                    codes  = docs.setdefault("codes", {})
                    ts_iso = datetime.now().isoformat()

                    # Build a result lookup by op index
                    result_by_idx = { i: results[i] for i in range(len(results)) }

                    # Apply docs_edits unconditionally (user wrote these)
                    for code_name, edits in docs_edits.items():
                        if code_name not in codes:
                            codes[code_name] = {}
                        for field, value in edits.items():
                            old_val = codes[code_name].get(field, "")
                            codes[code_name][field] = value
                            log = codes[code_name].setdefault("_log", [])
                            log.append({"ts": ts_iso, "field": field, "from": old_val, "to": value})

                    # Write provenance only for successful ops
                    for i, op in enumerate(operations):
                        r = result_by_idx.get(i, {})
                        if r.get("ok") is False:
                            continue
                        op_type = op.get("type")
                        sources = op.get("sources", [])
                        target  = op.get("target", "")
                        if op_type == "rename" and sources:
                            old_name = sources[0]
                            # Move docs entry to new key
                            if old_name in codes and old_name != target:
                                codes[target] = codes.pop(old_name)
                            tgt = codes.setdefault(target, {})
                            tgt["provenance"] = f"Renamed from {old_name} ({ts_iso[:10]})"
                            # Update parent refs
                            for c, cd in codes.items():
                                if cd.get("parent") == old_name:
                                    cd["parent"] = target
                        elif op_type == "merge" and sources:
                            tgt = codes.setdefault(target, {})
                            tgt["provenance"] = f"Merged from {', '.join(sources)} ({ts_iso[:10]}): {summary}"
                            # Remove source entries, reparent their children
                            for src in sources:
                                for c, cd in codes.items():
                                    if cd.get("parent") == src:
                                        cd["parent"] = target
                                codes.pop(src, None)
                        elif op_type == "move" and sources:
                            src_name = sources[0]
                            src_doc = codes.setdefault(src_name, {})
                            dest = target or ""
                            src_doc["parent"] = dest
                            old_prov = src_doc.get("provenance", "")
                            src_doc["provenance"] = (old_prov + f"\nMoved to {dest or '(top level)'} ({ts_iso[:10]})").strip()

                    # Determine overall status
                    n_ok    = sum(1 for r in results if r.get("ok") is not False)
                    n_fail  = len(results) - n_ok
                    ok_all  = n_fail == 0
                    status  = "ok" if ok_all else ("partial" if n_ok > 0 else "failed")

                    # Append refactor changelog entry — always, but with status
                    changelog = docs.setdefault("changelog", [])
                    changelog.append({
                        "ts":      ts_iso,
                        "type":    "refactor",
                        "status":  status,
                        "summary": summary,
                        "ops":     operations,
                        "results": results,
                    })

                    with open(working_docs, "w") as f:
                        json.dump(docs, f, ensure_ascii=False, indent=2)

                    if not ok_all:
                        ts_log = datetime.now().strftime("%H:%M:%S")
                        print(f"[{ts_log}] refactor/execute: {n_fail} op(s) failed — {status}")

                except Exception as e:
                    ts_log = datetime.now().strftime("%H:%M:%S")
                    print(f"[{ts_log}] refactor/execute: WARNING — could not update codebook.json: {e}")

            all_ok = all(r.get("ok") is not False for r in results)
            self._json(200, {"ok": all_ok, "results": results})

        except Exception as e:
            import traceback; traceback.print_exc()
            self._json(500, {"ok": False, "error": str(e), "results": []})

    # ── POST /refactor/move ────────────────────────────────────────────────────
    # Body: { code, new_parent, yaml_path }

    def _refactor_move(self, body):
        try:
            payload    = json.loads(body)
            code       = payload.get("code", "")
            new_parent = payload.get("new_parent", "")
            yaml_path  = Path(payload.get("yaml_path", str(DATA_DIR / "codebook.yaml")))
            self._do_move(code, new_parent, yaml_path)
            self._json(200, {"ok": True})
        except Exception as e:
            import traceback; traceback.print_exc()
            self._json(500, {"ok": False, "error": str(e)})

    def _do_remove(self, code, yaml_path):
        """Remove a code from codebook.yaml, re-parenting its children to its parent."""
        if not yaml_path.exists():
            raise FileNotFoundError(f"codebook.yaml not found: {yaml_path}")

        with open(yaml_path) as f:
            lines = f.readlines()

        code_pattern = re.compile(r'^(\s*)-\s+' + re.escape(code) + r'\s*:?\s*$')
        code_line_idx = None
        for i, line in enumerate(lines):
            if code_pattern.match(line):
                code_line_idx = i
                break

        if code_line_idx is None:
            return  # Already gone — nothing to do

        code_indent = len(lines[code_line_idx]) - len(lines[code_line_idx].lstrip())

        # Collect children (lines more indented than the code line)
        children = []
        j = code_line_idx + 1
        while j < len(lines):
            line = lines[j]
            if line.strip() == '' or line.strip().startswith('#'):
                j += 1
                continue
            line_indent = len(line) - len(line.lstrip())
            if line_indent > code_indent:
                children.append(line)
                j += 1
            else:
                break

        # Re-indent children to the code's own indent level
        if children:
            child_base_indent = len(children[0]) - len(children[0].lstrip())
            reindented = []
            for cl in children:
                if cl.strip():
                    cl_indent = len(cl) - len(cl.lstrip())
                    delta = cl_indent - child_base_indent
                    reindented.append(' ' * (code_indent + delta) + cl.lstrip())
                else:
                    reindented.append(cl)
        else:
            reindented = []

        # Replace code line + its children block with re-indented children
        lines[code_line_idx:code_line_idx + 1 + len(children)] = reindented

        with open(yaml_path, "w") as f:
            f.writelines(lines)

        ts_log = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts_log}] refactor/remove: stripped {code} from codebook.yaml")

    def _do_move(self, code, new_parent, yaml_path):
        """Move a code to a new parent in codebook.yaml by direct line manipulation."""
        if not yaml_path.exists():
            raise FileNotFoundError(f"codebook.yaml not found: {yaml_path}")

        with open(yaml_path) as f:
            lines = f.readlines()

        # Find the line containing the code (as a list item)
        code_pattern = re.compile(r'^(\s*)-\s+' + re.escape(code) + r'\s*:?\s*$')
        code_line_idx = None
        for i, line in enumerate(lines):
            if code_pattern.match(line):
                code_line_idx = i
                break

        if code_line_idx is None:
            raise ValueError(f"Code not found in codebook.yaml: {code}")

        # Collect the code's block: its line plus any indented children
        code_indent = len(lines[code_line_idx]) - len(lines[code_line_idx].lstrip())
        block = [lines[code_line_idx]]
        j = code_line_idx + 1
        while j < len(lines):
            line = lines[j]
            if line.strip() == '' or line.strip().startswith('#'):
                j += 1
                continue
            line_indent = len(line) - len(line.lstrip())
            if line_indent > code_indent:
                block.append(line)
                j += 1
            else:
                break

        # Remove the block from its current position
        del lines[code_line_idx:code_line_idx + len(block)]

        # Re-indent block to depth of new parent + 1
        if new_parent:
            parent_pattern = re.compile(r'^(\s*)-\s+' + re.escape(new_parent) + r'\s*:?\s*$')
            parent_line_idx = None
            for i, line in enumerate(lines):
                if parent_pattern.match(line):
                    parent_line_idx = i
                    break
            if parent_line_idx is None:
                raise ValueError(f"Parent code not found in codebook.yaml: {new_parent}")

            parent_indent = len(lines[parent_line_idx]) - len(lines[parent_line_idx].lstrip())
            new_indent    = parent_indent + 2

            # Ensure parent line ends with colon
            if not lines[parent_line_idx].rstrip().endswith(':'):
                lines[parent_line_idx] = lines[parent_line_idx].rstrip() + ':\n'

            # Re-indent block
            old_indent = code_indent
            reindented = []
            for bline in block:
                if bline.strip() == '':
                    reindented.append(bline)
                else:
                    bline_indent = len(bline) - len(bline.lstrip())
                    delta = bline_indent - old_indent
                    reindented.append(' ' * (new_indent + delta) + bline.lstrip())

            # Insert after parent line (find end of parent's existing children)
            insert_at = parent_line_idx + 1
            while insert_at < len(lines):
                line = lines[insert_at]
                if line.strip() == '' or line.strip().startswith('#'):
                    insert_at += 1
                    continue
                line_indent = len(line) - len(line.lstrip())
                if line_indent > parent_indent:
                    insert_at += 1
                else:
                    break
            lines[insert_at:insert_at] = reindented
        else:
            # Top-level: indent = 0
            reindented = []
            old_indent = code_indent
            for bline in block:
                if bline.strip() == '':
                    reindented.append(bline)
                else:
                    bline_indent = len(bline) - len(bline.lstrip())
                    delta = bline_indent - old_indent
                    reindented.append(' ' * max(0, delta) + bline.lstrip())
            # Append at end (before trailing newline)
            lines.extend(reindented)

        with open(yaml_path, "w") as f:
            f.writelines(lines)

        ts_log = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts_log}] refactor/move: {code} → {new_parent or '(top level)'}")

    def _do_create_stub(self, stub_name: str, parent: str, yaml_path: Path):
        """Insert a new stub node into codebook.yaml under parent (or at top level)."""
        import re
        with open(yaml_path) as f:
            lines = f.readlines()

        if parent:
            # Find parent line
            parent_pattern = re.compile(r'^(\s*)-\s+' + re.escape(parent) + r'\s*:?\s*$')
            parent_line_idx = None
            for i, line in enumerate(lines):
                if parent_pattern.match(line):
                    parent_line_idx = i
                    break
            if parent_line_idx is None:
                raise ValueError(f"Parent not found in codebook.yaml: {parent}")

            parent_indent = len(lines[parent_line_idx]) - len(lines[parent_line_idx].lstrip())
            new_indent    = parent_indent + 2

            # Ensure parent line ends with colon (has children)
            if not lines[parent_line_idx].rstrip().endswith(':'):
                lines[parent_line_idx] = lines[parent_line_idx].rstrip() + ':\n'

            # Find insertion point: after all existing children of parent
            insert_at = parent_line_idx + 1
            while insert_at < len(lines):
                line = lines[insert_at]
                if line.strip() == '' or line.strip().startswith('#'):
                    insert_at += 1
                    continue
                if len(line) - len(line.lstrip()) > parent_indent:
                    insert_at += 1
                else:
                    break

            new_line = ' ' * new_indent + '- ' + stub_name + ':\n'
            lines.insert(insert_at, new_line)
        else:
            # Top level — append before trailing blank lines
            insert_at = len(lines)
            while insert_at > 0 and lines[insert_at-1].strip() == '':
                insert_at -= 1
            lines.insert(insert_at, '- ' + stub_name + ':\n')

        with open(yaml_path, 'w') as f:
            f.writelines(lines)

        ts_log = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts_log}] refactor/stub: created {stub_name}" + (f" under {parent}" if parent else " (top level)"))

    # ── GET /refactor/tree ────────────────────────────────────────────────────
    # Returns the current codebook.yaml as a flat tree for runtime picker refresh.

    def _refactor_tree(self):
        yaml_path = SERVE_DIR / "codebook.yaml"
        try:
            if not yaml_path.exists():
                self._json(404, {"error": "codebook.yaml not found"})
                return
            with open(yaml_path) as f:
                text = f.read()
            nodes = self._parse_codebook_flat(text)
            self._json(200, {"tree": nodes, "ok": True})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _parse_codebook_flat(self, text):
        """Parse codebook.yaml into a flat list of {name, parent, depth, prefix}."""
        nodes  = []
        stack  = []  # (indent, name)
        for line in text.splitlines():
            stripped = line.lstrip()
            if not stripped or stripped.startswith('#'):
                continue
            if not stripped.startswith('-'):
                continue
            indent = len(line) - len(line.lstrip())
            depth  = indent // 2
            # Pop stack to current depth
            while stack and stack[-1][0] >= indent:
                stack.pop()
            name = stripped[1:].strip().rstrip(':')
            parent = stack[-1][1] if stack else ''
            prefix = name[:2] if len(name) >= 2 else name
            nodes.append({"name": name, "parent": parent, "depth": depth, "prefix": prefix})
            stack.append((indent, name))
        return nodes

    # ── GET /refactor/history?path=X ──────────────────────────────────────────

    def _refactor_history(self):
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        import urllib.parse
        scheme_path = Path(urllib.parse.unquote(params.get("path", str(DATA_DIR / "codebook.json"))))
        try:
            if not scheme_path.exists():
                self._json(200, {"entries": [], "ok": True})
                return
            with open(scheme_path) as f:
                data = json.load(f)
            changelog = data.get("changelog", [])
            entries = [e for e in changelog if e.get("type") == "refactor"]
            entries.sort(key=lambda e: e.get("ts", ""), reverse=True)
            self._json(200, {"entries": entries, "ok": True})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── Snapshot helpers ────────────────────────────────────────────────────────

    def _sanitize_segment(self, s):
        """Sanitize a name segment: alphanumeric and hyphens only, no underscores."""
        s = re.sub(r'[^A-Za-z0-9-]', '-', s.strip())
        s = re.sub(r'-+', '-', s).strip('-')
        return s[:40] or 'untitled'

    def _lineage_path(self):
        return SNAPSHOTS_DIR / "lineage.json"

    def _read_lineage(self):
        p = self._lineage_path()
        if p.exists():
            try:
                with open(p) as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def _write_lineage(self, data):
        with open(self._lineage_path(), "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def _parse_dir_name(self, name):
        """Parse a snapshot directory name into {timestamp, label}.
        Format: codebook_YYYYMMDD-HHMM[-optional-label]
        """
        m = re.match(r'^codebook_(\d{8}-\d{4})(?:-(.+))?$', name)
        if not m:
            return None
        return {
            'chain':     'codebook',
            'timestamp': m.group(1),
            'label':     m.group(2) or '',
        }

    # ── POST /snapshots/load ───────────────────────────────────────────────────
    # Copies snapshot's codebook.yaml and codebook.json over working files.

    def _snapshots_load(self, body):
        try:
            payload  = json.loads(body)
            dir_name = payload.get("dir", "")
            if not dir_name:
                self._json(400, {"ok": False, "error": "dir required"})
                return
            snap_dir = SNAPSHOTS_DIR / dir_name
            if not snap_dir.is_dir():
                self._json(404, {"ok": False, "error": f"Snapshot not found: {dir_name}"})
                return
            snap_yaml = snap_dir / "codebook.yaml"
            snap_json = snap_dir / "codebook.json"
            if snap_yaml.exists():
                shutil.copy2(snap_yaml, DATA_DIR / "codebook.yaml")
            if snap_json.exists():
                shutil.copy2(snap_json, DATA_DIR / "codebook.json")
            # Update working parent
            (DATA_DIR / ".working_parent").write_text(dir_name)
            ts_log = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts_log}] snapshots/load: loaded {dir_name}")
            self._json(200, {"ok": True, "dir": dir_name})
        except Exception as e:
            import traceback; traceback.print_exc()
            self._json(500, {"ok": False, "error": str(e)})

    # ── GET /snapshots/tree?dir=X ──────────────────────────────────────────────
    # Returns flat tree from a snapshot's codebook.yaml, or working tree if no dir.

    def _snapshots_tree(self):
        import urllib.parse
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        snap_dir = urllib.parse.unquote(params.get("dir", ""))
        try:
            if snap_dir:
                yaml_path = SNAPSHOTS_DIR / snap_dir / "codebook.yaml"
            else:
                yaml_path = SERVE_DIR / "codebook.yaml"
            if not yaml_path.exists():
                self._json(404, {"error": f"codebook.yaml not found: {yaml_path}"})
                return
            nodes = self._parse_codebook_flat(yaml_path.read_text())
            self._json(200, {"tree": nodes, "ok": True})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── GET /snapshots/list ────────────────────────────────────────────────────

    def _snapshots_list(self):
        lineage    = self._read_lineage()
        snapshots   = []
        docs_paths = []
        if SNAPSHOTS_DIR.is_dir():
            for d in sorted(SNAPSHOTS_DIR.iterdir()):
                if not d.is_dir() or d.name in ('__pycache__',):
                    continue
                parsed = self._parse_dir_name(d.name)
                if not parsed:
                    continue
                docs_json = d / "codebook.json"
                cb_yaml   = d / "codebook.yaml"
                entry = lineage.get(d.name, {})
                snapshots.append({
                    "dir":       d.name,
                    "path":      str(d),
                    "chain":     parsed['chain'],
                    "timestamp": parsed['timestamp'],
                    "label":     parsed.get('label', ''),
                    "note":      entry.get("note", ""),
                    "has_docs":  docs_json.exists(),
                    "has_yaml":  cb_yaml.exists(),
                })
                if docs_json.exists():
                    docs_paths.append(str(docs_json))

        # Also include the working sidecar at the top of suggestions
        active_docs = SERVE_DIR / "codebook.json"
        if active_docs.exists():
            p = str(active_docs)
            if p not in docs_paths:
                docs_paths.insert(0, p)

        self._json(200, {
            "snapshots":   snapshots,
            "docs_paths": docs_paths,
            "ok": True,
        })

    # ── GET /snapshots/lineage ─────────────────────────────────────────────────

    def _snapshots_lineage(self):
        self._json(200, {"lineage": self._read_lineage(), "ok": True})

    # ── POST /snapshots/create ─────────────────────────────────────────────────
    # Body: {
    #   "action":      "snapshot" | "fork",
    #   "parent_dir":  "codebook_20260310-0900"  (existing dir name, or "" for root),
    #   "fork_segment": "collaboration",          (fork only — new name segment)
    #   "note":        "optional prose note",
    #   "active_yaml_path":  "/abs/path/to/codebook.yaml",
    #   "active_docs_path":  "/abs/path/to/codebook.json",
    #   "include_md":  true | false,
    #   "tree":        [...],
    #   "overrides":   {...}
    # }

    def _snapshots_create(self, body):
        try:
            payload      = json.loads(body)
            label        = payload.get("label", "")
            note         = payload.get("note", "")
            active_yaml  = Path(payload.get("active_yaml_path", ""))
            active_docs  = Path(payload.get("active_docs_path", ""))
            include_md   = payload.get("include_md", False)
            tree         = payload.get("tree", [])
            overrides    = payload.get("overrides", {})

            ts = datetime.now().strftime("%Y%m%d-%H%M")

            # Naming: codebook_YYYYMMDD-HHMM[-optional-label]
            seg = self._sanitize_segment(label) if label else ""
            new_name = f"codebook_{ts}" + (f"-{seg}" if seg else "")

            new_dir = SNAPSHOTS_DIR / new_name
            if new_dir.exists():
                # Timestamp collision (rare): append seconds
                ts2 = datetime.now().strftime("%Y%m%d-%H%M%S")
                new_name = f"codebook_{ts2}" + (f"-{label}" if label else "")
                new_dir = SNAPSHOTS_DIR / new_name
            new_dir.mkdir(parents=True, exist_ok=True)

            # Always copy from the live working files in SERVE_DIR
            working_yaml = SERVE_DIR / "codebook.yaml"
            working_docs = SERVE_DIR / "codebook.json"

            if working_yaml.exists():
                shutil.copy2(working_yaml, new_dir / "codebook.yaml")
            else:
                (new_dir / "codebook.yaml").write_text(
                    to_qc_yaml(tree, overrides) if tree else "# empty codebook\n"
                )

            if working_docs.exists():
                shutil.copy2(working_docs, new_dir / "codebook.json")
            else:
                with open(new_dir / "codebook.json", "w") as f:
                    json.dump({"saved": datetime.now().isoformat(),
                               "codes": {}, "tree": tree, "overrides": overrides}, f, indent=2)

            # Optional MD export (plain text summary)
            if include_md:
                md_lines = [f"# {new_name}\n"]
                for node in tree:
                    pad = "  " * node.get("depth", 0)
                    md_lines.append(f"{pad}- {node.get('name','')}")
                (new_dir / "codebook.md").write_text("\n".join(md_lines))

            # Update lineage.json
            lineage = self._read_lineage()
            lineage[new_name] = {"ts": ts, "note": note}
            self._write_lineage(lineage)

            ts_log = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts_log}] snapshots/create → {new_name}")

            self._json(200, {"ok": True, "dir": new_name, "path": str(new_dir)})

        except Exception as e:
            import traceback; traceback.print_exc()
            self._json(500, {"error": str(e)})


    # ── GET /snapshots/read?dir=X ──────────────────────────────────────────────
    # Reads a snapshot codebook.json without changing working state.
    # Used by the cross-snapshot diff UI.

    def _snapshots_read(self):
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        import urllib.parse
        dir_name = urllib.parse.unquote(params.get("dir", ""))
        if not dir_name:
            self._json(400, {"error": "dir param required"}); return
        target = SNAPSHOTS_DIR / dir_name / "codebook.json"
        try:
            if not target.exists():
                self._json(404, {"error": f"Not found: {target}"}); return
            with open(target) as f:
                data = json.load(f)
            self._json(200, {
                "dir":       dir_name,
                "codes":     data.get("codes", {}),
                "overrides": data.get("overrides", {}),
                "saved":     data.get("saved", ""),
                "ok": True,
            })
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── Ollama proxy ───────────────────────────────────────────────────────────

    def _proxy(self, method, body):
        target = OLLAMA + self.path
        try:
            req = urllib.request.Request(
                target,
                data=body if body else None,
                method=method,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type",
                                 resp.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(resp_body)))
                self._cors()
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            err_body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err_body)))
            self._cors()
            self.end_headers()
            self.wfile.write(err_body)
        except Exception as e:
            msg = json.dumps({"error": str(e)}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self._cors()
            self.end_headers()
            self.wfile.write(msg)

    # ── Helper ─────────────────────────────────────────────────────────────────

    def _json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)


# ── Main ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) > 1:
        try:
            PORT = int(sys.argv[1])
        except ValueError:
            pass
    try:
        with http.server.ThreadingHTTPServer(("", PORT), Handler) as httpd:
            print(f"[qc-server] Listening on port {PORT} — Ctrl-C to stop\n")
            httpd.serve_forever()
    except OSError as e:
        print(f"\nERROR: Could not bind to port {PORT}: {e}")
        print(f"Try: python3 qc-reflect-server.py {PORT + 1}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n[qc-server] Stopped.")