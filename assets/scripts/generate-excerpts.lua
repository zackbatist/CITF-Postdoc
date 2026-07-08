--[[
generate-excerpts.lua

Reads every *.json file in a source directory and writes one .qmd file
per JSON file into an output directory, grouping each file's excerpts
by code.

USAGE

    pandoc lua generate-excerpts.lua <source_dir> <output_dir>

EXAMPLE

    pandoc lua generate-excerpts.lua qc/excerpts/source qc/excerpts/generated

This reads qc/excerpts/source/Personal_challenges.json and writes
qc/excerpts/generated/Personal_challenges.qmd.

Always fully overwrites whatever is in <output_dir>. Run it manually,
whenever you want, as many times as you want.
--]]

local BASE_LEVEL = 3

local function escape_md(s)
  s = s:gsub("\\", "\\\\")
  s = s:gsub("%*", "\\*")
  s = s:gsub("_", "\\_")
  s = s:gsub("`", "\\`")
  s = s:gsub("^#", "\\#")
  s = s:gsub("%[", "\\[")
  s = s:gsub("%]", "\\]")
  return s
end

local function read_file(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local content = f:read("*a")
  f:close()
  return content
end

local function write_file(path, content)
  local f = io.open(path, "w")
  if not f then
    io.stderr:write("ERROR: could not write " .. path .. "\n")
    os.exit(1)
  end
  f:write(content)
  f:close()
end

local function list_json_files(dir)
  local files = {}
  local ok, entries = pcall(pandoc.system.list_directory, dir)
  if not ok or not entries then
    io.stderr:write("ERROR: could not list directory " .. tostring(dir) .. "\n")
    os.exit(1)
  end
  for _, name in ipairs(entries) do
    if name:match("%.json$") then
      table.insert(files, pandoc.path.join({ dir, name }))
    end
  end
  table.sort(files)
  return files
end

local function code_segments(code)
  local segments = {}
  for seg in (code .. "/"):gmatch("([^/]*)/") do
    if seg ~= "" then table.insert(segments, seg) end
  end
  if #segments == 0 then segments = { code } end
  return segments
end

local function code_title(code)
  return (code:gsub("_", " "))
end

local function format_number(n)
  if math.floor(n) == n then
    return string.format("%d", n)
  end
  return tostring(n)
end

local function group_by_code(entries)
  local groups = {}
  local order = {}
  for _, e in ipairs(entries) do
    local code = e.code or "Uncoded"
    if not groups[code] then
      groups[code] = {}
      table.insert(order, code)
    end
    table.insert(groups[code], e)
  end
  table.sort(order)
  return groups, order
end

local function render_markdown(stem, entries)
  local groups, order = group_by_code(entries)
  local lines = {}

  table.insert(lines, string.rep("#", BASE_LEVEL) .. " " .. stem)
  table.insert(lines, "")

  for _, code in ipairs(order) do
    local segments = code_segments(code)
    for i, seg in ipairs(segments) do
      table.insert(lines, string.rep("#", BASE_LEVEL + i) .. " " .. code_title(seg))
      table.insert(lines, "")
    end

    local excerpts = groups[code]
    local multiple = #excerpts > 1
    for _, e in ipairs(excerpts) do
      if multiple then
        local loc_parts = {}
        if e.document then table.insert(loc_parts, e.document) end
        if e.line then table.insert(loc_parts, "line " .. format_number(e.line)) end
        if #loc_parts > 0 then
          table.insert(lines, "*" .. table.concat(loc_parts, " \u{2022} ") .. "*")
          table.insert(lines, "")
        end
      end
      for line in (e.text or ""):gmatch("([^\n]*)\n?") do
        if line ~= "" then
          table.insert(lines, "> " .. escape_md(line))
        end
      end
      table.insert(lines, "")
    end
  end

  return table.concat(lines, "\n")
end

-- Entry point --------------------------------------------------------------
-- Paths are fixed here instead of taken from command-line arguments, since
-- argument passing to `pandoc lua` scripts is inconsistent across pandoc
-- versions. Edit these two lines if your folder layout differs.

local source_dir = "qc/excerpts/source"
local output_dir = "qc/excerpts/generated"

os.execute('mkdir -p "' .. output_dir .. '"')

local count = 0
for _, path in ipairs(list_json_files(source_dir)) do
  local content = read_file(path)
  if content then
    local ok, decoded = pcall(pandoc.json.decode, content)
    if ok and decoded then
      local stem = pandoc.path.filename(path):gsub("%.json$", "")
      local out_path = pandoc.path.join({ output_dir, stem .. ".qmd" })
      write_file(out_path, render_markdown(stem, decoded))
      print("wrote " .. out_path .. " (" .. #decoded .. " excerpts)")
      count = count + 1
    else
      io.stderr:write("WARNING: failed to parse JSON in " .. path .. "\n")
    end
  end
end

print("done: " .. count .. " file(s) written to " .. output_dir)