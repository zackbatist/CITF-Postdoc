-- qc-refactor-filter.lua
-- Bakes codebook.yaml + corpus counts into qc/qc-refactor.html at render time.

-- Load shared helpers
-- Derive project root from PANDOC_SCRIPT_FILE; fall back to pwd if unset.
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
local to_json             = shared.to_json
local parse_codebook_yaml = shared.parse_codebook_yaml
local flatten_codebook    = shared.flatten_codebook
local read_json_file      = shared.read_json_file
local build_use_counts    = shared.build_use_counts

-- ── Config ────────────────────────────────────────────────────────────────────

local function get_project_root()
  local script = os.getenv("PANDOC_SCRIPT_FILE") or ""
  local root = script:match("^(.*)/qc-atelier/qc-refactor/[^/]+$")
  if root and root ~= "" then return root end
  local h = io.popen("pwd"); local cwd = h:read("*l"); h:close()
  return cwd or "."
end

local PROJECT_ROOT = get_project_root()

local function project_path(rel)
  if rel:sub(1,1) == "/" then return rel end
  return PROJECT_ROOT .. "/" .. rel
end

local function load_config()
  local cfg_file = os.getenv("QC_ATELIER_CONFIG") or project_path("qc-atelier-config.yaml")
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

local OUTPUT_PATH     = project_path("qc/qc-refactor.html")
local CODEBOOK_PATH   = project_path(S(config.directories.output_dir) .. "/codebook.yaml")
local SCHEME_JSON     = project_path(S(config.directories.output_dir) .. "/codebook.json")
local JSON_DIR        = project_path(S(config.directories.json_dir))
local CSS_FILE        = project_path("qc-atelier/qc-refactor/qc-refactor.css")
local SHARED_CSS_FILE = project_path("qc-atelier/shared/qc-shared.css")
local SHARED_JS_FILE  = project_path("qc-atelier/shared/qc-shared.js")
local JS_FILE         = project_path("qc-atelier/qc-refactor/qc-refactor.js")

-- ── Codebook loader ───────────────────────────────────────────────────────────

