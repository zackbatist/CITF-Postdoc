// qc-reflect.js
// Code system reflection tool for qualitative data analysis.
// Data injected by qc-reflect-filter.lua:
//   CODEBOOK_TREE, CORPUS_INDEX, COOC_DATA, ALL_CODES, DOC_NAMES, REFLECT_CONFIG

window.onerror = function(msg, src, line, col, err) {
  console.error('[qc-reflect error]', msg, 'at', src + ':' + line);
  if (err && err.stack) console.error(err.stack);
  return false;
};

(function() {
'use strict';

const API = 'http://localhost:' + (REFLECT_CONFIG.server_port || 8080);

const SYSTEM_PROMPT = 'You are assisting with qualitative data analysis following constructivist grounded theory (Charmaz) and Saldana\'s coding methods.\n\nKEY PRINCIPLES:\n- Coding is iterative. Initial coding produces many codes; focused coding selects those with enough analytic weight to anchor emerging categories.\n- Multiple codes on the same passage is expected. Each captures a different analytical dimension.\n- Codes are researcher constructions, not objective categories.\n- Your role is to give the researcher FEEDBACK on their own coding practice: where application diverges from intent, where patterns are inconsistent, where the code system could be more comprehensive.\n\nCITATION FORMAT: always cite corpus passages as [DocName:LineNum], e.g. [BMazer:125].';

var state = {
  selectedCodes:  [],
  treeCollapsed:  new Set(),
  treeSearch:     '',
  running:        false,
  progress:       '',
  startedAt:      null,
  docsData:       null,
  reports:        [],
  activeReportId: null,
  showTable:      false,
  priorRuns:      null,
  mockMode:       false,
  showPrompt:     false,
  promptPreview:  null,
};

function h(tag, attrs) {
  var el = document.createElement(tag);
  var children = Array.prototype.slice.call(arguments, 2);
  if (attrs) {
    Object.keys(attrs).forEach(function(k) {
      if (k === 'onClick')        el.addEventListener('click', attrs[k]);
      else if (k === 'onChange')  el.addEventListener('change', attrs[k]);
      else if (k === 'onInput')   el.addEventListener('input', attrs[k]);
      else if (k === 'className') el.className = attrs[k];
      else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(el.style, attrs[k]);
      else if (k === 'disabled')  el.disabled = attrs[k];
      else if (k === 'checked')   el.checked = attrs[k];
      else if (k === 'value')     el.value = attrs[k];
      else if (k === 'type')      el.type = attrs[k];
      else if (k === 'placeholder') el.placeholder = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
  }
  children.forEach(function(c) {
    if (c == null) return;
    if (typeof c === 'string') el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  });
  return el;
}

function isActiveCode(name) {
  if (!name || !String(name).slice(0,2).match(/^[0-9]{2}/)) return false;
  return CODEBOOK_TREE.some(function(n) { return n.name === name; });
}

function activeReport() {
  return state.reports.find(function(r) { return r.id === state.activeReportId; }) || null;
}

function setProgress(msg) { state.progress = msg; }

// ── LLM ───────────────────────────────────────────────────────────────────────

async function ollamaCall(prompt, model) {
  var useModel  = model || REFLECT_CONFIG.ollama_model || 'qwen3.5:35b';
  var ollamaUrl = (REFLECT_CONFIG.ollama_url || 'http://localhost:11434') + '/api/chat';
  var res = await fetch(ollamaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:   useModel,
      stream:  false,
      think:   false,
      options: { temperature: 0, num_ctx: REFLECT_CONFIG.num_ctx || 49152 },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  var data = await res.json();
  var text = (data.message && data.message.content) ? data.message.content : '';
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function ollamaJSON(prompt, model) {
  try {
    var text = await ollamaCall(prompt + '\n\nRespond ONLY with valid JSON, no markdown, no explanation.', model);
    text = text.replace(/```json\n?|```\n?/g, '').trim();
    return JSON.parse(text);
  } catch(e) { console.warn('[ollamaJSON]', e); return null; }
}

// ── Docs cache ────────────────────────────────────────────────────────────────

async function loadDocs() {
  if (state.docsData) return state.docsData;
  try {
    var res  = await fetch(API + '/docs/load?path=' + encodeURIComponent(REFLECT_CONFIG.scheme_path || ''));
    var data = await res.json();
    state.docsData = data.codes || {};
  } catch(e) { state.docsData = {}; }
  return state.docsData;
}

// ── Auto-detect ───────────────────────────────────────────────────────────────

async function runAutoDetect() {
  var docsData = await loadDocs();
  var selected = state.selectedCodes.map(function(s) { return s.name; });
  if (selected.length === 0) return;
  setProgress('Auto-detecting related codes...');
  render();

  var treeLines = ['CODE SYSTEM OUTLINE:'];
  CODEBOOK_TREE.filter(function(n) { return isActiveCode(n.name); }).forEach(function(node) {
    treeLines.push('  '.repeat(node.depth) + node.name + (node.parent ? ' < ' + node.parent : ''));
  });

  var docsLines = ['SELECTED CODE DOCUMENTATION:'];
  selected.forEach(function(name) {
    var doc = docsData[name] || {};
    docsLines.push('');
    docsLines.push(name + ' (uses: ' + ((CORPUS_INDEX[name]||{}).total||0) + ')');
    if (doc.scope)     docsLines.push('  scope: '     + doc.scope);
    if (doc.rationale) docsLines.push('  rationale: ' + doc.rationale);
  });

  var prompt = SYSTEM_PROMPT + '\n\n' + treeLines.join('\n') + '\n\n' + docsLines.join('\n') + '\n\nTASK: Identify other codes in the outline that should be scrutinized alongside the selected codes, based on: similar names, similar documented scope, co-occurrence in corpus, same branch, cross-cutting patterns.\n\nRespond with JSON only:\n{"related_codes": ["code names from the outline"], "reason": "brief explanation"}';

  var result = await ollamaJSON(prompt);
  var found  = (result && result.related_codes) ? result.related_codes : [];
  found.forEach(function(name) {
    var exists = state.selectedCodes.some(function(s) { return s.name === name; });
    var inTree = CODEBOOK_TREE.some(function(n) { return n.name === name; });
    if (!exists && inTree) state.selectedCodes.push({ name: name, auto: true });
  });

  setProgress(''); render();
}

// ── Report generation ─────────────────────────────────────────────────────────

function buildCodesDocs(codeNames, docsData) {
  var lines = [];
  codeNames.forEach(function(name) {
    var doc  = docsData[name] || {};
    var node = CODEBOOK_TREE.find(function(n) { return n.name === name; });
    var exs  = ((CORPUS_INDEX[name] || {}).excerpts || []).slice(0, 8);
    lines.push('');
    lines.push('## ' + name);
    if (node && node.parent) lines.push('Parent: ' + node.parent);
    lines.push('Uses: ' + ((CORPUS_INDEX[name]||{}).total||0));
    if (doc.scope)       lines.push('Scope: '       + doc.scope);
    if (doc.rationale)   lines.push('Rationale: '   + doc.rationale);
    if (doc.usage_notes) lines.push('Usage notes: ' + doc.usage_notes);
    if (exs.length > 0) {
      lines.push('Corpus excerpts:');
      exs.forEach(function(e) {
        var docShort = e.doc.replace(/^\d{4}-\d{2}-\d{2}-/, '');
        lines.push('  [' + docShort + ':' + e.line + '] ' + e.text.slice(0, 200));
      });
    }
  });
  return lines.join('\n');
}

function buildReportPrompt(codes, docsData) {
  var codeNames = codes.map(function(c) { return c.name; });
  var schema = [
    '{',
    '  "per_code": [',
    '    {',
    '      "name": "code name",',
    '      "summary": "how this code is actually being applied in the corpus",',
    '      "misapplications": [',
    '        {',
    '          "doc": "document name (no date prefix)",',
    '          "line": 0,',
    '          "text": "full excerpt text",',
    '          "explanation": "why this diverges from the documented scope or rationale"',
    '        }',
    '      ]',
    '    }',
    '  ],',
    '  "cross_code": {',
    '    "redundancies": [',
    '      {',
    '        "codes": ["code_a", "code_b"],',
    '        "explanation": "how these codes overlap or capture the same phenomenon",',
    '        "passages": [{"doc":"...","line":0,"text":"..."}]',
    '      }',
    '    ],',
    '    "tensions": [',
    '      {',
    '        "codes": ["code_a", "code_b"],',
    '        "explanation": "where the boundary between these codes is blurry or contested",',
    '        "passages": [{"doc":"...","line":0,"text":"..."}]',
    '      }',
    '    ],',
    '    "new_codes": [',
    '      {',
    '        "name": "proposed code name (gerund form)",',
    '        "rationale": "why this code is needed analytically",',
    '        "scope": "what it would capture that is not currently captured",',
    '        "passages": [{"doc":"...","line":0,"text":"..."}]',
    '      }',
    '    ]',
    '  },',
    '  "bottom_line": {',
    '    "assessment": "overall paragraph on the state of coding for these codes",',
    '    "recommendations": ["specific actionable recommendation 1", "..."]',
    '  }',
    '}',
  ].join('\n');

  return SYSTEM_PROMPT + '\n\n=== CODE DOCUMENTATION AND CORPUS APPLICATION ===\n' +
    buildCodesDocs(codeNames, docsData) + '\n\n' +
    'TASK: Produce a structured analytical report on these codes.\n\n' +
    'MOST IMPORTANT: Identify specific passages where application diverges from documented scope.\n' +
    'Be critical and direct — this is feedback for the researcher on their own coding practice.\n' +
    'For new code suggestions: be creative, look for analytical dimensions not currently captured,\n' +
    'and always cite specific passages that motivated the suggestion.\n\n' +
    'Document names: strip any date prefix (e.g. "2026-01-29-BMazer" -> "BMazer").\n\n' +
    'Respond with JSON only — no prose, no markdown, no explanation outside the JSON.\n\n' +
    schema;
}

function buildTablePrompt(reportData, codes) {
  var summary = (reportData.per_code || []).map(function(c) {
    return c.name + ': ' + c.summary + (c.misapplications && c.misapplications.length ?
      ' Misapplications: ' + c.misapplications.map(function(m) { return m.explanation; }).join('; ') : '');
  }).join('\n');
  return 'Given this analytical summary of codes:\n\n' + summary + '\n\nProduce a concise synthesis table for codes: ' + codes.join(', ') + '\n\nColumns: Code, What it actually captures, Key inconsistencies, Analytical level, Relationship to others.\n\nRespond with JSON only:\n{"headers": ["Code", "What it captures", "Key inconsistencies", "Analytical level", "Relationship to others"], "rows": [["code name", "...", "...", "...", "..."]]}';
}

async function runReport() {
  var codes = state.selectedCodes;
  if (codes.length === 0) return;
  state.running   = true;
  state.startedAt = Date.now();
  state.showTable = false;
  state.promptPreview = null;
  setProgress('Loading codebook documentation...');
  render();

  try {
    var docsData = await loadDocs();
    if (state.showPrompt) {
      state.promptPreview = buildReportPrompt(codes, docsData);
      state.running = false;
      setProgress(''); render(); return;
    }
    if (state.mockMode) {
      setProgress('Mock mode...');
      await new Promise(function(r) { setTimeout(r, 600); });
      var names = codes.map(function(c) { return c.name; });
      var mockData = {
        per_code: names.map(function(n) {
          var ex = ((CORPUS_INDEX[n]||{}).excerpts||[]).slice(0,1);
          return {
            name:    n,
            summary: '[MOCK] Applied across ' + ((CORPUS_INDEX[n]||{}).total||0) + ' passages.',
            misapplications: ex.map(function(e) {
              return { doc: e.doc.replace(/^\d{4}-\d{2}-\d{2}-/,''), line: e.line,
                       text: e.text, explanation: '[MOCK] This passage may diverge from documented scope.' };
            }),
          };
        }),
        cross_code: {
          redundancies: [{ codes: names.slice(0,2), explanation: '[MOCK] These codes overlap.',
            passages: [] }],
          tensions: [],
          new_codes: [{ name: 'Mock_new_code', rationale: '[MOCK] A new code is suggested.',
            scope: '[MOCK] Would capture X phenomenon.', passages: [] }],
        },
        bottom_line: {
          assessment: '[MOCK] Overall the coding is reasonable but has some inconsistencies.',
          recommendations: ['[MOCK] Review application of ' + (names[0]||'') + '.'],
        },
      };
      saveReport(codes, mockData, Date.now() - state.startedAt);
      state.running = false; setProgress(''); render(); return;
    }

    setProgress('Generating report...\nSending ' + codes.length + ' codes + corpus excerpts to LLM...');
    render();
    var prompt     = buildReportPrompt(codes, docsData);
    var reportData = await ollamaJSON(prompt);
    var elapsed    = Date.now() - state.startedAt;
    if (!reportData) throw new Error('LLM returned null or unparseable JSON');
    saveReport(codes, reportData, elapsed);
    setProgress('Saving and rendering...');
    render();
    await saveAndRender(codes, reportData, elapsed);
  } catch(e) {
    console.error('[runReport]', e);
    setProgress('Error: ' + (e.message || String(e)));
  }
  state.running = false; setProgress(''); render();
}

function saveReport(codes, reportData, elapsed) {
  var id = 'report_' + Date.now();
  state.reports.unshift({
    id:      id,
    ts:      new Date().toISOString(),
    label:   codes.map(function(c) { return c.name; }).join(' · ').slice(0, 60),
    codes:   codes.map(function(c) { return c.name; }),
    report:  reportText,
    table:   null,
    elapsed: elapsed,
  });
  state.activeReportId = id;
}

async function generateTable() {
  var report = activeReport();
  if (!report) return;
  setProgress('Generating synthesis table...');
  render();
  try {
    var result = await ollamaJSON(buildTablePrompt(report.data, report.codes));
    if (result) { report.table = result; state.showTable = true; }
  } catch(e) { console.error('[generateTable]', e); }
  setProgress(''); render();
}

function buildQMD(codeNames, data, ts, elapsed) {
  var secs = elapsed ? Math.round(elapsed / 1000) : 0;
  var mins = Math.floor(secs / 60);
  var timeStr = mins > 0 ? mins + 'm ' + (secs%60) + 's' : secs + 's';
  var lines = [];

  // YAML front matter
  lines.push('---');
  lines.push('title: "QC Reflect \u2014 ' + codeNames.join(', ') + '"');
  lines.push('date: "' + ts.slice(0,10) + '"');
  lines.push('format:');
  lines.push('  html:');
  lines.push('    theme: cosmo');
  lines.push('    toc: true');
  lines.push('    toc-depth: 3');
  lines.push('    code-fold: true');
  lines.push('    df-print: paged');
  lines.push('---');
  lines.push('');

  // Methods note
  lines.push('::: {.callout-note collapse="true"}');
  lines.push('## Methods note');
  lines.push('');
  lines.push('**Codes analysed:** ' + codeNames.join(', '));
  lines.push('');
  lines.push('**Generated:** ' + ts.replace('T',' ').slice(0,16) + (elapsed ? ' \u00b7 ' + timeStr : ''));
  lines.push('');
  lines.push('**Model:** ' + (REFLECT_CONFIG.ollama_model || 'unknown'));
  lines.push('');
  lines.push('**Corpus:** ' + DOC_NAMES.length + ' documents, ' + ALL_CODES.length + ' codes');
  lines.push(':::');
  lines.push('');

  // Per-code section with tabset
  lines.push('## Per-code analysis {.tabset}');
  lines.push('');
  (data.per_code || []).forEach(function(code) {
    lines.push('### ' + code.name);
    lines.push('');
    lines.push(code.summary || '');
    lines.push('');
    if (code.misapplications && code.misapplications.length > 0) {
      lines.push('**Misapplications and inconsistencies:**');
      lines.push('');
      code.misapplications.forEach(function(m) {
        lines.push('::: {.callout-warning}');
        lines.push('## [' + m.doc + ':' + m.line + ']');
        lines.push('');
        lines.push('> ' + (m.text || '').replace(/\n/g, '\n> '));
        lines.push('');
        lines.push(m.explanation || '');
        lines.push(':::');
        lines.push('');
      });
    } else {
      lines.push('*No misapplications identified.*');
      lines.push('');
    }
  });

  // Cross-code observations
  lines.push('## Cross-code observations');
  lines.push('');

  var crossCode = data.cross_code || {};

  if (crossCode.redundancies && crossCode.redundancies.length > 0) {
    lines.push('### Redundancies');
    lines.push('');
    crossCode.redundancies.forEach(function(r) {
      lines.push('**' + (r.codes || []).join(' \u00d7 ') + '**');
      lines.push('');
      lines.push(r.explanation || '');
      lines.push('');
      (r.passages || []).forEach(function(p) {
        lines.push('> [' + p.doc + ':' + p.line + '] ' + (p.text || ''));
        lines.push('');
      });
    });
  }

  if (crossCode.tensions && crossCode.tensions.length > 0) {
    lines.push('### Tensions');
    lines.push('');
    crossCode.tensions.forEach(function(t) {
      lines.push('**' + (t.codes || []).join(' \u00d7 ') + '**');
      lines.push('');
      lines.push(t.explanation || '');
      lines.push('');
      (t.passages || []).forEach(function(p) {
        lines.push('> [' + p.doc + ':' + p.line + '] ' + (p.text || ''));
        lines.push('');
      });
    });
  }

  if (crossCode.new_codes && crossCode.new_codes.length > 0) {
    lines.push('### Suggested new codes');
    lines.push('');
    crossCode.new_codes.forEach(function(nc) {
      lines.push('::: {.callout-tip}');
      lines.push('## ' + (nc.name || 'New code'));
      lines.push('');
      lines.push('**Rationale:** ' + (nc.rationale || ''));
      lines.push('');
      lines.push('**Scope:** ' + (nc.scope || ''));
      lines.push('');
      if (nc.passages && nc.passages.length > 0) {
        lines.push('**Supporting passages:**');
        lines.push('');
        nc.passages.forEach(function(p) {
          lines.push('> [' + p.doc + ':' + p.line + '] ' + (p.text || ''));
          lines.push('');
        });
      }
      lines.push(':::');
      lines.push('');
    });
  }

  // Bottom line
  var bl = data.bottom_line || {};
  lines.push('## Bottom line');
  lines.push('');
  lines.push(bl.assessment || '');
  lines.push('');
  if (bl.recommendations && bl.recommendations.length > 0) {
    lines.push('**Recommendations:**');
    lines.push('');
    bl.recommendations.forEach(function(r) {
      lines.push('- ' + r);
    });
  }

  return lines.join('\n');
}

async function saveAndRender(codes, reportData, elapsed) {
  var codeNames = codes.map(function(c) { return c.name; });
  var ts        = new Date().toISOString();
  var qmd       = buildQMD(codeNames, reportData, ts, elapsed);
  try {
    var res  = await fetch(API + '/reflect/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codes:       codeNames,
        label:       codeNames.join(' \u00b7 ').slice(0, 60),
        report_md:   qmd,
        report_json: { data: reportData, elapsed: elapsed },
      }),
    });
    var result = await res.json();
    var report = activeReport();
    if (report && result.rendered && result.html_url) report.html_url = result.html_url;
  } catch(e) { console.warn('[saveAndRender]', e); }
}

async function loadPriorRuns() {
  try {
    var res  = await fetch(API + '/reflect/reports');
    var data = await res.json();
    state.priorRuns = data.reports || [];
  } catch(e) { state.priorRuns = []; }
  render();
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  try {
    var root = document.getElementById('qc-reflect-root');
    if (!root) return;
    root.innerHTML = '';
    var shell = h('div', { className: 'app-shell' });

    // Topbar
    var tb = h('div', { className: 'top-bar' },
      h('h1', {}, 'QC Reflect'),
      h('span', { className: 'subtitle' }, DOC_NAMES.length + ' docs \u00b7 ' + ALL_CODES.length + ' codes'),
      h('div', { className: 'top-bar-spacer' }),
      h('button', { className: 'test-btn' + (state.mockMode ? ' active' : ''), title: 'Mock mode', onClick: function() { state.mockMode = !state.mockMode; render(); } }, '\uD83C\uDFAD Mock'),
      h('button', { className: 'test-btn' + (state.showPrompt ? ' active' : ''), title: 'Preview prompt', onClick: function() { state.showPrompt = !state.showPrompt; render(); } }, '\uD83D\uDCCB Prompt'),
      h('span', { className: 'model-badge' + (state.mockMode ? ' model-badge-test' : '') }, state.mockMode ? 'mock' : (REFLECT_CONFIG.ollama_model || 'unknown')),
      h('button', { className: 'topbar-theme-btn', title: 'Toggle theme', onClick: function() {
        document.body.classList.toggle('dark-mode');
        try { localStorage.setItem('qc.theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light'); } catch(e) {}
      }}, '\u25D1')
    );
    shell.appendChild(tb);

    var split = h('div', { className: 'main-split' });
    split.appendChild(buildLeftPanel());
    split.appendChild(buildRightPanel());
    shell.appendChild(split);
    root.appendChild(shell);
  } catch(e) { console.error('[render]', e.message, e.stack); }
}

function buildLeftPanel() {
  var panel = h('div', { className: 'sidebar' });
  var scopeCount = state.selectedCodes.length;

  panel.appendChild(h('div', { className: 'sidebar-section-label' },
    'SCOPE' + (scopeCount > 0 ? ' (' + scopeCount + ' SELECTED)' : '')));

  // Search
  var search = h('input', { type: 'text', className: 'search-input', placeholder: 'Filter codes...', value: state.treeSearch });
  search.addEventListener('input', function() {
    state.treeSearch = this.value;
    var treeEl = document.getElementById('reflect-tree');
    if (treeEl) { treeEl.innerHTML = ''; renderTree(treeEl); }
  });
  panel.appendChild(search);

  // Tree
  var treeWrap = h('div', { className: 'reflect-tree-wrap' });
  var treeEl   = h('div', { className: 'reflect-tree', id: 'reflect-tree' });
  renderTree(treeEl);
  treeWrap.appendChild(treeEl);
  panel.appendChild(treeWrap);

  // Action row
  var actionRow = h('div', { className: 'audit-action-row' });
  actionRow.appendChild(h('button', { className: 'btn', disabled: scopeCount === 0,
    onClick: function() { state.selectedCodes = []; render(); }
  }, 'Clear'));
  actionRow.appendChild(h('button', { className: 'btn primary audit-run-btn',
    disabled: state.running || scopeCount === 0,
    onClick: function() { runReport(); }
  }, state.running ? 'Running...' : 'Run Reflect'));
  panel.appendChild(actionRow);

  // Auto-detect
  panel.appendChild(h('button', { className: 'btn auto-detect-btn',
    disabled: state.running || scopeCount === 0,
    onClick: function() { runAutoDetect(); }
  }, '\uD83D\uDD0D Auto-detect related codes'));

  // Prior runs
  panel.appendChild(h('div', { className: 'sidebar-section-label sidebar-section-label-prior' }, 'PRIOR RUNS'));
  var priorWrap = h('div', { className: 'prior-runs-wrap' });

  state.reports.forEach(function(r) {
    var isActive = r.id === state.activeReportId;
    var row = h('div', { className: 'prior-run-row' + (isActive ? ' active' : ''),
      onClick: function() { state.activeReportId = r.id; state.showTable = false; render(); }
    });
    row.appendChild(h('div', { className: 'prior-run-label' }, r.label || r.codes.slice(0,3).join(' \u00b7 ')));
    row.appendChild(h('div', { className: 'prior-run-meta' },
      r.ts.slice(0,16).replace('T',' ') + (r.elapsed ? ' \u00b7 ' + Math.round(r.elapsed/1000) + 's' : '')));
    priorWrap.appendChild(row);
  });

  if (state.priorRuns === null) {
    priorWrap.appendChild(h('button', { className: 'btn-xs load-prior-btn',
      onClick: function() { loadPriorRuns(); }
    }, 'Load saved runs'));
  } else if (state.priorRuns.length === 0 && state.reports.length === 0) {
    priorWrap.appendChild(h('div', { className: 'scope-queue-empty' }, 'No runs yet.'));
  }

  panel.appendChild(priorWrap);
  return panel;
}

function renderTree(container) {
  var q = state.treeSearch.toLowerCase();
  var filtered = q
    ? CODEBOOK_TREE.filter(function(n) { return isActiveCode(n.name) && n.name.toLowerCase().includes(q); })
    : null;

  function renderNodes(nodeList) {
    nodeList.forEach(function(node) {
      if (!isActiveCode(node.name)) return;
      var isSelected  = state.selectedCodes.some(function(s) { return s.name === node.name; });
      var isAuto      = state.selectedCodes.some(function(s) { return s.name === node.name && s.auto; });
      var isCollapsed = !q && state.treeCollapsed.has(node.name);
      var hasChildren = CODEBOOK_TREE.some(function(n) { return n.parent === node.name && isActiveCode(n.name); });
      var uses        = (CORPUS_INDEX[node.name] || {}).total || 0;

      var row = h('div', { className: 'tree-row', style: { paddingLeft: (node.depth * 14 + 4) + 'px' } });

      if (!q && hasChildren) {
        var tog = h('button', { className: 'scope-toggle' }, isCollapsed ? '\u25B6' : '\u25BC');
        tog.addEventListener('mousedown', function(e) {
          e.preventDefault();
          if (isCollapsed) state.treeCollapsed.delete(node.name); else state.treeCollapsed.add(node.name);
          var treeEl = document.getElementById('reflect-tree');
          if (treeEl) { treeEl.innerHTML = ''; renderTree(treeEl); }
        });
        row.appendChild(tog);
      } else {
        row.appendChild(h('span', { className: 'scope-toggle-placeholder' }));
      }

      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = isSelected;
      cb.addEventListener('change', function() {
        if (cb.checked) { if (!isSelected) state.selectedCodes.push({ name: node.name, auto: false }); }
        else { state.selectedCodes = state.selectedCodes.filter(function(s) { return s.name !== node.name; }); }
        var lbl = document.querySelector('.sidebar-section-label');
        if (lbl) lbl.textContent = 'SCOPE (' + state.selectedCodes.length + ' SELECTED)';
        var clearBtn = document.querySelector('.audit-action-row .btn:not(.primary)');
        if (clearBtn) clearBtn.disabled = state.selectedCodes.length === 0;
        var runBtn   = document.querySelector('.audit-run-btn');
        if (runBtn)   runBtn.disabled   = state.running || state.selectedCodes.length === 0;
        var autoBtn  = document.querySelector('.auto-detect-btn');
        if (autoBtn)  autoBtn.disabled  = state.running || state.selectedCodes.length === 0;
      });
      row.appendChild(cb);
      row.appendChild(h('span', { className: 'tree-label' + (isAuto ? ' tree-label-auto' : '') }, node.name));
      if (uses) row.appendChild(h('span', { className: 'picker-count' }, String(uses)));
      container.appendChild(row);

      if (!q && !isCollapsed && hasChildren) {
        renderNodes(CODEBOOK_TREE.filter(function(n) { return n.parent === node.name; }));
      }
    });
  }

  var roots = q ? filtered : CODEBOOK_TREE.filter(function(n) { return !n.parent; });
  renderNodes(roots);
}

function buildRightPanel() {
  var panel = h('div', { className: 'right-panel' });
  if (state.running) { panel.appendChild(buildLoadingPanel()); return panel; }
  var report = activeReport();
  if (!report) { panel.appendChild(h('div', { className: 'empty-state' }, h('p', {}, 'Select codes from the tree and click Run Reflect.'))); return panel; }
  panel.appendChild(buildReportPanel(report));
  return panel;
}

function buildLoadingPanel() {
  var wrap = h('div', { className: 'loading-panel' });
  wrap.appendChild(h('span', { className: 'spinner-inline' }));
  var lines = state.progress.split('\n');
  lines.forEach(function(line, i) {
    wrap.appendChild(h('p', { className: i === 0 ? 'loading-progress' : 'loading-detail' }, line));
  });
  if (state.startedAt) {
    var elapsed = Math.round((Date.now() - state.startedAt) / 1000);
    var mins    = Math.floor(elapsed / 60);
    wrap.appendChild(h('p', { className: 'loading-elapsed' },
      (mins > 0 ? mins + 'm ' + (elapsed%60) + 's' : elapsed + 's') + ' elapsed'));
    setTimeout(function() { if (state.running) render(); }, 1000);
  }
  return wrap;
}

function buildReportPanel(report) {
  var wrap = h('div', { className: 'report-panel' });

  // Header
  var header = h('div', { className: 'report-panel-header' });
  var chipRow = h('div', { className: 'report-chips' });
  report.codes.forEach(function(name) {
    var isAuto = state.selectedCodes.some(function(s) { return s.name === name && s.auto; });
    var chip   = h('span', { className: 'code-chip' + (isAuto ? ' code-chip-auto' : '') }, name);
    chipRow.appendChild(chip);
  });
  header.appendChild(chipRow);

  var meta = h('div', { className: 'report-meta' });
  meta.appendChild(h('span', {}, report.codes.length + ' codes'));
  if (report.elapsed) {
    var secs = Math.round(report.elapsed/1000), mins = Math.floor(secs/60);
    meta.appendChild(h('span', { className: 'report-elapsed' }, ' \u00b7 ' + (mins > 0 ? mins + 'm ' + (secs%60) + 's' : secs + 's')));
  }
  header.appendChild(meta);

  var btnRow = h('div', { className: 'report-btn-row' });
  if (!state.showTable) {
    btnRow.appendChild(h('button', { className: 'btn', disabled: !!report.table,
      onClick: function() { generateTable(); }
    }, report.table ? 'Table generated' : 'Generate table'));
  } else {
    btnRow.appendChild(h('button', { className: 'btn',
      onClick: function() { state.showTable = false; render(); }
    }, '\u2190 Back to report'));
  }
  if (report.html_url) {
    btnRow.appendChild(h('button', { className: 'btn',
      onClick: function() { window.open(report.html_url, '_blank'); }
    }, '\u2197 Open rendered'));
  }
  header.appendChild(btnRow);
  wrap.appendChild(header);

  if (state.promptPreview) {
    wrap.appendChild(h('div', { className: 'prompt-preview' },
      h('div', { className: 'prompt-preview-label' }, 'Prompt preview'),
      h('pre', { className: 'prompt-preview-text' }, state.promptPreview)
    ));
    return wrap;
  }

  if (state.showTable && report.table) {
    wrap.appendChild(buildTableView(report.table));
  } else {
    wrap.appendChild(buildReportView(report.data));
  }
  return wrap;
}

function buildReportView(data) {
  var wrap = h('div', { className: 'report-prose' });
  if (!data) {
    wrap.appendChild(h('p', { className: 'report-p' }, 'No report data.'));
    return wrap;
  }

  // ── Per-code summaries ──────────────────────────────────────────────────────
  wrap.appendChild(h('h2', { className: 'report-h2' }, 'Per-code analysis'));

  (data.per_code || []).forEach(function(code) {
    wrap.appendChild(h('h3', { className: 'report-h3' }, code.name));

    var summaryEl = h('p', { className: 'report-p' });
    summaryEl.innerHTML = formatInline(code.summary || '');
    wrap.appendChild(summaryEl);

    if (code.misapplications && code.misapplications.length > 0) {
      wrap.appendChild(h('p', { className: 'report-p report-subhead' },
        code.misapplications.length + ' misapplication' + (code.misapplications.length !== 1 ? 's' : '') + ' identified:'));

      code.misapplications.forEach(function(m) {
        var callout = h('div', { className: 'callout callout-warning' });

        var citEl = h('div', { className: 'callout-header' });
        citEl.appendChild(h('span', { className: 'citation' }, '[' + m.doc + ':' + m.line + ']'));
        callout.appendChild(citEl);

        var quoteEl = h('blockquote', { className: 'callout-quote' });
        quoteEl.appendChild(document.createTextNode(m.text || ''));
        callout.appendChild(quoteEl);

        var explEl = h('p', { className: 'callout-body' });
        explEl.innerHTML = formatInline(m.explanation || '');
        callout.appendChild(explEl);

        wrap.appendChild(callout);
      });
    } else {
      wrap.appendChild(h('p', { className: 'report-p report-ok' },
        'No misapplications identified.'));
    }
  });

  // ── Cross-code observations ─────────────────────────────────────────────────
  var cc = data.cross_code || {};
  var hasCC = (cc.redundancies && cc.redundancies.length) ||
              (cc.tensions && cc.tensions.length) ||
              (cc.new_codes && cc.new_codes.length);

  if (hasCC) {
    wrap.appendChild(h('h2', { className: 'report-h2' }, 'Cross-code observations'));

    if (cc.redundancies && cc.redundancies.length > 0) {
      wrap.appendChild(h('h3', { className: 'report-h3' }, 'Redundancies'));
      cc.redundancies.forEach(function(r) {
        var block = h('div', { className: 'cc-block' });
        var codeRow = h('div', { className: 'cc-codes' });
        (r.codes || []).forEach(function(c, i) {
          if (i > 0) codeRow.appendChild(h('span', { className: 'cc-sep' }, ' × '));
          codeRow.appendChild(h('span', { className: 'code-chip' }, c));
        });
        block.appendChild(codeRow);
        var expl = h('p', { className: 'report-p' });
        expl.innerHTML = formatInline(r.explanation || '');
        block.appendChild(expl);
        (r.passages || []).forEach(function(p) {
          block.appendChild(buildPassage(p));
        });
        wrap.appendChild(block);
      });
    }

    if (cc.tensions && cc.tensions.length > 0) {
      wrap.appendChild(h('h3', { className: 'report-h3' }, 'Tensions'));
      cc.tensions.forEach(function(t) {
        var block = h('div', { className: 'cc-block' });
        var codeRow = h('div', { className: 'cc-codes' });
        (t.codes || []).forEach(function(c, i) {
          if (i > 0) codeRow.appendChild(h('span', { className: 'cc-sep' }, ' × '));
          codeRow.appendChild(h('span', { className: 'code-chip' }, c));
        });
        block.appendChild(codeRow);
        var expl = h('p', { className: 'report-p' });
        expl.innerHTML = formatInline(t.explanation || '');
        block.appendChild(expl);
        (t.passages || []).forEach(function(p) {
          block.appendChild(buildPassage(p));
        });
        wrap.appendChild(block);
      });
    }

    if (cc.new_codes && cc.new_codes.length > 0) {
      wrap.appendChild(h('h3', { className: 'report-h3' }, 'Suggested new codes'));
      cc.new_codes.forEach(function(nc) {
        var callout = h('div', { className: 'callout callout-tip' });
        var hdr = h('div', { className: 'callout-header' });
        hdr.appendChild(h('span', { className: 'new-code-name' }, nc.name || 'New code'));
        callout.appendChild(hdr);
        var body = h('div', { className: 'callout-body' });
        if (nc.rationale) {
          body.appendChild(h('p', { className: 'report-p' },
            h('strong', {}, 'Rationale: '), document.createTextNode(nc.rationale)));
        }
        if (nc.scope) {
          body.appendChild(h('p', { className: 'report-p' },
            h('strong', {}, 'Scope: '), document.createTextNode(nc.scope)));
        }
        if (nc.passages && nc.passages.length > 0) {
          body.appendChild(h('p', { className: 'report-p report-subhead' }, 'Supporting passages:'));
          nc.passages.forEach(function(p) { body.appendChild(buildPassage(p)); });
        }
        callout.appendChild(body);
        wrap.appendChild(callout);
      });
    }
  }

  // ── Bottom line ─────────────────────────────────────────────────────────────
  var bl = data.bottom_line || {};
  if (bl.assessment || (bl.recommendations && bl.recommendations.length)) {
    wrap.appendChild(h('h2', { className: 'report-h2' }, 'Bottom line'));
    if (bl.assessment) {
      var assessEl = h('p', { className: 'report-p report-assessment' });
      assessEl.innerHTML = formatInline(bl.assessment);
      wrap.appendChild(assessEl);
    }
    if (bl.recommendations && bl.recommendations.length > 0) {
      wrap.appendChild(h('p', { className: 'report-p report-subhead' }, 'Recommendations:'));
      var ul = h('ul', { className: 'report-ul' });
      bl.recommendations.forEach(function(r) {
        var li = h('li', { className: 'report-li' });
        li.innerHTML = formatInline(r);
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }
  }

  return wrap;
}

function buildPassage(p) {
  var block = h('div', { className: 'passage-block' });
  block.appendChild(h('span', { className: 'citation' }, '[' + p.doc + ':' + p.line + '] '));
  block.appendChild(document.createTextNode(p.text || ''));
  return block;
}


function buildTableView(table) {
  var wrap = h('div', { className: 'report-table-wrap' });
  if (!table.headers || !table.rows) return wrap;
  var tbl   = h('table', { className: 'report-table' });
  var thead = h('thead');
  var hrow  = h('tr');
  table.headers.forEach(function(hd) { hrow.appendChild(h('th', {}, hd)); });
  thead.appendChild(hrow); tbl.appendChild(thead);
  var tbody = h('tbody');
  table.rows.forEach(function(row) {
    var tr = h('tr');
    row.forEach(function(cell, i) {
      var td = document.createElement('td');
      if (i === 0) { td.innerHTML = '<span class="code-chip">' + cell + '</span>'; }
      else { td.innerHTML = formatInline(cell); }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody); wrap.appendChild(tbl);
  return wrap;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    var saved = localStorage.getItem('qc.theme');
    if (saved === 'dark') document.body.classList.add('dark-mode');
  } catch(e) {}
  render();
}

if (document.getElementById('qc-reflect-root')) { boot(); }
else { document.addEventListener('DOMContentLoaded', boot); }

})();
