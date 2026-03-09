-- qc-audit-filter.lua
-- Lua filter for qc-audit: reads per-document JSON exports and codebook.yaml,
-- computes corpus-wide statistics, and writes qc/qc-audit.html
-- Place in: assets/scripts/qc-audit/qc-audit-filter.lua

-- ── YAML helpers (copied from qc-viz-filter.lua) ─────────────────────────────

local function read_yaml_file(filepath)
  local file = io.open(filepath, "r")
  if not file then return nil end
  local content = file:read("*all")
  file:close()
  local success, result = pcall(function()
    local doc = pandoc.read("---\n" .. content .. "\n---", "markdown")
    return doc.meta
  end)
  if success and result then return result else return nil end
end

local function meta_to_lua(meta_value)
  if not meta_value then return nil end
  if type(meta_value) == "string" or type(meta_value) == "number" or type(meta_value) == "boolean" then
    return meta_value
  end
  if type(meta_value) == "table" then
    if meta_value.t == "MetaString" or meta_value.t == "MetaInlines" then
      return pandoc.utils.stringify(meta_value)
    elseif meta_value.t == "MetaBool" then
      return meta_value.c or meta_value
    elseif meta_value.t == "MetaList" then
      local result = {}
      for i, v in ipairs(meta_value) do result[i] = meta_to_lua(v) end
      return result
    elseif meta_value.t == "MetaMap" then
      local result = {}
      for k, v in pairs(meta_value) do result[k] = meta_to_lua(v) end
      return result
    else
      local result = {}
      for k, v in pairs(meta_value) do
        if type(k) == "number" then
          result[k] = meta_to_lua(v)
        elseif type(k) == "string" and k ~= "t" and k ~= "c" then
          result[k] = meta_to_lua(v)
        end
      end
      return result
    end
  end
  return pandoc.utils.stringify(meta_value)
end

-- ── Config ────────────────────────────────────────────────────────────────────

local config = {
  qc_dir       = os.getenv("QC_DIR")        or "qc",
  json_dir     = os.getenv("QC_JSON_DIR")   or "qc/json",
  output_dir   = os.getenv("QC_OUTPUT_DIR") or "qc",
  output_file  = "qc-audit.html",
  codebook     = os.getenv("QC_CODEBOOK")   or "qc/codebook.yaml",
  js_file      = "assets/scripts/qc-audit/qc-audit.js",
  css_file     = "assets/scripts/qc-audit/qc-audit.css",
  ollama_model = os.getenv("QC_AUDIT_MODEL") or "qwen2.5:7b",
  ollama_url   = os.getenv("OLLAMA_URL")     or "http://localhost:11434",
}

local output_path = config.output_dir .. "/" .. config.output_file

-- ── File helpers ──────────────────────────────────────────────────────────────

local function read_text_file(filepath)
  local file = io.open(filepath, "r")
  if not file then print("ERROR: Cannot open " .. filepath); return "" end
  local content = file:read("*all")
  file:close()
  return content
end

local function read_json_file(filepath)
  local file = io.open(filepath, "r")
  if not file then return nil end
  local content = file:read("*all")
  file:close()
  local ok, result = pcall(function() return pandoc.json.decode(content) end)
  return ok and result or nil
end

local function escape_html(str)
  if not str then return "" end
  str = str:gsub("&", "&amp;")
  str = str:gsub("<", "&lt;")
  str = str:gsub(">", "&gt;")
  str = str:gsub('"', "&quot;")
  return str
end

local function escape_js_string(str)
  if not str then return "" end
  str = str:gsub("\\", "\\\\")
  str = str:gsub('"', '\\"')
  str = str:gsub("\n", "\\n")
  str = str:gsub("\r", "\\r")
  return str
end

-- ── JSON files ────────────────────────────────────────────────────────────────

