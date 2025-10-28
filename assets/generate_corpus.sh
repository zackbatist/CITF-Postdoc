#!/bin/bash

# Define paths relative to CITF-Postdoc root
QC_DIR="qc"
CORPUS_DIR="$QC_DIR/corpus"
JSON_DIR="$QC_DIR/json"

# Store the current directory (project root)
PROJECT_ROOT="$(pwd)"

# Ensure directories exist
mkdir -p "$JSON_DIR"

echo "Running qualitative-coding export..."

# --- STEP 1: GENERATE JSON FILES ---

OLDPWD="$PWD"
cd "$QC_DIR" || { echo "❌ ERROR: Cannot change directory to $QC_DIR. Aborting."; exit 1; }
echo "Working directory changed to: $PWD"

# List all .txt files in corpus/
find corpus -name "*.txt" | grep -v 'corpus/2025-03-26-x.txt' | grep -v 'corpus/2025-04-07-JBergeron.txt' | grep -v 'corpus/2025-07-31-DAC.txt' | while read -r filepath_rel_qc; do
    
    filename=$(basename "$filepath_rel_qc")
    filename_stem="${filename%.txt}"
    
    json_output="../$JSON_DIR/${filename_stem}.json" 
    
    echo "Processing $filename. Using pattern: $filename_stem"
    
    ./bin/qc codes find --json --pattern "$filename_stem" --before 0 --after 0 > "$json_output"
    
    if [ ! -s "$json_output" ]; then
        echo "⚠️ WARNING: $json_output is empty (0 bytes or just []). Pattern used: $filename_stem"
    fi
    
done

# Return to the project root directory
cd "$OLDPWD"
echo "Returned to project root: $PWD"
echo "JSON generation complete."

# --- STEP 2: CALL THE LUA SCRIPT TO GENERATE 0.HTML (ROBUST EXECUTION) ---

LUA_SCRIPT_PATH="$PROJECT_ROOT/assets/qualitative-viz.lua"

echo "Calling Lua script using absolute path and environment variable..."

# Export the absolute path as a reliable environment variable for the Lua filter.
export PROJECT_ROOT_PATH="$PROJECT_ROOT"

# Method A: Use the universal 'pandoc' command with --lua-filter on a dummy file.
# We direct output to /dev/null since the filter writes the real output file.
echo "Attempting method A: pandoc --lua-filter..."
/usr/bin/env pandoc --lua-filter "$LUA_SCRIPT_PATH" /dev/null -o /dev/null

# Check the exit status of the Pandoc command.
if [ $? -ne 0 ]; then
    echo "Pandoc call failed. Attempting method B: Quarto run with standard filter syntax..."
    # Method B: Fallback to Quarto's filter execution command.
    quarto run --filter "$LUA_SCRIPT_PATH" dummy_input.md -o dummy_output.html
fi

echo "HTML generation completed by Lua script."