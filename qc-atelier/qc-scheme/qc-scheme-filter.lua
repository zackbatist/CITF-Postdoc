-- qc-scheme-filter.lua
-- Bakes codebook.yaml + codebook.json + corpus excerpts
-- into qc/qc-scheme.html at render time.

-- Load shared helpers from qc-shared.lua (sibling of this filter's directory)
local function _get_project_root_early()
  local s = os.getenv("PANDOC_SCRIPT_FILE") or ""
  local r = s:gsub("/qc-atelier/[^/]+/[^/]+$", "")
  if r ~= "" and r ~= s then return r end
  local h = io.popen("pwd"); local cwd = h:read("*l"); h:close()
  return cwd or "."
end
local _shared_path = _get_project_root_early() .. "/qc-atelier/shared/qc-shared.lua"
local shared = dofile(_shared_path)

local read_yaml_file      = shared.read_yaml_file
local meta_to_lua         = shared.meta_to_lua
local S                   = shared.S
local N                   = shared.N
local read_text_file      = shared.read_text_file
local get_json_files      = shared.get_json_files
local read_json_file      = shared.read_json_file
local js_safe             = shared.js_safe
local to_json             = shared.to_json
local parse_codebook_yaml = shared.parse_codebook_yaml
local flatten_codebook    = shared.flatten_codebook
local build_use_counts    = shared.build_use_counts
local build_code_colors   = shared.build_code_colors

-- ── Config ────────────────────────────────────────────────────────────────────

-- Resolve the project root from this filter's own path.
-- PANDOC_SCRIPT_FILE is set by Pandoc to the filter's absolute path.
local function get_project_root()
  local script = os.getenv("PANDOC_SCRIPT_FILE") or ""
  -- filter is at <root>/qc-atelier/qc-scheme/qc-scheme-filter.lua
  -- so go up 3 levels
  local root = script:match("^(.*)/qc-atelier/qc-scheme/[^/]+$")
  if root and root ~= "" then return root end
  -- Fallback: use cwd
  local h = io.popen("pwd"); local cwd = h:read("*l"); h:close()
  return cwd or "."
end

local PROJECT_ROOT = get_project_root()

local function project_path(rel)
  if rel:sub(1,1) == "/" then return rel end
  return PROJECT_ROOT .. "/" .. rel
end

local function load_config()
  local cfg_file = os.getenv("QC_ATELIER_CONFIG") or project_path("qc-atelier/qc-atelier-config.yaml")
  local cfg = {
    directories = { json_dir = "qc/json", output_dir = "qc" },
    server = { port = 8080 },
  }
  local raw = read_yaml_file(cfg_file)
  if raw then
    local y = meta_to_lua(raw)
    local function merge(t, s)
      if type(s) ~= "table" then return end
      for k, v in pairs(s) do
        if type(v) == "table" and type(t[k]) == "table" then merge(t[k], v)
        elseif v ~= nil then t[k] = v end
      end
    end
    merge(cfg, y)
  end
  return cfg
end

local config = load_config()

-- These paths are always relative to project root, never from shared config:
local OUTPUT_PATH     = project_path("qc-atelier/qc-scheme.html")
local CODEBOOK_PATH   = project_path(S(config.directories.output_dir) .. "/codebook.yaml")
local SCHEME_JSON = project_path(S(config.directories.output_dir) .. "/codebook.json")
local JSON_DIR        = project_path(S(config.directories.json_dir))
local CSS_FILE        = project_path("qc-atelier/qc-scheme/qc-scheme.css")
local SHARED_CSS_FILE = project_path("qc-atelier/shared/qc-shared.css")
local SHARED_JS_FILE  = project_path("qc-atelier/shared/qc-shared.js")
local JS_FILE         = project_path("qc-atelier/qc-scheme/qc-scheme.js")

-- ── Codebook loader ───────────────────────────────────────────────────────────
local function load_codebook_tree()
  local path = CODEBOOK_PATH
  print("qc-scheme: reading codebook from " .. path)
  local f = io.open(path, "r")
  if not f then print("qc-scheme: WARNING could not open " .. path); return {} end
  local text = f:read("*all"); f:close()
  local raw_nodes = parse_codebook_yaml(text)
  local nodes = flatten_codebook(raw_nodes, nil, 0)
  print(string.format("qc-scheme: codebook tree — %d nodes", #nodes))
  return nodes
end

-- ── Generate HTML ─────────────────────────────────────────────────────────────

local function generate_html()
  local json_files = get_json_files(JSON_DIR)
  local tree       = load_codebook_tree()
  local use_counts = build_use_counts(json_files)
  -- DOCS_DATA is intentionally empty here — loadDocs() fetches live data
  -- from the server on page load, so the baked value is just a fallback.

  local shared_css = read_text_file(SHARED_CSS_FILE)
  local css        = read_text_file(CSS_FILE)
  local shared_js  = read_text_file(SHARED_JS_FILE)
  local js         = read_text_file(JS_FILE)

  local html = {}
  html[#html+1] = '<!DOCTYPE html><html lang="en"><head>'
  html[#html+1] = '<meta charset="UTF-8">'
  html[#html+1] = '<meta name="viewport" content="width=device-width,initial-scale=1">'
  html[#html+1] = '<title>QC Scheme</title>'
  html[#html+1] = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">'
  html[#html+1] = '<style>' .. (shared_css or '') .. '\n' .. (css or '') .. '</style>'
  html[#html+1] = '</head><body>'
  html[#html+1] = '<nav class="qc-nav"><a class="qc-nav-brand" href="/">qc-atelier</a><a href="/qc-viz.html">viz</a><a href="/qc-scheme.html" class="active">scheme</a><a href="/qc-refactor.html">refactor</a><a href="/qc-reflect.html">reflect</a><a href="/qc-align.html" class="inactive">align</a><a href="/qc-unfold.html" class="inactive">unfold</a><a href="/qc-trace.html" class="inactive">trace</a></nav>'
  html[#html+1] = '<script>'
  html[#html+1] = 'const CODEBOOK_TREE = ' .. to_json(tree)       .. ';'
  html[#html+1] = 'const CORPUS_COUNTS = ' .. to_json(use_counts) .. ';'
  html[#html+1] = 'const ALL_CODES = '     .. to_json({})         .. ';'
  html[#html+1] = 'const DOCS_DATA = {"codes":{}};'
  
  -- Export code colours and schema
  local code_schema   = config.code_schema or {}
  local palette       = code_schema.palette or {"#2196F3","#FF9800","#9C27B0","#4CAF50","#E91E63","#FFC107","#009688","#F44336","#00BCD4","#8BC34A"}
  local default_color = code_schema.default_color or "#757575"
  local colors_derived = build_code_colors(tree, palette, default_color)
  html[#html+1] = 'const CODE_COLORS = ' .. to_json(colors_derived) .. ';'
  html[#html+1] = 'const CODE_SCHEMA = ' .. to_json({default_color = default_color}) .. ';'

html[#html+1] = 'const DOCS_CONFIG = '   .. to_json({
    server_port        = N(config.server.port),
    scheme_path = SCHEME_JSON,
    json_dir           = JSON_DIR,
  }) .. ';'
  html[#html+1] = '</script>'
  html[#html+1] = '<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>'
  html[#html+1] = '<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js"></script>'
  html[#html+1] = '<div id="qc-scheme-root"></div>'
  html[#html+1] = '<script>' .. (shared_js or '') .. '</script>'
  

  html[#html+1] = '<script>' .. js .. '</script>'
  html[#html+1] = '</body></html>'

  return table.concat(html, "\n")
end

function Pandoc(doc)
  print("qc-scheme: filter running, project_root=" .. PROJECT_ROOT .. ", output=" .. OUTPUT_PATH)
  local html = generate_html()
  print("qc-scheme: html length=" .. #html)
  local dir = OUTPUT_PATH:match("^(.+)/[^/]+$")
  if dir then os.execute("mkdir -p \"" .. dir .. "\"") end
  local f = io.open(OUTPUT_PATH, "w")
  if f then
    f:write(html); f:close()
    print("qc-scheme: wrote " .. OUTPUT_PATH)
  else
    print("ERROR: could not write " .. OUTPUT_PATH)
  end
  return doc
end
