-- coding-visualizer.lua
-- Place in assets/coding-visualizer.lua

-- Code prefix schema
local code_schema = {
  ["10"] = "People",
  ["11"] = "Roles and positions",
  ["20"] = "Organizations",
  ["21"] = "Research consortia",
  ["22"] = "Projects / Studies",
  ["30"] = "Activities",
  ["40"] = "Abstractions",
  ["41"] = "Kinds of work",
  ["43"] = "Kinds of data",
  ["44"] = "Kinds of relationships",
  ["50"] = "Challenges and resolutions",
  ["51"] = "Goals",
  ["52"] = "Challenges",
  ["53"] = "Means",
  ["54"] = "Contexts",
  ["55"] = "Hypotheticals",
  ["56"] = "Outcomes",
  ["57"] = "Facilitators",
  ["58"] = "Drivers",
  ["60"] = "Figurations",
  ["61"] = "Analogies",
  ["62"] = "Stories",
  ["63"] = "Comparisons",
  ["70"] = "Concepts",
  ["80"] = "Qualities"
}

-- Generate color for code prefix
local function get_prefix_color(prefix)
  local colors = {
    ["10"] = "#2196F3", ["11"] = "#1976D2",
    ["20"] = "#FF9800", ["21"] = "#F57C00", ["22"] = "#E64A19",
    ["30"] = "#9C27B0", 
    ["40"] = "#4CAF50", ["41"] = "#388E3C", ["43"] = "#2E7D32", ["44"] = "#1B5E20",
    ["50"] = "#E91E63", ["51"] = "#C2185B", ["52"] = "#AD1457", 
    ["53"] = "#880E4F", ["54"] = "#F06292", ["55"] = "#EC407A", 
    ["56"] = "#D81B60", ["57"] = "#C2185B", ["58"] = "#AD1457",
    ["60"] = "#FFC107", ["61"] = "#FFA000", ["62"] = "#FF8F00", ["63"] = "#FF6F00",
    ["70"] = "#9C27B0",
    ["80"] = "#009688"
  }
  return colors[prefix] or "#757575"
end

-- Read JSON file
local function read_json_file(filepath)
  local file = io.open(filepath, "r")
  if not file then return nil end
  local content = file:read("*all")
  file:close()
  
  local success, result = pcall(function()
    return pandoc.json.decode(content)
  end)
  
  return success and result or nil
end

-- Read text file
local function read_text_file(filepath)
  local file = io.open(filepath, "r")
  if not file then return "" end
  local content = file:read("*all")
  file:close()
  return content
end

