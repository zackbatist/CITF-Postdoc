(function() {
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

var API              = 'http://localhost:' + (REFACTOR_CONFIG ? REFACTOR_CONFIG.server_port : 8080);
var SCHEME_PATH      = REFACTOR_CONFIG ? REFACTOR_CONFIG.scheme_path : '';
var SEG_TRUNCATE     = 140;
var DOC_FIELDS       = ['scope', 'rationale', 'usage_notes', 'provenance'];
var DOC_FIELD_LABELS = { scope: 'Scope', rationale: 'Rationale', usage_notes: 'Usage notes', provenance: 'Provenance' };

// ── State ─────────────────────────────────────────────────────────────────────

var state = {
  // Separate queues per operation type
  queues: { rename: [], merge: [], move: [], deprecate: [] },
  activeTab:   'rename',       // which op tab is open
  previewTab:  'diff',         // diff | impact
  panelTab:    'preview',      // preview | script | results
  results:     null,
  nextId:      1,
  sessionNote: '',
  // Loaded codebook.json data
  docsData:    null,           // full codes object from codebook.json
  docsEdits:   {},             // {codeName: {field: value}} — edits made in UI
  // UI state
  expandedSegs: {},            // key → bool
  pickerOpen:   null,
};

// ── Load codebook.json ────────────────────────────────────────────────────────

async function loadDocs() {
  try {
    var res  = await fetch(API + '/docs/load?path=' + encodeURIComponent(SCHEME_PATH));
    var data = await res.json();
    if (data.ok) {
      state.docsData = data.codes || {};
    }
  } catch(e) {
    console.warn('Could not load codebook.json:', e);
  }
}

function getCodeDoc(name) {
  var base  = (state.docsData && state.docsData[name]) || {};
  var edits = state.docsEdits[name] || {};
  return Object.assign({}, base, edits);
}

function setCodeDocField(codeName, field, value) {
  if (!state.docsEdits[codeName]) state.docsEdits[codeName] = {};
  state.docsEdits[codeName][field] = value;
}

// ── Tree helpers ──────────────────────────────────────────────────────────────

function getTree()          { return CODEBOOK_TREE || []; }
function corpusCount(name)  { var c = CORPUS_COUNTS && CORPUS_COUNTS[name]; return c ? c.total : 0; }
function corpusSegs(name)   { return (CORPUS_DATA && CORPUS_DATA[name]) || []; }

function nodeByName(name) {
  return getTree().find(function(n) { return n.name === name; }) || null;
}

function childrenOf(name) {
  return getTree().filter(function(n) { return n.parent === name; });
}

// ── String helpers ────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function shellQuote(s) { return "'" + String(s).replace(/'/g,"'\\''") + "'"; }
function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0,n) + '…' : s; }

// ── Tree picker ───────────────────────────────────────────────────────────────

function openPicker(fieldId, onSelect, allowNew) {
  closePicker();
  state.pickerOpen   = { fieldId, onSelect, allowNew: !!allowNew, search: '' };
  renderPicker();
}

function closePicker() {
  state.pickerOpen = null;
  var el = document.getElementById('tree-picker');
  if (el) el.remove();
}

