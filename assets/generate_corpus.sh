#!/bin/bash

# --- 1. Robust Path Setup ---
# Calculate the absolute path to the directory containing this script ('assets/').
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd -P)

# The documents are in 'qc/corpus', which is one level up from 'assets'
ASSETS_DIR="${SCRIPT_DIR}/../qc/corpus" 

# The Lua script ('aggregate_corpus.lua') is in the SAME directory as this script:
# LUA_SCRIPT="${SCRIPT_DIR}/aggregate_corpus.lua"
LUA_SCRIPT="${SCRIPT_DIR}/x.lua"


# --- 2. Exclusion List ---
declare -a EXCLUDED_DOCUMENTS=(
    "2025-03-26-x"
    "2025-04-07-JBergeron"
    "2025-07-31-DAC"
)


# --- 3. File Processing Logic (Uses Process Substitution for portability) ---
declare -a FILES_TO_PROCESS=()
FOUND_COUNT=0
SKIPPED_COUNT=0

# The process substitution < <(...) ensures the counters are updated correctly
while IFS= read -r -d $'\0' file_path; do
    
    [[ -z "$file_path" ]] && continue
    
    FOUND_COUNT=$((FOUND_COUNT + 1))
    
    # Extract the base name (e.g., "2025-03-26")
    filename=$(basename "$file_path")
    base_name="${filename%.*}"
    
    # Check for exclusion
    IS_EXCLUDED=0
    for excluded_name in "${EXCLUDED_DOCUMENTS[@]}"; do
        if [[ "$base_name" == "$excluded_name" ]]; then
            IS_EXCLUDED=1
            break
        fi
    done
    
    if [ "$IS_EXCLUDED" -eq 1 ]; then
        echo "Excluding: $file_path" >&2
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue # Skip to the next file
    fi
    
    # Add the file path to the processing array
    FILES_TO_PROCESS+=("$file_path")

done < <(find "${ASSETS_DIR}" -type f \( -name "*.txt" -o -name "*.corpus" \) -print0)

# --- 4. Execution and Reporting ---

echo "" >&2
echo "--- AGGREGATION REPORT ---" >&2
echo "Searching in: ${ASSETS_DIR}" >&2
echo "Total files found: $FOUND_COUNT" >&2
echo "Files skipped: $SKIPPED_COUNT" >&2
echo "Files to process: ${#FILES_TO_PROCESS[@]}" >&2

if [ ${#FILES_TO_PROCESS[@]} -gt 0 ]; then
    echo "Processing ${#FILES_TO_PROCESS[@]} file(s) with ${LUA_SCRIPT}..." >&2
    echo "---------------------------" >&2
    lua "${LUA_SCRIPT}" "${FILES_TO_PROCESS[@]}"
else
    echo "---------------------------" >&2
    echo "ERROR: No valid files remained after filtering. Lua script not executed." >&2
    exit 1
fi