-- qc-align-filter.lua
-- Reads qc/json/*.json, codebook.yaml, and codebook.json at render time.
-- Bakes corpus excerpts, co-occurrence data, codebook tree, and documentation
-- into qc/qc-align.html for LLM-assisted code system auditing.

-- ── Shared helpers ────────────────────────────────────────────────────────────
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
local to_json             = shared.to_json
local parse_codebook_yaml = shared.parse_codebook_yaml
local flatten_codebook    = shared.flatten_codebook
local build_use_counts    = shared.build_use_counts

-- Reads qc/json/*.json and codebook.yaml at render time.
-- Bakes corpus excerpts, co-occurrence data, and a structured codebook tree
-- into qc/qc-align.html for LLM-driven thematic overlap analysis.

-- ── Config ────────────────────────────────────────────────────────────────────

local function get_project_root()
  local script = os.getenv("PANDOC_SCRIPT_FILE") or ""
  local root = script:match("^(.*)/qc-atelier/qc-align/[^/]+$")
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
    directories = {
      json_dir    = "qc/json",
      output_dir  = "qc",
    },
    ollama = {
      url     = "http://localhost:11434",
      model   = "qwen3.5:35b",
      num_ctx = 49152,
    },
    candidates = {
      max_pairs             = 40,
      max_cross_category    = 20,
      max_excerpts_per_code = 20,
    },
    code_schema = { categories = {}, colors = {}, default_color = "#757575" },
    server = { port = 8080 },
    align = {
      models = {
        overlap          = "qwen3.5:35b",
        inconsistency    = "qwen3.5:35b",
        bloat            = "qwen3.5:35b",
        restructure      = "qwen3.5:35b",
        line_splitting   = "qwen3.5:35b",
        code_propagation = "qwen3.5:35b",
      }
    },
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
    print("qc-align: loaded config from " .. cfg_file)
  end
  return cfg
end

local config = load_config()

local OUTPUT_PATH     = project_path(S(config.directories.output_dir) .. "/qc-align.html")
local CODEBOOK_PATH   = project_path(S(config.directories.output_dir) .. "/codebook.yaml")
local SCHEME_JSON     = project_path(S(config.directories.output_dir) .. "/codebook.json")
local JSON_DIR        = project_path(S(config.directories.json_dir))
local CSS_FILE        = project_path("qc-atelier/qc-align/qc-align.css")
local SHARED_CSS_FILE = project_path("qc-atelier/shared/qc-shared.css")
local SHARED_JS_FILE  = project_path("qc-atelier/shared/qc-shared.js")
local JS_FILE         = project_path("qc-atelier/qc-align/qc-align.js")

-- ── Codebook loader ───────────────────────────────────────────────────────────

local function load_codebook_tree()
  print("qc-align: reading codebook from " .. CODEBOOK_PATH)
  local f = io.open(CODEBOOK_PATH, "r")
  if not f then print("qc-align: WARNING could not open " .. CODEBOOK_PATH); return {} end
  local text = f:read("*all"); f:close()
  local raw_nodes = parse_codebook_yaml(text)
  local nodes = flatten_codebook(raw_nodes, nil, 0)
  print(string.format("qc-align: codebook tree — %d nodes", #nodes))
  return nodes
end

-- ── Corpus loading ────────────────────────────────────────────────────────────

local function build_corpus_index(json_files)
  local excerpts    = {}
  local by_doc_code = {}
  local doc_set     = {}
  local doc_order   = {}

  for _, jf in ipairs(json_files) do
    local data = read_json_file(jf)
    if data then
      for _, entry in ipairs(data) do
        local code = entry.code
        local doc  = entry.document or jf:match("([^/]+)%.json$") or jf
        doc = doc:gsub("^.*/", ""):gsub("%.txt$", "")
        local line = entry.line or 0
        local text = entry.text or
                     (entry.text_lines and table.concat(entry.text_lines, " ")) or ""
        if code and code ~= "" then
          if not excerpts[code] then excerpts[code] = {} end
          excerpts[code][#excerpts[code]+1] = { doc = doc, line = line, text = text }
          if not by_doc_code[doc] then by_doc_code[doc] = {} end
          by_doc_code[doc][code] = true
          if not doc_set[doc] then
            doc_set[doc] = true; doc_order[#doc_order+1] = doc
          end
        end
      end
    end
  end

  table.sort(doc_order)

  local cooc = {}
  for _, codes in pairs(by_doc_code) do
    local code_list = {}
    for c, _ in pairs(codes) do code_list[#code_list+1] = c end
    for i = 1, #code_list do
      for j = i+1, #code_list do
        local a, b = code_list[i], code_list[j]
        if a > b then a, b = b, a end
        if not cooc[a] then cooc[a] = {} end
        cooc[a][b] = (cooc[a][b] or 0) + 1
      end
    end
  end

  return excerpts, cooc, doc_order, by_doc_code
end

local function capped_excerpts(list)
  local max = N(config.candidates.max_excerpts_per_code)
  if not list then return {} end
  if #list <= max then return list end
  local result = {}
  local step = #list / max
  for i = 0, max - 1 do
    result[#result+1] = list[math.floor(i * step) + 1]
  end
  return result
end

local function get_color(code)
  local prefix = code:match("^(%d%d)_")
  if prefix and config.code_schema.colors[prefix] then
    return S(config.code_schema.colors[prefix])
  end
  return S(config.code_schema.default_color)
end

local function build_cooc_summary(cooc, excerpts)
  local list = {}
  for a, partners in pairs(cooc) do
    for b, shared in pairs(partners) do
      list[#list+1] = {
        code_a = a, code_b = b, shared_docs = shared,
        total_a = excerpts[a] and #excerpts[a] or 0,
        total_b = excerpts[b] and #excerpts[b] or 0,
      }
    end
  end
  table.sort(list, function(x, y) return x.shared_docs > y.shared_docs end)
  local top = {}
  for i = 1, math.min(500, #list) do top[i] = list[i] end
  return top
end

-- ── Generate HTML ─────────────────────────────────────────────────────────────

local function generate_html()
  local json_files = get_json_files(JSON_DIR)
  if #json_files == 0 then print("WARNING: No JSON files found in " .. JSON_DIR) end

  local excerpts, cooc, doc_order, by_doc_code = build_corpus_index(json_files)
  local cooc_summary  = build_cooc_summary(cooc, excerpts)
  local codebook_tree = load_codebook_tree()

  local all_codes = {}
  for code, _ in pairs(excerpts) do all_codes[#all_codes+1] = code end
  table.sort(all_codes)

  local active_set = {}
  for _, c in ipairs(all_codes) do active_set[c] = true end

  -- Filter tree to corpus-active nodes; annotate with use counts
  local active_tree = {}
  for _, node in ipairs(codebook_tree) do
    if active_set[node.name] or node.depth <= 1 then
      local active_children = {}
      for _, child in ipairs(node.children) do
        if active_set[child] then active_children[#active_children+1] = child end
      end
      active_tree[#active_tree+1] = {
        name     = node.name,
        parent   = node.parent,
        depth    = node.depth,
        prefix   = node.prefix,
        children = active_children,
        uses     = excerpts[node.name] and #excerpts[node.name] or 0,
      }
    end
  end

  local code_docs = {}
  for _, doc in ipairs(doc_order) do
    for code, _ in pairs(by_doc_code[doc] or {}) do
      if not code_docs[code] then code_docs[code] = {} end
      code_docs[code][#code_docs[code]+1] = doc
    end
  end

  local corpus_index = {}
  for _, code in ipairs(all_codes) do
    corpus_index[code] = {
      total    = #excerpts[code],
      docs     = code_docs[code] or {},
      excerpts = capped_excerpts(excerpts[code]),
    }
  end

  local code_colors = {}
  for _, code in ipairs(all_codes) do code_colors[code] = get_color(code) end

  print(string.format("qc-align: %d docs, %d active codes, %d tree nodes, %d cooc pairs",
    #doc_order, #all_codes, #active_tree, #cooc_summary))

  local shared_css = read_text_file(SHARED_CSS_FILE)
  local css_content = read_text_file(CSS_FILE)
  local shared_js   = read_text_file(SHARED_JS_FILE)
  local js_content  = read_text_file(JS_FILE)

  local html = {}
  html[#html+1] = '<!DOCTYPE html><html lang="en"><head>'
  html[#html+1] = '<meta charset="UTF-8">'
  html[#html+1] = '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
  html[#html+1] = '<title>QC Align</title>'
  html[#html+1] = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">'
  html[#html+1] = '<style>' .. shared_css .. '\n' .. css_content .. '</style>'
  html[#html+1] = '</head><body>'
  html[#html+1] = '<nav class="qc-nav"><a class="qc-nav-brand" href="/">qc-atelier</a><a href="/qc-scheme.html">scheme</a><a href="/qc-viz.html">viz</a><a href="/qc-refactor.html">refactor</a><a href="/qc-align.html" class="active">align</a></nav>'
  html[#html+1] = '<script>'
  html[#html+1] = 'const DOC_NAMES = '      .. to_json(doc_order)    .. ';'
  html[#html+1] = 'const ALL_CODES = '      .. to_json(all_codes)    .. ';'
  html[#html+1] = 'const CORPUS_INDEX = '   .. to_json(corpus_index) .. ';'
  html[#html+1] = 'const CODE_COLORS = '    .. to_json(code_colors)  .. ';'
  html[#html+1] = 'const CODEBOOK_TREE = '  .. to_json(active_tree)  .. ';'
  html[#html+1] = 'const COOC_DATA = '      .. to_json(cooc_summary) .. ';'
  html[#html+1] = 'const ALIGN_CONFIG = '   .. to_json({
    ollama_url  = S(config.ollama.url),
    ollama_model = S(config.ollama.model),
    num_ctx     = N(config.ollama.num_ctx),
    server_port = N(config.server.port),
    scheme_path = SCHEME_JSON,
    json_dir    = JSON_DIR,
    max_pairs   = N(config.candidates.max_pairs),
    max_cross   = N(config.candidates.max_cross_category),
  }) .. ';'
  html[#html+1] = '</script>'
  html[#html+1] = '<script>' .. shared_js .. '</script>'
  html[#html+1] = '<script>' .. js_content .. '</script>'
  html[#html+1] = '<div id="qc-align-root"></div>'
  html[#html+1] = '</body></html>'

    return table.concat(html, "\n")
end

function Pandoc(doc)
  print("qc-align: filter running, output=" .. OUTPUT_PATH)
  local html = generate_html()
  local dir = OUTPUT_PATH:match("^(.+)/[^/]+$")
  if dir then os.execute("mkdir -p \"" .. dir .. "\"") end
  local f = io.open(OUTPUT_PATH, "w")
  if f then
    f:write(html); f:close()
    print("qc-align: wrote " .. OUTPUT_PATH)
  else
    print("ERROR: could not write to " .. OUTPUT_PATH)
  end
  return doc
end