function renderPicker() {
  var p = state.pickerOpen;
  if (!p) return;
  var anchor = document.getElementById(p.fieldId);
  if (!anchor) return;
  var old = document.getElementById('tree-picker');
  if (old) old.remove();

  var picker = document.createElement('div');
  picker.id  = 'tree-picker';
  picker.className = 'tree-picker';

  var search = document.createElement('input');
  search.className   = 'picker-search';
  search.placeholder = 'Search codes…';
  search.value       = p.search;
  picker.appendChild(search);

  var list  = document.createElement('div');
  list.className = 'picker-list';
  var query = p.search.toLowerCase();
  var nodes = getTree();

  function matches(node) {
    if (node.name.toLowerCase().indexOf(query) >= 0) return true;
    return nodes.some(function(n) { return n.parent === node.name && matches(n); });
  }

  var shown = query ? nodes.filter(matches) : nodes;

  if (shown.length === 0) {
    var empty = document.createElement('div');
    empty.className   = 'picker-empty';
    empty.textContent = p.allowNew && query ? 'Press Enter to use "' + query + '"' : 'No matching codes';
    list.appendChild(empty);
  } else {
    shown.forEach(function(node) {
      var item = document.createElement('div');
      item.className  = 'picker-item';
      item.dataset.name = node.name;
      item.setAttribute('tabindex', '0');

      var indent = document.createElement('span');
      indent.className   = 'picker-indent';
      indent.textContent = '  '.repeat(node.depth);

      var label = document.createElement('span');
      label.className = 'picker-label';

      if (query) {
        var idx = node.name.toLowerCase().indexOf(query);
        if (idx >= 0) {
          label.innerHTML = esc(node.name.slice(0, idx))
            + '<mark>' + esc(node.name.slice(idx, idx + query.length)) + '</mark>'
            + esc(node.name.slice(idx + query.length));
        } else {
          label.textContent = node.name;
          item.classList.add('picker-item-dim');
        }
      } else {
        label.textContent = node.name;
      }

      item.appendChild(indent);
      item.appendChild(label);

      var cnt = corpusCount(node.name);
      if (cnt > 0) {
        var countEl = document.createElement('span');
        countEl.className   = 'picker-count';
        countEl.textContent = cnt;
        item.appendChild(countEl);
      }

      item.addEventListener('mousedown', function(e) { e.preventDefault(); selectFromPicker(node.name); });
      list.appendChild(item);
    });
  }

  picker.appendChild(list);

  var rect = anchor.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.top      = rect.bottom + 2 + 'px';
  picker.style.left     = rect.left + 'px';
  picker.style.width    = Math.max(rect.width, 280) + 'px';
  document.body.appendChild(picker);

  search.focus();
  search.addEventListener('input', function() {
    if (state.pickerOpen) state.pickerOpen.search = search.value;
    renderPicker();
  });
  search.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closePicker(); return; }
    if (e.key === 'Enter') {
      var q = search.value.trim();
      if (p.allowNew && q) { selectFromPicker(q); return; }
      var first = list.querySelector('.picker-item:not(.picker-item-dim)');
      if (first) selectFromPicker(first.dataset.name);
    }
    if (e.key === 'ArrowDown') {
      var items = list.querySelectorAll('.picker-item');
      if (items.length) items[0].focus();
    }
  });
  list.addEventListener('keydown', function(e) {
    var items = Array.from(list.querySelectorAll('.picker-item'));
    var idx   = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && idx < items.length - 1) items[idx+1].focus();
    if (e.key === 'ArrowUp')   { if (idx > 0) items[idx-1].focus(); else search.focus(); }
    if (e.key === 'Enter' && idx >= 0) selectFromPicker(items[idx].dataset.name);
    if (e.key === 'Escape') closePicker();
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

document.addEventListener('mousedown', function(e) {
  var picker = document.getElementById('tree-picker');
  if (!picker) return;
  var fieldEl = state.pickerOpen && document.getElementById(state.pickerOpen.fieldId);
  if (!picker.contains(e.target) && (!fieldEl || !fieldEl.contains(e.target))) {
    closePicker();
  }
});

// ── Code input component ──────────────────────────────────────────────────────

function codeInputHTML(id, placeholder, allowNew) {
  return '<div class="code-input-wrap">'
    + '<input type="text" id="' + id + '" class="code-input" placeholder="' + esc(placeholder || 'select…') + '" readonly>'
    + '<span class="code-input-arrow">▾</span>'
    + '</div>';
}

function wireCodeInput(id, onSelect, allowNew) {
  var input = document.getElementById(id);
  if (!input) return;
  var open = function() { openPicker(id, onSelect, allowNew); };
  input.addEventListener('focus', open);
  input.addEventListener('click', open);
}

// ── Code documentation panel ──────────────────────────────────────────────────
// Shows editable documentation fields for a code, inline in the form.

function codePanelHTML(codeName, panelId) {
  var doc = getCodeDoc(codeName);
  var cnt = corpusCount(codeName);
  var html = '<div class="code-panel" id="' + panelId + '">';
  html += '<div class="code-panel-header">'
    + '<span class="code-panel-name">' + esc(codeName) + '</span>'
    + (cnt > 0 ? '<span class="code-panel-count">' + cnt + ' segments</span>' : '')
    + '</div>';

  DOC_FIELDS.forEach(function(field) {
    var val = doc[field] || '';
    html += '<div class="code-panel-field">'
      + '<label class="code-panel-label">' + DOC_FIELD_LABELS[field] + '</label>'
      + '<textarea class="code-panel-textarea" data-code="' + esc(codeName) + '" data-field="' + field + '" rows="2">'
      + esc(val)
      + '</textarea>'
      + '</div>';
  });

  html += '</div>';
  return html;
}

function wireCodePanel(panelId) {
  var panel = document.getElementById(panelId);
  if (!panel) return;
  panel.querySelectorAll('.code-panel-textarea').forEach(function(ta) {
    ta.addEventListener('input', function() {
      setCodeDocField(ta.dataset.code, ta.dataset.field, ta.value);
    });
  });
}

// ── Operation forms ───────────────────────────────────────────────────────────

var _mergeRowCount = 0;

function renderOpForm() {
  var form = document.getElementById('op-form');
  closePicker();
  form.innerHTML = '';

  var type = state.activeTab;

  if (type === 'rename') {
    form.innerHTML = [
      '<div class="op-form-row"><label>Code to rename</label>',
      codeInputHTML('rename-source', 'select code…', false),
      '</div>',
      '<div class="op-form-row"><label>New name</label>',
      '<input type="text" id="rename-target" placeholder="new name" class="code-input" style="readonly:false">',
      '</div>',
      '<div id="rename-panels"></div>',
    ].join('');

    wireCodeInput('rename-source', function(name) {
      var panels = document.getElementById('rename-panels');
      if (panels) {
        panels.innerHTML = codePanelHTML(name, 'rename-src-panel');
        wireCodePanel('rename-src-panel');
      }
    }, false);

    // Make rename-target editable (not readonly)
    var rt = document.getElementById('rename-target');
    if (rt) rt.removeAttribute('readonly');
  }

  if (type === 'merge') {
    _mergeRowCount = 0;
    form.innerHTML = [
      '<div class="op-form-row"><label>Source codes</label>',
      '<div class="merge-grid" id="merge-grid"></div>',
      '<button class="btn" style="margin-top:6px;width:100%" id="add-merge-src">+ Add code</button>',
      '</div>',
      '<div class="op-form-row"><label>Target <span class="label-hint">(surviving name)</span></label>',
      codeInputHTML('merge-target', 'select or type new…', true),
      '</div>',
      '<div id="merge-panels"></div>',
    ].join('');

    addMergeSourceRow();
    document.getElementById('add-merge-src').addEventListener('click', addMergeSourceRow);

    wireCodeInput('merge-target', function(name) {
      refreshMergePanels();
    }, true);
  }

  if (type === 'move') {
    form.innerHTML = [
      '<div class="op-form-row"><label>Code to move</label>',
      codeInputHTML('move-source', 'select code…', false),
      '</div>',
      '<div class="op-form-row"><label>New parent <span class="label-hint">(leave empty for top level)</span></label>',
      codeInputHTML('move-parent', 'select parent…', false),
      '<button class="btn" style="margin-top:4px" id="move-clear-parent">Set to top level</button>',
      '</div>',
      '<div id="move-panels"></div>',
    ].join('');

    wireCodeInput('move-source', function(name) {
      var panels = document.getElementById('move-panels');
      if (panels) {
        panels.innerHTML = codePanelHTML(name, 'move-src-panel');
        wireCodePanel('move-src-panel');
      }
    }, false);

    wireCodeInput('move-parent', null, false);

    document.getElementById('move-clear-parent').addEventListener('click', function() {
      var inp = document.getElementById('move-parent');
      if (inp) inp.value = '';
    });
  }

  if (type === 'deprecate') {
    form.innerHTML = [
      '<div class="op-form-row"><label>Code to deprecate</label>',
      codeInputHTML('deprecate-source', 'select code…', false),
      '</div>',
      '<p class="form-hint">Sets status to "deprecated" in codebook.json. No qc CLI command is run.</p>',
      '<div id="deprecate-panels"></div>',
    ].join('');

    wireCodeInput('deprecate-source', function(name) {
      var panels = document.getElementById('deprecate-panels');
      if (panels) {
        panels.innerHTML = codePanelHTML(name, 'deprecate-src-panel');
        wireCodePanel('deprecate-src-panel');
      }
    }, false);
  }
}

function addMergeSourceRow() {
  var grid = document.getElementById('merge-grid');
  if (!grid) return;
  var rowId = 'merge-src-' + (++_mergeRowCount);
  var row   = document.createElement('div');
  row.className  = 'merge-row';
  row.dataset.rowId = rowId;
  row.innerHTML  = codeInputHTML(rowId, 'select code…', false)
    + '<button class="btn-icon danger merge-row-remove" title="Remove">×</button>';
  row.querySelector('.merge-row-remove').addEventListener('click', function() {
    grid.removeChild(row);
    refreshMergePanels();
  });
  grid.appendChild(row);
  wireCodeInput(rowId, function() { refreshMergePanels(); }, false);
}

function getMergeSourceNames() {
  var srcs = [];
  document.querySelectorAll('#merge-grid .merge-row').forEach(function(row) {
    var inp = row.querySelector('.code-input');
    if (inp && inp.value) srcs.push(inp.value);
  });
  return srcs;
}

function refreshMergePanels() {
  var panels = document.getElementById('merge-panels');
  if (!panels) return;
  var srcs   = getMergeSourceNames();
  var target = (document.getElementById('merge-target') || {}).value || '';
  var all    = srcs.concat(target ? [target] : []);
  // Deduplicate
  var seen = new Set();
  all = all.filter(function(n) { if (seen.has(n)) return false; seen.add(n); return true; });

  panels.innerHTML = all.map(function(name, i) {
    var panelId = 'merge-panel-' + i;
    return codePanelHTML(name, panelId);
  }).join('');

  all.forEach(function(name, i) {
    wireCodePanel('merge-panel-' + i);
  });
}

// ── Add operation ─────────────────────────────────────────────────────────────

function addOperation() {
  var type = state.activeTab;
  var op   = null;

  if (type === 'rename') {
    var src = (document.getElementById('rename-source') || {}).value || '';
    var tgt = ((document.getElementById('rename-target') || {}).value || '').trim();
    if (!src) { alert('Please select a source code.'); return; }
    if (!tgt) { alert('Please enter a new name.'); return; }
    if (src === tgt) { alert('Source and target are the same.'); return; }
    op = { id: state.nextId++, type: 'rename', sources: [src], target: tgt };
  }

  if (type === 'merge') {
    var srcs = getMergeSourceNames();
    var tgt  = ((document.getElementById('merge-target') || {}).value || '').trim();
    if (srcs.length === 0) { alert('Please select at least one source code.'); return; }
    if (!tgt) { alert('Please select or enter a target code.'); return; }
    srcs = srcs.filter(function(s) { return s !== tgt; });
    if (srcs.length === 0) { alert('Sources and target cannot all be the same code.'); return; }
    op = { id: state.nextId++, type: 'merge', sources: srcs, target: tgt };
  }

  if (type === 'move') {
    var src    = (document.getElementById('move-source') || {}).value || '';
    var parent = ((document.getElementById('move-parent') || {}).value || '').trim();
    if (!src) { alert('Please select a code to move.'); return; }
    op = { id: state.nextId++, type: 'move', sources: [src], target: parent };
  }

  if (type === 'deprecate') {
    var src = (document.getElementById('deprecate-source') || {}).value || '';
    if (!src) { alert('Please select a code to deprecate.'); return; }
    op = { id: state.nextId++, type: 'deprecate', sources: [src], target: src };
  }

  if (op) {
    state.queues[type].push(op);
    state.expandedSegs = {};
    renderQueueForTab(type);
    renderPreview();
    renderScript();
    renderExecuteRow();
    // Clear the form
    renderOpForm();
  }
}

// ── Queue rendering ───────────────────────────────────────────────────────────

function opDesc(op) {
  var srcs = op.sources.map(function(s) {
    return '<span class="code-name">' + esc(s) + '</span>';
  }).join('<span class="arrow">, </span>');

  if (op.type === 'rename') {
    return srcs + '<span class="arrow"> → </span><span class="code-name">' + esc(op.target) + '</span>';
  }
  if (op.type === 'merge') {
    return srcs + '<span class="arrow"> → </span><span class="code-name">' + esc(op.target) + '</span>';
  }
  if (op.type === 'move') {
    return srcs + '<span class="arrow"> → </span>'
      + (op.target ? '<span class="code-name">' + esc(op.target) + '</span>' : '<em>(top level)</em>');
  }
  if (op.type === 'deprecate') {
    return srcs + '<span class="arrow"> → </span><em>deprecated</em>';
  }
  return '';
}

function renderQueueForTab(type) {
  var list = document.getElementById('queue-list-' + type);
  if (!list) return;
  var queue = state.queues[type];

  if (queue.length === 0) {
    list.innerHTML = '<div class="queue-empty">No ' + type + ' operations staged.</div>';
    return;
  }

  list.innerHTML = queue.map(function(op) {
    var swapBtn = (type === 'merge' && op.sources.length > 0)
      ? '<button class="queue-item-swap" data-id="' + op.id + '" title="Swap target with first source">⇄</button>'
      : '';
    return '<div class="queue-item" data-id="' + op.id + '">'
      + '<span class="queue-item-badge badge-' + type + '">' + type + '</span>'
      + '<div class="queue-item-body"><div class="queue-item-desc">' + opDesc(op) + '</div></div>'
      + swapBtn
      + '<button class="queue-item-remove" data-id="' + op.id + '" data-type="' + type + '" title="Remove">×</button>'
      + '</div>';
  }).join('');

  list.querySelectorAll('.queue-item-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = parseInt(btn.dataset.id);
      var t  = btn.dataset.type;
      state.queues[t] = state.queues[t].filter(function(o) { return o.id !== id; });
      renderQueueForTab(t);
      renderPreview();
      renderScript();
      renderExecuteRow();
    });
  });

  list.querySelectorAll('.queue-item-swap').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = parseInt(btn.dataset.id);
      var op = state.queues['merge'].find(function(o) { return o.id === id; });
      if (!op || !op.sources.length) return;
      var oldTgt = op.target;
      op.target  = op.sources[0];
      op.sources = [oldTgt].concat(op.sources.slice(1));
      renderQueueForTab('merge');
      renderPreview();
      renderScript();
    });
  });
}

