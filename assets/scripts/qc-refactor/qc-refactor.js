(function() {
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

var API = 'http://localhost:' + (REFACTOR_CONFIG ? REFACTOR_CONFIG.server_port : 8080);

// ── State ─────────────────────────────────────────────────────────────────────

var state = {
  queue:      [],          // [{id, type, sources, target}]  type: rename|merge|deprecate
  opType:     'rename',    // active form type
  panelTab:   'preview',   // preview|script|results
  results:    null,        // last execution results
  nextId:     1,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function allCodeNames() {
  var names = [];
  (CODEBOOK_TREE || []).forEach(function(node) { names.push(node.name); });
  return names.sort();
}

function corpusCount(name) {
  var c = CORPUS_COUNTS && CORPUS_COUNTS[name];
  return c ? c.total : 0;
}

function queuedTargets() {
  // Names introduced by the queue that don't exist in the baked tree
  var existing = new Set(allCodeNames());
  var targets = new Set();
  state.queue.forEach(function(op) {
    if (!existing.has(op.target)) targets.add(op.target);
  });
  return targets;
}

function opDescription(op) {
  if (op.type === 'rename') {
    return '<span class="code-name">' + esc(op.sources[0]) + '</span>'
         + '<span class="arrow">→</span>'
         + '<span class="code-name">' + esc(op.target) + '</span>';
  }
  if (op.type === 'merge') {
    return op.sources.map(function(s) {
      return '<span class="code-name">' + esc(s) + '</span>';
    }).join('<span class="arrow">,</span> ')
    + '<span class="arrow">→</span>'
    + '<span class="code-name">' + esc(op.target) + '</span>';
  }
  if (op.type === 'deprecate') {
    return '<span class="code-name">' + esc(op.sources[0]) + '</span>'
         + '<span class="arrow">→</span> deprecated';
  }
  return '';
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function generateScript() {
  var lines = ['#!/bin/bash', '# qc-refactor — generated script', ''];
  state.queue.forEach(function(op) {
    if (op.type === 'rename') {
      lines.push('qc codes rename ' + shellQuote(op.sources[0]) + ' ' + shellQuote(op.target));
    } else if (op.type === 'merge') {
      var srcs = op.sources.map(shellQuote).join(' ');
      lines.push('qc codes rename ' + srcs + ' ' + shellQuote(op.target));
    } else if (op.type === 'deprecate') {
      lines.push('# deprecate: ' + op.sources[0] + ' (status change in codebook.json only)');
    }
  });
  return lines.join('\n');
}

function shellQuote(s) {
  // Simple single-quote escaping
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  renderQueue();
  renderForm();
  renderPreview();
  renderScript();
  renderExecuteRow();
}

function renderForm() {
  var opType = state.opType;

  // Tab highlight
  document.querySelectorAll('.op-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.type === opType);
  });

  var form = document.getElementById('op-form');
  form.innerHTML = '';

  var names = allCodeNames();

  if (opType === 'rename') {
    form.innerHTML = [
      '<div class="op-form-row">',
      '  <label>Code to rename</label>',
      '  <select id="rename-source">',
      '    <option value="">— select code —</option>',
      names.map(function(n) { return '<option>' + esc(n) + '</option>'; }).join(''),
      '  </select>',
      '</div>',
      '<div class="op-form-row">',
      '  <label>New name</label>',
      '  <input type="text" id="rename-target" placeholder="new code name">',
      '</div>',
    ].join('');
  }

  if (opType === 'merge') {
    form.innerHTML = [
      '<div class="op-form-row">',
      '  <label>Source codes (merge these into target)</label>',
      '  <div class="sources-list" id="merge-sources">',
      '    <div class="source-item">',
      '      <select><option value="">— select code —</option>',
      names.map(function(n) { return '<option>' + esc(n) + '</option>'; }).join(''),
      '      </select>',
      '    </div>',
      '  </div>',
      '  <button class="btn" style="margin-top:4px" id="add-source">+ Add source</button>',
      '</div>',
      '<div class="op-form-row">',
      '  <label>Target code (keep this name)</label>',
      '  <select id="merge-target">',
      '    <option value="">— select or type new —</option>',
      names.map(function(n) { return '<option>' + esc(n) + '</option>'; }).join(''),
      '  </select>',
      '</div>',
    ].join('');

    document.getElementById('add-source').addEventListener('click', function() {
      var list = document.getElementById('merge-sources');
      var item = document.createElement('div');
      item.className = 'source-item';
      item.innerHTML = '<select><option value="">— select code —</option>'
        + names.map(function(n) { return '<option>' + esc(n) + '</option>'; }).join('')
        + '</select>'
        + '<button class="btn-icon danger" title="Remove">×</button>';
      item.querySelector('button').addEventListener('click', function() {
        list.removeChild(item);
      });
      list.appendChild(item);
    });
  }

  if (opType === 'deprecate') {
    form.innerHTML = [
      '<div class="op-form-row">',
      '  <label>Code to deprecate</label>',
      '  <select id="deprecate-source">',
      '    <option value="">— select code —</option>',
      names.map(function(n) { return '<option>' + esc(n) + '</option>'; }).join(''),
      '  </select>',
      '</div>',
      '<p style="font-size:11px;color:var(--text-faint);margin:0">',
      'Sets status to "deprecated" in codebook.json. No qc CLI command is run.',
      '</p>',
    ].join('');
  }
}

function renderQueue() {
  var list = document.getElementById('queue-list');
  if (state.queue.length === 0) {
    list.innerHTML = '<div class="queue-empty">No operations staged.</div>';
    return;
  }
  list.innerHTML = state.queue.map(function(op) {
    var badgeClass = 'badge-' + op.type;
    return '<div class="queue-item" data-id="' + op.id + '">'
      + '<span class="queue-item-badge ' + badgeClass + '">' + op.type + '</span>'
      + '<div class="queue-item-body"><div class="queue-item-desc">' + opDescription(op) + '</div></div>'
      + '<button class="queue-item-remove" data-id="' + op.id + '" title="Remove">×</button>'
      + '</div>';
  }).join('');

  list.querySelectorAll('.queue-item-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = parseInt(btn.dataset.id);
      state.queue = state.queue.filter(function(op) { return op.id !== id; });
      render();
    });
  });
}

