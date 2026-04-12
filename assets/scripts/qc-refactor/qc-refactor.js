(function() {
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

var API = 'http://localhost:' + (REFACTOR_CONFIG ? REFACTOR_CONFIG.server_port : 8080);
var SEGMENT_PREVIEW_LENGTH = 120;

// ── State ─────────────────────────────────────────────────────────────────────

var state = {
  queue:          [],       // [{id, type, sources, target}]
  opType:         'rename',
  panelTab:       'preview',
  results:        null,
  nextId:         1,
  expandedSegs:   {},       // opId -> bool (segments expanded in preview)
  // Tree picker state
  pickerOpen:     null,     // {fieldId, onSelect, multi}
  pickerSearch:   '',
};

// ── Tree helpers ──────────────────────────────────────────────────────────────

function getTree() { return CODEBOOK_TREE || []; }

function nodeByName(name) {
  return getTree().find(function(n) { return n.name === name; }) || null;
}

function corpusCount(name) {
  var c = CORPUS_COUNTS && CORPUS_COUNTS[name];
  return c ? c.total : 0;
}

function corpusSegments(name) {
  return (CORPUS_DATA && CORPUS_DATA[name]) || [];
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ── Tree picker component ─────────────────────────────────────────────────────
// A searchable, hierarchical code picker that replaces flat <select> elements.
// Usage: openPicker(fieldId, onSelect, allowNew)
//   fieldId  — id of the <input> element showing the selected value
//   onSelect — callback(name) called when a node is chosen
//   allowNew — if true, pressing Enter with unmatched text creates a new name

function openPicker(fieldId, onSelect, allowNew) {
  closePicker();
  state.pickerOpen  = { fieldId: fieldId, onSelect: onSelect, allowNew: !!allowNew };
  state.pickerSearch = '';
  renderPicker();
}

function closePicker() {
  state.pickerOpen = null;
  var existing = document.getElementById('tree-picker');
  if (existing) existing.remove();
}

function renderPicker() {
  var p = state.pickerOpen;
  if (!p) return;

  var anchor = document.getElementById(p.fieldId);
  if (!anchor) return;

  var existing = document.getElementById('tree-picker');
  if (existing) existing.remove();

  var picker = document.createElement('div');
  picker.id = 'tree-picker';
  picker.className = 'tree-picker';

  // Search box
  var searchBox = document.createElement('input');
  searchBox.className = 'picker-search';
  searchBox.placeholder = 'Search codes…';
  searchBox.value = state.pickerSearch;
  picker.appendChild(searchBox);

  // Tree list
  var list = document.createElement('div');
  list.className = 'picker-list';

  var query = state.pickerSearch.toLowerCase();
  var nodes = getTree();

  // Filter: show node if it or any descendant matches
  function nodeMatches(node) {
    if (node.name.toLowerCase().indexOf(query) >= 0) return true;
    // check children in tree
    return nodes.some(function(n) {
      return n.parent === node.name && nodeMatches(n);
    });
  }

  var shown = query ? nodes.filter(nodeMatches) : nodes;

  if (shown.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = p.allowNew && query
      ? 'Press Enter to use "' + query + '" as a new name'
      : 'No matching codes';
    list.appendChild(empty);
  } else {
    shown.forEach(function(node) {
      var item = document.createElement('div');
      item.className = 'picker-item';
      item.dataset.name = node.name;

      var indent = document.createElement('span');
      indent.className = 'picker-indent';
      indent.textContent = '  '.repeat(node.depth);

      var label = document.createElement('span');
      label.className = 'picker-label';

      // Highlight match
      if (query) {
        var idx = node.name.toLowerCase().indexOf(query);
        if (idx >= 0) {
          label.innerHTML =
            esc(node.name.slice(0, idx))
            + '<mark>' + esc(node.name.slice(idx, idx + query.length)) + '</mark>'
            + esc(node.name.slice(idx + query.length));
        } else {
          label.textContent = node.name;
          item.classList.add('picker-item-dim');
        }
      } else {
        label.textContent = node.name;
      }

      var count = corpusCount(node.name);
      if (count > 0) {
        var countEl = document.createElement('span');
        countEl.className = 'picker-count';
        countEl.textContent = count;
        item.appendChild(indent);
        item.appendChild(label);
        item.appendChild(countEl);
      } else {
        item.appendChild(indent);
        item.appendChild(label);
      }

      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        selectFromPicker(node.name);
      });

      list.appendChild(item);
    });
  }

  picker.appendChild(list);

  // Position below anchor
  var rect = anchor.getBoundingClientRect();
  picker.style.top  = (rect.bottom + window.scrollY + 2) + 'px';
  picker.style.left = (rect.left + window.scrollX) + 'px';
  picker.style.width = Math.max(rect.width, 280) + 'px';

  document.body.appendChild(picker);

  // Wire search
  searchBox.focus();
  searchBox.addEventListener('input', function() {
    state.pickerSearch = searchBox.value;
    renderPicker();
  });

  searchBox.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closePicker(); return; }
    if (e.key === 'Enter') {
      var q = searchBox.value.trim();
      if (p.allowNew && q) {
        selectFromPicker(q);
      } else {
        // Pick first visible match
        var first = list.querySelector('.picker-item:not(.picker-item-dim)');
        if (first) selectFromPicker(first.dataset.name);
      }
    }
    if (e.key === 'ArrowDown') {
      var items = list.querySelectorAll('.picker-item');
      if (items.length) items[0].focus();
    }
  });

  // Keyboard nav in list
  list.addEventListener('keydown', function(e) {
    var items = Array.from(list.querySelectorAll('.picker-item'));
    var idx   = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && idx < items.length - 1) items[idx+1].focus();
    if (e.key === 'ArrowUp')   { if (idx > 0) items[idx-1].focus(); else searchBox.focus(); }
    if (e.key === 'Enter' && idx >= 0) selectFromPicker(items[idx].dataset.name);
    if (e.key === 'Escape') closePicker();
  });

  list.querySelectorAll('.picker-item').forEach(function(item) {
    item.setAttribute('tabindex', '0');
  });
}

