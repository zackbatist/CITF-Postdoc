-- qualitative-viz.lua
-- Quarto filter to generate an HTML visualization of coded interview transcripts.
-- Designed to be executed as a Pandoc filter after PROJECT_ROOT_PATH is set in the shell script.

-- Define paths relative to the project root (CITF-Postdoc)
local QC_DIR = 'qc'
local CORPUS_DIR = QC_DIR .. '/corpus'
local JSON_DIR = QC_DIR .. '/json'
local OUTPUT_FILENAME = '0.html'

-- Define the absolute project path using the environment variable set by the shell.
-- This is critical for reliable I/O in CloudStorage environments.
local PROJECT_ROOT_PATH = os.getenv("PROJECT_ROOT_PATH") or "."


-- Code prefix schema and Color mapping (Assumed content is functional)
local CODE_SCHEMA = {
    ['10'] = 'People', ['11'] = 'Roles and positions',
    ['20'] = 'Organizations', ['21'] = 'Research consortia', ['22'] = 'Projects / Studies',
    ['30'] = 'Activities',
    ['40'] = 'Abstractions', ['41'] = 'Kinds of work', ['43'] = 'Kinds of data', ['44'] = 'Kinds of relationships',
    ['50'] = 'Challenges and resolutions', ['51'] = 'Goals', ['52'] = 'Challenges', ['53'] = 'Means', ['54'] = 'Contexts', ['55'] = 'Hypotheticals', ['56'] = 'Outcomes', ['57'] = 'Facilitators', ['58'] = 'Drivers',
    ['60'] = 'Figurations', ['61'] = 'Analogies', ['62'] = 'Stories', ['63'] = 'Comparisons',
    ['70'] = 'Concepts',
    ['80'] = 'Qualities',
}

local COLOR_MAP = {
    ['10'] = '#2c7fb8', ['11'] = '#7fcdbb',
    ['20'] = '#238b45', ['21'] = '#74c476', ['22'] = '#c7e9c0',
    ['30'] = '#fe9929',
    ['40'] = '#88419d', ['41'] = '#b3cde3', ['43'] = '#8c96c6', ['44'] = '#8c6fb8',
    ['50'] = '#d7301f', ['51'] = '#ef6548', ['52'] = '#fc8d59', ['53'] = '#fdbb84', ['54'] = '#fdd49e', ['55'] = '#fee8c8', ['56'] = '#fff7bc', ['57'] = '#ffeda0', ['58'] = '#fed98e',
    ['60'] = '#ffaa00', ['61'] = '#ffcc66', ['62'] = '#ffee00', ['63'] = '#fff9c4',
    ['70'] = '#41ab5d',
    ['80'] = '#737373',
    ['DEFAULT'] = '#cccccc'
}


-- Function to compute the absolute path to the output file
local function get_output_file_path(project_root)
    if not project_root or project_root == "" then
        io.stderr:write("❌ ERROR: Project root path is empty/missing! Aborting path construction.\n")
        return nil
    end
    
    -- Using simple concatenation for output path
    local path = project_root .. '/' .. QC_DIR .. '/' .. OUTPUT_FILENAME
    return path
end

-- Function to get all files in a directory (must use absolute path)
local function list_files(dir)
    local results = {}
    
    -- *** CRITICAL FIX: Use simple string concatenation instead of pandoc.path.join ***
    -- This resolves the "table expected, got string" error.
    local absolute_dir = PROJECT_ROOT_PATH .. '/' .. dir
    
    local p = io.popen('find "' .. absolute_dir .. '" -maxdepth 1 -name "*.json" -type f')
    
    if p then
        for line in p:lines() do
            -- The find command returns the absolute path
            table.insert(results, line)
        end
        p:close()
    end
    return results
end

