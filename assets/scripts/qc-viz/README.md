# qc-viz: Qualitative Coding Visualization

A tool for visualizing qualitative coding data from the [qualitative-coding](https://github.com/cproctor/qualitative-coding/) Python package within a [Quarto](https://quarto.org/) project.

## Features

- Interactive filtering by code categories and individual codes
- Multi-speaker filtering
- Toggle visibility of uncoded segments
- Export to CSV, JSON, Excel, HTML, and PDF
- Collapsible interview sections with persistent state
- Color-coded tags for easy code identification

## Installation

1. Copy the `qc-viz` directory to your project's `assets/` folder:
   ```
   assets/
   └── qc-viz/
       ├── qc-viz.css
       ├── qc-viz.js
       ├── qc-viz-filter.lua
       └── qc-viz-pre-render.sh
   ```

2. Make the pre-render script executable:
   ```bash
   chmod +x assets/qc-viz/qc-viz-pre-render.sh
   ```

3. Create a trigger document (e.g., `qc-viz.qmd`):
   ```yaml
   ---
   title: "Qualitative Coding Visualization"
   format:
     html:
       filters:
         - assets/qc-viz/qc-viz-filter.lua
   ---
   
   This generates the qualitative coding visualization.
   ```

4. Update your `_quarto.yml`:
   ```yaml
   project:
     pre-render:
       - bash assets/qc-viz/qc-viz-pre-render.sh
   ```

## Project Structure Requirements

I tried to make this as context-agnostic as possible, but you may need to adapt paths and configurations to fit your own project structure.
For clarity, I refer to the root of your project as `project-root/`, and here is a diagram of the expected structure:

```project-root/
├── assets/
│   └── qc-viz/          # This tool's files
├── qc/                  # Qualitative coding directory (configurable)
│   ├── bin/activate     # Python venv (optional)
│   ├── corpus/          # Text files (.txt)
│       └── exclude/     # Corpus files to exclude from qc-viz
│   ├── json/            # Generated JSON (auto-created)
│   └── qc-viz.html      # Generated output (auto-created)
└── qc-viz.qmd           # Trigger document
```

## Configuration

All paths and settings can be customized via environment variables:

### Bash Script Configuration

Set these in your environment or `_quarto.yml`:

- `QC_DIR` - Base directory for qualitative coding files (default: `qc`)
- `QC_VENV` - Path to Python virtual environment activation script (default: `${QC_DIR}/bin/activate`)
- `QC_CORPUS_DIR` - Directory containing corpus text files (default: `${QC_DIR}/corpus`)
- `QC_JSON_DIR` - Directory for generated JSON files (default: `${QC_DIR}/json`)
- `QC_EXCLUDE_FILES` - Space-separated list of files to exclude (default: none)

Example in `_quarto.yml`:
```yaml
project:
  pre-render:
    - bash -c "QC_EXCLUDE_FILES='interview-1.txt interview-2.txt' bash assets/qc-viz/qc-viz-pre-render.sh"
```

### Lua Filter Configuration

Set these as environment variables:

- `QC_DIR` - Base directory (default: `qc`)
- `QC_OUTPUT_FILE` - Output filename (default: `qc-viz.html`)
- `QC_CSS_FILE` - Path to CSS file (default: `assets/qc-viz/qc-viz.css`)
- `QC_JS_FILE` - Path to JavaScript file (default: `assets/qc-viz/qc-viz.js`)

Example in `_quarto.yml`:
```yaml
project:
  pre-render:
    - bash -c "export QC_DIR=qualitative-data && bash assets/qc-viz/qc-viz-pre-render.sh"
```

## Code Schema Customization

I use a [Johnny Decimal](https://johnnydecimal.com/) system to organize codes into categories.
I may adapt this tool to read from the code schema file in the future, but for now, you can customize categories and colors directly in the Lua filter.

To customize code categories, edit the `code_schema` table in `qc-viz-filter.lua`:

```lua
local code_schema = {
  ["10"] = "People",
  ["11"] = "Roles and positions",
  -- Add your own categories...
}
```

And update colors in `get_prefix_color()`:

```lua
local function get_prefix_color(prefix)
  local colors = {
    ["10"] = "#2196F3",
    -- Add your own colors...
  }
  return colors[prefix] or "#757575"
end
```

## Usage

1. Code your corpus files using the `qc` command-line tool
2. Run `quarto render` or `quarto render qc-viz.qmd`
3. Open the generated `qc/qc-viz.html` in your browser

## Data Format

The tool works with the JSON output from:
```bash
qc codes find --json --pattern filename.txt --before 0 --after 0
```

Expected JSON structure:
```json
[
  {
    "document": "interview.txt",
    "line": 3,
    "code": "51_02_Goals",
    "text_lines": [3, 4],
    "text": "Full text of the coded segment..."
  }
]
```

## Corpus File Format

Text files should have speaker attributions in the format:
```
Speaker Name: Text content here...
Another Speaker: More content...
```

Lines without a speaker prefix inherit the most recent speaker.

## Sensitive Data

The tool is designed to extract data from your corpus files and generate an HTML visualization.
No sensitive data is transmitted externally, but sensitive information may be included in the generated HTML file.
Ensure that you handle and share the output file appropriately.
For instance, you may want to apply custom Quarto [render targets](https://quarto.org/docs/projects/quarto-projects.html#render-targets) to exclude files and directories containing sensitive information, use .gitignore to prevent committing sensitive data, maintain your working directory as a private or local [git submodule](https://zackbatist.info/CITF-Postdoc/posts/tech-specs.html#git-submodules), or maintain a separate project for visualization purposes.

## Portability

The generated HTML file is completely self-contained with:
- Embedded CSS and JavaScript
- No external dependencies (except CDN libraries for export functionality)
- Can be shared, archived, or hosted anywhere

## Browser Compatibility

- Modern browsers (Chrome, Firefox, Safari, Edge)
- JavaScript must be enabled
- LocalStorage used for state persistence (optional)

## Troubleshooting

### JSON files not generating
- Check that `qc` is installed: `qc --version`
- Verify the virtual environment path
- Ensure corpus files exist in the correct directory

### HTML not generated
- Check Quarto render output for errors
- Verify paths in configuration
- Ensure JSON files were created successfully

### Codes not appearing
- Verify JSON structure matches expected format
- Check that line numbers are 0-indexed in JSON
- Ensure text files aren't empty

## License

This tool is designed to work with the qualitative-coding Python package.
Adapt and use freely in your own projects.

## Credits

Built for use with [qualitative-coding](https://github.com/cproctor/qualitative-coding/) by Chris Proctor.