function renderPreview() {
  var panel = document.getElementById('preview-panel');
  if (state.panelTab !== 'preview') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (!CODEBOOK_TREE || CODEBOOK_TREE.length === 0) {
    panel.innerHTML = '<div class="preview-empty">No codebook loaded.</div>';
    return;
  }

  // Build a map of operations affecting each code name
  var opMap = {}; // name → {type, role}  role: src|tgt
  var removedNames = new Set();
  var addedNames   = new Set();

  state.queue.forEach(function(op) {
    if (op.type === 'rename') {
      opMap[op.sources[0]] = { type: 'rename', role: 'src', target: op.target };
      removedNames.add(op.sources[0]);
      if (!allCodeNames().includes(op.target)) addedNames.add(op.target);
    } else if (op.type === 'merge') {
      op.sources.forEach(function(s) {
        opMap[s] = { type: 'merge', role: 'src', target: op.target };
        removedNames.add(s);
      });
      if (!allCodeNames().includes(op.target)) {
        opMap[op.target] = { type: 'merge', role: 'tgt' };
        addedNames.add(op.target);
      } else {
        opMap[op.target] = { type: 'merge', role: 'tgt' };
      }
    } else if (op.type === 'deprecate') {
      opMap[op.sources[0]] = { type: 'deprecate', role: 'src' };
    }
  });

  var html = [];

  CODEBOOK_TREE.forEach(function(node) {
    var indent = '';
    for (var i = 0; i < node.depth; i++) indent += '  ';
    var op = opMap[node.name];
    var nodeClass = 'tree-node';
    var tag = '';
    var extra = '';

    if (op) {
      if (op.type === 'rename' && op.role === 'src') {
        nodeClass += ' op-remove';
        tag = '<span class="node-tag tag-renamed">→ ' + esc(op.target) + '</span>';
      } else if (op.type === 'merge' && op.role === 'src') {
        nodeClass += ' op-remove';
        tag = '<span class="node-tag tag-merge-src">merge into ' + esc(op.target) + '</span>';
      } else if (op.type === 'merge' && op.role === 'tgt') {
        tag = '<span class="node-tag tag-merge-tgt">merge target</span>';
      } else if (op.type === 'deprecate') {
        nodeClass += ' op-deprecate';
        tag = '<span class="node-tag tag-deprecated">deprecated</span>';
      }
    }

    var count = corpusCount(node.name);
    var countStr = count > 0 ? '<span class="node-count">(' + count + ')</span>' : '';

    html.push('<div class="' + nodeClass + '">'
      + '<span class="indent">' + esc(indent) + '</span>'
      + '<span class="node-name">' + esc(node.name) + '</span>'
      + countStr + tag
      + '</div>');
  });

  // Append any brand-new names introduced by renames (not already in tree)
  addedNames.forEach(function(name) {
    if (!CODEBOOK_TREE.some(function(n) { return n.name === name; })) {
      html.push('<div class="tree-node op-add">'
        + '<span class="node-name">' + esc(name) + '</span>'
        + '<span class="node-tag tag-renamed">new</span>'
        + '</div>');
    }
  });

  panel.innerHTML = html.length ? html.join('') : '<div class="preview-empty">No changes staged.</div>';
}