function selectFromPicker(name) {
  var p = state.pickerOpen;
  if (!p) return;
  var input = document.getElementById(p.fieldId);
  if (input) input.value = name;
  if (p.onSelect) p.onSelect(name);
  closePicker();
}

// Close picker on outside click
document.addEventListener('mousedown', function(e) {
  var picker = document.getElementById('tree-picker');
  if (picker && !picker.contains(e.target)) {
    var fieldEl = state.pickerOpen && document.getElementById(state.pickerOpen.fieldId);
    if (!fieldEl || !fieldEl.contains(e.target)) {
      closePicker();
    }
  }
});

// ── Code input field helper ───────────────────────────────────────────────────
// Renders a text input that opens the tree picker on focus/click.
// Returns HTML string. Call wireCodeInput(id, onSelect, allowNew) after inserting.

function codeInputHTML(id, placeholder, allowNew) {
  return '<div class="code-input-wrap">'
    + '<input type="text" id="' + id + '" class="code-input" placeholder="' + esc(placeholder || 'select or search…') + '" readonly>'
    + '<span class="code-input-arrow">▾</span>'
    + '</div>';
}

function wireCodeInput(id, onSelect, allowNew) {
  var input = document.getElementById(id);
  if (!input) return;
  input.addEventListener('focus', function() { openPicker(id, onSelect, allowNew); });
  input.addEventListener('click', function() { openPicker(id, onSelect, allowNew); });
}

// ── Form rendering ────────────────────────────────────────────────────────────

function renderForm() {
  var opType = state.opType;
  document.querySelectorAll('.op-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.type === opType);
  });

  var form = document.getElementById('op-form');
  form.innerHTML = '';
  closePicker();

  if (opType === 'rename') {
    form.innerHTML = [
      '<div class="op-form-row">',
      '  <label>Code to rename</label>',
      codeInputHTML('rename-source', 'select code…', false),
      '</div>',
      '<div class="op-form-row">',
      '  <label>New name</label>',
      '  <input type="text" id="rename-target" placeholder="new name">',
      '</div>',
    ].join('');
    wireCodeInput('rename-source', null, false);
  }

  if (opType === 'merge') {
    form.innerHTML = [
      '<div class="op-form-row">',
      '  <label>Codes to merge</label>',
      '  <div class="merge-grid" id="merge-grid"></div>',
      '  <button class="btn" style="margin-top:6px;width:100%" id="add-source">+ Add code</button>',
      '</div>',
      '<div class="op-form-row" style="margin-top:4px">',
      '  <label>Target <span style="font-weight:400;color:var(--text-faint)">(surviving name)</span></label>',
      codeInputHTML('merge-target', 'select or type new…', true),
      '</div>',
    ].join('');
    addMergeRow();
    document.getElementById('add-source').addEventListener('click', addMergeRow);
    wireCodeInput('merge-target', null, true);
  }

  if (opType === 'deprecate') {
    form.innerHTML = [
      '<div class="op-form-row">',
      '  <label>Code to deprecate</label>',
      codeInputHTML('deprecate-source', 'select code…', false),
      '</div>',
      '<p class="form-hint">Sets status to "deprecated" in codebook.json only. No qc CLI command is run.</p>',
    ].join('');
    wireCodeInput('deprecate-source', null, false);
  }
}