function allOps() {
  return state.queues.rename
    .concat(state.queues.merge)
    .concat(state.queues.move)
    .concat(state.queues.deprecate);
}

function totalOps() { return allOps().length; }

// ── Preview — tree diff ───────────────────────────────────────────────────────

function renderTreeDiff() {
  var panel = document.getElementById('diff-panel');
  if (!panel) return;

  var ops = allOps();
  if (ops.length === 0) {
    panel.innerHTML = '<div class="preview-empty">Stage operations to see a tree diff.</div>';
    return;
  }

  // Build op map
  var opMap = {};
  ops.forEach(function(op) {
    if (op.type === 'rename') {
      opMap[op.sources[0]] = { op: op, role: 'rename-src' };
    } else if (op.type === 'merge') {
      op.sources.forEach(function(s) { opMap[s] = { op: op, role: 'merge-src' }; });
      if (!opMap[op.target] || opMap[op.target].role !== 'merge-src') {
        opMap[op.target] = { op: op, role: 'merge-tgt' };
      }
    } else if (op.type === 'move') {
      opMap[op.sources[0]] = { op: op, role: 'move' };
    } else if (op.type === 'deprecate') {
      opMap[op.sources[0]] = { op: op, role: 'deprecate' };
    }
  });

  var html = [];
  var addedNames = new Set();
  ops.forEach(function(op) {
    if (op.type === 'rename' && !CODEBOOK_TREE.some(function(n) { return n.name === op.target; })) {
      addedNames.add(op.target);
    }
  });

  getTree().forEach(function(node) {
    var info   = opMap[node.name];
    var role   = info ? info.role : null;
    var op     = info ? info.op   : null;
    var indent = '  '.repeat(node.depth);
    var cls    = 'tree-node';
    var tag    = '';

    if (role === 'rename-src') {
      cls += ' op-remove';
      tag = '<span class="node-tag tag-renamed">→ ' + esc(op.target) + '</span>';
    } else if (role === 'merge-src') {
      cls += ' op-remove';
      tag = '<span class="node-tag tag-merge-src">→ ' + esc(op.target) + '</span>';
    } else if (role === 'merge-tgt') {
      tag = '<span class="node-tag tag-merge-tgt">merge target</span>';
    } else if (role === 'move') {
      cls += ' op-move';
      tag = '<span class="node-tag tag-move">→ ' + esc(op.target || '(top level)') + '</span>';
    } else if (role === 'deprecate') {
      cls += ' op-deprecate';
      tag = '<span class="node-tag tag-deprecated">deprecated</span>';
    }

    var cnt    = corpusCount(node.name);
    var cntEl  = cnt > 0 ? '<span class="node-count">(' + cnt + ')</span>' : '';

    html.push('<div class="' + cls + '">'
      + '<span class="picker-indent">' + esc(indent) + '</span>'
      + '<span class="node-name">' + esc(node.name) + '</span>'
      + cntEl + tag
      + '</div>');
  });

  addedNames.forEach(function(name) {
    if (!CODEBOOK_TREE.some(function(n) { return n.name === name; })) {
      html.push('<div class="tree-node op-add">'
        + '<span class="node-name">' + esc(name) + '</span>'
        + '<span class="node-tag tag-renamed">new</span>'
        + '</div>');
    }
  });

  panel.innerHTML = html.join('');
}

