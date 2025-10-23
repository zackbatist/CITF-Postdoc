-- ==========================================================
-- FILE: assets/aggregate_corpus.lua
-- ==========================================================

-- --- Configuration & Dependencies ---
local json = require("dkjson") 
local OUTPUT_DIR_RELATIVE = "qc/json"
local JSON_OUTPUT_DIR = OUTPUT_DIR_RELATIVE

-- 1. Function to ensure the output directory exists
local function ensure_output_dir()
    local success = os.execute("mkdir -p " .. JSON_OUTPUT_DIR)
    if success ~= 0 and success ~= true then
        io.stderr:write("LUA FATAL ERROR: Could not create output directory: " .. JSON_OUTPUT_DIR .. "\n")
        return false
    end
    return true
end

-- 2. Function to perform analysis and return a Lua table
local function analyze_document(file_path)
    
    -- --- File and Filename Safety Checks ---
    if not file_path or file_path == "" then return nil end

    local filename = file_path:match("([^/]+)$")
    
    -- 1. If the filename has no period, it's not a standard file.
    if not filename:find(".") then
        io.stderr:write("LUA WARNING: Skipping directory or extensionless file: " .. file_path .. "\n")
        return nil
    end
    
    -- 2. Robustly extract the base name (e.g., "2025-03-26").
    local filename_base = filename:match("(.+)%.[^%.]+$") 

    if not filename_base then 
        io.stderr:write("LUA WARNING: Skipping invalid file name structure: " .. file_path .. "\n")
        return nil 
    end
    
    -- --- File I/O and Content Analysis ---
    local f = io.open(file_path, "r")
    if not f then
        io.stderr:write("LUA READ ERROR: Could not open file: " .. file_path .. "\n")
        return nil
    end
    local content = f:read("*a")
    f:close()
    
    local char_count = #content
    local word_count = select(2, content:gsub("%S+", "")) 
    
    return {
        file = filename_base,
        char_count = char_count,
        word_count = word_count,
        analysis_date = os.date("%Y-%m-%d %H:%M:%S")
    }
end

-- --- Main Execution ---

if not ensure_output_dir() then
    os.exit(1)
end

for i, file_path in ipairs(arg) do
    local analysis_data = analyze_document(file_path)

    if analysis_data then
        local filename_base = analysis_data.file 
        local output_file_path = JSON_OUTPUT_DIR .. "/" .. filename_base .. ".json"

        local json_string = json.encode(analysis_data)

        local f, err = io.open(output_file_path, "w")
        if not f then
            io.stderr:write("LUA WRITE ERROR: Cannot open " .. output_file_path .. ". Reason: " .. tostring(err) .. "\n")
        else
            f:write(json_string)
            f:close()
        end
    end
end