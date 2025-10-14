-- assets/aggregate_corpus.lua

-- Helper function to read a whole file's content
local function read_file(path)
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    return content
end

-- Function to generate a simple URL-friendly slug
local function to_slug(text)
    -- Text currently looks like: "YYYY-MM-DD-title-slug" (from the caller)
    
    -- 1. Convert to lowercase
    local slug = text:lower()
    -- 2. Replace non-alphanumeric/non-dash/non-underscore with a single dash
    slug = slug:gsub("[^%w%-]", "-")
    -- 3. Replace multiple dashes with a single dash
    slug = slug:gsub("([%-])[%-]+", "%1")
    -- 4. Remove leading/trailing dashes
    slug = slug:gsub("^(%s*[%-]+)", ""):gsub("([%s%-]+)$", "")
    
    return slug
end

-- =======================================================================
-- JSON Decode Setup: Assumes 'dkjson' is installed
-- =======================================================================
local json_decode
do
    local success, dkjson = pcall(require, "dkjson")
    if success then
        json_decode = dkjson.decode
    else
        io.stderr:write("CRITICAL: 'dkjson' library is missing. Install with 'luarocks install dkjson'.\n")
        json_decode = function(str) return {} end
    end
end
-- =======================================================================

-- Define the prefix names for the legend
-- The order here determines the order in the legend.
local prefix_map = {
    -- 10s: People & Roles (Warm: Yellow/Amber Family)
    { code = 10, name = "People" },
    { code = 11, name = "Roles" },
    
    -- 20s: Organizations & Projects (Official/Alert: Red/Rose Family)
    { code = 20, name = "Organizations" },
    { code = 21, name = "Research Consortia" },
    { code = 22, name = "Individual Projects" },

    -- 30s: Activities (Action: Emerald Green)
    { code = 30, name = "Activities" },
    
    -- 40s: Abstractions (Conceptual: Teal/Cyan/Sky Family)
    { code = 41, name = "Kinds of Work" },
    { code = 43, name = "Kinds of Data" },
    { code = 44, name = "Relationships" },
    
    -- 50s: Challenges & Resolutions (Process: Blue/Violet/Indigo Family)
    { code = 51, name = "Goals" },
    { code = 52, name = "Challenges" },
    { code = 53, name = "Means/Mechanisms" },
    { code = 54, name = "Contexts" },
    { code = 55, name = "Hypotheticals" },
    { code = 56, name = "Outcomes" },
    { code = 57, name = "Facilitators" },
    { code = 58, name = "Drivers" },
    
    -- 60s: Figurations & Narrative (Meta: Gray/Brown Family)
    { code = 60, name = "Figurations" },
    { code = 61, name = "Analogies" },
    { code = 62, name = "Stories" },
    { code = 63, name = "Comparisons" },
    
    -- 70s: Concepts (Light Green)
    { code = 70, name = "Concepts" },
    
    -- 80s: Qualities (Lavender)
    { code = 80, name = "Qualities" },
}

