--[[ Lua Script: Aggregate Double Space Utility: aggregate_double_space.lua ]]
-- This script aggregates the content of multiple text files specified as command-line arguments.
-- For each line, it applies double-spacing and bolds speaker names (Name:), regardless of indentation.
-- The final, single, processed output is written to 'double_spaced_corpus.md' in the current directory.

-- The target output file name (no leading underscore to avoid file lock issues)
local OUTPUT_FILENAME = "qc/double_spaced_corpus.md"

-- --- Core Functions ---

-- Function to process a single line: bold speaker name and add double-spacing
local function format_line(line)
    -- Remove any leading/trailing whitespace for clean processing
    line = line:match("^%s*(.*%S)%s*$") or line
    
    -- If the line is empty or nil after trimming, just return an extra newline
    if not line or line == "" then
        return "\n"
    end

    -- Pattern to find speaker names:
    -- ^%s*: Match start of line, allowing leading whitespace (robustness)
    -- ([^:]+): Capture the speaker name (one or more characters that are NOT a colon) -> %1
    -- : : Match the literal colon and the single space
    local formatted_line = line:gsub("^%s*([^:]+): ", "**%1:** ")

    -- Return the formatted line followed by an extra newline for double-spacing
    return formatted_line .. "\n\n"
end

-- Function to process a single input file and write content to the output file
local function process_file(filepath, output_handle)
    local input_file = io.open(filepath, "r")
    if not input_file then
        -- Print a warning but continue processing other files
        io.stderr:write(string.format("[LUA WARNING] Could not open input file: %s\n", filepath))
        return
    end

    -- Add a clear marker for each file that was aggregated (optional but good practice)
    output_handle:write(string.format("## Source File: %s\n\n", filepath))
    
    local line_count = 0
    for line in input_file:lines() do
        local output_content = format_line(line)
        output_handle:write(output_content)
        line_count = line_count + 1
    end

    input_file:close()
    io.stdout:write(string.format("[LUA] Successfully processed %d lines from: %s\n", line_count, filepath))
end


-- --- Main Execution ---

-- Command-line arguments start at arg[1]
local input_files = { ... }
local num_files = #input_files

io.stdout:write(string.format("[LUA] Starting robust corpus aggregation. Found %d files.\n", num_files))

if num_files == 0 then
    io.stderr:write("[LUA ERROR] Found 0 input files. Check 'corpus/*.txt' path and file existence. Exiting.\n")
    return
end

-- Open the final output file for writing ('w'). This overwrites any previous version.
local output_file = io.open(OUTPUT_FILENAME, "w")
if not output_file then
    io.stderr:write(string.format("[LUA ERROR] Could not open output file for writing: %s. Check permissions.\n", OUTPUT_FILENAME))
    return
end

-- Process all files
for i = 1, num_files do
    process_file(input_files[i], output_file)
end

output_file:close()

io.stdout:write(string.format("[LUA] Aggregation complete. Output written to %s.\n", OUTPUT_FILENAME))