local function load_codebook_tree()
  local path = CODEBOOK_PATH
  print("qc-refactor: reading codebook from " .. path)
  local f = io.open(path, "r")
  if not f then print("qc-refactor: WARNING could not open " .. path); return {} end
  local text = f:read("*all"); f:close()
  local raw_nodes = parse_codebook_yaml(text)
  local nodes = flatten_codebook(raw_nodes, nil, 0)
  print(string.format("qc-refactor: codebook tree — %d nodes", #nodes))
  return nodes
end

-- ── Generate HTML ─────────────────────────────────────────────────────────────

local function build_corpus_data(json_files)
  -- Full coding entries per code: {code -> [{document, line, text}, ...]}
  -- Capped at 30 entries per code to keep HTML size reasonable.
  local MAX_PER_CODE = 30
  local result = {}
  for _, jf in ipairs(json_files) do
    local data = read_json_file(jf)
    if data then
      for _, entry in ipairs(data) do
        local code = entry.code
        local doc  = (entry.document or jf:match("([^/]+)%.json$") or jf)
                       :gsub("^.*/",""):gsub("%.txt$","")
        local line = entry.line or 0
        local text = entry.text or ""
        if code and code ~= "" then
          if not result[code] then result[code] = {} end
          if #result[code] < MAX_PER_CODE then
            result[code][#result[code]+1] = { document=doc, line=line, text=text }
          end
        end
      end
    end
  end
  return result
end

local function generate_html()
  local json_files   = get_json_files(JSON_DIR)
  local tree         = load_codebook_tree()
  local use_counts   = build_use_counts(json_files)
  local corpus_data  = build_corpus_data(json_files)

  local shared_css = read_text_file(SHARED_CSS_FILE)
  local css        = read_text_file(CSS_FILE)
  local shared_js  = read_text_file(SHARED_JS_FILE)
  local js         = read_text_file(JS_FILE)

  local html = {}
  html[#html+1] = '<!DOCTYPE html><html lang="en"><head>'
  html[#html+1] = '<meta charset="UTF-8">'
  html[#html+1] = '<meta name="viewport" content="width=device-width,initial-scale=1">'
  html[#html+1] = '<title>QC Refactor</title>'
  html[#html+1] = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">'
  html[#html+1] = '<style>' .. shared_css .. '\n' .. css .. '</style>'
  html[#html+1] = '</head><body>'
  html[#html+1] = '<nav class="qc-nav"><a class="qc-nav-brand" href="/">qc-atelier</a><a href="/qc-scheme.html">scheme</a><a href="/qc-viz.html">viz</a><a href="/qc-refactor.html" class="active">refactor</a></nav>'
  html[#html+1] = '<script>'
  html[#html+1] = 'const CODEBOOK_TREE = ' .. to_json(tree)       .. ';'
  html[#html+1] = 'const CORPUS_COUNTS = ' .. to_json(use_counts) .. ';'
  html[#html+1] = 'const CORPUS_DATA = '   .. to_json(corpus_data)  .. ';'
  html[#html+1] = 'const REFACTOR_CONFIG = ' .. to_json({
    server_port = N(config.server.port),
    scheme_path = SCHEME_JSON,
    json_dir    = JSON_DIR,
  }) .. ';'
  
  -- Export code colours and schema
  local code_schema  = config.code_schema or {}
  local colors_raw   = code_schema.colors or {}
  local default_color = code_schema.default_color or "#757575"
  html[#html+1] = 'const CODE_COLORS = ' .. to_json(colors_raw) .. ';'
  html[#html+1] = 'const CODE_SCHEMA = ' .. to_json({default_color = default_color}) .. ';'

  html[#html+1] = '</script>'
  html[#html+1] = [[
<div id="qc-refactor-root">

<div class="qr-topbar">
  <button class="qr-mode-btn active" data-mode="refactor">Refactor</button>
  <button class="qr-mode-btn" data-mode="snapshots">Snapshots</button>
</div>

<div class="app">

  <div class="op-panel">
    <div class="op-tabs">
      <button class="op-tab active" data-type="rename">Rename</button>
      <button class="op-tab" data-type="merge">Merge</button>
      <button class="op-tab" data-type="move">Move</button>
      <button class="op-tab" data-type="deprecate">Deprecate</button>
      <button class="op-tab" data-type="stub">Create stub</button>
    </div>
    <div class="op-form" id="op-form"></div>
    <div class="op-add-row">
      <button class="btn primary" id="btn-add" style="width:100%">Add to queue</button>
    </div>
  </div>

  <div class="queue-panel">
    <div class="queue-header">Staged operations</div>
    <div class="queue-list" id="queue-list"></div>
    <div class="session-note-area">
      <label class="session-note-label">Session note</label>
      <textarea id="session-note" class="session-note-textarea" placeholder="Describe what changed and why — written into the changelog and code provenance…"></textarea>
    </div>
    <div class="queue-footer">
      <div class="queue-count" id="queue-count">Queue is empty</div>
      <div class="execute-row">
        <button class="btn" id="btn-clear" disabled>Clear all</button>
        <button class="btn primary" id="btn-execute" disabled style="flex:1">Execute</button>
      </div>
    </div>
  </div>

  <div class="right-panel">
    <div class="panel-tabs">
      <button class="panel-tab active" data-tab="preview">Preview</button>
      <button class="panel-tab" data-tab="script">Script</button>
      <button class="panel-tab" data-tab="results">Results</button>
      <button class="panel-tab" data-tab="history">History</button>
    </div>
    <div id="preview-wrap" class="preview-wrap">
      <div class="preview-tabs">
        <button class="preview-tab active" data-ptab="diff">Tree diff</button>
        <button class="preview-tab" data-ptab="impact">Corpus impact</button>
      </div>
      <div id="diff-panel" class="diff-panel"></div>
      <div id="impact-panel" class="impact-panel hidden"></div>
    </div>
    <div class="script-panel hidden" id="script-panel"></div>
    <div class="results-panel hidden" id="results-panel"></div>
    <div class="history-panel hidden" id="history-panel"></div>
  </div>

</div>

<div id="snapshots-view" class="hidden">
  <div class="snap-view-inner">
    <div id="snapshots-panel"></div>
  </div>
</div>

</div>]]
  html[#html+1] = '<script>' .. shared_js .. '</script>'
  

  html[#html+1] = '<script>' .. js .. '</script>'
  html[#html+1] = '</body></html>'

  return table.concat(html, "\n")
end

function Pandoc(doc)
  print("qc-refactor: filter running, project_root=" .. PROJECT_ROOT .. ", output=" .. OUTPUT_PATH)
  local html = generate_html()
  local dir = OUTPUT_PATH:match("^(.+)/[^/]+$")
  if dir then os.execute("mkdir -p \"" .. dir .. "\"") end
  local f = io.open(OUTPUT_PATH, "w")
  if f then
    f:write(html); f:close()
    print("qc-refactor: wrote " .. OUTPUT_PATH)
  else
    print("ERROR: could not write " .. OUTPUT_PATH)
  end
  return doc
end