// ── Preview — corpus impact ───────────────────────────────────────────────────

function renderCorpusImpact() {
  var panel = document.getElementById('impact-panel');
  if (!panel) return;

  var ops = allOps().filter(function(op) { return op.type !== 'move'; });

  if (ops.length === 0) {
    panel.innerHTML = '<div class="preview-empty">No corpus-affecting operations staged.</div>';
    return;
  }

  var html = ops.map(function(op) {
    var affectedCodes = op.type === 'deprecate' ? op.sources : op.sources.concat(
      CODEBOOK_TREE.some(function(n) { return n.name === op.target; }) ? [op.target] : []
    );
    // Deduplicate
    var seen = new Set();
    affectedCodes = affectedCodes.filter(function(n) { if (seen.has(n)) return false; seen.add(n); return true; });

    var badgeCls = 'badge-' + op.type;
    var h = '<div class="impact-op">'
      + '<div class="impact-op-header">'
      + '<span class="queue-item-badge ' + badgeCls + '">' + op.type + '</span>'
      + '<span class="impact-op-desc">' + opDesc(op) + '</span>'
      + '</div>';

    h += affectedCodes.map(function(codeName) {
      var segs  = corpusSegs(codeName);
      var cnt   = corpusCount(codeName);
      var role  = op.sources.includes(codeName) ? 'src' : 'tgt';
      var key   = op.id + ':' + codeName;
      var exp   = !!state.expandedSegs[key];
      var segCls = 'seg-block seg-' + role;

      var block = '<div class="' + segCls + '">'
        + '<button class="seg-toggle" data-key="' + esc(key) + '">'
        + (exp ? '▾ ' : '▸ ')
        + '<span class="code-name">' + esc(codeName) + '</span>'
        + ' — ' + cnt + ' segment' + (cnt !== 1 ? 's' : '')
        + (segs.length < cnt ? ' (showing ' + segs.length + ')' : '')
        + '</button>';

      if (exp && segs.length > 0) {
        block += '<div class="seg-list">'
          + segs.map(function(s) {
              return '<div class="seg-item">'
                + '<span class="seg-loc">' + esc(s.document) + ':' + s.line + '</span>'
                + '<span class="seg-text">' + esc(truncate(s.text, SEG_TRUNCATE)) + '</span>'
                + '</div>';
            }).join('')
          + '</div>';
      } else if (exp && segs.length === 0) {
        block += '<div class="seg-empty">No segment text available.</div>';
      }

      block += '</div>';
      return block;
    }).join('');

    h += '</div>';
    return h;
  }).join('');

  panel.innerHTML = html;

  panel.querySelectorAll('.seg-toggle').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key = btn.dataset.key;
      state.expandedSegs[key] = !state.expandedSegs[key];
      renderCorpusImpact();
    });
  });
}

