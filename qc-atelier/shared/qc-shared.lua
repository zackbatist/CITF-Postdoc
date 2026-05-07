-- qc-shared.lua
-- Shared Lua helpers for qc-atelier filters.
-- Loaded at render time via dofile(); not a runtime dependency.
--
-- Load from a filter with:
--   local shared_path = (os.getenv("PANDOC_SCRIPT_FILE") or "")
--     :gsub("/assets/scripts/[^/]+/[^/]+$", "") .. "/assets/scripts/shared/qc-shared.lua"
--   local shared = dofile(shared_path)

local M = {}

-- ── YAML / meta helpers ───────────────────────────────────────────────────────

-- Read a YAML file using Pandoc's built-in parser.
-- Returns Pandoc meta on success, nil on failure.
function M.read_yaml_file(filepath)
  local file = io.open(filepath, "r")
  if not file then return nil end
  local content = file:read("*all"); file:close()
  local ok, result = pcall(function()
    local doc = pandoc.read("---\n" .. content .. "\n---", "markdown")
    return doc.meta
  end)
  return (ok and result) and result or nil
end

-- Recursively convert Pandoc MetaValue types to plain Lua values.
function M.meta_to_lua(v)
  if not v then return nil end
  if type(v) == "string" or type(v) == "number" or type(v) == "boolean" then return v end
  if type(v) == "table" then
    if v.t == "MetaString" or v.t == "MetaInlines" then return pandoc.utils.stringify(v) end
    if v.t == "MetaBool" then return v.c ~= nil and v.c or v end
    if v.t == "MetaList" then
      local r = {}; for i, x in ipairs(v) do r[i] = M.meta_to_lua(x) end; return r
    end
    if v.t == "MetaMap" then
      local r = {}; for k, x in pairs(v) do r[k] = M.meta_to_lua(x) end; return r
    end
    local r = {}
    for k, x in pairs(v) do
      if type(k) == "number" then r[k] = M.meta_to_lua(x)
      elseif type(k) == "string" and k ~= "t" and k ~= "c" then r[k] = M.meta_to_lua(x) end
    end
    if next(r) then return r end
    return pandoc.utils.stringify(v)
  end
  return pandoc.utils.stringify(v)
end

-- Coerce a Pandoc meta value (or plain value) to string.
function M.S(v)
  if type(v) == "table" then return pandoc.utils.stringify(v) end
  return tostring(v or "")
end

-- Coerce a Pandoc meta value (or plain value) to number.
function M.N(v)
  if type(v) == "table" then return tonumber(pandoc.utils.stringify(v)) or 0 end
  return tonumber(v) or 0
end

-- ── File helpers ──────────────────────────────────────────────────────────────

function M.read_text_file(path)
  local f = io.open(path, "r")
  if not f then return "" end
  local c = f:read("*all"); f:close(); return c
end

function M.get_json_files(dir)
  local files = {}
  local h = io.popen("find " .. dir .. " -name '*.json' 2>/dev/null | sort")
  if h then for f in h:lines() do files[#files+1] = f end; h:close() end
  return files
end

function M.read_json_file(path)
  local f = io.open(path, "r"); if not f then return nil end
  local raw = f:read("*all"); f:close()
  local ok, data = pcall(function() return pandoc.json.decode(raw) end)
  return ok and data or nil
end

-- ── JSON serialiser ───────────────────────────────────────────────────────────

function M.js_safe(s)
  return s:gsub("\\","\\\\"):gsub('"','\\"'):gsub("\n","\\n")
          :gsub("\r","\\r"):gsub("\t","\\t"):gsub("</","\\/")
end

function M.to_json(v)
  if v == nil then return "null" end
  local t = type(v)
  if t == "boolean" then return v and "true" or "false" end
  if t == "number"  then return tostring(v) end
  if t == "string"  then return '"' .. M.js_safe(v) .. '"' end
  if t == "table"   then
    local n, is_seq = 0, true
    for k, _ in pairs(v) do
      if type(k) ~= "number" then is_seq = false; break end
      n = n + 1
    end
    if is_seq and n > 0 then
      for i = 1, n do if v[i] == nil then is_seq = false; break end end
    end
    if is_seq and n == 0 then return "[]" end
    if is_seq then
      local parts = {}
      for i = 1, n do parts[i] = M.to_json(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    else
      local parts = {}
      for k, x in pairs(v) do
        parts[#parts+1] = '"' .. M.js_safe(tostring(k)) .. '":' .. M.to_json(x)
      end
      if #parts == 0 then return "[]" end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  end
  return "null"
end

-- ── Codebook YAML parser ──────────────────────────────────────────────────────
-- Handles qc's bare list YAML format, which Pandoc's meta parser mangles.
-- Input: raw text of codebook.yaml
-- Output: nested Lua table (list of {_key, _children, _indent} nodes)

function M.parse_codebook_yaml(text)
  local root = {}
  local stack = { { list = root, indent = -1 } }

  local function current() return stack[#stack] end

  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    if line:match("^%s*$") or line:match("^%s*#") then goto continue end

    local indent = #line:match("^(%s*)")
    local item   = line:match("^%s*-%s+(.-)%s*$")
    local kv     = item and item:match("^([^:]+):%s*(.-)%s*$")

    if item then
      while #stack > 1 and indent <= current().indent do
        table.remove(stack)
      end

      if kv then
        local key = item:match("^([^:]+):")
        local node = { _key = key, _children = {}, _indent = indent }
        local parent_list = current().list
        parent_list[#parent_list + 1] = node
        stack[#stack + 1] = { list = node._children, indent = indent }
      else
        current().list[#current().list + 1] = { _key = item, _children = {}, _indent = indent }
      end
    end

    ::continue::
  end

  return root
end

-- Flatten the nested codebook tree into a list of
-- {name, parent, depth, prefix, children} records.
function M.flatten_codebook(nodes, parent, depth, result)
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
        M.flatten_codebook(node._children, name, depth + 1, result)
      end
    end
  end
  return result
end

-- ── Corpus use counts ─────────────────────────────────────────────────────────
-- Counts per-code occurrences across all corpus JSON files.
-- Returns {code -> {total=N, docs=[...]}}

function M.build_use_counts(json_files)
  local counts = {}
  local by_doc = {}
  for _, jf in ipairs(json_files) do
    local data = M.read_json_file(jf)
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
  local result = {}
  for code, n in pairs(counts) do
    local docs = {}
    for d, _ in pairs(by_doc[code]) do docs[#docs+1] = d end
    table.sort(docs)
    result[code] = { total = n, docs = docs }
  end
  return result
end


-- ── Code colour assignment ────────────────────────────────────────────────────
-- Derives CODE_COLORS from the codebook tree and a palette.
-- Assigns one palette colour per unique two-digit prefix, in sort order.
-- Returns a table: {["10"] = "#2196F3", ["30"] = "#9C27B0", ...}

function M.build_code_colors(nodes, palette, default_color)
  palette      = palette      or {}
  default_color = default_color or "#757575"

  -- Collect unique two-digit prefixes in sort order
  local seen    = {}
  local prefixes = {}
  for _, node in ipairs(nodes) do
    local prefix = (node.name or ""):match("^(%d%d)_")
    if prefix and not seen[prefix] then
      seen[prefix] = true
      prefixes[#prefixes + 1] = prefix
    end
  end
  table.sort(prefixes)

  -- Assign palette colours round-robin
  local colors = {}
  for i, prefix in ipairs(prefixes) do
    colors[prefix] = palette[((i - 1) % #palette) + 1] or default_color
  end
  return colors
end

return M
