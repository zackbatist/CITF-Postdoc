#!/bin/sh

# 1. Generate all required JSON files using the qc tool
echo "--- Starting JSON Generation ---"

# Change directory to 'qc/' where the settings.yaml and project database reside.
(
    cd qc || exit 1 
    
    # Create the dedicated directory for JSON output
    mkdir -p json
    echo "JSON output directory created at qc/json/"
    
    # Temporarily copy files from 'corpus/' to the current directory (qc/) 
    # so the 'qc codes find' command can work with just the filename.
    echo "Copying corpus files to qc/ for qc tool execution..."
    cp corpus/*.txt .
    
    # Run the command for each file now located directly in the qc/ directory.
    for TXT_FILE in *.txt; do
        # Skip the loop if no files were copied (e.g., if another .txt exists)
        if [ "$TXT_FILE" = "*.txt" ]; then
            continue
        fi

        FILENAME=$(basename "$TXT_FILE")
        JSON_OUT_PATH="json/${FILENAME%.txt}.json" 
        
        echo "Generating codes for $FILENAME -> $JSON_OUT_PATH"
        
        # Execute the qc command. Output is piped to the new json/ subdirectory.
        qc codes find -rjp "$FILENAME" > "$JSON_OUT_PATH"
    done
    
    # Clean up the temporary files from the qc/ directory
    echo "Cleaning up temporary corpus files..."
    rm *.txt

)

# 2. Run the Lua aggregator filter 
echo "--- Starting Lua Aggregation ---"
# This is executed back in the CITF-Postdoc root directory.
/opt/homebrew/bin/lua assets/aggregate_corpus.lua qc/corpus/*.txt > qc/aggregated_corpus.html

echo "--- Pre-render complete ---"
