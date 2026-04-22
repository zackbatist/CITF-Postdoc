#!/bin/bash
# Pre-render script to generate JSON files from qc database
# This script is context-agnostic and works with any qualitative-coding project
# Place this in: qc-atelier/shared/qc-pre-render.sh
set -e

# Function to read YAML config (simple parser for our needs)
read_yaml_config() {
    local config_file="${1:-qc-atelier-config.yaml}"
    if [ ! -f "$config_file" ]; then
        return 1
    fi

    # Extract directory and file configurations.
    # Strip inline comments (# ...) and surrounding whitespace after the value.
    _parse_yaml_value() {
        grep "^  ${1}:" "$2" \
            | sed 's/.*: *//' \
            | sed 's/[[:space:]]*#.*//' \
            | sed 's/^"\(.*\)"$/\1/' \
            | tr -d '"' \
            | tr -d "'" \
            | sed 's/[[:space:]]*$//'
    }

    QC_DIR_FROM_CONFIG=$(_parse_yaml_value "qc_dir" "$config_file")
    QC_CORPUS_DIR_FROM_CONFIG=$(_parse_yaml_value "corpus_dir" "$config_file")
    QC_EXCLUDE_DIR_FROM_CONFIG=$(_parse_yaml_value "exclude_dir" "$config_file")
    QC_JSON_DIR_FROM_CONFIG=$(_parse_yaml_value "json_dir" "$config_file")
    QC_VENV_FROM_CONFIG=$(_parse_yaml_value "venv" "$config_file")

    return 0
}

# Try to load config file
CONFIG_FILE="${QC_ATELIER_CONFIG:-qc-atelier-config.yaml}"
if read_yaml_config "$CONFIG_FILE"; then
    echo "Loaded configuration from: $CONFIG_FILE"
fi

# Configuration - Environment variables take precedence, then config file, then defaults
QC_DIR="${QC_DIR:-${QC_DIR_FROM_CONFIG:-qc}}"
QC_VENV="${QC_VENV:-${QC_VENV_FROM_CONFIG:-${QC_DIR}/bin/activate}}"
QC_CORPUS_DIR="${QC_CORPUS_DIR:-${QC_CORPUS_DIR_FROM_CONFIG:-${QC_DIR}/corpus}}"
QC_EXCLUDE_DIR="${QC_EXCLUDE_DIR:-${QC_EXCLUDE_DIR_FROM_CONFIG:-${QC_CORPUS_DIR}/exclude}}"
QC_JSON_DIR="${QC_JSON_DIR:-${QC_JSON_DIR_FROM_CONFIG:-${QC_DIR}/json}}"

echo "Using configuration:"
echo "  QC_DIR: $QC_DIR"
echo "  QC_CORPUS_DIR: $QC_CORPUS_DIR"
echo "  QC_EXCLUDE_DIR: $QC_EXCLUDE_DIR"
echo "  QC_JSON_DIR: $QC_JSON_DIR"

# Check if virtual environment exists
if [ ! -f "$QC_VENV" ]; then
    echo "WARNING: Virtual environment not found at $QC_VENV"
    echo "Attempting to run qc without activating venv..."
else
    echo "Activating virtual environment: $QC_VENV"
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
    if [ ! -f "$file" ]; then
        echo "WARNING: No .txt files found in corpus/"
        cd ..
        exit 0
    fi

    basename=$(basename "$file")

    if [ -d "$QC_EXCLUDE_DIR" ] && [ -f "${QC_EXCLUDE_DIR}/${basename}" ]; then
        echo "Skipping excluded file: $basename (found in exclude/)"
        continue
    fi

    echo "Generating JSON for: $basename"
    qc codes find --json --pattern "$basename" --before 0 --after 0 > "json/${basename%.txt}.json"
done
cd ..

if [ -n "$VIRTUAL_ENV" ]; then
    deactivate
fi

echo "JSON generation complete"