// ── Preview wrapper ───────────────────────────────────────────────────────────

function renderPreview() {
  var previewWrap = document.getElementById('preview-wrap');
  if (!previewWrap) return;
  if (state.panelTab !== 'preview') {
    previewWrap.classList.add('hidden');
    return;
  }
  previewWrap.classList.remove('hidden');

  // Sub-tab highlighting
  document.querySelectorAll('.preview-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.ptab === state.previewTab);
  });

  var diffPanel   = document.getElementById('diff-panel');
  var impactPanel = document.getElementById('impact-panel');
  if (diffPanel)   diffPanel.classList.toggle('hidden',   state.previewTab !== 'diff');
  if (impactPanel) impactPanel.classList.toggle('hidden', state.previewTab !== 'impact');

  if (state.previewTab === 'diff')   renderTreeDiff();
  if (state.previewTab === 'impact') renderCorpusImpact();
}

// ── Script ────────────────────────────────────────────────────────────────────

function generateScript() {
  var lines = ['#!/bin/bash', '# qc-refactor — generated script', ''];
  allOps().forEach(function(op) {
    if (op.type === 'rename') {
      lines.push('qc codes rename ' + shellQuote(op.sources[0]) + ' ' + shellQuote(op.target));
    } else if (op.type === 'merge') {
      lines.push('qc codes rename ' + op.sources.map(shellQuote).join(' ') + ' ' + shellQuote(op.target));
    } else if (op.type === 'move') {
      lines.push('# move ' + op.sources[0] + ' → ' + (op.target || '(top level)') + '  [codebook.yaml edit]');
    } else if (op.type === 'deprecate') {
      lines.push('# deprecate: ' + op.sources[0] + '  [codebook.json status change]');
    }
  });
  return lines.join('\n');
}