var _mergeRowCount = 0;
function addMergeRow() {
  var grid = document.getElementById('merge-grid');
  if (!grid) return;
  var rowId = 'merge-src-' + (++_mergeRowCount);
  var row = document.createElement('div');
  row.className = 'merge-row';
  row.dataset.rowId = rowId;
  row.innerHTML = codeInputHTML(rowId, 'select code…', false)
    + '<button class="btn-icon danger merge-row-remove" title="Remove">×</button>';
  row.querySelector('.merge-row-remove').addEventListener('click', function() {
    grid.removeChild(row);
  });
  grid.appendChild(row);
  wireCodeInput(rowId, null, false);
}

// ── Queue rendering ───────────────────────────────────────────────────────────

function opDescription(op) {
  if (op.type === 'rename') {
    return '<span class="code-name">' + esc(op.sources[0]) + '</span>'
         + '<span class="arrow">→</span>'
         + '<span class="code-name">' + esc(op.target) + '</span>';
  }
  if (op.type === 'merge') {
    return op.sources.map(function(s) {
      return '<span class="code-name">' + esc(s) + '</span>';
    }).join('<span class="arrow">, </span>')
    + '<span class="arrow"> → </span>'
    + '<span class="code-name">' + esc(op.target) + '</span>';
  }
  if (op.type === 'deprecate') {
    return '<span class="code-name">' + esc(op.sources[0]) + '</span>'
         + '<span class="arrow"> → </span>deprecated';
  }
  return '';
}

function renderQueue() {
  var list = document.getElementById('queue-list');
  if (state.queue.length === 0) {
    list.innerHTML = '<div class="queue-empty">No operations staged.</div>';
    return;
  }

  list.innerHTML = state.queue.map(function(op) {
    var badgeClass = 'badge-' + op.type;
    var swapBtn = op.type === 'merge' && op.sources.length > 0
      ? '<button class="queue-item-swap" data-id="' + op.id + '" title="Swap target with first source">⇄</button>'
      : '';
    return '<div class="queue-item" data-id="' + op.id + '">'
      + '<span class="queue-item-badge ' + badgeClass + '">' + op.type + '</span>'
      + '<div class="queue-item-body"><div class="queue-item-desc">' + opDescription(op) + '</div></div>'
      + swapBtn
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

  list.querySelectorAll('.queue-item-swap').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = parseInt(btn.dataset.id);
      var op = state.queue.find(function(o) { return o.id === id; });
      if (!op || op.sources.length === 0) return;
      // Promote first source to target, demote current target to first source
      var oldTarget  = op.target;
      var newTarget  = op.sources[0];
      var newSources = [oldTarget].concat(op.sources.slice(1));
      op.target  = newTarget;
      op.sources = newSources;
      render();
    });
  });
}

// ── Preview rendering ─────────────────────────────────────────────────────────

