#!/bin/bash

# Pre-render script to generate JSON files from qc database
# Place this in the project root: CITF-Postdoc/assets/coding-viz-pre-render.sh

set -e

# Activate virtual environment
source qc/bin/activate

# Create json directory if it doesn't exist
mkdir -p qc/json

# List of files to exclude
EXCLUDE_FILES=(
    "2025-03-26-x.txt"
    "2025-04-07-JBergeron.txt"
    "2025-07-31-DAC.txt"
)

# Get all txt files in corpus directory
cd qc
for file in corpus/*.txt; do
    basename=$(basename "$file")
    
    # Check if file should be excluded
    skip=false
    for exclude in "${EXCLUDE_FILES[@]}"; do
        if [[ "$basename" == "$(basename "$exclude")" ]]; then
            skip=true
            break
        fi
    done
    
    if [ "$skip" = true ]; then
        echo "Skipping excluded file: $basename"
        continue
    fi
    
    # Generate JSON for this file
    echo "Generating JSON for: $basename"
    qc codes find --json --pattern "$basename" --before 0 --after 0 > "json/${basename%.txt}.json"
done

cd ..
deactivate

echo "JSON generation complete"