-- The main script logic
local function aggregate_corpus()
    -- Get the list of text file paths from command line arguments
    local txt_paths = {}
    for i = 1, #arg do
        table.insert(txt_paths, arg[i])
    end

    if #txt_paths == 0 then
        io.stderr:write("Usage: lua aggregate_corpus.lua <path/to/*.txt>\n")
        return
    end
    
    -- INJECT CSS FOR AESTHETICS AND COLLAPSIBLE FUNCTIONALITY
    print([[
<style>
    /* Base Container and Fonts */
    .corpus-master-container {
        font-family: 'Inter', sans-serif;
        max-width: 1200px;
        margin: 0 auto;
        padding: 20px 0;
    }
    .document-container {
        background-color: #ffffff; /* White background for each doc */
        border-radius: 12px;
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.05);
        margin-bottom: 25px;
        overflow: hidden;
    }

    /* Document Title / Collapse Button */
    .document-title {
        background-color: #1f2937; /* Dark header */
        color: white;
        font-weight: 700;
        font-size: 1.1em;
        width: 100%;
        text-align: left;
        padding: 15px 20px;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        transition: background-color 0.2s;
        border-radius: 12px 12px 0 0;
    }
    .document-title:hover {
        background-color: #374151;
    }
    .toggle-icon {
        margin-right: 15px;
        font-size: 0.8em;
        transition: transform 0.2s;
    }

    /* Grid Layout for Header and Rows (inside document content) */
    .corpus-header-doc-specific, .corpus-row {
        display: grid;
        /* Set the right column to a fixed width (350px) and let the left column take the rest */
        grid-template-columns: auto 350px; 
        gap: 20px;
        padding: 12px 16px;
        align-items: start;
        border-bottom: 1px solid #e5e7eb;
    }

    /* Header Styling for Columns */
    .corpus-header-doc-specific {
        background-color: #f3f4f6; /* Light gray header for column names */
        color: #4b5563;
        font-weight: 600;
        font-size: 0.9em;
        border-bottom: 2px solid #e5e7eb;
        position: sticky;
        top: 0;
        z-index: 5;
    }
    
    /* Document Content (Collapsible) */
    .document-content {
        max-height: 1000vh; /* Large value allows content to transition correctly */
        transition: max-height 0.4s ease-in-out, opacity 0.3s ease;
        overflow: hidden;
    }
    /* Ensure content starts visually closed if collapsed state is set */
    .document-content.collapsed {
        max-height: 0;
        opacity: 0;
        padding: 0;
    }
    
    /* Row Styling */
    .corpus-row:nth-child(odd) {
        background-color: #f9fafb; /* Very light gray stripe */
    }
    .corpus-row:nth-child(even) {
        background-color: #ffffff;
    }
    .corpus-row:hover {
        background-color: #e5e7eb;
    }
    
    /* Text Content */
    .corpus-text {
        font-size: 0.9em;
        line-height: 1.5;
        color: #374151;
    }
    .corpus-text pre {
        margin: 0;
        padding: 0;
        white-space: pre-wrap;
        word-wrap: break-word;
        font-family: inherit;
    }

    /* Code Tags - GUARANTEED LEFT ALIGNMENT */
    .corpus-codes {
        align-self: start !important; 
        text-align: left !important; 
        padding-top: 5px; 
    }
    .code-list {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-start !important; 
        gap: 6px;
        margin-top: -4px; 
        width: 100% !important; 
        text-align: left !important; 
    }
    .code-tag {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.75em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        /* Allow text to wrap within the code pill */
        white-space: normal; 
        word-break: break-word;
        /* Default Gray (Fallback) */
        color: #475569; 
        background-color: #e2e8f0; 
        border: 1px solid #94a3b8; 
    }
    
    /* Highlight Coded Rows */
    .coded-row {
        border-left: 4px solid #3b82f6; /* Blue marker */
        padding-left: 12px !important;
    }

    /* --- LEGEND STYLING (UPDATED FOR 5 COLUMNS & RICHER COLORS) --- */
    .code-legend-container {
        background-color: #f9fafb;
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 25px;
        border: 1px solid #e5e7eb;
    }
    .legend-title {
        font-size: 1.4em;
        font-weight: 700;
        color: #1f2937;
        margin-bottom: 15px;
        padding-bottom: 5px;
        border-bottom: 2px solid #e5e7eb;
    }
    .legend-grid {
        /* CHANGED: 5-column structure for balanced height */
        display: grid; 
        grid-template-columns: repeat(5, 1fr); 
        gap: 20px; /* Space between columns */
    }
    .legend-group {
        /* Vertical stacking within each column */
        display: flex;
        flex-direction: column;
        gap: 5px; /* Vertical spacing inside the column */
        border-right: 1px solid #e5e7eb; /* Subtle separator between columns */
        padding-right: 20px;
    }
    .legend-group:last-child {
        border-right: none;
        padding-right: 0;
    }
    .legend-item {
        display: flex;
        align-items: center;
        font-size: 0.9em;
        color: #374151;
        font-weight: 500;
        padding: 3px 0;
    }
    /* Vertical Separator between prefix groups (10s, 20s, etc.) */
    .legend-group-separator {
        padding-top: 10px !important;
        margin-top: 5px;
        border-top: 1px dashed #cccccc; /* Dashed line for separation */
    }

    .legend-swatch {
        display: block;
        width: 16px;
        height: 16px;
        border-radius: 4px;
        margin-right: 10px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    .legend-name {
        line-height: 1.2;
    }
    /* Ensure the prefix number is correctly bolded */
    .legend-name strong {
        font-weight: 700;
    }


    /* ========================================================= */
    /* PREFIX COLOR PALETTES - RICHER COLORS                     */
    /* ========================================================= */

    /* 10s: People & Roles (Warm: Amber/Orange) */
    .prefix-10-tag, .prefix-10-tag .legend-swatch { background-color: #fcd34d !important; color: #78350f !important; border-color: #fbbf24 !important; } /* Amber 300 */
    .prefix-11-tag, .prefix-11-tag .legend-swatch { background-color: #f59e0b !important; color: #9a3412 !important; border-color: #f97316 !important; } /* Orange 400 */
    
    /* 20s: Organizations & Projects (Official/Alert: Red/Rose) */
    .prefix-20-tag, .prefix-20-tag .legend-swatch { background-color: #f87171 !important; color: #7f1d1d !important; border-color: #ef4444 !important; } /* Red 400 */
    .prefix-21-tag, .prefix-21-tag .legend-swatch { background-color: #f472b6 !important; color: #831843 !important; border-color: #ec4899 !important; } /* Pink 400 */
    .prefix-22-tag, .prefix-22-tag .legend-swatch { background-color: #fb7185 !important; color: #9d174d !important; border-color: #f43f5e !important; } /* Rose 400 */
    
    /* 30s: Activities (Action: Emerald Green) */
    .prefix-30-tag, .prefix-30-tag .legend-swatch { background-color: #34d399 !important; color: #047857 !important; border-color: #10b981 !important; } /* Emerald 400 */
    
    /* 40s: Abstractions (Conceptual: Teal/Cyan/Sky Family) */
    .prefix-41-tag, .prefix-41-tag .legend-swatch { background-color: #2dd4bf !important; color: #0f766e !important; border-color: #14b8a6 !important; } /* Teal 400 (Work) */
    .prefix-43-tag, .prefix-43-tag .legend-swatch { background-color: #22d3ee !important; color: #0e7490 !important; border-color: #06b6d4 !important; } /* Cyan 400 (Data) */
    .prefix-44-tag, .prefix-44-tag .legend-swatch { background-color: #7dd3fc !important; color: #0c4a6e !important; border-color: #38bdf8 !important; } /* Sky 400 (Relationships) */

    /* 50s: Challenges & Resolutions (Process: Blue/Violet/Indigo) */
    .prefix-51-tag, .prefix-51-tag .legend-swatch { background-color: #60a5fa !important; color: #1e40af !important; border-color: #3b82f6 !important; } /* Blue 400 (Goals) */
    .prefix-52-tag, .prefix-52-tag .legend-swatch { background-color: #818cf8 !important; color: #3730a3 !important; border-color: #6366f1 !important; } /* Indigo 400 (Challenges) */
    .prefix-53-tag, .prefix-53-tag .legend-swatch { background-color: #a78bfa !important; color: #5b21b6 !important; border-color: #8b5cf6 !important; } /* Violet 400 (Means) */
    .prefix-54-tag, .prefix-54-tag .legend-swatch { background-color: #c084fc !important; color: #6b21a8 !important; border-color: #a855f7 !important; } /* Purple 400 (Contexts) */
    .prefix-55-tag, .prefix-55-tag .legend-swatch { background-color: #e879f9 !important; color: #9d174d !important; border-color: #d946ef !important; } /* Fuchsia 400 (Hypotheticals) */
    .prefix-56-tag, .prefix-56-tag .legend-swatch { background-color: #a3e635 !important; color: #4f7200 !important; border-color: #84cc16 !important; } /* Lime 400 (Outcomes) */
    .prefix-57-tag, .prefix-57-tag .legend-swatch { background-color: #34d399 !important; color: #065f46 !important; border-color: #10b981 !important; } /* Mint (Emerald 400 with darker text) */
    .prefix-58-tag, .prefix-58-tag .legend-swatch { background-color: #fb923c !important; color: #7c2d12 !important; border-color: #f97316 !important; } /* Orange 400 (Drivers) */
    
    /* 60s: Figurations & Narrative (Meta: Gray/Brown) */
    .prefix-60-tag, .prefix-60-tag .legend-swatch { background-color: #9ca3af !important; color: #374151 !important; border-color: #6b7280 !important; } /* Gray 400 */
    .prefix-61-tag, .prefix-61-tag .legend-swatch { background-color: #a8a29e !important; color: #292524 !important; border-color: #78716c !important; } /* Stone 400 */
    .prefix-62-tag, .prefix-62-tag .legend-swatch { background-color: #fb923c !important; color: #7c2d12 !important; border-color: #f97316 !important; } /* Sand/Orange 400 (Stories) */
    .prefix-63-tag, .prefix-63-tag .legend-swatch { background-color: #60a5fa !important; color: #1e40af !important; border-color: #3b82f6 !important; } /* Light Blue (Comparisons) */

    /* 70s: Concepts (Distinct Green) */
    .prefix-70-tag, .prefix-70-tag .legend-swatch { background-color: #86efac !important; color: #15803d !important; border-color: #4ade80 !important; } /* Lime 300 */
    
    /* 80s: Qualities (Lavender) */
    .prefix-80-tag, .prefix-80-tag .legend-swatch { background-color: #c4b5fd !important; color: #5b21b6 !important; border-color: #a78bfa !important; } /* Lavender 300 */

    /* Mobile Responsiveness */
    @media (max-width: 768px) {
        .corpus-header-doc-specific, .corpus-row {
            grid-template-columns: 1fr; /* Stack columns */
            gap: 10px;
        }
        .corpus-text {
            border-bottom: 1px dashed #ccc;
            padding-bottom: 10px;
        }
        .coded-row {
            border-left: none; 
            border-top: 4px solid #3b82f6; 
        }
        /* Stack the legend groups on mobile */
        .legend-grid {
             grid-template-columns: 1fr; 
        }
        .legend-group {
            border-right: none;
            border-bottom: 1px solid #e5e7eb;
            padding-right: 0;
            padding-bottom: 10px;
            margin-bottom: 10px;
        }
        .legend-group:last-child {
            border-bottom: none;
        }
        .legend-group-separator {
            padding-top: 10px !important;
            margin-top: 5px;
            border-top: 1px dashed #cccccc; 
        }
    }
</style>
<script>
    // --- Cookie Management Functions ---
    function setCookie(name, value, days) {
        let expires = "";
        if (days) {
            const date = new Date();
            // Set cookie expiration 
            date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
            expires = "; expires=" + date.toUTCString();
        }
        // Save the cookie with a 1-year expiration (365 days)
        document.cookie = name + "=" + (value || "") + expires + "; path=/; max-age=" + (days * 24 * 60 * 60); 
    }

    function getCookie(name) {
        const nameEQ = name + "=";
        const ca = document.cookie.split(';');
        for(let i = 0; i < ca.length; i++) {
            let c = ca[i];
            // Trim leading spaces
            while (c.charAt(0) === ' ') c = c.substring(1, c.length);
            // Check if cookie matches name
            if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
        }
        return null;
    }
    // -----------------------------------

    function toggleDocument(slug) {
        const content = document.getElementById('content-' + slug);
        const icon = document.getElementById('icon-' + slug);

        if (content.classList.contains('collapsed')) {
            // EXPAND
            content.classList.remove('collapsed');
            // Setting max-height to scrollHeight initiates the transition
            content.style.maxHeight = content.scrollHeight + "px";
            icon.textContent = '▼';
            // Save state to Cookie
            setCookie('docState-' + slug, 'expanded', 365); 
        } else {
            // COLLAPSE
            // Set max-height before adding 'collapsed' to ensure smooth transition
            content.style.maxHeight = content.scrollHeight + "px"; 
            content.classList.add('collapsed');
            // Timeout needed to allow transition to start from calculated height
            setTimeout(() => {
                content.style.maxHeight = '0'; 
            }, 10);
            icon.textContent = '▶';
            // Save state to Cookie
            setCookie('docState-' + slug, 'collapsed', 365); 
        }
    }

    // Set initial state based on Cookie and handle scroll to hash
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('.document-content').forEach(content => {
            const slug = content.id.replace('content-', '');
            const icon = document.getElementById('icon-' + slug);
            // Read state from Cookie
            const savedState = getCookie('docState-' + slug); 

            // Default to collapsed unless explicitly saved as expanded
            if (savedState === 'expanded') {
                content.classList.remove('collapsed');
                // Use a large value to allow content to flow naturally
                content.style.maxHeight = '1000vh'; 
                icon.textContent = '▼';
            } else {
                // Initial state is collapsed
                icon.textContent = '▶';
                content.classList.add('collapsed');
                content.style.maxHeight = '0'; 
            }
        });

        // Handle URL hash (slug) for direct linking
        if (window.location.hash) {
            const slug = window.location.hash.substring(1); // Remove '#'
            const content = document.getElementById('content-' + slug);
            const container = document.getElementById('doc-' + slug);
            
            if (content && container) {
                let shouldScrollDelay = false;
                
                // If the targeted document is collapsed, expand it
                if (content.classList.contains('collapsed')) {
                    // Call the toggle function to expand and update the Cookie
                    toggleDocument(slug); 
                    shouldScrollDelay = true;
                }
                
                // Scroll the containing element into view, delaying if we just expanded it
                // 450ms is slightly longer than the 0.4s CSS transition
                setTimeout(() => {
                    container.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, shouldScrollDelay ? 450 : 50); 
            }
        }
    });
</script>
    ]])

    -- Start the master container
    print('<div class="corpus-master-container">')

    -- Generate the Code Prefix Legend HTML
    local legend_html = {}
    table.insert(legend_html, '<div class="code-legend-container">')
    table.insert(legend_html, '<h2 class="legend-title">Code Prefix Legend (Grouped by Theme)</h2>')
    table.insert(legend_html, '<div class="legend-grid">')

    local current_group = 1
    local prev_prefix = 0
    table.insert(legend_html, '<div class="legend-group">') -- Start Group 1

    -- Custom index-based breaking logic to create 5 balanced columns
    -- Break indices (i) where the NEW column starts: 6, 10, 15, 18
    -- Sizes: (5, 4, 5, 3, 6)
    for i, item in ipairs(prefix_map) do
        local prefix = math.floor(item.code / 10) * 10
        local next_group_needed = false
        local separator_class = ""

        -- Column Break Logic (based on item index i):
        
        -- 1. Starts Col 2 (after 22, Index 5). Item 6 (30) starts Col 2.
        if i == 6 then 
            next_group_needed = true
            current_group = 2
        -- 2. Starts Col 3 (after 44, Index 9). Item 10 (51) starts Col 3.
        elseif i == 10 then
            next_group_needed = true
            current_group = 3
        -- 3. Starts Col 4 (after 55, Index 14). Item 15 (56) starts Col 4.
        elseif i == 15 then
            next_group_needed = true
            current_group = 4
        -- 4. Starts Col 5 (after 58, Index 17). Item 18 (60) starts Col 5.
        elseif i == 18 then
            next_group_needed = true
            current_group = 5
        end
        
        if next_group_needed then
            table.insert(legend_html, '</div>') -- Close previous legend-group
            table.insert(legend_html, '<div class="legend-group">') -- Start new legend-group
        end

        -- Internal Separators (if prefix changes AND we are NOT starting a new column)
        if prefix ~= prev_prefix and prev_prefix ~= 0 and not next_group_needed then
            separator_class = " legend-group-separator"
        end
        
        -- Add the current item
        table.insert(legend_html, string.format(
            '<div class="legend-item%s"><span class="legend-swatch prefix-%d-tag"></span><span class="legend-name"><strong>%d</strong>: %s</span></div>', 
            separator_class, item.code, item.code, item.name
        ))

        prev_prefix = prefix
    end

    table.insert(legend_html, '</div>') -- Close the last group (Group 5)
    table.insert(legend_html, '</div>') -- Close legend-grid
    table.insert(legend_html, '</div>') -- Close code-legend-container

    -- Print the legend before documents start
    print(table.concat(legend_html, "\n"))


    for _, txt_path in ipairs(txt_paths) do
        local txt_filename = txt_path:match("([^/]+)$")
        -- Generate slug based on filename (without .txt)
        local doc_slug = to_slug(txt_filename:gsub("%.txt$", ""))
        local doc_id = "doc-" .. doc_slug -- ID for the container element
        local json_filename = txt_path:gsub("%.txt$", ".json"):match("([^/]+)$")
        
        -- FIX: Update the JSON path to look inside the new 'json' subdirectory
        local json_path = "qc/json/" .. json_filename 

        -- 1. Read and parse the text file
        local txt_content = read_file(txt_path)
        if not txt_content then
            io.stderr:write("Warning: Could not read text file: " .. txt_path .. "\n")
            goto continue
        end
        local txt_lines = {}
        for line in txt_content:gmatch("([^\n]*)\n?") do
            table.insert(txt_lines, line)
        end
        local num_txt_lines = #txt_lines

        -- 2. Read and parse the JSON file
        local json_content = read_file(json_path)
        local codes_data = {}
        if json_content then
            local ok, result = pcall(json_decode, json_content)
            if ok and type(result) == "table" then
                codes_data = result
            else
                io.stderr:write("Error: JSON parsing failed for " .. json_path .. ".\n")
            end
        else
            io.stderr:write("Warning: Could not read JSON file: " .. json_path .. "\n")
        end

        -- START DOCUMENT WRAPPER
        -- Set ID using the slug for direct linking via URL hash
        print(string.format('<div class="document-container" id="%s">', doc_id))
        -- Use the slug in the toggle function
        print(string.format('<button class="document-title" onclick="toggleDocument(\'%s\')">', doc_slug))
        -- Set default icon to collapsed (will be overridden by JS on DOMContentLoaded if state is expanded)
        print(string.format('<span id="icon-%s" class="toggle-icon">▶</span> Document: %s', doc_slug, txt_filename))
        print('</button>')
        
        -- Column Headers (inside the collapsible section)
        print('<div class="corpus-header-doc-specific">')
        print('  <div class="corpus-header-text">Corpus Text</div>')
        print('  <div class="corpus-header-codes">Codes</div>')
        print('</div>')

        -- Collapsible Content Body
        -- Add 'collapsed' class by default (will be removed by JS if state is expanded/cookie exists)
        print(string.format('<div id="content-%s" class="document-content collapsed">', doc_slug))


        -- 3. Pre-process the codes data into a structure keyed by start line
        local coded_blocks = {}
        for _, block in ipairs(codes_data) do 
            local start_line = block.text_lines[1]
            local end_line = block.text_lines[2]

            if not coded_blocks[start_line] then
                coded_blocks[start_line] = {
                    text = block.text,
                    codes = {},
                    end_line = end_line 
                }
            end

            table.insert(coded_blocks[start_line].codes, block.code)
        end

        -- 4. Combine uncoded and coded text into a final ordered list of blocks
        local final_blocks = {}
        local current_line = 1
        while current_line <= num_txt_lines do
            local current_block = coded_blocks[current_line]

            if current_block then
                -- Coded block found
                table.insert(final_blocks, {
                    text = current_block.text,
                    codes = current_block.codes,
                    is_coded = true
                })
                -- Move the cursor past the lines covered by this block
                current_line = current_block.end_line + 1

            else
                -- Uncoded block: find the next coded block's start line or end of file
                local next_coded_line = num_txt_lines + 1
                for start_line, _ in pairs(coded_blocks) do
                    if start_line > current_line and start_line < next_coded_line then
                        next_coded_line = start_line
                    end
                end

                -- Extract the uncoded text block
                if next_coded_line > current_line then
                    local uncoded_text = table.concat(txt_lines, "\n", current_line, next_coded_line - 1)
                    
                    if not uncoded_text:match("^%s*$") then 
                         table.insert(final_blocks, {
                            text = uncoded_text,
                            codes = {},
                            is_coded = false
                        })
                    end
                end
                
                current_line = next_coded_line
            end
            ::continue_while::
        end


        -- 5. Generate HTML for the blocks 
        for _, block in ipairs(final_blocks) do
            local data_str = "" -- data attributes for the text block

            print('<div class="corpus-row ' .. (block.is_coded and 'coded-row' or 'uncoded-row') .. '">')

            -- Corpus Text Column
            print('  <div class="corpus-text" ' .. data_str .. '>')
            print(string.format('<pre>%s</pre>', block.text:gsub("<", "&lt;"):gsub(">", "&gt;")))
            print('  </div>')

            -- Codes Column
            print('  <div class="corpus-codes">')
            if block.is_coded then
                -- No coloring class needed on the parent div anymore
                print('    <div class="code-list">') 
                for _, code in ipairs(block.codes) do
                    -- Determine the specific color class for THIS tag
                    local tag_color_class = ""
                    -- Match the initial number prefix, even if it's 3 digits (e.g., 41)
                    local prefix = code:match("^(%d+)") 
                    if prefix then
                        tag_color_class = "prefix-" .. prefix .. "-tag"
                    end
                    
                    -- Print the code tag with its specific color class
                    print('      <span class="code-tag ' .. tag_color_class .. '">' .. code .. '</span>')
                end
                print('    </div>')
            end 
            print('  </div>')

            print('</div>')
        end
        
        -- END DOCUMENT WRAPPER
        print('</div>') -- Close document-content (collapsible)
        print('</div>') -- Close document-container

        ::continue::
    end

    print('</div>') -- Close corpus-master-container
end

aggregate_corpus()
