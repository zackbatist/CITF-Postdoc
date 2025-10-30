#!/bin/bash

# Pre-render script to generate JSON files from qc database
# This script is context-agnostic and works with any qualitative-coding project
# Place this in: assets/qc-viz/qc-viz-pre-render.sh

set -e

# Configuration - can be overridden by environment variables
QC_DIR="${QC_DIR:-qc}"
QC_VENV="${QC_VENV:-${QC_DIR}/bin/activate}"
QC_CORPUS_DIR="${QC_CORPUS_DIR:-${QC_DIR}/corpus}"
QC_JSON_DIR="${QC_JSON_DIR:-${QC_DIR}/json}"

# List of files to exclude (can be set via QC_EXCLUDE_FILES env var)
# Format: space-separated list of basenames
if [ -z "$QC_EXCLUDE_FILES" ]; then
    # Default exclusions - override by setting QC_EXCLUDE_FILES=""
    EXCLUDE_ARRAY=()
else
    IFS=' ' read -r -a EXCLUDE_ARRAY <<< "$QC_EXCLUDE_FILES"
fi

# Check if virtual environment exists
if [ ! -f "$QC_VENV" ]; then
    echo "WARNING: Virtual environment not found at $QC_VENV"
    echo "Attempting to run qc without activating venv..."
else
    # Activate virtual environment
    source "$QC_VENV"
fi

# Create json directory if it doesn't exist
mkdir -p "$QC_JSON_DIR"

# Get all txt files in corpus directory
if [ ! -d "$QC_CORPUS_DIR" ]; then
    echo "ERROR: Corpus directory not found at $QC_CORPUS_DIR"
    exit 1
fi

cd "$QC_DIR"

for file in corpus/*.txt; do
    # Check if glob matched anything
    if [ ! -f "$file" ]; then
        echo "WARNING: No .txt files found in corpus/"
        cd ..
        exit 0
    fi
    
    basename=$(basename "$file")
    
    # Check if file should be excluded
    skip=false
    for exclude in "${EXCLUDE_ARRAY[@]}"; do
        if [[ "$basename" == "$exclude" ]]; then
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

# Deactivate venv if it was activated
if [ -n "$VIRTUAL_ENV" ]; then
    deactivate
fi

echo "JSON generation complete"