function renderScript() {
  var panel = document.getElementById('script-panel');
  if (!panel) return;
  if (state.panelTab !== 'script') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (totalOps() === 0) {
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
      var btn = document.getElementById('copy-script');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(function() { if (btn) btn.textContent = 'Copy'; }, 1500); }
    });
  });
}

// ── Results ───────────────────────────────────────────────────────────────────

function renderResults() {
  var panel = document.getElementById('results-panel');
  if (!panel) return;
  if (state.panelTab !== 'results') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (!state.results) {
    panel.innerHTML = '<div class="script-empty">No execution results yet.</div>';
    return;
  }

  panel.innerHTML = state.results.map(function(r) {
    return '<div class="result-item ' + (r.ok ? 'ok' : 'err') + '">'
      + '<span class="result-icon">' + (r.ok ? '✓' : '✗') + '</span>'
      + '<div class="result-body">'
      + '<div class="result-cmd">' + esc(r.cmd) + '</div>'
      + (r.output ? '<div class="result-out">' + esc(r.output) + '</div>' : '')
      + '</div></div>';
  }).join('');
}

// ── Execute row ───────────────────────────────────────────────────────────────

function renderExecuteRow() {
  var n = totalOps();
  var countEl = document.getElementById('queue-count');
  if (countEl) countEl.textContent = n === 0 ? 'Queue is empty' : n === 1 ? '1 operation staged' : n + ' operations staged';
  var btnEx = document.getElementById('btn-execute');
  var btnCl = document.getElementById('btn-clear');
  if (btnEx) btnEx.disabled = n === 0;
  if (btnCl) btnCl.disabled = n === 0;
}

