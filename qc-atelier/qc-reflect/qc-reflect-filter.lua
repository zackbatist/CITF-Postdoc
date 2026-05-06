-- qc-reflect-filter.lua
-- Bakes codebook tree, documentation, corpus index, and co-occurrence data
-- into qc/qc-reflect.html for LLM-assisted code system reflection.

-- ── Shared helpers ─────────────────────────────────────────────────────────────
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

-- ── Config ─────────────────────────────────────────────────────────────────────

local function get_project_root()
  local script = os.getenv("PANDOC_SCRIPT_FILE") or ""
  local root = script:match("^(.*)/qc-atelier/qc-reflect/[^/]+$")
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
  local cfg_file = os.getenv("QC_ATELIER_CONFIG") or project_path("qc-atelier/qc-atelier-config.yaml")
  local cfg = {
    directories = {
      json_dir    = "qc/json",
      output_dir  = "qc",
    },
    ollama = {
      url     = "http://localhost:11434",
      model   = "qwen3.5:35b",
      naming_model = "qwen2.5:1.5b",
      num_ctx = 49152,
    },
    reflect = {
      max_excerpts_per_code = 20,
    },
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
    print("qc-reflect: loaded config from " .. cfg_file)
  end
  return cfg
end

local config      = load_config()
local OUTPUT_PATH = project_path(S(config.directories.output_dir) .. "/qc-reflect.html")
local CODEBOOK_PATH   = project_path(S(config.directories.output_dir) .. "/codebook.yaml")
local SCHEME_JSON     = project_path(S(config.directories.output_dir) .. "/codebook.json")
local JSON_DIR        = project_path(S(config.directories.json_dir))
local CSS_FILE        = project_path("qc-atelier/qc-reflect/qc-reflect.css")
local SHARED_CSS_FILE = project_path("qc-atelier/shared/qc-shared.css")
local SHARED_JS_FILE  = project_path("qc-atelier/shared/qc-shared.js")
local JS_FILE         = project_path("qc-atelier/qc-reflect/qc-reflect.js")

-- ── Codebook loader ────────────────────────────────────────────────────────────

local function load_codebook_tree()
  print("qc-reflect: reading codebook from " .. CODEBOOK_PATH)
  local f = io.open(CODEBOOK_PATH, "r")
  if not f then print("qc-reflect: WARNING could not open " .. CODEBOOK_PATH); return {} end
  local text = f:read("*all"); f:close()
  local raw_nodes = parse_codebook_yaml(text)
  local nodes     = flatten_codebook(raw_nodes, nil, 0)
  print(string.format("qc-reflect: codebook tree — %d nodes", #nodes))
  return nodes
end

-- ── Corpus index ───────────────────────────────────────────────────────────────
-- Builds per-code excerpts and co-occurrence data from JSON exports.
-- Excerpt format: { doc, line, text }
-- Citation format expected by JS: [DocName:LineNum]

local function build_corpus_index(json_files)
  local excerpts    = {}   -- code -> [{doc, line, text}]
  local by_doc_code = {}   -- doc  -> {code -> true}
  local doc_order   = {}

  local max_ex = N(config.reflect.max_excerpts_per_code)
  if max_ex == 0 then max_ex = 20 end

  for _, jf in ipairs(json_files) do
    local data = read_json_file(jf)
    if data then
      for _, entry in ipairs(data) do
        local code = entry.code
        local doc  = (entry.document or jf:match("([^/]+)%.json$") or jf)
                       :gsub("^.*/", ""):gsub("%.txt$", "")
        local line = entry.line or 0
        local text = entry.text or
                     (entry.text_lines and table.concat(entry.text_lines, " ")) or ""
        if code and code ~= "" then
          if not excerpts[code] then excerpts[code] = {} end
          if #excerpts[code] < max_ex then
            excerpts[code][#excerpts[code]+1] = { doc = doc, line = line, text = text }
          end
          if not by_doc_code[doc] then
            by_doc_code[doc] = {}
            doc_order[#doc_order+1] = doc
          end
          by_doc_code[doc][code] = true
        end
      end
    end
  end

  table.sort(doc_order)

  -- Co-occurrence: code pairs sharing documents
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

  -- Flatten co-occurrence to sorted list
  local cooc_list = {}
  for a, partners in pairs(cooc) do
    for b, shared in pairs(partners) do
      cooc_list[#cooc_list+1] = {
        code_a = a, code_b = b, shared_docs = shared,
        total_a = excerpts[a] and #excerpts[a] or 0,
        total_b = excerpts[b] and #excerpts[b] or 0,
      }
    end
  end
  table.sort(cooc_list, function(x, y) return x.shared_docs > y.shared_docs end)

  -- Corpus index per code
  local corpus_index = {}
  local all_codes = {}
  for code, exs in pairs(excerpts) do
    all_codes[#all_codes+1] = code
    corpus_index[code] = {
      total    = #exs,
      excerpts = exs,
    }
  end
  table.sort(all_codes)

  return corpus_index, cooc_list, all_codes, doc_order, by_doc_code
end

-- ── Generate HTML ──────────────────────────────────────────────────────────────

local function generate_html()
  local json_files = get_json_files(JSON_DIR)
  if #json_files == 0 then
    print("qc-reflect: WARNING no JSON files in " .. JSON_DIR)
  end

  local tree                                            = load_codebook_tree()
  local use_counts                                      = build_use_counts(json_files)
  local corpus_index, cooc_list, all_codes, doc_order, by_doc_code = build_corpus_index(json_files)

  -- Build doc-code matrix: doc -> [code, code, ...]
  local doc_code_matrix = {}
  for doc, codes in pairs(by_doc_code) do
    local code_list = {}
    for code, _ in pairs(codes) do
      code_list[#code_list+1] = code
    end
    table.sort(code_list)
    doc_code_matrix[doc] = code_list
  end

  local shared_css = read_text_file(SHARED_CSS_FILE)
  local css        = read_text_file(CSS_FILE)
  local shared_js  = read_text_file(SHARED_JS_FILE)
  local js         = read_text_file(JS_FILE)

  -- Annotate tree with use counts
  for _, node in ipairs(tree) do
    local uc = use_counts[node.name]
    node.uses = uc and uc.total or 0
  end

  local html = {}
  html[#html+1] = '<!DOCTYPE html><html lang="en"><head>'
  html[#html+1] = '<meta charset="UTF-8">'
  html[#html+1] = '<meta name="viewport" content="width=device-width,initial-scale=1">'
  html[#html+1] = '<title>QC Reflect</title>'
  html[#html+1] = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">'
  html[#html+1] = '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>'
  html[#html+1] = '<style>' .. shared_css .. '\n' .. css .. '</style>'
  html[#html+1] = '</head><body>'
  html[#html+1] = '<nav class="qc-nav"><a class="qc-nav-brand" href="/">qc-atelier</a>'
    .. '<a href="/qc-scheme.html">scheme</a>'
    .. '<a href="/qc-viz.html">viz</a>'
    .. '<a href="/qc-refactor.html">refactor</a>'
    .. '<a href="/qc-reflect.html" class="active">reflect</a></nav>'
  html[#html+1] = '<script>'
  html[#html+1] = 'const CODEBOOK_TREE  = ' .. to_json(tree)             .. ';'
  html[#html+1] = 'const CORPUS_INDEX   = ' .. to_json(corpus_index)     .. ';'
  html[#html+1] = 'const COOC_DATA      = ' .. to_json(cooc_list)        .. ';'
  html[#html+1] = 'const ALL_CODES      = ' .. to_json(all_codes)        .. ';'
  html[#html+1] = 'const DOC_NAMES      = ' .. to_json(doc_order)        .. ';'
  html[#html+1] = 'const DOC_CODE_MATRIX = ' .. to_json(doc_code_matrix) .. ';'
  
  -- Export code colours and schema
  local code_schema  = config.code_schema or {}
  local colors_raw   = code_schema.colors or {}
  local default_color = code_schema.default_color or "#757575"
  html[#html+1] = 'const CODE_COLORS = ' .. to_json(colors_raw) .. ';'
  html[#html+1] = 'const CODE_SCHEMA = ' .. to_json({default_color = default_color}) .. ';'

html[#html+1] = 'const REFLECT_CONFIG = ' .. to_json({
    ollama_url    = S(config.ollama.url),
    ollama_model  = S(config.ollama.model),
    naming_model  = S(config.ollama.naming_model),
    num_ctx       = N(config.ollama.num_ctx),
    server_port   = N(config.server.port),
    scheme_path   = SCHEME_JSON,
  }) .. ';'
  html[#html+1] = '</script>'
  html[#html+1] = '<script>' .. shared_js .. '</script>'
  html[#html+1] = '<div id="qc-reflect-root"></div>'
  

  html[#html+1] = '<script>' .. js .. '</script>'
  html[#html+1] = '</body></html>'

  return table.concat(html, "\n")
end

function Pandoc(doc)
  print("qc-reflect: filter running, output=" .. OUTPUT_PATH)
  local html = generate_html()
  local dir = OUTPUT_PATH:match("^(.+)/[^/]+$")
  if dir then os.execute("mkdir -p \"" .. dir .. "\"") end
  local f = io.open(OUTPUT_PATH, "w")
  if f then
    f:write(html); f:close()
    print("qc-reflect: wrote " .. OUTPUT_PATH)
  else
    print("ERROR: could not write " .. OUTPUT_PATH)
  end
  return doc
end