function renderScript() {
  var panel = document.getElementById('script-panel');
  if (state.panelTab !== 'script') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (state.queue.length === 0) {
    panel.innerHTML = '<div class="script-empty">Stage operations to generate a script.</div>';
    return;
  }

  var script = generateScript();
  panel.innerHTML = '<div class="script-block">'
    + '<button class="btn script-copy" id="copy-script">Copy</button>'
    + esc(script)
    + '</div>';

  document.getElementById('copy-script').addEventListener('click', function() {
    navigator.clipboard.writeText(script).then(function() {
      document.getElementById('copy-script').textContent = 'Copied!';
      setTimeout(function() {
        document.getElementById('copy-script').textContent = 'Copy';
      }, 1500);
    });
  });
}

function renderResults() {
  var panel = document.getElementById('results-panel');
  if (state.panelTab !== 'results') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (!state.results) {
    panel.innerHTML = '<div class="script-empty">No execution results yet.</div>';
    return;
  }

  panel.innerHTML = state.results.map(function(r) {
    var cls = r.ok ? 'ok' : 'err';
    var icon = r.ok ? '✓' : '✗';
    return '<div class="result-item ' + cls + '">'
      + '<span class="result-icon">' + icon + '</span>'
      + '<div class="result-body">'
      + '<div class="result-cmd">' + esc(r.cmd) + '</div>'
      + (r.output ? '<div class="result-out">' + esc(r.output) + '</div>' : '')
      + '</div>'
      + '</div>';
  }).join('');
}

function renderExecuteRow() {
  var count = state.queue.length;
  document.getElementById('queue-count').textContent =
    count === 0 ? 'Queue is empty'
    : count === 1 ? '1 operation staged'
    : count + ' operations staged';
  document.getElementById('btn-execute').disabled = count === 0;
  document.getElementById('btn-clear').disabled = count === 0;
}

// ── Add operation ─────────────────────────────────────────────────────────────

function addOperation() {
  var op = null;

  if (state.opType === 'rename') {
    var src = (document.getElementById('rename-source') || {}).value || '';
    var tgt = ((document.getElementById('rename-target') || {}).value || '').trim();
    if (!src || !tgt) { alert('Please select a source code and enter a new name.'); return; }
    if (src === tgt)  { alert('Source and target names are the same.'); return; }
    op = { id: state.nextId++, type: 'rename', sources: [src], target: tgt };
  }

  if (state.opType === 'merge') {
    var selects = document.querySelectorAll('#merge-sources select');
    var srcs = [];
    selects.forEach(function(s) { if (s.value) srcs.push(s.value); });
    var tgt = (document.getElementById('merge-target') || {}).value || '';
    if (srcs.length < 1) { alert('Please select at least one source code.'); return; }
    if (!tgt)            { alert('Please select or enter a target code name.'); return; }
    op = { id: state.nextId++, type: 'merge', sources: srcs, target: tgt };
  }

  if (state.opType === 'deprecate') {
    var src = (document.getElementById('deprecate-source') || {}).value || '';
    if (!src) { alert('Please select a code to deprecate.'); return; }
    op = { id: state.nextId++, type: 'deprecate', sources: [src], target: src };
  }

  if (op) {
    state.queue.push(op);
    render();
  }
}

// ── Execute ───────────────────────────────────────────────────────────────────

function showSummaryModal() {
  document.getElementById('summary-modal').classList.remove('hidden');
  document.getElementById('summary-text').focus();
}

function hideSummaryModal() {
  document.getElementById('summary-modal').classList.add('hidden');
}

