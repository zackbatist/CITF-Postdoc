#!/usr/bin/env python3
"""
qc-reflect-server.py
Companion server for qc-reflect.html and qc-codebook-docs.html.

Routes:
  Static files        GET  /*              → serves qc/ directory
  Ollama proxy        ANY  /api/*          → http://localhost:11434
  Reflect logs        POST /logs/save      → save report log to disk
                      GET  /logs/list      → list all saved logs
  Docs persistence    POST /docs/save      → write codebook.docs.json
                      GET  /docs/load      → read codebook.docs.json

Usage (from project root):
    python3 qc-reflect-server.py [port]

Opens:
    http://localhost:8080/qc-reflect.html
    http://localhost:8080/qc-codebook-docs.html
"""

import http.server
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path


# ── Config ─────────────────────────────────────────────────────────────────────

def load_config():
    config_path = os.environ.get("QC_REFLECT_CONFIG", "qc-reflect-config.yaml")
    defaults = {
        "port":       8080,
        "serve_dir":  "qc",
        "logs_dir":   "qc/reflect-logs",
        "ollama_url": "http://localhost:11434",
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
        logs_dir   = logs_dir_r if os.path.isabs(logs_dir_r) \
                     else os.path.join(output_dir, logs_dir_r)

        return {
            "port":       int(port_str),
            "serve_dir":  output_dir,  # filters write HTML here; serve from same dir
            "logs_dir":   logs_dir,
            "ollama_url": ollama_url.rstrip("/"),
        }
    except Exception as e:
        print(f"[config] Could not parse {config_path}: {e}  — using defaults")
        return defaults


CONFIG    = load_config()
SERVE_DIR = Path(CONFIG["serve_dir"]).resolve()
LOGS_DIR  = Path(CONFIG["logs_dir"]).resolve()
PORT      = CONFIG["port"]
OLLAMA    = CONFIG["ollama_url"]

LOGS_DIR.mkdir(parents=True, exist_ok=True)

print(f"[qc-server] Serving   http://localhost:{PORT}/qc-reflect.html")
print(f"[qc-server]           http://localhost:{PORT}/qc-codebook-docs.html")
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
    print(f"[qc-server] Run: quarto render qc-reflect.qmd && quarto render qc-codebook-docs.qmd")


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
        "# codebook.yaml — generated by qc-codebook-docs",
        "# qc-compatible format: bare list, no documentation fields.",
        "# Edit documentation in qc-codebook-docs; do not hand-edit structure here.",
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
        if any(path.startswith(p) for p in ("/logs/", "/docs/", "/api/", "/excerpts/")):
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
        if self.path == "/logs/list":
            self._logs_list()
        elif self.path.startswith("/docs/list-json"):
            self._docs_list_json()
        elif self.path.startswith("/docs/load-json"):
            self._docs_load_json()
        elif self.path.startswith("/docs/load"):
            self._docs_load()
        elif self.path.startswith("/excerpts/fetch"):
            self._excerpts_fetch()
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
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        docs_path = Path(params.get("path", "qc/codebook.docs.json"))
        json_path = docs_path  # already .json; kept as Path object
        try:
            if json_path.exists():
                with open(json_path) as f:
                    data = json.load(f)
                self._json(200, {
                    "codes":     data.get("codes", {}),
                    "overrides": data.get("overrides", {}),
                    "ok": True,
                })
            elif docs_path.exists():
                with open(docs_path) as f:
                    raw = f.read()
                self._json(200, {"raw": raw, "ok": True})
            else:
                self._json(200, {"codes": {}, "overrides": {}, "ok": True, "new": True})
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── GET /docs/list-json?dir=X ──────────────────────────────────────────
    # Lists qc-codebook-docs JSON files in a directory, newest first.

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
    # Loads any qc-codebook-docs JSON from an arbitrary absolute path.
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
            ts = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts}] imported {target}")
            self._json(200, {
                "codes":     data.get("codes", {}),
                "overrides": data.get("overrides", {}),
                "saved":     data.get("saved", ""),
                "ok": True,
            })
        except Exception as e:
            self._json(500, {"error": str(e)})

    # ── POST /docs/save ────────────────────────────────────────────────────────

    def _docs_save(self, body):
        try:
            payload   = json.loads(body)
            docs_path = Path(payload.get("path", "qc/codebook.docs.json"))
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