local function get_json_files(dir)
  local files = {}
  local handle = io.popen('ls "' .. dir .. '"/*.json 2>/dev/null')
  if not handle then return files end
  for line in handle:lines() do
    files[#files + 1] = line
  end
  handle:close()
  table.sort(files)
  return files
end

-- ── Build corpus statistics from JSON exports ─────────────────────────────────
-- Each JSON file is a list of {document, line, code, text_lines, text} objects

local function build_corpus_stats(json_files)
  -- code_stats[code] = { total=N, by_doc={docname: count} }
  local code_stats = {}
  -- all_codes[code] = true  (codes actually used)
  local all_codes = {}
  -- docs in order
  local doc_names = {}
  local doc_set = {}

  for _, filepath in ipairs(json_files) do
    local basename = filepath:match("([^/]+)%.json$")
    if basename then
      local data = read_json_file(filepath)
      if data and type(data) == "table" then
        if not doc_set[basename] then
          doc_set[basename] = true
          doc_names[#doc_names + 1] = basename
        end
        for _, entry in ipairs(data) do
          local code = entry.code
          if code and type(code) == "string" and code ~= "" then
            all_codes[code] = true
            if not code_stats[code] then
              code_stats[code] = { total = 0, by_doc = {} }
            end
            code_stats[code].total = code_stats[code].total + 1
            code_stats[code].by_doc[basename] = (code_stats[code].by_doc[basename] or 0) + 1
          end
        end
      end
    end
  end

  return code_stats, all_codes, doc_names
end

-- ── Codebook: flat list of all codes defined ──────────────────────────────────

local function flatten_codebook(node, results)
  results = results or {}
  if type(node) == "string" then
    results[#results + 1] = node
  elseif type(node) == "table" then
    for k, v in pairs(node) do
      if type(k) == "string" then
        results[#results + 1] = k
        flatten_codebook(v, results)
      elseif type(k) == "number" then
        flatten_codebook(v, results)
      end
    end
  end
  return results
end

local function load_codebook_codes()
  local raw = read_yaml_file(config.codebook)
  if not raw then return {} end
  local parsed = meta_to_lua(raw)
  if not parsed then return {} end
  return flatten_codebook(parsed)
end

-- ── Serialise stats to JS object literal ─────────────────────────────────────

local function stats_to_js(code_stats, doc_names, codebook_codes, codebook_text)
  local lines = {}

  -- doc names array
  lines[#lines + 1] = 'const DOC_NAMES = ' .. pandoc.json.encode(doc_names) .. ';'

  -- codebook raw text (for AI prompt)
  lines[#lines + 1] = 'const CODEBOOK_TEXT = "' .. escape_js_string(codebook_text) .. '";'

  -- codebook codes array
  -- pandoc.json.encode encodes an empty Lua table as {} (object), not [] (array).
  -- To guarantee a JS array we always serialise element-by-element.
  local cc_parts = {}
  for _, v in ipairs(codebook_codes) do
    cc_parts[#cc_parts + 1] = '"' .. v:gsub('\\', '\\\\'):gsub('"', '\\"') .. '"'
  end
  lines[#lines + 1] = 'const CODEBOOK_CODES = [' .. table.concat(cc_parts, ',') .. '];'

  -- code stats object: {code: {total, byDoc: {doc: count}}}
  local stats_obj = {}
  for code, s in pairs(code_stats) do
    stats_obj[code] = { total = s.total, byDoc = s.by_doc }
  end
  lines[#lines + 1] = 'const CODE_STATS = ' .. pandoc.json.encode(stats_obj) .. ';'

  -- co-occurrence: for each pair of codes, how many docs do they share?
  -- only include pairs with >= 2 shared docs, limit to top 80
  local pairs_list = {}
  local code_list = {}
  for code, _ in pairs(code_stats) do code_list[#code_list + 1] = code end
  for i = 1, #code_list do
    for j = i + 1, #code_list do
      local ca, cb = code_list[i], code_list[j]
      local shared = 0
      for doc, _ in pairs(code_stats[ca].by_doc) do
        if code_stats[cb].by_doc[doc] then shared = shared + 1 end
      end
      if shared >= 2 then
        pairs_list[#pairs_list + 1] = { code_a = ca, code_b = cb, shared_docs = shared }
      end
    end
  end
  table.sort(pairs_list, function(a, b) return a.shared_docs > b.shared_docs end)
  local top_pairs = {}
  for i = 1, math.min(80, #pairs_list) do top_pairs[i] = pairs_list[i] end
  lines[#lines + 1] = 'const CO_OCCURRENCE = ' .. pandoc.json.encode(top_pairs) .. ';'

  -- config
  lines[#lines + 1] = 'const AUDIT_CONFIG = ' .. pandoc.json.encode({
    ollama_model = config.ollama_model,
    ollama_url   = config.ollama_url,
  }) .. ';'

  return table.concat(lines, "\n")
end

-- ── Generate HTML ─────────────────────────────────────────────────────────────

local function generate_html()
  local json_files = get_json_files(config.json_dir)
  if #json_files == 0 then
    print("WARNING: No JSON files found in " .. config.json_dir)
  end

  local code_stats, all_codes, doc_names = build_corpus_stats(json_files)
  local codebook_codes = load_codebook_codes()
  local codebook_text  = read_text_file(config.codebook)
  local css_content    = read_text_file(config.css_file)
  local js_content     = read_text_file(config.js_file)
  local data_js        = stats_to_js(code_stats, doc_names, codebook_codes, codebook_text)

  print("qc-audit: " .. #doc_names .. " documents, " .. (function()
    local n = 0; for _ in pairs(code_stats) do n = n + 1 end; return n
  end)() .. " codes")

  local html = {}
  html[#html + 1] = '<!DOCTYPE html>'
  html[#html + 1] = '<html lang="en">'
  html[#html + 1] = '<head>'
  html[#html + 1] = '  <meta charset="UTF-8">'
  html[#html + 1] = '  <meta name="viewport" content="width=device-width, initial-scale=1.0">'
  html[#html + 1] = '  <title>QC Corpus Audit</title>'
  html[#html + 1] = '  <style>' .. css_content .. '</style>'
  html[#html + 1] = '</head>'
  html[#html + 1] = '<body>'
  html[#html + 1] = '<script>'
  html[#html + 1] = data_js
  html[#html + 1] = '</script>'
  html[#html + 1] = '<script>'
  html[#html + 1] = js_content
  html[#html + 1] = '</script>'
  html[#html + 1] = '<div id="qc-audit-root"></div>'
  html[#html + 1] = '</body>'
  html[#html + 1] = '</html>'

  return table.concat(html, "\n")
end

-- ── Main Pandoc filter ────────────────────────────────────────────────────────

function Pandoc(doc)
  local html = generate_html()
  local out = io.open(output_path, "w")
  if out then
    out:write(html)
    out:close()
    print("Generated " .. output_path)
  else
    print("ERROR: Could not write to " .. output_path)
  end
  return doc
end