function renderPreview() {
  var panel = document.getElementById('preview-panel');
  if (state.panelTab !== 'preview') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (!CODEBOOK_TREE || CODEBOOK_TREE.length === 0) {
    panel.innerHTML = '<div class="preview-empty">No codebook loaded.</div>';
    return;
  }

  // Build op map
  var opMap = {}; // name → {op, role}
  var addedNames = new Set();

  state.queue.forEach(function(op) {
    if (op.type === 'rename') {
      opMap[op.sources[0]] = { op: op, role: 'rename-src' };
      if (!CODEBOOK_TREE.some(function(n) { return n.name === op.target; })) {
        addedNames.add(op.target);
      }
    } else if (op.type === 'merge') {
      op.sources.forEach(function(s) {
        opMap[s] = { op: op, role: 'merge-src' };
      });
      opMap[op.target] = (opMap[op.target] || { op: op, role: 'merge-tgt' });
      if (!CODEBOOK_TREE.some(function(n) { return n.name === op.target; })) {
        addedNames.add(op.target);
      }
    } else if (op.type === 'deprecate') {
      opMap[op.sources[0]] = { op: op, role: 'deprecate' };
    }
  });

  var html = [];

  CODEBOOK_TREE.forEach(function(node) {
    var info   = opMap[node.name];
    var role   = info ? info.role : null;
    var op     = info ? info.op   : null;
    var indent = '  '.repeat(node.depth);

    var nodeClass = 'tree-node';
    var tag = '';

    if (role === 'rename-src') {
      nodeClass += ' op-remove';
      tag = '<span class="node-tag tag-renamed">→ ' + esc(op.target) + '</span>';
    } else if (role === 'merge-src') {
      nodeClass += ' op-remove';
      tag = '<span class="node-tag tag-merge-src">→ ' + esc(op.target) + '</span>';
    } else if (role === 'merge-tgt') {
      tag = '<span class="node-tag tag-merge-tgt">merge target</span>';
    } else if (role === 'deprecate') {
      nodeClass += ' op-deprecate';
      tag = '<span class="node-tag tag-deprecated">deprecated</span>';
    }

    var count   = corpusCount(node.name);
    var countEl = count > 0 ? '<span class="node-count">(' + count + ')</span>' : '';

    html.push('<div class="' + nodeClass + '">'
      + '<span class="picker-indent">' + esc(indent) + '</span>'
      + '<span class="node-name">' + esc(node.name) + '</span>'
      + countEl + tag
      + '</div>');

    // Affected segments — show for any op role
    if (role && count > 0) {
      var segs     = corpusSegments(node.name);
      var opId     = op.id;
      var key      = opId + ':' + node.name;
      var expanded = !!state.expandedSegs[key];
      var segClass = role.indexOf('src') >= 0 ? 'segs-src' : 'segs-tgt';

      html.push('<div class="seg-block ' + segClass + '">'
        + '<button class="seg-toggle" data-key="' + esc(key) + '">'
        + (expanded ? '▾ ' : '▸ ')
        + count + ' affected segment' + (count !== 1 ? 's' : '')
        + (segs.length < count ? ' (showing ' + segs.length + ')' : '')
        + '</button>'
        + (expanded ? renderSegments(segs) : '')
        + '</div>');
    }
  });

  // New names from renames
  addedNames.forEach(function(name) {
    if (!CODEBOOK_TREE.some(function(n) { return n.name === name; })) {
      html.push('<div class="tree-node op-add">'
        + '<span class="node-name">' + esc(name) + '</span>'
        + '<span class="node-tag tag-renamed">new</span>'
        + '</div>');
    }
  });

  if (!html.length) {
    panel.innerHTML = '<div class="preview-empty">No changes staged.</div>';
    return;
  }

  panel.innerHTML = html.join('');

  // Wire segment toggles
  panel.querySelectorAll('.seg-toggle').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key = btn.dataset.key;
      state.expandedSegs[key] = !state.expandedSegs[key];
      renderPreview();
    });
  });
}

function renderSegments(segs) {
  if (!segs || segs.length === 0) return '';
  return '<div class="seg-list">'
    + segs.map(function(s) {
        return '<div class="seg-item">'
          + '<span class="seg-loc">' + esc(s.document) + ':' + s.line + '</span>'
          + '<span class="seg-text">' + esc(truncate(s.text, SEGMENT_PREVIEW_LENGTH)) + '</span>'
          + '</div>';
      }).join('')
    + '</div>';
}

// ── Script rendering ──────────────────────────────────────────────────────────

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

function renderScript() {
  var panel = document.getElementById('script-panel');
  if (state.panelTab !== 'script') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (state.queue.length === 0) {
    panel.innerHTML = '<div class="script-empty">Stage operations to generate a script.</div>';
    return;
  }

  var script = generateScript();
  panel.innerHTML = '<div class="script-block" id="script-block-content">'
    + '<button class="btn script-copy" id="copy-script">Copy</button>'
    + esc(script)
    + '</div>';

  document.getElementById('copy-script').addEventListener('click', function() {
    navigator.clipboard.writeText(script).then(function() {
      document.getElementById('copy-script').textContent = 'Copied!';
      setTimeout(function() {
        var el = document.getElementById('copy-script');
        if (el) el.textContent = 'Copy';
      }, 1500);
    });
  });
}

// ── Results rendering ─────────────────────────────────────────────────────────

function renderResults() {
  var panel = document.getElementById('results-panel');
  if (state.panelTab !== 'results') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (!state.results) {
    panel.innerHTML = '<div class="script-empty">No execution results yet.</div>';
    return;
  }

  panel.innerHTML = state.results.map(function(r) {
    var cls  = r.ok ? 'ok' : 'err';
    var icon = r.ok ? '✓' : '✗';
    return '<div class="result-item ' + cls + '">'
      + '<span class="result-icon">' + icon + '</span>'
      + '<div class="result-body">'
      + '<div class="result-cmd">' + esc(r.cmd) + '</div>'
      + (r.output ? '<div class="result-out">' + esc(r.output) + '</div>' : '')
      + '</div></div>';
  }).join('');
}

