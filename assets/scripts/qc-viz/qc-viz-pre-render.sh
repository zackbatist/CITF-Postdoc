#!/bin/bash

# Pre-render script to generate JSON files from qc database
# This script is context-agnostic and works with any qualitative-coding project
# Place this in: assets/scripts/qc-viz/qc-viz-pre-render.sh

set -e

# Function to read YAML config (simple parser for our needs)
read_yaml_config() {
    local config_file="${1:-qc-viz-config.yaml}"
    
    if [ ! -f "$config_file" ]; then
        return 1
    fi
    
    # Extract directory configurations
    QC_DIR_FROM_CONFIG=$(grep "^  qc_dir:" "$config_file" | sed 's/.*: *"\?\([^"]*\)"\?.*/\1/' | tr -d '"')
    QC_CORPUS_DIR_FROM_CONFIG=$(grep "^  corpus_dir:" "$config_file" | sed 's/.*: *"\?\([^"]*\)"\?.*/\1/' | tr -d '"')
    QC_EXCLUDE_DIR_FROM_CONFIG=$(grep "^  exclude_dir:" "$config_file" | sed 's/.*: *"\?\([^"]*\)"\?.*/\1/' | tr -d '"')
    QC_JSON_DIR_FROM_CONFIG=$(grep "^  json_dir:" "$config_file" | sed 's/.*: *"\?\([^"]*\)"\?.*/\1/' | tr -d '"')
    
    # Extract file configurations
    QC_VENV_FROM_CONFIG=$(grep "^  venv:" "$config_file" | sed 's/.*: *"\?\([^"]*\)"\?.*/\1/' | tr -d '"')
    
    return 0
}

# Try to load config file
CONFIG_FILE="${QC_VIZ_CONFIG:-qc-viz-config.yaml}"
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
    # Activate virtual environment
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
    # Check if glob matched anything
    if [ ! -f "$file" ]; then
        echo "WARNING: No .txt files found in corpus/"
        cd ..
        exit 0
    fi
    
    basename=$(basename "$file")
    
    # Check if file exists in exclude directory
    if [ -d "$QC_EXCLUDE_DIR" ] && [ -f "${QC_EXCLUDE_DIR}/${basename}" ]; then
        echo "Skipping excluded file: $basename (found in exclude/)"
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
#!/bin/bash

# Pre-render script to generate JSON files from qc database
# This script is context-agnostic and works with any qualitative-coding project
# Place this in: assets/scripts/qc-viz/qc-viz-pre-render.sh

set -e

# Configuration - can be overridden by environment variables
QC_DIR="${QC_DIR:-qc}"
QC_VENV="${QC_VENV:-${QC_DIR}/bin/activate}"
QC_CORPUS_DIR="${QC_CORPUS_DIR:-${QC_DIR}/corpus}"
QC_EXCLUDE_DIR="${QC_EXCLUDE_DIR:-${QC_CORPUS_DIR}/exclude}"
QC_JSON_DIR="${QC_JSON_DIR:-${QC_DIR}/json}"

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
    
    # Check if file exists in exclude directory
    if [ -d "$QC_EXCLUDE_DIR" ] && [ -f "${QC_EXCLUDE_DIR}/${basename}" ]; then
        echo "Skipping excluded file: $basename (found in exclude/)"
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