async function executeQueue(summary) {
  hideSummaryModal();

  var payload = {
    operations: state.queue,
    summary:    summary,
    script:     generateScript(),
    scheme_path: REFACTOR_CONFIG ? REFACTOR_CONFIG.scheme_path : '',
  };

  try {
    var res = await fetch(API + '/refactor/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await res.json();

    state.results = data.results || [];
    state.queue   = [];
    state.panelTab = 'results';
    render();

    // Switch to results tab
    document.querySelectorAll('.panel-tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.tab === 'results');
    });
    document.getElementById('results-panel').classList.remove('hidden');
    document.getElementById('preview-panel').classList.add('hidden');
    document.getElementById('script-panel').classList.add('hidden');
    renderResults();

  } catch(e) {
    alert('Execution error: ' + e.message);
  }
}

// ── Initialise ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {

  // Build skeleton
  document.getElementById('qc-refactor-root').innerHTML = [
    '<div class="app">',

    // ── Left panel
    '<div class="queue-panel">',
    '  <div class="panel-header">Operations</div>',
    '  <div class="op-tabs">',
    '    <button class="op-tab active" data-type="rename">Rename</button>',
    '    <button class="op-tab" data-type="merge">Merge</button>',
    '    <button class="op-tab" data-type="deprecate">Deprecate</button>',
    '  </div>',
    '  <div class="op-form" id="op-form"></div>',
    '  <div style="padding:8px 14px;border-bottom:1px solid var(--border-dim);flex-shrink:0">',
    '    <button class="btn primary" id="btn-add" style="width:100%">Add to queue</button>',
    '  </div>',
    '  <div class="queue-list" id="queue-list"></div>',
    '  <div class="queue-footer">',
    '    <div class="queue-count" id="queue-count">Queue is empty</div>',
    '    <div class="execute-row">',
    '      <button class="btn" id="btn-clear" disabled>Clear</button>',
    '      <button class="btn primary" id="btn-execute" disabled style="flex:1">Execute queue…</button>',
    '    </div>',
    '  </div>',
    '</div>',

    // ── Right panel
    '<div class="right-panel">',
    '  <div class="panel-tabs">',
    '    <button class="panel-tab active" data-tab="preview">Preview</button>',
    '    <button class="panel-tab" data-tab="script">Script</button>',
    '    <button class="panel-tab" data-tab="results">Results</button>',
    '  </div>',
    '  <div class="preview-panel" id="preview-panel"></div>',
    '  <div class="script-panel hidden" id="script-panel"></div>',
    '  <div class="results-panel hidden" id="results-panel"></div>',
    '</div>',

    '</div>',

    // ── Summary modal
    '<div class="modal-overlay hidden" id="summary-modal">',
    '  <div class="modal">',
    '    <h2>Describe this change</h2>',
    '    <p>This summary will be recorded in the changelog and used as the snapshot label.</p>',
    '    <textarea id="summary-text" placeholder="e.g. Merged overlapping activity codes into Activities_General"></textarea>',
    '    <div class="modal-actions">',
    '      <button class="btn" id="btn-cancel-summary">Cancel</button>',
    '      <button class="btn primary" id="btn-confirm-execute">Execute</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('');

  // Op type tabs
  document.querySelectorAll('.op-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      state.opType = tab.dataset.type;
      render();
    });
  });

  // Add button
  document.getElementById('btn-add').addEventListener('click', addOperation);

  // Clear button
  document.getElementById('btn-clear').addEventListener('click', function() {
    state.queue = [];
    render();
  });

  // Execute button → show summary modal
  document.getElementById('btn-execute').addEventListener('click', showSummaryModal);

  // Modal cancel
  document.getElementById('btn-cancel-summary').addEventListener('click', hideSummaryModal);

  // Modal confirm execute
  document.getElementById('btn-confirm-execute').addEventListener('click', function() {
    var summary = document.getElementById('summary-text').value.trim();
    if (!summary) { alert('Please enter a summary.'); return; }
    executeQueue(summary);
  });

  // Panel tabs
  document.querySelectorAll('.panel-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      state.panelTab = tab.dataset.tab;
      document.querySelectorAll('.panel-tab').forEach(function(t) {
        t.classList.toggle('active', t === tab);
      });
      document.getElementById('preview-panel').classList.toggle('hidden', state.panelTab !== 'preview');
      document.getElementById('script-panel').classList.toggle('hidden',  state.panelTab !== 'script');
      document.getElementById('results-panel').classList.toggle('hidden', state.panelTab !== 'results');
      renderPreview();
      renderScript();
      renderResults();
    });
  });

  render();
});

})();