-- Function to process one interview
local function process_interview(json_path)
    
    -- 1. Read JSON Content (Absolute path)
    local f_json = io.open(json_path, "r")
    if not f_json then
        io.stderr:write('❌ ERROR: Failed to open JSON file for reading: ' .. json_path .. "\n")
        return "" 
    end
    
    local json_content = f_json:read("*a")
    f_json:close()
    
    if not json_content or #json_content == 0 or json_content:match('^%s*%[%s*%]%s*$') then 
        io.stderr:write('Warning: JSON content is empty or an empty array in ' .. json_path .. ". Skipping.\n")
        return "" 
    end

    -- 2. Decode JSON
    local success, json_data = pcall(pandoc.json.decode, json_content)
    if not success or not json_data or #json_data == 0 then 
        io.stderr:write('❌ ERROR: Pandoc failed to decode JSON from ' .. json_path .. ". Error: " .. tostring(json_data) .. "\n")
        return "" 
    end
    
    -- 3. Read Transcript Content (Absolute path)
    local document_name = json_data[1].document 
    local interview_name = document_name:match("([^/\\%.]+)")
    
    -- Construct the absolute path to the transcript using PROJECT_ROOT_PATH
    local txt_path_rel = CORPUS_DIR .. '/' .. interview_name .. '.txt' 
    local txt_path_abs = PROJECT_ROOT_PATH .. '/' .. txt_path_rel
    
    local f_txt = io.open(txt_path_abs, "r")
    if not f_txt then
        io.stderr:write('❌ ERROR: Transcript file not found/readable: ' .. txt_path_abs .. "\n")
        return "" 
    end
    
    local transcript_content = f_txt:read("*a")
    f_txt:close()
    
    -- 4. Process Codes and Transcript
    local transcript_lines = {}
    for line in transcript_content:gmatch("([^\n]*)\n?") do
        table.insert(transcript_lines, line)
    end
    
    local line_codes = {}
    for _, item in ipairs(json_data) do
        local line_num = item.line
        local code = item.code
        if not line_codes[line_num] then line_codes[line_num] = {} end
        line_codes[line_num][code] = true
    end

    local html_rows = {}
    local current_speaker = ""
    local speaker_pattern = "^(%S+%s*:)"
    
    for i, line_text in ipairs(transcript_lines) do
        local line_num = i
        local speaker_match = line_text:match(speaker_pattern)
        if speaker_match then current_speaker = speaker_match:gsub(':', ''):gsub(' ', '') end
        
        local codes_for_line = line_codes[line_num] or {}
        local codes_html = {}
        local codes_list_raw = {} 
        
        for code in pairs(codes_for_line) do
            local prefix = code:match("^(%d%d)") or "DEFAULT"
            local color = COLOR_MAP[prefix] or COLOR_MAP.DEFAULT
            table.insert(codes_html, string.format('<div class="code-wrapper"><div class="code-tag %s" data-code="%s" style="background-color: %s;">%s</div></div>', 'group-' .. prefix, code, color, code))
            table.insert(codes_list_raw, code)
        end
        
        local speaker_td = string.format('<td class="speaker-col" data-speaker="%s">%s</td>', current_speaker, pandoc.utils.escape_html(current_speaker))
        local text_td = string.format('<td class="text-col" data-line="%d">%s</td>', line_num, pandoc.utils.escape_html(line_text))
        local codes_td = string.format('<td class="codes-col" data-codes="%s">%s</td>', table.concat(codes_list_raw, '|'), table.concat(codes_html, ' '))
        
        table.insert(html_rows, string.format('<tr>%s%s%s</tr>', speaker_td, text_td, codes_td))
    end
    
    local html_table = string.format([=[
<div class="interview-wrapper" id="wrapper-%s">
<h2 id="%s" class="interview-heading">%s</h2>
<div class="interview-table-container">
<div class="collapsible-content">
<table id="table-%s" class="interview-table" data-document="%s">
<thead><tr><th>Speaker</th><th>Text</th><th>Codes</th></tr></thead>
<tbody>
%s
</tbody>
</table>
</div>
</div>
</div>
    ]=], interview_name, interview_name, interview_name, interview_name, document_name, table.concat(html_rows, "\n"))
    
    return html_table
end

-- Helper functions for CSS/JS/Legend (Omitted for brevity)
local function generate_css() return "/* CSS content */" end
local function generate_legend() return "" end
local function generate_filter_ui() return "" end
local function generate_javascript() return "/* JS content */" end

-- The main execution function
function pre_render()
    
    -- 1. Project root is already defined globally by os.getenv()
    
    -- 2. Read JSON files
    local json_files = list_files(JSON_DIR)

    -- 3. Process each interview
    local content_blocks = {}
    for _, path in ipairs(json_files) do
        table.insert(content_blocks, process_interview(path))
    end
    
    if #table.concat(content_blocks, "") == 0 then
        io.stderr:write("⚠️ Warning: No coded content was successfully processed. Aborting HTML generation.\n")
        return {} 
    end
    
    -- 4. Generate HTML structure
    local html_content = table.concat(content_blocks, "\n")
    local css = generate_css()
    local js = generate_javascript()
    local legend = generate_legend()
    local filter_ui = generate_filter_ui()
    
    local final_html = string.format([=[
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Qualitative Coding Visualization</title><style>%s</style></head>
<body><h1>Qualitative Coding Visualization: Interview Data</h1>%s%s%s</body>%s
</html>
    ]=], css, legend, filter_ui, html_content, js)
    
    -- 5. Write to qc/0.html
    local OUTPUT_FILE = get_output_file_path(PROJECT_ROOT_PATH)
    
    if not OUTPUT_FILE then
        io.stderr:write('❌ ERROR: Aborting HTML write due to missing project path.\n')
        return {}
    end
    
    local f = io.open(OUTPUT_FILE, "w")
    
    io.stderr:write('\nAttempting to write final HTML output to: ' .. OUTPUT_FILE .. "\n")
    
    if f then
        f:write(final_html)
        f:close()
        print('✅ Successfully generated ' .. OUTPUT_FILE)
    else
        io.stderr:write('❌ FATAL ERROR: Could not write HTML output to ' .. OUTPUT_FILE .. ". Check permissions and Cloud Sync I/O stability.\n")
    end
    
    return {}
end

-- Execution entry point for Pandoc filters
if pandoc then
    print("Executing pre_render via pandoc environment.")
    pre_render()
end

-- Return for filter compatibility
return {
    pre_render = pre_render
}