-- qc-viz-filter.lua
-- Place in assets/scripts/qc-viz/qc-viz-filter.lua
-- This filter is context-agnostic and can be used in any qualitative-coding project

-- Load YAML parser (Pandoc's built-in)
local function read_yaml_file(filepath)
  local file = io.open(filepath, "r")
  if not file then return nil end
  local content = file:read("*all")
  file:close()
  
  -- Try to parse as YAML using Pandoc
  local success, result = pcall(function()
    -- Use Pandoc's read function to parse YAML frontmatter
    local doc = pandoc.read("---\n" .. content .. "\n---", "markdown")
    return doc.meta
  end)
  
  if success and result then
    return result
  else
    return nil
  end
end

-- Convert Pandoc meta values to Lua tables recursively
local function meta_to_lua(meta_value)
  if not meta_value then return nil end
  
  -- Handle simple types
  if type(meta_value) == "string" or type(meta_value) == "number" or type(meta_value) == "boolean" then
    return meta_value
  end
  
  -- Handle Pandoc meta types
  if type(meta_value) == "table" then
    if meta_value.t == "MetaString" or meta_value.t == "MetaInlines" then
      return pandoc.utils.stringify(meta_value)
    elseif meta_value.t == "MetaBool" then
      return meta_value.c or meta_value
    elseif meta_value.t == "MetaList" then
      local result = {}
      for i, v in ipairs(meta_value) do
        result[i] = meta_to_lua(v)
      end
      return result
    elseif meta_value.t == "MetaMap" then
      local result = {}
      for k, v in pairs(meta_value) do
        result[k] = meta_to_lua(v)
      end
      return result
    else
      -- Try to handle as regular table
      local result = {}
      local has_numeric_keys = false
      local has_string_keys = false
      
      for k, v in pairs(meta_value) do
        if type(k) == "number" then
          has_numeric_keys = true
          result[k] = meta_to_lua(v)
        elseif type(k) == "string" and k ~= "t" and k ~= "c" then
          has_string_keys = true
          result[k] = meta_to_lua(v)
        end
      end
      
      -- If it's a mixed or empty table, try to stringify
      if not has_numeric_keys and not has_string_keys then
        return pandoc.utils.stringify(meta_value)
      end
      
      return result
    end
  end
  
  return pandoc.utils.stringify(meta_value)
end

-- Load configuration from YAML file or environment variables
local function load_config()
  local config_file = os.getenv("QC_VIZ_CONFIG") or "qc-viz-config.yaml"
  local verbose = os.getenv("QC_VERBOSE") == "true"
  
  -- Default configuration
  local config = {
    directories = {
      qc_dir = "qc",
      corpus_dir = "qc/corpus",
      exclude_dir = "qc/corpus/exclude",
      json_dir = "qc/json",
      output_dir = "qc"
    },
    files = {
      output_file = "qc-viz.html",
      css_file = "assets/scripts/qc-viz/qc-viz.css",
      js_file = "assets/scripts/qc-viz/qc-viz.js",
      venv = "qc/bin/activate"
    },
    code_filters = {
      whitelist = {
        enabled = false,
        codes = {},
        prefixes = {},
        prefix_ranges = {},
        patterns = {},
        branches = {}
      },
      blacklist = {
        enabled = true,
        codes = {},
        prefixes = {},
        prefix_ranges = {},
        patterns = {},
        branches = {}
      }
    },
    code_schema = {
      categories = {},
      colors = {},
      default_color = "#757575"
    },
    display = {
      speaker_column = {
        min_width = 80,
        max_width = 200,
        char_multiplier = 8
      },
      sections = {
        default_collapsed = false,
        preserve_filename_format = true
      },
      code_tags = {
        show_full_code = true
      }
    },
    codebook = {
      enabled = true,
      path = "qc/codebook.yaml"
    },
    advanced = {
      json_line_offset = 1,
      verbose = verbose
    }
  }
  
  if verbose then
    print("DEBUG: Looking for config file: " .. config_file)
  end
  
  -- Try to load YAML config
  local yaml_config = read_yaml_file(config_file)
  
  if yaml_config then
    if verbose then
      print("DEBUG: Found YAML config, attempting to parse...")
    end
    
    local yaml_lua = meta_to_lua(yaml_config)
    
    -- Deep merge function
    local function merge(target, source)
      if type(source) ~= "table" then return end
      for k, v in pairs(source) do
        if type(v) == "table" and type(target[k]) == "table" then
          merge(target[k], v)
        elseif v ~= nil then
          target[k] = v
        end
      end
    end
    
    merge(config, yaml_lua)
    
    if verbose then
      print("Loaded configuration from: " .. config_file)
    end
  else
    if verbose then
      print("No config file found at: " .. config_file)
      print("Using built-in defaults")
    end
  end
  
  -- Environment variable overrides (highest priority)
  config.directories.qc_dir = os.getenv("QC_DIR") or config.directories.qc_dir
  config.files.output_file = os.getenv("QC_OUTPUT_FILE") or config.files.output_file
  config.files.css_file = os.getenv("QC_CSS_FILE") or config.files.css_file
  config.files.js_file = os.getenv("QC_JS_FILE") or config.files.js_file
  
  -- Validate that required files are set
  if not config.files or not config.files.css_file or not config.files.js_file then
    error("ERROR: CSS or JS file path is nil. config.files=" .. tostring(config.files))
  end
  
  return config
end

-- Load configuration
local config = load_config()

-- Store file paths at module level to ensure they're accessible
local CSS_FILE = config.files.css_file
local JS_FILE = config.files.js_file

-- Derived paths - must come AFTER config loading
local json_dir = config.directories.json_dir
local corpus_dir = config.directories.corpus_dir
local output_path = config.directories.output_dir .. "/" .. config.files.output_file
local codebook_path = config.codebook.path

if config.advanced.verbose then
  print("DEBUG: Loaded config, derived paths:")
  print("DEBUG: CSS_FILE = " .. tostring(CSS_FILE))
  print("DEBUG: JS_FILE = " .. tostring(JS_FILE))
  print("DEBUG: json_dir = " .. json_dir)
  print("DEBUG: corpus_dir = " .. corpus_dir)
  print("DEBUG: output_path = " .. output_path)
  print("DEBUG: codebook_path = " .. codebook_path)
end

-- Parse codebook to extract category labels
local function parse_codebook(codebook_data, prefix_to_label)
  if type(codebook_data) ~= "table" then return end
  
  for _, item in ipairs(codebook_data) do
    if type(item) == "table" then
      -- This is a nested structure
      for key, value in pairs(item) do
        if type(key) == "string" then
          -- Extract prefix from key (e.g., "11_Roles" -> "11")
          local prefix = key:match("^(%d%d)_")
          if prefix then
            -- Extract label (e.g., "11_Roles" -> "Roles")
            local label = key:match("^%d%d_(.+)$") or key
            prefix_to_label[prefix] = label
          end
          
          -- Recursively parse nested items
          if type(value) == "table" then
            parse_codebook(value, prefix_to_label)
          end
        end
      end
    elseif type(item) == "string" then
      -- This is a flat code
      local prefix = item:match("^(%d%d)_")
      if prefix and not prefix_to_label[prefix] then
        -- Extract label from the code itself if no parent category exists
        local label = item:match("^%d%d_(%w+)")
        if label then
          prefix_to_label[prefix] = label
        end
      end
    end
  end
end

-- Load code schema from codebook
local function load_code_schema_from_codebook()
  if not config.codebook.enabled then
    if config.advanced.verbose then
      print("DEBUG: Codebook integration disabled")
    end
    return nil
  end
  
  local codebook = read_yaml_file(codebook_path)
  if not codebook then
    if config.advanced.verbose then
      print("DEBUG: Could not read codebook from: " .. codebook_path)
    end
    return nil
  end
  
  if config.advanced.verbose then
    print("DEBUG: Successfully loaded codebook from: " .. codebook_path)
  end
  
  local codebook_lua = meta_to_lua(codebook)
  if not codebook_lua then
    if config.advanced.verbose then
      print("DEBUG: Could not parse codebook")
    end
    return nil
  end
  
  local prefix_to_label = {}
  parse_codebook(codebook_lua, prefix_to_label)
  
  if config.advanced.verbose then
    print("DEBUG: Extracted " .. #prefix_to_label .. " categories from codebook")
    for prefix, label in pairs(prefix_to_label) do
      print("DEBUG:   " .. prefix .. " -> " .. label)
    end
  end
  
  return prefix_to_label
end

-- Generate color palette for prefixes
local function generate_color_palette()
  -- Expanded color palette with more distinct colors
  local base_colors = {
    "#2196F3", "#FF9800", "#9C27B0", "#4CAF50", "#E91E63",
    "#FFC107", "#009688", "#F44336", "#3F51B5", "#8BC34A",
    "#FF5722", "#00BCD4", "#CDDC39", "#673AB7", "#795548",
    "#607D8B", "#FF6F00", "#1976D2", "#C2185B", "#388E3C"
  }
  
  return base_colors
end

-- Default code schema (fallback)
local default_code_schema = {
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

-- Code filtering functions
local function matches_pattern(code, pattern)
  return code:match(pattern) ~= nil
end

local function matches_prefix(code, prefix)
  return code:sub(1, #prefix) == prefix
end

local function matches_prefix_range(code, range_str)
  local start_str, end_str = range_str:match("^(%d+)%-(%d+)$")
  if not start_str or not end_str then return false end
  
  local code_prefix = code:match("^(%d+)_")
  if not code_prefix then return false end
  
  local code_num = tonumber(code_prefix)
  local start_num = tonumber(start_str)
  local end_num = tonumber(end_str)
  
  return code_num >= start_num and code_num <= end_num
end

local function matches_branch(code, branch_name, recursive)
  if recursive then
    return code:match("^" .. branch_name) ~= nil
  else
    return code == branch_name
  end
end

local function should_include_code(code)
  -- Whitelist takes precedence
  if config.code_filters.whitelist.enabled then
    -- Check specific codes
    for _, wl_code in ipairs(config.code_filters.whitelist.codes) do
      if code == wl_code then return true end
    end
    
    -- Check prefixes
    for _, prefix in ipairs(config.code_filters.whitelist.prefixes) do
      if matches_prefix(code, prefix) then return true end
    end
    
    -- Check prefix ranges
    for _, range in ipairs(config.code_filters.whitelist.prefix_ranges) do
      if matches_prefix_range(code, range) then return true end
    end
    
    -- Check patterns
    for _, pattern in ipairs(config.code_filters.whitelist.patterns) do
      if matches_pattern(code, pattern) then return true end
    end
    
    -- Check branches
    for _, branch in ipairs(config.code_filters.whitelist.branches) do
      if matches_branch(code, branch.name, branch.recursive) then return true end
    end
    
    return false  -- Not in whitelist
  end
  
  -- Blacklist mode
  if config.code_filters.blacklist.enabled then
    -- Check specific codes
    for _, bl_code in ipairs(config.code_filters.blacklist.codes) do
      if code == bl_code then return false end
    end
    
    -- Check prefixes
    for _, prefix in ipairs(config.code_filters.blacklist.prefixes) do
      if matches_prefix(code, prefix) then return false end
    end
    
    -- Check prefix ranges
    for _, range in ipairs(config.code_filters.blacklist.prefix_ranges) do
      if matches_prefix_range(code, range) then return false end
    end
    
    -- Check patterns
    for _, pattern in ipairs(config.code_filters.blacklist.patterns) do
      if matches_pattern(code, pattern) then return false end
    end
    
    -- Check branches
    for _, branch in ipairs(config.code_filters.blacklist.branches) do
      if matches_branch(code, branch.name, branch.recursive) then return false end
    end
  end
  
  return true  -- Not blacklisted
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
  if config.advanced.verbose then
    print("DEBUG: read_text_file called with filepath = " .. tostring(filepath))
  end
  
  local file = io.open(filepath, "r")
  if not file then 
    print("ERROR: Could not open file: " .. tostring(filepath))
    return "" 
  end
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
  local name = filename:gsub("%.txt$", "")
  if not config.display.sections.preserve_filename_format then
    name = name:gsub("%-", " ")
  end
  return name
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

-- Collect all codes and build schema dynamically
local function collect_codes_and_build_schema(json_files)
  local codes_by_prefix = {}
  local all_prefixes = {}
  
  -- First pass: collect all codes after filtering
  for _, json_file in ipairs(json_files) do
    local json_data = read_json_file(json_file)
    if json_data then
      for _, entry in ipairs(json_data) do
        if entry.code and should_include_code(entry.code) then
          local prefix = entry.code:match("^(%d%d)_")
          if prefix then
            all_prefixes[prefix] = true
            if not codes_by_prefix[prefix] then
              codes_by_prefix[prefix] = {}
            end
            codes_by_prefix[prefix][entry.code] = true
          end
        end
      end
    end
  end
  
  -- Convert code sets to sorted arrays
  for prefix, code_set in pairs(codes_by_prefix) do
    local code_array = {}
    for code, _ in pairs(code_set) do
      code_array[#code_array + 1] = code
    end
    table.sort(code_array)
    codes_by_prefix[prefix] = code_array
  end
  
  -- Build schema: try codebook first, then config, then generate from codes, then fallback
  local code_schema = {}
  local color_palette = generate_color_palette()
  local code_colors = {}
  
  -- Step 1: Try to load from codebook
  local codebook_schema = load_code_schema_from_codebook()
  
  -- Step 2: Check config for manually defined schema
  local has_config_schema = next(config.code_schema.categories) ~= nil
  local has_config_colors = next(config.code_schema.colors) ~= nil
  
  if config.advanced.verbose then
    print("DEBUG: Building code schema...")
    print("DEBUG: Has codebook schema: " .. tostring(codebook_schema ~= nil))
    print("DEBUG: Has config schema: " .. tostring(has_config_schema))
  end
  
  -- Build schema for each prefix found in the data
  local sorted_prefixes = {}
  for prefix, _ in pairs(all_prefixes) do
    sorted_prefixes[#sorted_prefixes + 1] = prefix
  end
  table.sort(sorted_prefixes)
  
  for i, prefix in ipairs(sorted_prefixes) do
    -- Priority: codebook > config > default > auto-generate
    if codebook_schema and codebook_schema[prefix] then
      code_schema[prefix] = codebook_schema[prefix]
    elseif has_config_schema and config.code_schema.categories[prefix] then
      code_schema[prefix] = config.code_schema.categories[prefix]
    elseif default_code_schema[prefix] then
      code_schema[prefix] = default_code_schema[prefix]
    else
      -- Auto-generate label from first code with this prefix
      if codes_by_prefix[prefix] and #codes_by_prefix[prefix] > 0 then
        local first_code = codes_by_prefix[prefix][1]
        local label = first_code:match("^%d%d_(%w+)") or prefix
        code_schema[prefix] = label
      else
        code_schema[prefix] = prefix
      end
    end
    
    -- Assign colors: config > generate from palette
    if has_config_colors and config.code_schema.colors[prefix] then
      code_colors[prefix] = config.code_schema.colors[prefix]
    else
      -- Use palette with wrapping
      local color_index = ((i - 1) % #color_palette) + 1
      code_colors[prefix] = color_palette[color_index]
    end
    
    if config.advanced.verbose then
      print("DEBUG: Schema for " .. prefix .. ": " .. code_schema[prefix] .. " (" .. code_colors[prefix] .. ")")
    end
  end
  
  return codes_by_prefix, code_schema, code_colors
end

-- Generate color for code prefix
local function get_prefix_color(prefix, code_colors)
  return code_colors[prefix] or config.code_schema.default_color
end

-- Collect all speakers
local function collect_all_speakers(json_files, corpus_dir)
  local speakers = {}
  
  for _, json_file in ipairs(json_files) do
    local basename = json_file:match("([^/]+)%.json$")
    if basename then
      local corpus_file = corpus_dir .. "/" .. basename .. ".txt"
      local corpus_lines = read_corpus_file(corpus_file)
      
      for _, line in ipairs(corpus_lines) do
        local speaker = extract_speaker(line)
        if speaker then
          speakers[speaker] = true
        end
      end
    end
  end
  
  local speaker_array = {}
  for speaker, _ in pairs(speakers) do
    speaker_array[#speaker_array + 1] = speaker
  end
  table.sort(speaker_array)
  
  return speaker_array
end

-- Find longest speaker
local function find_longest_speaker(speakers)
  local max_length = 0
  for _, speaker in ipairs(speakers) do
    if #speaker > max_length then
      max_length = #speaker
    end
  end
  return max_length
end

-- Generate HTML
local function generate_html()
  local html = ""
  local json_files = get_json_files(json_dir)
  
  -- Build schema dynamically based on actual codes (after filtering)
  local codes_by_prefix, code_schema, code_colors = collect_codes_and_build_schema(json_files)
  
  local all_speakers = collect_all_speakers(json_files, corpus_dir)
  local max_speaker_length = find_longest_speaker(all_speakers)
  local speaker_width = math.max(80, math.min(200, max_speaker_length * 8 + 20))
  
  -- CSS
  local css_content = read_text_file(CSS_FILE)
  html = html .. "<style>\n" .. css_content .. "\n.speaker-cell { width: " .. speaker_width .. "px; }\n</style>\n"
  
  -- JavaScript libraries
  html = html .. '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>\n'
  html = html .. '<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>\n'
  html = html .. '<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js"></script>\n'
  
  -- JavaScript
  local js_content = read_text_file(JS_FILE)
  
  -- Add handlers for select/deselect all codes buttons
  local additional_js = [[
    
    // Select All Codes button
    document.addEventListener('DOMContentLoaded', function() {
      document.getElementById('select-all-codes')?.addEventListener('click', function() {
        document.querySelectorAll('.code-checkbox').forEach(cb => {
          cb.checked = true;
          const prefix = cb.dataset.prefix;
          const code = cb.dataset.code;
          if (window.state && window.state.selectedCodes) {
            if (!window.state.selectedCodes[prefix]) {
              window.state.selectedCodes[prefix] = {};
            }
            window.state.selectedCodes[prefix][code] = true;
          }
        });
        
        if (window.saveState) window.saveState();
        if (window.updateAllCategoryStates) window.updateAllCategoryStates();
        if (window.updateAllFilters) window.updateAllFilters();
      });
      
      document.getElementById('deselect-all-codes')?.addEventListener('click', function() {
        document.querySelectorAll('.code-checkbox').forEach(cb => {
          cb.checked = false;
          const prefix = cb.dataset.prefix;
          const code = cb.dataset.code;
          if (window.state && window.state.selectedCodes) {
            if (!window.state.selectedCodes[prefix]) {
              window.state.selectedCodes[prefix] = {};
            }
            window.state.selectedCodes[prefix][code] = false;
          }
        });
        
        if (window.saveState) window.saveState();
        if (window.updateAllCategoryStates) window.updateAllCategoryStates();
        if (window.updateAllFilters) window.updateAllFilters();
      });
    });
  ]]
  
  html = html .. "<script>\n" .. js_content .. additional_js .. "\n</script>\n"
  
  -- Container start
  html = html .. '<div class="qc-viz-container">\n'
  
  -- Filter controls
  html = html .. '  <div class="filter-controls">\n'
  html = html .. '    <div class="filter-header">\n'
  html = html .. '      <h3>Filter by Codes</h3>\n'
  html = html .. '      <div class="filter-actions">\n'
  html = html .. '        <div class="toggle-uncoded">\n'
  html = html .. '          <input type="checkbox" id="show-uncoded">\n'
  html = html .. '          <label for="show-uncoded">Show uncoded segments</label>\n'
  html = html .. '        </div>\n'
  html = html .. '        <div class="speaker-filter">\n'
  html = html .. '          <span class="speaker-filter-label">Speakers <span class="speaker-filter-summary">(all)</span> ▾</span>\n'
  html = html .. '          <div class="speaker-filter-dropdown" id="speaker-filter-dropdown">\n'
  html = html .. '            <div class="speaker-filter-controls">\n'
  html = html .. '              <button class="speaker-filter-btn" id="speaker-select-all">All</button>\n'
  html = html .. '              <button class="speaker-filter-btn" id="speaker-select-none">None</button>\n'
  html = html .. '            </div>\n'
  
  for _, speaker in ipairs(all_speakers) do
    local speaker_id = escape_html(speaker):gsub("[^%w]", "-")
    html = html .. '            <div class="speaker-filter-item">\n'
    html = html .. '              <input type="checkbox" class="speaker-checkbox" data-speaker="' .. escape_html(speaker) .. '" id="spk-' .. speaker_id .. '" checked>\n'
    html = html .. '              <label for="spk-' .. speaker_id .. '">' .. escape_html(speaker) .. '</label>\n'
    html = html .. '            </div>\n'
  end
  
  html = html .. '          </div>\n'
  html = html .. '        </div>\n'
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
  html = html .. '        <button class="action-btn" id="select-all-codes">Select All</button>\n'
  html = html .. '        <button class="action-btn" id="deselect-all-codes">Deselect All</button>\n'
  html = html .. '      </div>\n'
  html = html .. '    </div>\n'
  html = html .. '    <div class="filter-grid">\n'
  
  -- Generate filter categories (only for prefixes that exist after filtering)
  local sorted_prefixes = {}
  for prefix, _ in pairs(codes_by_prefix) do
    sorted_prefixes[#sorted_prefixes + 1] = prefix
  end
  table.sort(sorted_prefixes)
  
  for _, prefix in ipairs(sorted_prefixes) do
    local color = get_prefix_color(prefix, code_colors)
    local label = code_schema[prefix] or prefix
    local codes = codes_by_prefix[prefix]
    
    html = html .. '      <div class="filter-category" data-prefix="' .. prefix .. '" style="border-left-color: ' .. color .. ';">\n'
    html = html .. '        <div class="category-header collapsed">\n'
    html = html .. '          <div class="category-title">\n'
    html = html .. '            <span>' .. prefix .. ': ' .. label .. '</span>\n'
    html = html .. '            <span class="category-status">(all)</span>\n'
    html = html .. '          </div>\n'
    html = html .. '          <button class="select-all-btn" data-prefix="' .. prefix .. '">None</button>\n'
    html = html .. '          <span class="expand-icon">▼</span>\n'
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
          local display_text = line
          if speaker then
            display_text = line:gsub("^" .. speaker:gsub("([%^%$%(%)%%%.%[%]%*%+%-%?])", "%%%1") .. ":%s*", "")
          end
          
          -- Include both coded and uncoded lines
          html = html .. '          <tr>\n'
          html = html .. '            <td class="speaker-cell">' .. escape_html(current_speaker) .. '</td>\n'
          html = html .. '            <td class="text-cell">' .. escape_html(display_text) .. '</td>\n'
          html = html .. '            <td class="codes-cell">'
          
          if codes and #codes > 0 then
            coded_lines = coded_lines + 1
            
            for _, code in ipairs(codes) do
              local prefix = code:match("^(%d%d)_")
              if prefix then
                local color = get_prefix_color(prefix, code_colors)
                html = html .. '<span class="code-tag" data-code="' .. escape_html(code) .. 
                              '" data-prefix="' .. prefix .. 
                              '" style="background-color: ' .. color .. '">' .. 
                              escape_html(code) .. '</span> '
              end
            end
          end
          
          html = html .. '</td>\n'
          html = html .. '          </tr>\n'
        end
        
        html = html .. '        </tbody>\n'
        html = html .. '      </table>\n'
        html = html .. '      <div class="stats-summary">Showing 0 of ' .. #corpus_lines .. ' lines (0/' .. coded_lines .. ' coded, 0/' .. (#corpus_lines - coded_lines) .. ' uncoded)</div>\n'
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
  
  local output_file = io.open(output_path, "w")
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
    print("Generated " .. output_path)
  else
    print("ERROR: Could not write to " .. output_path)
  end
  
  return doc
end