// ── Full render ───────────────────────────────────────────────────────────────

function render() {
  ['rename','merge','move','deprecate'].forEach(renderQueueForTab);
  renderOpForm();
  renderPreview();
  renderScript();
  renderResults();
  renderExecuteRow();
}

// ── Execute ───────────────────────────────────────────────────────────────────

function showSummaryModal() {
  var modal = document.getElementById('summary-modal');
  var ta    = document.getElementById('summary-text');
  if (modal) modal.classList.remove('hidden');
  if (ta)    { ta.value = state.sessionNote; ta.focus(); }
}

function hideSummaryModal() {
  var modal = document.getElementById('summary-modal');
  if (modal) modal.classList.add('hidden');
}

async function executeQueue(summary) {
  state.sessionNote = summary;
  hideSummaryModal();

  var payload = {
    operations:  allOps(),
    summary:     summary,
    script:      generateScript(),
    scheme_path: SCHEME_PATH,
    docs_edits:  state.docsEdits,
  };

  try {
    var res  = await fetch(API + '/refactor/execute', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    var data = await res.json();

    state.results    = data.results || [];
    state.queues     = { rename: [], merge: [], move: [], deprecate: [] };
    state.docsEdits  = {};
    state.expandedSegs = {};
    state.panelTab   = 'results';

    // Reload docs data so edits are reflected
    await loadDocs();

    document.querySelectorAll('.panel-tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.tab === 'results');
    });
    document.getElementById('preview-wrap')  && document.getElementById('preview-wrap').classList.add('hidden');
    document.getElementById('script-panel')  && document.getElementById('script-panel').classList.add('hidden');
    document.getElementById('results-panel') && document.getElementById('results-panel').classList.remove('hidden');

    render();
  } catch(e) {
    alert('Execution error: ' + e.message);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async function() {

  document.getElementById('qc-refactor-root').innerHTML = [
    '<div class="app">',

    // ── Left: op tabs + form + per-type queues
    '<div class="queue-panel">',
    '  <div class="op-tabs">',
    '    <button class="op-tab active" data-type="rename">Rename</button>',
    '    <button class="op-tab" data-type="merge">Merge</button>',
    '    <button class="op-tab" data-type="move">Move</button>',
    '    <button class="op-tab" data-type="deprecate">Deprecate</button>',
    '  </div>',
    '  <div class="op-form" id="op-form"></div>',
    '  <div style="padding:8px 14px;border-bottom:1px solid var(--border-dim);flex-shrink:0">',
    '    <button class="btn primary" id="btn-add" style="width:100%">Add to queue</button>',
    '  </div>',
    // Per-type queue lists (only active one visible)
    '  <div class="queue-list" id="queue-list-rename"></div>',
    '  <div class="queue-list hidden" id="queue-list-merge"></div>',
    '  <div class="queue-list hidden" id="queue-list-move"></div>',
    '  <div class="queue-list hidden" id="queue-list-deprecate"></div>',
    '  <div class="queue-footer">',
    '    <div class="queue-count" id="queue-count">Queue is empty</div>',
    '    <div class="execute-row">',
    '      <button class="btn" id="btn-clear" disabled>Clear all</button>',
    '      <button class="btn primary" id="btn-execute" disabled style="flex:1">Execute queue…</button>',
    '    </div>',
    '  </div>',
    '</div>',

    // ── Right: panel tabs + preview (with sub-tabs) + script + results
    '<div class="right-panel">',
    '  <div class="panel-tabs">',
    '    <button class="panel-tab active" data-tab="preview">Preview</button>',
    '    <button class="panel-tab" data-tab="script">Script</button>',
    '    <button class="panel-tab" data-tab="results">Results</button>',
    '  </div>',
    // Preview wrap with diff / impact sub-tabs
    '  <div id="preview-wrap" class="preview-wrap">',
    '    <div class="preview-tabs">',
    '      <button class="preview-tab active" data-ptab="diff">Tree diff</button>',
    '      <button class="preview-tab" data-ptab="impact">Corpus impact</button>',
    '    </div>',
    '    <div id="diff-panel" class="diff-panel"></div>',
    '    <div id="impact-panel" class="impact-panel hidden"></div>',
    '  </div>',
    '  <div class="script-panel hidden" id="script-panel"></div>',
    '  <div class="results-panel hidden" id="results-panel"></div>',
    '</div>',

    '</div>',

    // ── Summary modal
    '<div class="modal-overlay hidden" id="summary-modal">',
    '  <div class="modal">',
    '    <h2>Session note</h2>',
    '    <p>This note will be used as the snapshot label and will seed the provenance fields of affected codes.</p>',
    '    <textarea id="summary-text" placeholder="e.g. Merged overlapping activity codes following second coding round"></textarea>',
    '    <div class="modal-actions">',
    '      <button class="btn" id="btn-cancel-summary">Cancel</button>',
    '      <button class="btn primary" id="btn-confirm-execute">Execute</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('');

  // Load codebook docs
  await loadDocs();

  // Op type tabs
  document.querySelectorAll('.op-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      state.activeTab = tab.dataset.type;
      document.querySelectorAll('.op-tab').forEach(function(t) {
        t.classList.toggle('active', t === tab);
      });
      // Show correct queue list
      ['rename','merge','move','deprecate'].forEach(function(t) {
        var el = document.getElementById('queue-list-' + t);
        if (el) el.classList.toggle('hidden', t !== state.activeTab);
      });
      closePicker();
      renderOpForm();
    });
  });

  // Preview sub-tabs
  document.querySelectorAll('.preview-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      state.previewTab = tab.dataset.ptab;
      document.querySelectorAll('.preview-tab').forEach(function(t) {
        t.classList.toggle('active', t === tab);
      });
      var diff   = document.getElementById('diff-panel');
      var impact = document.getElementById('impact-panel');
      if (diff)   diff.classList.toggle('hidden',   state.previewTab !== 'diff');
      if (impact) impact.classList.toggle('hidden', state.previewTab !== 'impact');
      renderTreeDiff();
      renderCorpusImpact();
    });
  });

  // Panel tabs
  document.querySelectorAll('.panel-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      state.panelTab = tab.dataset.tab;
      document.querySelectorAll('.panel-tab').forEach(function(t) {
        t.classList.toggle('active', t === tab);
      });
      var pw = document.getElementById('preview-wrap');
      var sp = document.getElementById('script-panel');
      var rp = document.getElementById('results-panel');
      if (pw) pw.classList.toggle('hidden',  state.panelTab !== 'preview');
      if (sp) sp.classList.toggle('hidden',  state.panelTab !== 'script');
      if (rp) rp.classList.toggle('hidden',  state.panelTab !== 'results');
      renderPreview();
      renderScript();
      renderResults();
    });
  });

  document.getElementById('btn-add').addEventListener('click', addOperation);

  document.getElementById('btn-clear').addEventListener('click', function() {
    state.queues     = { rename: [], merge: [], move: [], deprecate: [] };
    state.docsEdits  = {};
    state.expandedSegs = {};
    render();
  });

  document.getElementById('btn-execute').addEventListener('click', showSummaryModal);
  document.getElementById('btn-cancel-summary').addEventListener('click', hideSummaryModal);
  document.getElementById('btn-confirm-execute').addEventListener('click', function() {
    var summary = (document.getElementById('summary-text') || {}).value || '';
    summary = summary.trim();
    if (!summary) { alert('Please enter a session note.'); return; }
    executeQueue(summary);
  });

  render();
});

})();
