-- qc-reflect-filter.lua
-- Reads qc/json/*.json and codebook.yaml at render time.
-- Bakes corpus excerpts, co-occurrence data, and a structured codebook tree
-- into qc/qc-reflect.html for LLM-driven thematic overlap analysis.

-- ── YAML / config helpers ─────────────────────────────────────────────────────

local function read_yaml_file(filepath)
  local file = io.open(filepath, "r")
  if not file then return nil end
  local content = file:read("*all")
  file:close()
  local success, result = pcall(function()
    local doc = pandoc.read("---\n" .. content .. "\n---", "markdown")
    return doc.meta
  end)
  return (success and result) and result or nil
end

local function meta_to_lua(v)
  if not v then return nil end
  if type(v) == "string" or type(v) == "number" or type(v) == "boolean" then return v end
  if type(v) == "table" then
    if v.t == "MetaString" or v.t == "MetaInlines" then return pandoc.utils.stringify(v) end
    if v.t == "MetaBool" then return v.c ~= nil and v.c or v end
    if v.t == "MetaList" then
      local r = {}; for i, x in ipairs(v) do r[i] = meta_to_lua(x) end; return r
    end
    if v.t == "MetaMap" then
      local r = {}; for k, x in pairs(v) do r[k] = meta_to_lua(x) end; return r
    end
    local r = {}
    for k, x in pairs(v) do
      if type(k) == "number" then r[k] = meta_to_lua(x)
      elseif type(k) == "string" and k ~= "t" and k ~= "c" then r[k] = meta_to_lua(x) end
    end
    if next(r) then return r end
    return pandoc.utils.stringify(v)
  end
  return pandoc.utils.stringify(v)
end

local function load_config()
  local cfg_file = os.getenv("QC_REFLECT_CONFIG") or "qc-reflect-config.yaml"
  local cfg = {
    directories = {
      json_dir    = "qc/json",
      output_dir  = "qc",
      logs_dir    = "reflect-logs",
    },
    files = {
      output_file = "qc-reflect.html",
      css_file    = "assets/scripts/qc-reflect/qc-reflect.css",
      js_file     = "assets/scripts/qc-reflect/qc-reflect.js",
      codebook    = "qc/codebook.yaml",
    },
    ollama = {
      url     = "http://localhost:11434",
      model   = "qwen2.5:14b",
      num_ctx = 32768,
    },
    candidates = {
      max_pairs             = 40,
      max_cross_category    = 20,
      max_excerpts_per_code = 20,
    },
    code_schema = { categories = {}, colors = {}, default_color = "#757575" },
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

local config = load_config()

local function S(v)
  if type(v) == "table" then return pandoc.utils.stringify(v) end
  return tostring(v or "")
end
local function N(v)
  if type(v) == "table" then return tonumber(pandoc.utils.stringify(v)) or 0 end
  return tonumber(v) or 0
end

local json_dir    = S(config.directories.json_dir)
local output_dir  = S(config.directories.output_dir)
local logs_dir    = output_dir .. "/" .. S(config.directories.logs_dir)
local output_path = output_dir .. "/" .. S(config.files.output_file)

-- ── File helpers ──────────────────────────────────────────────────────────────

local function read_text_file(path)
  local f = io.open(path, "r")
  if not f then print("ERROR: cannot open " .. path); return "" end
  local c = f:read("*all"); f:close(); return c
end

local function get_json_files(dir)
  local files = {}
  local h = io.popen("find " .. dir .. " -name '*.json' 2>/dev/null | sort")
  if h then for f in h:lines() do files[#files+1] = f end; h:close() end
  return files
end

local function read_json_file(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local raw = f:read("*all"); f:close()
  local ok, data = pcall(function() return pandoc.json.decode(raw) end)
  return ok and data or nil
end

local function ensure_dir(path)
  os.execute("mkdir -p " .. path)
end

-- ── JSON serialiser ───────────────────────────────────────────────────────────

local function js_safe(s)
  return s:gsub("\\", "\\\\")
          :gsub('"',  '\\"')
          :gsub("\n", "\\n")
          :gsub("\r", "\\r")
          :gsub("\t", "\\t")
          :gsub("</", "<\\/")
end

local function to_json(v)
  if v == nil     then return "null" end
  local t = type(v)
  if t == "boolean" then return v and "true" or "false" end
  if t == "number"  then return tostring(v) end
  if t == "string"  then return '"' .. js_safe(v) .. '"' end
  if t == "table"   then
    -- Determine if this is a sequence (all keys are consecutive integers from 1)
    local n = 0
    local is_seq = true
    for k, _ in pairs(v) do
      if type(k) ~= "number" then is_seq = false; break end
      n = n + 1
    end
    -- Also check keys are 1..n with no gaps
    if is_seq and n > 0 then
      for i = 1, n do
        if v[i] == nil then is_seq = false; break end
      end
    end
    if is_seq then
      local parts = {}
      for i = 1, n do parts[i] = to_json(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    else
      local parts = {}
      for k, x in pairs(v) do
        parts[#parts+1] = '"' .. js_safe(tostring(k)) .. '":' .. to_json(x)
      end
      -- Empty table → always emit [] not {} (JS needs arrays for CODEBOOK_TREE etc)
      if #parts == 0 then return "[]" end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  end
  return "null"
end

-- ── Codebook tree parser ──────────────────────────────────────────────────────
-- Walks the nested YAML list and produces flat nodes:
--   { name, parent, depth, prefix, children:[name,...], uses }

local function parse_codebook_tree(data, parent, depth, nodes, parent_children)
  if type(data) ~= "table" then return end
  depth = depth or 0
  for _, item in ipairs(data) do
    if type(item) == "string" then
      local name   = item
      local prefix = name:match("^(%d%d)_") or ""
      nodes[#nodes+1] = {
        name = name, parent = parent or "", depth = depth,
        prefix = prefix, children = {},
      }
      if parent and parent_children[parent] then
        parent_children[parent][#parent_children[parent]+1] = name
      end
    elseif type(item) == "table" then
      for key, children in pairs(item) do
        if type(key) == "string" then
          local name   = key
          local prefix = name:match("^(%d%d)_") or ""
          local my_ch  = {}
          nodes[#nodes+1] = {
            name = name, parent = parent or "", depth = depth,
            prefix = prefix, children = my_ch,
          }
          parent_children[name] = my_ch
          if parent and parent_children[parent] then
            parent_children[parent][#parent_children[parent]+1] = name
          end
          if type(children) == "table" then
            parse_codebook_tree(children, name, depth + 1, nodes, parent_children)
          end
        end
      end
    end
  end
end

local function load_codebook_tree()
  local path = S(config.files.codebook)
  local raw  = read_yaml_file(path)
  if not raw then print("WARNING: could not read codebook from " .. path); return {} end
  local data = meta_to_lua(raw)
  if not data then return {} end
  -- Top level is either a list or a single-key map wrapping a list
  local list = data
  if type(data) == "table" and not data[1] then
    for _, v in pairs(data) do list = v; break end
  end
  local nodes = {}
  local parent_children = {}
  parse_codebook_tree(list, nil, 0, nodes, parent_children)
  print(string.format("qc-reflect: parsed codebook — %d nodes", #nodes))
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
  local json_files = get_json_files(json_dir)
  if #json_files == 0 then print("WARNING: No JSON files found in " .. json_dir) end

  ensure_dir(logs_dir)

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

  print(string.format("qc-reflect: %d docs, %d active codes, %d tree nodes, %d cooc pairs",
    #doc_order, #all_codes, #active_tree, #cooc_summary))

  local css_content = read_text_file(S(config.files.css_file))
  local js_content  = read_text_file(S(config.files.js_file))

  local html = {}
  html[#html+1] = '<!DOCTYPE html><html lang="en"><head>'
  html[#html+1] = '<meta charset="UTF-8">'
  html[#html+1] = '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
  html[#html+1] = '<title>QC Reflection</title>'
  html[#html+1] = '<style>' .. css_content .. '</style>'
  html[#html+1] = '</head><body>'
  html[#html+1] = '<script>'
  html[#html+1] = 'const DOC_NAMES = '      .. to_json(doc_order)    .. ';'
  html[#html+1] = 'const ALL_CODES = '      .. to_json(all_codes)    .. ';'
  html[#html+1] = 'const CORPUS_INDEX = '   .. to_json(corpus_index) .. ';'
  html[#html+1] = 'const CODE_COLORS = '    .. to_json(code_colors)  .. ';'
  html[#html+1] = 'const CODEBOOK_TREE = '  .. to_json(active_tree)  .. ';'
  html[#html+1] = 'const COOC_DATA = '      .. to_json(cooc_summary) .. ';'
  html[#html+1] = 'const REFLECT_CONFIG = ' .. to_json({
    ollama_url      = S(config.ollama.url),
    ollama_model    = S(config.ollama.model),
    num_ctx         = N(config.ollama.num_ctx),
    logs_dir        = S(config.directories.logs_dir),
    log_server_port = N(config.server.port),
    max_pairs       = N(config.candidates.max_pairs),
    max_cross       = N(config.candidates.max_cross_category),
  }) .. ';'
  html[#html+1] = '</script>'
  html[#html+1] = '<script>' .. js_content .. '</script>'
  html[#html+1] = '<div id="qc-reflect-root"></div>'
  html[#html+1] = '</body></html>'

  return table.concat(html, "\n")
end

function Pandoc(doc)
  local html = generate_html()
  local f = io.open(output_path, "w")
  if f then
    f:write(html); f:close()
    print("qc-reflect: wrote " .. output_path)
  else
    print("ERROR: could not write to " .. output_path)
  end
  return doc
end