-- Read corpus text file
local function read_corpus_file(filepath)
  local file = io.open(filepath, "r")
  if not file then return {} end
  local lines = {}
  for line in file:lines() do
    lines[#lines + 1] = line
  end
  file:close()
  return lines
end

-- Extract speaker from line
local function extract_speaker(line)
  return line:match("^([^:]+):")
end

-- Parse filename to interview name
local function get_interview_name(filename)
  return filename:gsub("%.txt$", ""):gsub("%-", " ")
end

-- Generate slug
local function slugify(text)
  return text:lower():gsub(" ", "-"):gsub("[^%w%-]", "")
end

-- Escape HTML
local function escape_html(str)
  if not str then return "" end
  return str:gsub("&", "&amp;")
            :gsub("<", "&lt;")
            :gsub(">", "&gt;")
            :gsub('"', "&quot;")
            :gsub("'", "&#39;")
end

-- Get JSON files
local function get_json_files(dir)
  local files = {}
  local handle = io.popen("find " .. dir .. " -name '*.json' 2>/dev/null | sort")
  if handle then
    for file in handle:lines() do
      files[#files + 1] = file
    end
    handle:close()
  end
  return files
end

-- Collect all codes
local function collect_all_codes(json_files)
  local codes_by_prefix = {}
  
  for _, json_file in ipairs(json_files) do
    local json_data = read_json_file(json_file)
    if json_data then
      for _, entry in ipairs(json_data) do
        if entry.code then
          local prefix = entry.code:match("^(%d%d)_")
          if prefix then
            if not codes_by_prefix[prefix] then
              codes_by_prefix[prefix] = {}
            end
            codes_by_prefix[prefix][entry.code] = true
          end
        end
      end
    end
  end
  
  for prefix, code_set in pairs(codes_by_prefix) do
    local code_array = {}
    for code, _ in pairs(code_set) do
      code_array[#code_array + 1] = code
    end
    table.sort(code_array)
    codes_by_prefix[prefix] = code_array
  end
  
  return codes_by_prefix
end

-- Find longest speaker
local function find_longest_speaker(json_files, corpus_dir)
  local max_length = 0
  
  for _, json_file in ipairs(json_files) do
    local basename = json_file:match("([^/]+)%.json$")
    if basename then
      local corpus_file = corpus_dir .. "/" .. basename .. ".txt"
      local corpus_lines = read_corpus_file(corpus_file)
      
      for _, line in ipairs(corpus_lines) do
        local speaker = extract_speaker(line)
        if speaker and #speaker > max_length then
          max_length = #speaker
        end
      end
    end
  end
  
  return max_length
end

-- Generate HTML
local function generate_html()
  local html = ""
  local json_dir = "qc/json"
  local corpus_dir = "qc/corpus"
  local json_files = get_json_files(json_dir)
  
  local codes_by_prefix = collect_all_codes(json_files)
  local max_speaker_length = find_longest_speaker(json_files, corpus_dir)
  local speaker_width = math.max(80, math.min(200, max_speaker_length * 8 + 20))
  
  -- CSS
  local css_content = read_text_file("assets/coding-viz.css")
  html = html .. "<style>\n" .. css_content .. "\n.speaker-cell { width: " .. speaker_width .. "px; }\n</style>\n"
  
  -- JavaScript libraries
  html = html .. '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>\n'
  html = html .. '<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>\n'
  html = html .. '<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js"></script>\n'
  
  -- JavaScript
  local js_content = read_text_file("assets/coding-viz.js")
  html = html .. "<script>\n" .. js_content .. "\n</script>\n"
  
  -- Container start
  html = html .. '<div class="coding-viz-container">\n'
  
  -- Filter controls
  html = html .. '  <div class="filter-controls">\n'
  html = html .. '    <div class="filter-header">\n'
  html = html .. '      <h3>Filter by Codes</h3>\n'
  html = html .. '      <div class="filter-actions">\n'
  html = html .. '        <div style="position: relative;">\n'
  html = html .. '          <button class="action-btn export" id="export-btn">Export ▾</button>\n'
  html = html .. '          <div class="export-menu" id="export-menu">\n'
  html = html .. '            <div class="export-option" data-format="csv">CSV</div>\n'
  html = html .. '            <div class="export-option" data-format="json">JSON</div>\n'
  html = html .. '            <div class="export-option" data-format="excel">Excel</div>\n'
  html = html .. '            <div class="export-option" data-format="html">HTML</div>\n'
  html = html .. '            <div class="export-option" data-format="pdf">PDF</div>\n'
  html = html .. '          </div>\n'
  html = html .. '        </div>\n'
  html = html .. '        <button class="action-btn clear" id="clear-all-filters">Clear Filters</button>\n'
  html = html .. '      </div>\n'
  html = html .. '    </div>\n'
  html = html .. '    <div class="filter-grid">\n'
  
  -- Generate filter categories
  local sorted_prefixes = {}
  for prefix, _ in pairs(codes_by_prefix) do
    sorted_prefixes[#sorted_prefixes + 1] = prefix
  end
  table.sort(sorted_prefixes)
  
  for _, prefix in ipairs(sorted_prefixes) do
    local color = get_prefix_color(prefix)
    local label = code_schema[prefix] or prefix
    local codes = codes_by_prefix[prefix]
    
    html = html .. '      <div class="filter-category" data-prefix="' .. prefix .. '" style="border-color: ' .. color .. ';">\n'
    html = html .. '        <div class="category-header collapsed">\n'
    html = html .. '          <div class="category-title">' .. prefix .. ': ' .. label .. '</div>\n'
    html = html .. '          <div class="category-controls">\n'
    html = html .. '            <button class="select-all-btn" data-prefix="' .. prefix .. '">None</button>\n'
    html = html .. '            <span class="expand-icon">▼</span>\n'
    html = html .. '          </div>\n'
    html = html .. '        </div>\n'
    html = html .. '        <div class="codes-list collapsed">\n'
    
    for _, code in ipairs(codes) do
      local code_escaped = escape_html(code)
      local code_id = code_escaped:gsub("[^%w]", "-")
      
      html = html .. '          <div class="code-item">\n'
      html = html .. '            <input type="checkbox" class="code-checkbox" data-prefix="' .. prefix .. '" data-code="' .. code_escaped .. '" id="cb-' .. code_id .. '" checked>\n'
      html = html .. '            <label for="cb-' .. code_id .. '">' .. code_escaped .. '</label>\n'
      html = html .. '          </div>\n'
    end
    
    html = html .. '        </div>\n'
    html = html .. '      </div>\n'
  end
  
  html = html .. '    </div>\n'
  html = html .. '  </div>\n'
  
  -- Process interviews
  for _, json_file in ipairs(json_files) do
    local basename = json_file:match("([^/]+)%.json$")
    if basename then
      local corpus_file = corpus_dir .. "/" .. basename .. ".txt"
      local json_data = read_json_file(json_file)
      local corpus_lines = read_corpus_file(corpus_file)
      
      if json_data and #corpus_lines > 0 then
        local line_codes = {}
        for _, entry in ipairs(json_data) do
          if entry.line and entry.code then
            local lua_line_num = entry.line + 1
            if not line_codes[lua_line_num] then
              line_codes[lua_line_num] = {}
            end
            line_codes[lua_line_num][#line_codes[lua_line_num] + 1] = entry.code
          end
        end
        
        local interview_name = get_interview_name(basename)
        local slug = slugify(interview_name)
        
        html = html .. '  <div class="interview-section" id="' .. slug .. '">\n'
        html = html .. '    <div class="interview-header">\n'
        html = html .. '      <h2>' .. escape_html(interview_name) .. '</h2>\n'
        html = html .. '      <span class="collapse-icon">▼</span>\n'
        html = html .. '    </div>\n'
        html = html .. '    <div class="interview-content">\n'
        html = html .. '      <table class="coding-table">\n'
        html = html .. '        <thead>\n'
        html = html .. '          <tr>\n'
        html = html .. '            <th>Speaker</th>\n'
        html = html .. '            <th>Text</th>\n'
        html = html .. '            <th>Codes</th>\n'
        html = html .. '          </tr>\n'
        html = html .. '        </thead>\n'
        html = html .. '        <tbody>\n'
        
        local current_speaker = ""
        local coded_lines = 0
        
        for i, line in ipairs(corpus_lines) do
          local speaker = extract_speaker(line)
          if speaker then
            current_speaker = speaker
          end
          
          local codes = line_codes[i]
          if codes and #codes > 0 then
            coded_lines = coded_lines + 1
            
            local display_text = line
            if speaker then
              display_text = line:gsub("^" .. speaker:gsub("([%^%$%(%)%%%.%[%]%*%+%-%?])", "%%%1") .. ":%s*", "")
            end
            
            html = html .. '          <tr>\n'
            html = html .. '            <td class="speaker-cell">' .. escape_html(current_speaker) .. '</td>\n'
            html = html .. '            <td class="text-cell">' .. escape_html(display_text) .. '</td>\n'
            html = html .. '            <td class="codes-cell">'
            
            for _, code in ipairs(codes) do
              local prefix = code:match("^(%d%d)_")
              if prefix then
                local color = get_prefix_color(prefix)
                html = html .. '<span class="code-tag" data-code="' .. escape_html(code) .. 
                              '" data-prefix="' .. prefix .. 
                              '" style="background-color: ' .. color .. '">' .. 
                              escape_html(code) .. '</span> '
              end
            end
            
            html = html .. '</td>\n'
            html = html .. '          </tr>\n'
          end
        end
        
        html = html .. '        </tbody>\n'
        html = html .. '      </table>\n'
        html = html .. '      <div class="stats-summary">Showing ' .. coded_lines .. ' of ' .. coded_lines .. ' coded lines</div>\n'
        html = html .. '    </div>\n'
        html = html .. '  </div>\n'
      end
    end
  end
  
  html = html .. '</div>\n'
  
  return html
end

-- Main filter
function Pandoc(doc)
  local html_content = generate_html()
  
  local output_file = io.open("qc/0.html", "w")
  if output_file then
    output_file:write('<!DOCTYPE html>\n')
    output_file:write('<html lang="en">\n')
    output_file:write('<head>\n')
    output_file:write('  <meta charset="UTF-8">\n')
    output_file:write('  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n')
    output_file:write('  <title>Qualitative Coding Visualization</title>\n')
    output_file:write('</head>\n')
    output_file:write('<body>\n')
    output_file:write(html_content)
    output_file:write('</body>\n')
    output_file:write('</html>\n')
    output_file:close()
    print("Generated qc/0.html")
  else
    print("ERROR: Could not write to qc/0.html")
  end
  
  return doc
end