// ── Execute row ───────────────────────────────────────────────────────────────

function renderExecuteRow() {
  var count = state.queue.length;
  document.getElementById('queue-count').textContent =
    count === 0 ? 'Queue is empty'
    : count === 1 ? '1 operation staged'
    : count + ' operations staged';
  document.getElementById('btn-execute').disabled = count === 0;
  document.getElementById('btn-clear').disabled   = count === 0;
}

// ── Full render ───────────────────────────────────────────────────────────────

function render() {
  renderQueue();
  renderForm();
  renderPreview();
  renderScript();
  renderExecuteRow();
}

// ── Add operation ─────────────────────────────────────────────────────────────

function addOperation() {
  var op = null;

  if (state.opType === 'rename') {
    var src = (document.getElementById('rename-source') || {}).value || '';
    var tgt = ((document.getElementById('rename-target') || {}).value || '').trim();
    if (!src) { alert('Please select a source code.'); return; }
    if (!tgt) { alert('Please enter a new name.'); return; }
    if (src === tgt) { alert('Source and target names are the same.'); return; }
    op = { id: state.nextId++, type: 'rename', sources: [src], target: tgt };
  }

  if (state.opType === 'merge') {
    var rows = document.querySelectorAll('#merge-grid .merge-row');
    var srcs = [];
    rows.forEach(function(row) {
      var inp = row.querySelector('.code-input');
      if (inp && inp.value) srcs.push(inp.value);
    });
    var tgtEl = document.getElementById('merge-target');
    var tgt   = tgtEl ? tgtEl.value.trim() : '';
    if (srcs.length < 1) { alert('Please select at least one source code.'); return; }
    if (!tgt)            { alert('Please select or enter a target code.'); return; }
    // Target must not also be a source
    srcs = srcs.filter(function(s) { return s !== tgt; });
    if (srcs.length === 0) { alert('Sources and target cannot all be the same code.'); return; }
    op = { id: state.nextId++, type: 'merge', sources: srcs, target: tgt };
  }

  if (state.opType === 'deprecate') {
    var src = (document.getElementById('deprecate-source') || {}).value || '';
    if (!src) { alert('Please select a code to deprecate.'); return; }
    op = { id: state.nextId++, type: 'deprecate', sources: [src], target: src };
  }

  if (op) {
    state.queue.push(op);
    state.expandedSegs = {};
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
    operations:  state.queue,
    summary:     summary,
    script:      generateScript(),
    scheme_path: REFACTOR_CONFIG ? REFACTOR_CONFIG.scheme_path : '',
  };

  try {
    var res  = await fetch(API + '/refactor/execute', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    var data = await res.json();

    state.results      = data.results || [];
    state.queue        = [];
    state.expandedSegs = {};
    state.panelTab     = 'results';

    document.querySelectorAll('.panel-tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.tab === 'results');
    });
    document.getElementById('preview-panel').classList.add('hidden');
    document.getElementById('script-panel').classList.add('hidden');
    document.getElementById('results-panel').classList.remove('hidden');

    render();
  } catch(e) {
    alert('Execution error: ' + e.message);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {

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

  document.querySelectorAll('.op-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      state.opType = tab.dataset.type;
      _mergeRowCount = 0;
      render();
    });
  });

  document.getElementById('btn-add').addEventListener('click', addOperation);
  document.getElementById('btn-clear').addEventListener('click', function() {
    state.queue = []; state.expandedSegs = {}; render();
  });
  document.getElementById('btn-execute').addEventListener('click', showSummaryModal);
  document.getElementById('btn-cancel-summary').addEventListener('click', hideSummaryModal);
  document.getElementById('btn-confirm-execute').addEventListener('click', function() {
    var summary = document.getElementById('summary-text').value.trim();
    if (!summary) { alert('Please enter a summary.'); return; }
    executeQueue(summary);
  });

  document.querySelectorAll('.panel-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      state.panelTab = tab.dataset.tab;
      document.querySelectorAll('.panel-tab').forEach(function(t) {
        t.classList.toggle('active', t === tab);
      });
      document.getElementById('preview-panel').classList.toggle('hidden',  state.panelTab !== 'preview');
      document.getElementById('script-panel').classList.toggle('hidden',   state.panelTab !== 'script');
      document.getElementById('results-panel').classList.toggle('hidden',  state.panelTab !== 'results');
      renderPreview();
      renderScript();
      renderResults();
    });
  });

  render();
});

})();
