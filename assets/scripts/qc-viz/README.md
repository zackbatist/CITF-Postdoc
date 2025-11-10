# qc-viz: Qualitative Coding Visualization

A tool for visualizing qualitative coding data from the [qualitative-coding](https://github.com/cproctor/qualitative-coding/) Python package within a [Quarto](https://quarto.org/) project.

## Features

- **Interactive filtering** by code categories and individual codes
- **Multi-speaker filtering** with checkbox selection
- **Toggle uncoded segments** visibility
- **Export** to CSV, JSON, Excel, HTML, and PDF with filter parameters documented
- **Collapsible sections** with persistent state between sessions
- **Color-coded tags** for easy code identification
- **Directory-based exclusion** of sensitive or incomplete files

## Installation

1. **Copy the tool** to your project's `assets/scripts/` directory:
   ```
   assets/
   └── scripts/
       └── qc-viz/
           ├── qc-viz.css
           ├── qc-viz.js
           ├── qc-viz-filter.lua
           └── qc-viz-pre-render.sh
   ```

2. **Make the pre-render script executable:**
   ```bash
   chmod +x assets/scripts/qc-viz/qc-viz-pre-render.sh
   ```

3. **Create a trigger document** (e.g., `qc-viz.qmd`):
   ```yaml
   ---
   title: "Qualitative Coding Visualization"
   format:
     html:
       filters:
         - assets/scripts/qc-viz/qc-viz-filter.lua
   ---
   
   This generates the qualitative coding visualization.
   ```

4. **Update your `_quarto.yml`:**
   ```yaml
   project:
     pre-render:
       - bash assets/scripts/qc-viz/qc-viz-pre-render.sh
   ```

## Project Structure

The tool expects the following structure, though all paths are configurable via environment variables:

```
project-root/
├── assets/
│   └── scripts/
│       └── qc-viz/          # Tool files
├── qc/                      # Qualitative coding directory
│   ├── bin/activate         # Python venv (optional)
│   ├── corpus/              # Text files to analyze
│   │   └── exclude/         # Files to exclude from visualization
│   ├── json/                # Generated JSON (auto-created)
│   └── qc-viz.html          # Generated visualization (auto-created)
└── qc-viz.qmd               # Trigger document
```

## Usage

### Basic Workflow

1. **Code your interviews** using the `qc` command-line tool
2. **Exclude sensitive files** by moving them to `qc/corpus/exclude/`:
   ```bash
   mkdir -p qc/corpus/exclude
   mv qc/corpus/sensitive-interview.txt qc/corpus/exclude/
   ```
3. **Generate visualization:**
   ```bash
   quarto render qc-viz.qmd
   ```
4. **Open in browser:** `qc/qc-viz.html`

### Excluding Files

To exclude files from the visualization, simply move them to the `exclude/` subdirectory:

```bash
mkdir -p qc/corpus/exclude
mv qc/corpus/file-to-exclude.txt qc/corpus/exclude/
```

Files in `qc/corpus/exclude/` are:
- Skipped during JSON generation
- Not included in the visualization
- Still available for coding with the `qc` tool

This is useful for:
- Incomplete or in-progress interviews
- Sensitive data that shouldn't be visualized
- Test files or drafts
- Files that need further review before inclusion

## Configuration

qc-viz supports flexible configuration through a YAML file or environment variables. Configuration precedence (highest to lowest):

1. Environment variables
2. YAML configuration file
3. Default values

### Configuration File

Create a `qc-viz-config.yaml` file in your project root (or specify a custom location with the `QC_VIZ_CONFIG` environment variable):

```yaml
# See assets/scripts/qc-viz/qc-viz-config.yaml for full example

directories:
  qc_dir: "qc"
  corpus_dir: "qc/corpus"
  exclude_dir: "qc/corpus/exclude"

code_filters:
  blacklist:
    enabled: true
    branches:
      - name: "old_codes"
        recursive: true

code_schema:
  categories:
    "51": "Goals"
    "52": "Challenges"
  colors:
    "51": "#C2185B"
    "52": "#AD1457"
```

### Code Filtering

qc-viz provides powerful filtering to include or exclude codes from visualization. This is especially useful for:
- Excluding orphaned or deprecated codes
- Hiding codes under an "old_codes" branch
- Working with multiple codebooks
- Focusing on specific code categories

**Whitelist Mode** (include only specific codes):
```yaml
code_filters:
  whitelist:
    enabled: true
    codes:                    # Specific codes
      - "51_02_Initial_goals"
      - "62_01_Origin_story"
    prefixes:                 # Johnny Decimal prefixes
      - "51_"
      - "52_"
    prefix_ranges:            # Ranges of prefixes
      - "50-59"               # Codes 50_ through 59_
    patterns:                 # Regex patterns
      - ".*_goals$"           # Codes ending with _goals
    branches:                 # Code tree branches
      - name: "challenges"
        recursive: true       # Include all child codes
```

**Blacklist Mode** (exclude specific codes):
```yaml
code_filters:
  blacklist:
    enabled: true
    codes:                    # Specific codes to exclude
      - "99_test_code"
    prefixes:                 # Exclude by prefix
      - "99_"
    prefix_ranges:            # Exclude prefix ranges
      - "90-99"
    patterns:                 # Regex patterns
      - ".*_old$"             # Exclude codes ending with _old
    branches:                 # Exclude entire branches
      - name: "old_codes"
        recursive: true       # Exclude all descendants
      - name: "drafts"
        recursive: false      # Only exclude exact match
```

**Filtering Logic:**
- If whitelist is enabled, ONLY whitelisted codes are included (blacklist is ignored)
- If whitelist is disabled, all codes are included EXCEPT blacklisted ones
- Multiple filter types within a mode are combined with OR logic
- Use `recursive: true` for branches to exclude all descendants
- Use `recursive: false` to match only the exact branch name

**Common Use Cases:**

```yaml
# Exclude old/deprecated codes
code_filters:
  blacklist:
    enabled: true
    branches:
      - name: "old_codes"
        recursive: true
      - name: "deprecated"
        recursive: true

# Focus on specific analysis (goals and challenges only)
code_filters:
  whitelist:
    enabled: true
    prefix_ranges:
      - "50-59"

# Exclude test codes and temporary annotations
code_filters:
  blacklist:
    enabled: true
    patterns:
      - "^test_"
      - "^temp_"
      - ".*_draft$"
```

## Customizing Code Schema

The tool uses a [Johnny Decimal](https://johnnydecimal.com/)-style coding system by default. To customize for your project:

### Edit Code Categories

In `assets/scripts/qc-viz/qc-viz-filter.lua`, modify the `code_schema` table:

```lua
local code_schema = {
  ["10"] = "People",
  ["11"] = "Roles and positions",
  ["20"] = "Organizations",
  -- Add your categories...
}
```

### Edit Code Colors

In the same file, modify `get_prefix_color()`:

```lua
local function get_prefix_color(prefix)
  local colors = {
    ["10"] = "#2196F3",  -- Blue for People
    ["20"] = "#FF9800",  -- Orange for Organizations
    -- Add your colors...
  }
  return colors[prefix] or "#757575"  -- Default gray
end
```

> **Note:** Future versions may read the code schema from a configuration file automatically.

## Data Formats

### Corpus Files

Text files should use speaker attributions:

```
Interviewer: Can you tell me about your experience?
Participant: Well, it started when I joined the project...
Interviewer: What happened next?
Participant: Then we discovered an interesting pattern.
```

Lines without a speaker prefix inherit the most recent speaker.

### JSON Output

The tool processes JSON generated by:
```bash
qc codes find --json --pattern filename.txt --before 0 --after 0
```

Expected structure:
```json
[
  {
    "document": "interview.txt",
    "line": 3,
    "code": "51_02_Initial_goals",
    "text_lines": [3, 4],
    "text": "Full text of the coded segment..."
  }
]
```

**Note:** Line numbers are 0-indexed in JSON but the tool handles conversion automatically.

## Features in Detail

### Filtering

- **Code categories:** Click colored blocks to expand and see all codes in that category
- **Individual codes:** Check/uncheck specific codes within categories
- **Speakers:** Select which speakers to show (supports multiple selection)
- **Uncoded segments:** Toggle visibility of lines without codes
- **Status indicators:** Visual feedback shows which filters are active

### Exporting

All export formats include:
- Currently visible data based on active filters
- Complete documentation of filter parameters
- Export timestamp and record count

Supported formats:
- **CSV** - With commented header containing filter info
- **JSON** - Structured data with metadata
- **Excel** - Multiple sheets (data + filter info)
- **HTML** - Standalone formatted document
- **PDF** - Print-ready document

### State Persistence

The tool remembers between sessions:
- Which interview sections are collapsed/expanded
- Which code filter dropdowns are open/closed
- Which codes are selected/deselected
- Which speakers are selected
- Whether uncoded segments are visible

This uses browser LocalStorage and is specific to each browser/device.

## Security and Privacy

### Sensitive Data Handling

The tool:
- ✅ Runs entirely locally (no external data transmission)
- ✅ Generates a self-contained HTML file
- ✅ Embeds all data in the output file
- ❌ Does not anonymize or redact content automatically

**Important:** The generated HTML file contains all visible text from your corpus files. Handle it appropriately:

- Use the `exclude/` directory for sensitive files
- Configure [Quarto render targets](https://quarto.org/docs/projects/quarto-projects.html#render-targets) to exclude sensitive directories
- Add output files to `.gitignore` if working with private repositories
- Consider using [git submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules) for private data
- Maintain separate projects for analysis vs. publication

### Export Libraries

The export functionality loads these libraries from CDN:
- [SheetJS](https://cdn.sheetjs.com/) (xlsx.js) for Excel export
- [jsPDF](https://cdnjs.cloudflare.com) for PDF generation

These run in your browser and don't transmit data externally.

## Browser Compatibility

**Supported:**
- Chrome/Edge (v90+)
- Firefox (v88+)
- Safari (v14+)

**Requirements:**
- JavaScript enabled
- LocalStorage enabled (for state persistence)
- Modern CSS support (grid, flexbox)

## Troubleshooting

### JSON files not generating

**Symptoms:** No JSON files in `qc/json/` after rendering

**Solutions:**
- Check `qc` is installed: `qc --version`
- Verify virtual environment path exists
- Ensure corpus files exist in `qc/corpus/`
- Check files aren't in the exclude directory
- Look for error messages in Quarto render output

### HTML file empty or incomplete

**Symptoms:** Generated HTML has no content or missing interviews

**Solutions:**
- Verify JSON files were created successfully
- Check JSON structure matches expected format
- Ensure text files use the correct speaker format
- Verify line numbers in JSON match corpus files

### Codes not appearing

**Symptoms:** Tables show text but no code tags

**Solutions:**
- Check that coding was done with `qc` tool
- Verify JSON contains code data
- Ensure code prefixes match the schema (e.g., "51_", "62_")
- Check that codes follow the naming convention

### Styling issues

**Symptoms:** Layout problems, missing colors, or alignment issues

**Solutions:**
- Clear browser cache
- Verify CSS file path is correct
- Check browser console for errors
- Try opening in a different browser

### State not persisting

**Symptoms:** Filter selections reset on page reload

**Solutions:**
- Enable LocalStorage in browser settings
- Check browser privacy settings
- Try clearing LocalStorage and reloading
- Verify JavaScript is enabled

## Technical Details

### Architecture

The tool consists of:

1. **Bash script** (`qc-viz-pre-render.sh`): Generates JSON from corpus files
2. **Lua filter** (`qc-viz-filter.lua`): Processes JSON and generates HTML
3. **CSS** (`qc-viz.css`): Styling and layout
4. **JavaScript** (`qc-viz.js`): Interactivity and state management

### Workflow

```
Corpus files (.txt) 
    ↓
qc tool (coding)
    ↓
Bash script (JSON generation)
    ↓
Lua filter (HTML generation)
    ↓
qc-viz.html (visualization)
```

### Dependencies

**Runtime:**
- Bash shell
- Python with `qualitative-coding` package
- Quarto (v1.3+)
- Modern web browser

**Optional:**
- Python virtual environment
- Git (for version control)

## License

This tool is designed to work with the qualitative-coding Python package and Quarto.
Adapt and use freely in your own projects.

## Credits

- Built for use with [qualitative-coding](https://github.com/cproctor/qualitative-coding/) by Chris Proctor
- Designed for integration with [Quarto](https://quarto.org/) projects
- Developed by Zack Batist

## Contributing

Found a bug or have a feature request? Please open an issue or submit a pull request.

## Version History

- **v1.0** (2024): Initial release with core features
  - Interactive filtering
  - Multi-speaker support
  - Export functionality
  - Directory-based exclusion