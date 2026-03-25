-- qc-scheme-filter.lua
-- Bakes codebook.yaml + codebook.json + corpus excerpts
-- into qc/qc-scheme.html at render time.

local function read_yaml_file(filepath)
  local file = io.open(filepath, "r")
  if not file then return nil end
  local content = file:read("*all"); file:close()
  local ok, result = pcall(function()
    local doc = pandoc.read("---\n" .. content .. "\n---", "markdown")
    return doc.meta
  end)
  return (ok and result) and result or nil
end

-- Parse codebook.yaml directly from raw text.
-- codebook.yaml is a bare YAML list/tree; Pandoc's meta parser can mangle it.
-- This parser handles the actual format: indented "- key:" and "- value" lines.
local function parse_codebook_yaml(text)
  local root = {}
  local stack = { { list = root, indent = -1 } }

  local function current() return stack[#stack] end

  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    -- Skip blank lines and comments
    if line:match("^%s*$") or line:match("^%s*#") then goto continue end

    local indent = #line:match("^(%s*)")
    local item   = line:match("^%s*-%s+(.-)%s*$")  -- "- something"
    local kv     = item and item:match("^([^:]+):%s*(.-)%s*$")  -- "key: value" or "key:"

    if item then
      -- Pop stack to correct indent level
      while #stack > 1 and indent <= current().indent do
        table.remove(stack)
      end

      if kv then
        -- "- ParentCode:" or "- ParentCode: value" — treat as parent node
        local key = item:match("^([^:]+):")
        local node = { _key = key, _children = {}, _indent = indent }
        local parent_list = current().list
        parent_list[#parent_list + 1] = node
        -- Push this node's children list onto the stack
        stack[#stack + 1] = { list = node._children, indent = indent }
      else
        -- "- LeafCode" — leaf node
        current().list[#current().list + 1] = { _key = item, _children = {}, _indent = indent }
      end
    end

    ::continue::
  end

  return root
end

local function flatten_codebook(nodes, parent, depth, result)
  depth = depth or 0
  result = result or {}
  for _, node in ipairs(nodes) do
    if type(node) == "table" and node._key then
      local name   = node._key
      local prefix = name:match("^(%d%d)_") or ""
      result[#result + 1] = {
        name     = name,
        parent   = parent or "",
        depth    = depth,
        prefix   = prefix,
        children = {},
      }
      if node._children and #node._children > 0 then
        flatten_codebook(node._children, name, depth + 1, result)
      end
    end
  end
  return result
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

local function S(v)
  if type(v) == "table" then return pandoc.utils.stringify(v) end
  return tostring(v or "")
end

local function N(v)
  if type(v) == "table" then return tonumber(pandoc.utils.stringify(v)) or 0 end
  return tonumber(v) or 0
end

-- ── Config ────────────────────────────────────────────────────────────────────

-- Resolve the project root from this filter's own path.
-- PANDOC_SCRIPT_FILE is set by Pandoc to the filter's absolute path.
local function get_project_root()
  local script = os.getenv("PANDOC_SCRIPT_FILE") or ""
  -- filter is at <root>/assets/scripts/qc-scheme/qc-scheme-filter.lua
  -- so go up 3 levels
  local root = script:match("^(.*)/assets/scripts/qc%-codebook%-docs/[^/]+$")
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

-- These paths are always relative to project root, never from shared config:
local OUTPUT_PATH     = project_path("qc/qc-scheme.html")
local CODEBOOK_PATH   = project_path(S(config.directories.output_dir) .. "/codebook.yaml")
local SCHEME_JSON = project_path(S(config.directories.output_dir) .. "/codebook.json")
local JSON_DIR        = project_path(S(config.directories.json_dir))
local CSS_FILE        = project_path("assets/scripts/qc-scheme/qc-scheme.css")
local JS_FILE         = project_path("assets/scripts/qc-scheme/qc-scheme.js")

-- ── File helpers ──────────────────────────────────────────────────────────────

local function read_text_file(path)
  local f = io.open(path, "r")
  if not f then return "" end
  local c = f:read("*all"); f:close(); return c
end

local function get_json_files(dir)
  local files = {}
  local h = io.popen("find " .. dir .. " -name '*.json' 2>/dev/null | sort")
  if h then for f in h:lines() do files[#files+1] = f end; h:close() end
  return files
end

local function read_json_file(path)
  local f = io.open(path, "r"); if not f then return nil end
  local raw = f:read("*all"); f:close()
  local ok, data = pcall(function() return pandoc.json.decode(raw) end)
  return ok and data or nil
end

-- ── JSON serialiser ───────────────────────────────────────────────────────────

local function js_safe(s)
  return s:gsub("\\","\\\\"):gsub('"','\\"'):gsub("\n","\\n")
          :gsub("\r","\\r"):gsub("\t","\\t"):gsub("</","\\/")
end

local function to_json(v)
  if v == nil then return "null" end
  local t = type(v)
  if t == "boolean" then return v and "true" or "false" end
  if t == "number"  then return tostring(v) end
  if t == "string"  then return '"' .. js_safe(v) .. '"' end
  if t == "table"   then
    -- Detect sequence
    local n, is_seq = 0, true
    for k, _ in pairs(v) do
      if type(k) ~= "number" then is_seq = false; break end
      n = n + 1
    end
    if is_seq and n > 0 then
      for i = 1, n do if v[i] == nil then is_seq = false; break end end
    end
    if is_seq and n == 0 then
      -- empty table — check if caller intends object or array; default to array
      -- for DOCS_DATA.codes we override below, so this is fine for tree/counts
      return "[]"
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
      if #parts == 0 then return "[]" end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  end
  return "null"
end

-- ── Codebook tree parser ──────────────────────────────────────────────────────

local function parse_tree(data, parent, depth, nodes, parent_ch)
  if type(data) ~= "table" then return end
  depth = depth or 0
  for _, item in ipairs(data) do
    if type(item) == "string" then
      local name = item
      nodes[#nodes+1] = { name=name, parent=parent or "", depth=depth,
                           prefix=name:match("^(%d%d)_") or "", children={} }
      if parent and parent_ch[parent] then
        parent_ch[parent][#parent_ch[parent]+1] = name
      end
    elseif type(item) == "table" then
      for key, children in pairs(item) do
        if type(key) == "string" then
          local name = key
          local my_ch = {}
          nodes[#nodes+1] = { name=name, parent=parent or "", depth=depth,
                               prefix=name:match("^(%d%d)_") or "", children=my_ch }
          parent_ch[name] = my_ch
          if parent and parent_ch[parent] then
            parent_ch[parent][#parent_ch[parent]+1] = name
          end
          if type(children) == "table" then
            parse_tree(children, name, depth+1, nodes, parent_ch)
          end
        end
      end
    end
  end
end

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

-- ── Corpus excerpt index (for auto-suggesting examples) ───────────────────────

-- Corpus use counts only (not full text — excerpts fetched on demand via server)
local function build_use_counts(json_files)
  local counts = {}  -- code -> total uses
  local by_doc = {}  -- code -> set of docs
  for _, jf in ipairs(json_files) do
    local data = read_json_file(jf)
    if data then
      for _, entry in ipairs(data) do
        local code = entry.code
        local doc  = (entry.document or jf:match("([^/]+)%.json$") or jf)
                       :gsub("^.*/",""):gsub("%.txt$","")
        if code and code ~= "" then
          counts[code] = (counts[code] or 0) + 1
          if not by_doc[code] then by_doc[code] = {} end
          by_doc[code][doc] = true
        end
      end
    end
  end
  -- Convert doc sets to sorted lists
  local result = {}
  for code, n in pairs(counts) do
    local docs = {}
    for d, _ in pairs(by_doc[code]) do docs[#docs+1] = d end
    table.sort(docs)
    result[code] = { total = n, docs = docs }
  end
  return result
end

-- ── Generate HTML ─────────────────────────────────────────────────────────────

local function generate_html()
  local json_files = get_json_files(JSON_DIR)
  local tree       = load_codebook_tree()
  local use_counts = build_use_counts(json_files)
  -- DOCS_DATA is intentionally empty here — loadDocs() fetches live data
  -- from the server on page load, so the baked value is just a fallback.

  local css = read_text_file(CSS_FILE)
  local js  = read_text_file(JS_FILE)

  local html = {}
  html[#html+1] = '<!DOCTYPE html><html lang="en"><head>'
  html[#html+1] = '<meta charset="UTF-8">'
  html[#html+1] = '<meta name="viewport" content="width=device-width,initial-scale=1">'
  html[#html+1] = '<title>QC Scheme</title>'
  html[#html+1] = '<style>' .. css .. '</style>'
  html[#html+1] = '</head><body>'
  html[#html+1] = '<script>'
  html[#html+1] = 'const CODEBOOK_TREE = ' .. to_json(tree)       .. ';'
  html[#html+1] = 'const CORPUS_COUNTS = ' .. to_json(use_counts) .. ';'
  html[#html+1] = 'const ALL_CODES = '     .. to_json({})         .. ';'
  html[#html+1] = 'const DOCS_DATA = {"codes":{}};'
  html[#html+1] = 'const DOCS_CONFIG = '   .. to_json({
    server_port        = N(config.server.port),
    scheme_path = SCHEME_JSON,
    json_dir           = JSON_DIR,
  }) .. ';'
  html[#html+1] = '</script>'
  html[#html+1] = '<script>' .. js .. '</script>'
  html[#html+1] = '<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>'
  html[#html+1] = '<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js"></script>'
  html[#html+1] = '<div id="qc-scheme-root"></div>'
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
