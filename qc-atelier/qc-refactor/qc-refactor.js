(function() {
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

var API              = 'http://localhost:' + (REFACTOR_CONFIG ? REFACTOR_CONFIG.server_port : 8080);
var SCHEME_PATH      = REFACTOR_CONFIG ? REFACTOR_CONFIG.scheme_path : '';
var SEG_TRUNCATE     = 140;
var DOC_FIELDS       = ['scope', 'rationale', 'usage_notes', 'provenance'];
var DOC_FIELD_LABELS = { scope: 'Scope', rationale: 'Rationale', usage_notes: 'Usage notes', provenance: 'History' };
var DOC_FIELD_HINTS  = {
  scope:       'What this code captures and where it ends',
  rationale:   'Why this code exists; when to apply vs. siblings',
  usage_notes: 'Edge cases, what to exclude, common confusions',
  provenance:  'When created, split from, merged with',
};
var DOC_FIELD_PLACEHOLDERS = {
  scope:       'What does this code cover?',
  rationale:   'When to use this? How does it differ from nearby codes?',
  usage_notes: 'What are the tricky cases? What should NOT be coded here?',
  provenance:  'e.g. Split from X in Oct 2025',
};

// ── State ─────────────────────────────────────────────────────────────────────

var state = {
  // Unified queue — all op types together
  queue:       [],
  activeTab:   'rename',       // which op tab is open
  previewTab:  'diff',         // diff | impact
  panelTab:    'preview',      // preview | script | results | history
  appMode:     'refactor',     // refactor | snapshots
  snapshotsData:   null,
  snapshotsStatus: '',         // '' | 'loading' | 'ok' | 'error'
  snapshotLabel:   '',
  snapshotNote:    '',
  results:     null,
  snapshot:    null,
  nextId:      1,
  sessionNote: '',
  // Loaded codebook.json data
  docsData:    null,           // full codes object from codebook.json
  docsEdits:   {},             // {codeName: {field: value}} — edits made in UI
  // UI state
  expandedSegs: {},            // key → bool
  pickerOpen:     null,
  pickerCollapsed: new Set(),   // collapsed branch names in multi-select picker
};

// ── Load codebook.json ────────────────────────────────────────────────────────

async function loadDocs() {
  try {
    var res  = await fetch(API + '/docs/load?path=' + encodeURIComponent(SCHEME_PATH));
    var data = await res.json();
    if (data.ok) {
      state.docsData = data.codes || {};
      var mismatches = data.mismatches || [];
      if (mismatches.length > 0) {
        console.warn('[qc-refactor] Parent mismatches:', mismatches);
        var msg = '⚠ Parent mismatch detected:\n'
          + mismatches.map(function(m) {
              return '  ' + m.code + ': yaml=' + (m.yaml_parent||'(top)') + ', json=' + (m.json_parent||'(top)');
            }).join('\n');
        showFormError(msg);
      }
    }
  } catch(e) {
    console.warn('Could not load codebook.json:', e);
  }
}

async function refreshTree() {
  try {
    var res  = await fetch(API + '/refactor/tree');
    var data = await res.json();
    if (data.ok && data.tree) {
      _runtimeTree = data.tree;
    }
  } catch(e) {
    console.warn('Could not refresh tree:', e);
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

// ── Runtime tree (mutable copy of baked globals, updated after execute) ───────

var _runtimeTree   = (CODEBOOK_TREE || []).map(function(n) { return Object.assign({}, n); });
var _runtimeCounts = Object.assign({}, CORPUS_COUNTS || {});

function getTree()         { return _runtimeTree; }
function corpusCount(name) { var c = _runtimeCounts[name]; return c ? c.total : 0; }
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
    var val         = doc[field] || '';
    var hint        = DOC_FIELD_HINTS[field] || '';
    var placeholder = DOC_FIELD_PLACEHOLDERS[field] || '';
    html += '<div class="code-panel-field">'
      + '<label class="code-panel-label">'
      + DOC_FIELD_LABELS[field]
      + (hint ? '<span class="code-panel-field-hint">' + esc(hint) + '</span>' : '')
      + '</label>'
      + '<textarea class="code-panel-textarea" data-code="' + esc(codeName) + '" data-field="' + field + '" rows="2" placeholder="' + esc(placeholder) + '">'
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

function showFormError(msg) {
  var el = document.getElementById('op-form-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(function() { el.classList.add('hidden'); }, 3000);
}

function clearFormError() {
  var el = document.getElementById('op-form-error');
  if (el) el.classList.add('hidden');
}

var _mergeRowCount = 0;

function renderOpForm() {
  var form = document.getElementById('op-form');
  closePicker();
  form.innerHTML = '';

  var type = state.activeTab;
  form.innerHTML = '<div id="op-form-error" class="op-form-error hidden"></div>';

  if (type === 'rename') {
    form.innerHTML += [
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
    form.innerHTML += [
      '<div class="op-form-row"><label>Source codes</label>',
      '<div class="merge-grid" id="merge-grid"></div>',
      '<button class="btn" style="margin-top:6px;width:100%" id="add-merge-src">+ Add code</button>',
      '</div>',
      '<div class="op-form-row"><label>Target <span class="label-hint">(surviving name)</span></label>',
      codeInputHTML('merge-target', 'select or type new…', true),
      '</div>',
      '<div style="padding:4px 0 6px;display:flex;justify-content:flex-end">',
      '  <button class="btn" id="merge-swap-btn" title="Swap: promote first source to target">⇄ Swap target with first source</button>',
      '</div>',
      '<div id="merge-panels"></div>',
    ].join('');

    addMergeSourceRow();
    document.getElementById('add-merge-src').addEventListener('click', addMergeSourceRow);

    wireCodeInput('merge-target', function(name) {
      refreshMergePanels();
    }, true);

    // Swap: promote first source to target, demote current target to first source
    var swapBtn = document.getElementById('merge-swap-btn');
    if (swapBtn) {
      swapBtn.addEventListener('click', function() {
        var rows     = document.querySelectorAll('#merge-grid .merge-row');
        var firstInp = rows.length > 0 ? rows[0].querySelector('.code-input') : null;
        var tgtInp   = document.getElementById('merge-target');
        if (!firstInp || !tgtInp) return;
        var oldFirst  = firstInp.value;
        var oldTarget = tgtInp.value;
        firstInp.value = oldTarget;
        tgtInp.value   = oldFirst;
        refreshMergePanels();
      });
    }
  }

  if (type === 'move') {
    form.innerHTML += [
      '<div class="op-form-row"><label>Codes to move</label>',
      '<div class="multi-picker-wrap">',
        '<input class="picker-search" id="move-multi-search" placeholder="Search codes…" autocomplete="off">',
        '<div class="multi-picker-list" id="move-multi-list"></div>',
      '</div>',
      '</div>',
      '<div class="op-form-row"><label>New parent <span class="label-hint">(leave empty for top level)</span></label>',
      codeInputHTML('move-parent', 'select parent…', false),
      '<button class="btn" style="margin-top:4px" id="move-clear-parent">Set to top level</button>',
      '</div>',
      '<div id="move-panels"></div>',
    ].join('');

    // Initialise multi-select state
    if (!state.moveSelected) state.moveSelected = new Set();

    function renderMultiList(query) {
      var list = document.getElementById('move-multi-list');
      if (!list) return;
      var nodes = getTree();
      query = (query || '').toLowerCase();

      function isVisible(node) {
        if (query) return node.name.toLowerCase().indexOf(query) >= 0;
        // Check if any ancestor is collapsed
        var cur = node.parent;
        while (cur) {
          if (state.pickerCollapsed.has(cur)) return false;
          var p = nodes.find(function(n) { return n.name === cur; });
          cur = p ? p.parent : null;
        }
        return true;
      }

      function hasChildren(name) {
        return nodes.some(function(n) { return n.parent === name; });
      }

      var shown = nodes.filter(isVisible);

      list.innerHTML = shown.map(function(node) {
        var checked   = state.moveSelected.has(node.name) ? 'checked' : '';
        var collapsed  = state.pickerCollapsed.has(node.name);
        var children   = hasChildren(node.name);
        var toggleBtn  = (!query && children)
          ? '<button class="multi-picker-toggle" data-name="' + esc(node.name) + '" tabindex="-1">'
            + (collapsed ? '▶' : '▼') + '</button>'
          : '<span class="multi-picker-toggle-placeholder"></span>';
        var cnt = corpusCount(node.name);
        var cntHtml = cnt > 0 ? '<span class="picker-count">' + cnt + '</span>' : '';
        return '<label class="multi-picker-item" style="padding-left:' + (node.depth * 14 + 4) + 'px">'
          + toggleBtn
          + '<input type="checkbox" class="multi-picker-cb" data-name="' + esc(node.name) + '" ' + checked + '>'
          + '<span class="picker-label">' + esc(node.name) + '</span>'
          + cntHtml
          + '</label>';
      }).join('');

      // Wire collapse toggles
      list.querySelectorAll('.multi-picker-toggle').forEach(function(btn) {
        btn.addEventListener('mousedown', function(e) {
          e.preventDefault();
          var name = btn.dataset.name;
          if (state.pickerCollapsed.has(name)) state.pickerCollapsed.delete(name);
          else state.pickerCollapsed.add(name);
          renderMultiList(document.getElementById('move-multi-search').value);
        });
      });

      // Wire checkboxes
      list.querySelectorAll('.multi-picker-cb').forEach(function(cb) {
        cb.addEventListener('change', function() {
          var name = cb.dataset.name;
          if (cb.checked) {
            state.moveSelected.add(name);
            // Show doc panel for most recently checked
            var panels = document.getElementById('move-panels');
            if (panels) {
              panels.innerHTML = codePanelHTML(name, 'move-src-panel');
              wireCodePanel('move-src-panel');
            }
          } else {
            state.moveSelected.delete(name);
          }
        });
      });
    }

    renderMultiList('');

    document.getElementById('move-multi-search').addEventListener('input', function() {
      renderMultiList(this.value);
    });

    wireCodeInput('move-parent', null, false);

    document.getElementById('move-clear-parent').addEventListener('click', function() {
      var inp = document.getElementById('move-parent');
      if (inp) inp.value = '';
    });
  }

  if (type === 'deprecate') {
    form.innerHTML += [
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

  var html = '';

  // Source codes — read-only summary of existing notes (they are disappearing)
  if (srcs.length > 0) {
    html += '<div class="merge-sources-summary">';
    html += '<div class="merge-sources-label">Source notes (read-only — will be carried into target)</div>';
    srcs.forEach(function(name) {
      var doc = getCodeDoc(name);
      var cnt = corpusCount(name);
      var hasContent = DOC_FIELDS.some(function(f) { return doc[f]; });
      html += '<div class="merge-src-summary">';
      html += '<div class="merge-src-name"><span class="code-name">' + esc(name) + '</span>';
      if (cnt > 0) html += '<span class="code-panel-count">' + cnt + ' segments</span>';
      html += '</div>';
      if (hasContent) {
        DOC_FIELDS.forEach(function(field) {
          if (doc[field]) {
            html += '<div class="merge-src-field">'
              + '<span class="merge-src-field-label">' + DOC_FIELD_LABELS[field] + '</span>'
              + '<span class="merge-src-field-val">' + esc(doc[field]) + '</span>'
              + '</div>';
          }
        });
      } else {
        html += '<div class="merge-src-empty">No existing documentation.</div>';
      }
      html += '</div>';
    });
    html += '</div>';
  }

  // Target code — editable, pre-populated from sources if target has no existing content
  if (target) {
    var targetDoc = getCodeDoc(target);
    // Pre-populate empty target fields from source docs (concatenated)
    var prePopulated = false;
    if (srcs.length > 0) {
      DOC_FIELDS.forEach(function(field) {
        if (!targetDoc[field] && !state.docsEdits[target]?.[field]) {
          var combined = srcs.map(function(s) {
            var d = getCodeDoc(s);
            return d[field] ? '[from ' + s + ']: ' + d[field] : '';
          }).filter(Boolean).join('\n');
          if (combined) {
            if (!state.docsEdits[target]) state.docsEdits[target] = {};
            state.docsEdits[target][field] = combined;
            prePopulated = true;
          }
        }
      });
    }
    html += codePanelHTML(target, 'merge-target-panel');
  }

  panels.innerHTML = html;
  if (target) wireCodePanel('merge-target-panel');
}

// ── Repopulate form from a queue item (for editing) ──────────────────────────

function repopulateForm(op) {
  if (op.type === 'rename') {
    var src = document.getElementById('rename-source');
    var tgt = document.getElementById('rename-target');
    if (src) { src.value = op.sources[0]; src.dispatchEvent(new Event('change')); }
    if (tgt) tgt.value = op.target;
    // Trigger the panel
    var panels = document.getElementById('rename-panels');
    if (panels && op.sources[0]) {
      panels.innerHTML = codePanelHTML(op.sources[0], 'rename-src-panel');
      wireCodePanel('rename-src-panel');
    }
  }

  if (op.type === 'merge') {
    // Sources: clear the default one row and add one per source
    var grid = document.getElementById('merge-grid');
    if (grid) {
      grid.innerHTML = '';
      _mergeRowCount = 0;
      op.sources.forEach(function(s) {
        addMergeSourceRow();
        var rows = grid.querySelectorAll('.merge-row');
        var lastRow = rows[rows.length - 1];
        var inp = lastRow ? lastRow.querySelector('.code-input') : null;
        if (inp) inp.value = s;
      });
    }
    var tgt = document.getElementById('merge-target');
    if (tgt) tgt.value = op.target;
    refreshMergePanels();
  }

  if (op.type === 'move') {
    var src = document.getElementById('move-source');
    var par = document.getElementById('move-parent');
    if (src) src.value = op.sources[0];
    if (par) par.value = op.target || '';
    var panels = document.getElementById('move-panels');
    if (panels && op.sources[0]) {
      panels.innerHTML = codePanelHTML(op.sources[0], 'move-src-panel');
      wireCodePanel('move-src-panel');
    }
  }

  if (op.type === 'deprecate') {
    var src = document.getElementById('deprecate-source');
    if (src) src.value = op.sources[0];
    var panels = document.getElementById('deprecate-panels');
    if (panels && op.sources[0]) {
      panels.innerHTML = codePanelHTML(op.sources[0], 'deprecate-src-panel');
      wireCodePanel('deprecate-src-panel');
    }
  }
}

// ── Apply executed ops to runtime tree ───────────────────────────────────────
// Called after a successful execute to keep pickers and counts current
// without requiring a re-render.

function applyOpsToRuntimeTree(operations) {
  operations.forEach(function(op) {
    var sources = op.sources || [];
    var target  = op.target  || '';

    if (op.type === 'rename' && sources.length === 1) {
      var old = sources[0];
      _runtimeTree.forEach(function(n) {
        if (n.name   === old) n.name   = target;
        if (n.parent === old) n.parent = target;
      });
      if (_runtimeCounts[old]) {
        _runtimeCounts[target] = _runtimeCounts[old];
        delete _runtimeCounts[old];
      }
    }

    if (op.type === 'merge') {
      // Reassign children of sources to target, remove source nodes
      sources.forEach(function(src) {
        _runtimeTree.forEach(function(n) {
          if (n.parent === src) n.parent = target;
        });
        _runtimeTree = _runtimeTree.filter(function(n) { return n.name !== src; });
        // Accumulate counts into target
        if (_runtimeCounts[src]) {
          if (!_runtimeCounts[target]) _runtimeCounts[target] = { total: 0, docs: 0 };
          _runtimeCounts[target].total += _runtimeCounts[src].total;
          delete _runtimeCounts[src];
        }
      });
      // Add target node if it doesn't exist
      if (!_runtimeTree.find(function(n) { return n.name === target; })) {
        _runtimeTree.push({ name: target, parent: '', depth: 0, prefix: target.slice(0, 2) });
      }
    }

    if (op.type === 'move' && sources.length === 1) {
      var src = sources[0];
      _runtimeTree.forEach(function(n) {
        if (n.name === src) n.parent = target;
      });
    }

    // deprecate: no tree structure change needed
  });

  // Recompute depths
  var depthCache = {};
  function getDepth(name) {
    if (!name) return 0;
    if (depthCache[name] !== undefined) return depthCache[name];
    var node = _runtimeTree.find(function(n) { return n.name === name; });
    if (!node || !node.parent) { depthCache[name] = 0; return 0; }
    depthCache[name] = 1 + getDepth(node.parent);
    return depthCache[name];
  }
  _runtimeTree.forEach(function(n) { n.depth = getDepth(n.name); });
}

// ── Add operation ─────────────────────────────────────────────────────────────

function addOperation() {
  var type = state.activeTab;
  var op   = null;

  if (type === 'rename') {
    var src = (document.getElementById('rename-source') || {}).value || '';
    var tgt = ((document.getElementById('rename-target') || {}).value || '').trim();
    if (!src) { showFormError('Please select a source code.'); return; }
    if (!tgt) { showFormError('Please enter a new name.'); return; }
    if (src === tgt) { showFormError('Source and target are the same.'); return; }
    op = { id: state.nextId++, type: 'rename', sources: [src], target: tgt };
  }

  if (type === 'merge') {
    var srcs = getMergeSourceNames();
    var tgt  = ((document.getElementById('merge-target') || {}).value || '').trim();
    if (srcs.length === 0) { showFormError('Please select at least one source code.'); return; }
    if (!tgt) { showFormError('Please select or enter a target code.'); return; }
    srcs = srcs.filter(function(s) { return s !== tgt; });
    if (srcs.length === 0) { showFormError('Sources and target cannot all be the same code.'); return; }
    op = { id: state.nextId++, type: 'merge', sources: srcs, target: tgt };
  }

  if (type === 'move') {
    var srcs   = Array.from(state.moveSelected || []);
    var parent = ((document.getElementById('move-parent') || {}).value || '').trim();
    if (srcs.length === 0) { showFormError('Please select at least one code to move.'); return; }
    srcs.forEach(function(src) {
      state.queue.push({ id: state.nextId++, type: 'move', sources: [src], target: parent });
    });
    // Keep selection visible — cleared after execute
    state.expandedSegs = {};
    renderQueue();
    renderPreview();
    renderScript();
    renderExecuteRow();
    return;
  }

  if (type === 'deprecate') {
    var src = (document.getElementById('deprecate-source') || {}).value || '';
    if (!src) { showFormError('Please select a code to deprecate.'); return; }
    op = { id: state.nextId++, type: 'deprecate', sources: [src], target: src };
  }

  if (op) {
    state.queue.push(op);
    state.expandedSegs = {};
    renderQueue();
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

function renderQueue() {
  var list = document.getElementById('queue-list');
  if (!list) return;

  if (state.queue.length === 0) {
    list.innerHTML = '<div class="queue-empty">No operations staged.</div>';
    return;
  }

  list.innerHTML = state.queue.map(function(op) {
    var type = op.type;
    return '<div class="queue-item" data-id="' + op.id + '">'
      + '<span class="queue-item-badge badge-' + type + '">' + type + '</span>'
      + '<div class="queue-item-body"><div class="queue-item-desc">' + opDesc(op) + '</div></div>'
      + '<button class="queue-item-edit" data-id="' + op.id + '" data-type="' + type + '" title="Edit">✎</button>'
      + '<button class="queue-item-remove" data-id="' + op.id + '" data-type="' + type + '" title="Remove">×</button>'
      + '</div>';
  }).join('');

  list.querySelectorAll('.queue-item-edit').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = parseInt(btn.dataset.id);
      var t  = btn.dataset.type;
      var op = state.queue.find(function(o) { return o.id === id; });
      if (!op) return;
      state.queue = state.queue.filter(function(o) { return o.id !== id; });
      state.activeTab = t;
      document.querySelectorAll('.op-tab').forEach(function(tab) {
        tab.classList.toggle('active', tab.dataset.type === t);
      });
      renderOpForm();
      repopulateForm(op);
      renderQueue();
      renderPreview();
      renderScript();
      renderExecuteRow();
    });
  });

  list.querySelectorAll('.queue-item-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = parseInt(btn.dataset.id);
      state.queue = state.queue.filter(function(o) { return o.id !== id; });
      renderQueue();
      renderPreview();
      renderScript();
      renderExecuteRow();
    });
  });
}

function allOps()   { return state.queue; }
function totalOps() { return state.queue.length; }

// ── Preview — tree diff ───────────────────────────────────────────────────────

// ── Preview — post-operation tree (accordion) ────────────────────────────────
//
// Builds a virtual post-operation tree and renders it as a collapsible accordion.
// Affected branches expanded by default; unaffected collapsed.
// Changes shown subtly inline (was X, +N merged, moved, deprecated).

function buildVirtualTree() {
  var ops = allOps();

  // Set of source names being removed (merge-src, rename-src)
  var removed  = new Set();
  // Map: oldName → newName (rename)
  var renamed  = {};
  // Map: targetName → [sourceNames] (merge)
  var mergedFrom = {};
  // Map: name → newParent (move)
  var moved    = {};
  // Set of deprecated names
  var deprecated = new Set();

  ops.forEach(function(op) {
    if (op.type === 'rename') {
      removed.add(op.sources[0]);
      renamed[op.sources[0]] = op.target;
    } else if (op.type === 'merge') {
      op.sources.forEach(function(s) { removed.add(s); });
      if (!mergedFrom[op.target]) mergedFrom[op.target] = [];
      op.sources.forEach(function(s) { mergedFrom[op.target].push(s); });
    } else if (op.type === 'move') {
      moved[op.sources[0]] = op.target; // op.target = new parent ('' = top level)
    } else if (op.type === 'deprecate') {
      deprecated.add(op.sources[0]);
    }
  });

  // Build virtual node list: start from baked tree, apply transformations
  var vnodes = [];
  getTree().forEach(function(node) {
    // Skip merge sources (they disappear)
    if (removed.has(node.name) && !renamed[node.name]) return;

    var vname   = renamed[node.name] || node.name;
    var vparent = moved[node.name] !== undefined ? moved[node.name]
                : (node.parent && renamed[node.parent] ? renamed[node.parent] : node.parent);
    var vdepth  = node.depth; // will be recalculated after move

    var annot = null;
    if (renamed[node.name])        annot = { type: 'renamed',    from: node.name };
    else if (mergedFrom[vname])    annot = { type: 'merged',     from: mergedFrom[vname] };
    else if (moved[node.name] !== undefined) annot = { type: 'moved', to: moved[node.name] };
    else if (deprecated.has(node.name))      annot = { type: 'deprecated' };

    vnodes.push({
      name:    vname,
      origName: node.name,
      parent:  vparent || '',
      depth:   vdepth,
      prefix:  node.prefix,
      annot:   annot,
      affected: !!annot,
    });
  });

  return vnodes;
}

function buildTreeAccordion(vnodes) {
  // Build parent→children map
  var childMap = {};
  vnodes.forEach(function(n) {
    if (!childMap[n.parent]) childMap[n.parent] = [];
    childMap[n.parent].push(n);
  });

  // Determine which nodes have affected descendants
  function hasAffectedDescendant(name) {
    var children = childMap[name] || [];
    for (var i = 0; i < children.length; i++) {
      if (children[i].affected) return true;
      if (hasAffectedDescendant(children[i].name)) return true;
    }
    return false;
  }

  var html = '';

  function renderNode(node, depth) {
    var children    = childMap[node.name] || [];
    var hasChildren = children.length > 0;
    var isAffected  = node.affected;
    var hasAffDesc  = hasAffectedDescendant(node.name);
    // Expand if affected or has affected descendants
    var expanded    = isAffected || hasAffDesc;
    var nodeId      = 'dtree-' + node.name.replace(/[^a-zA-Z0-9]/g, '_');

    var cls = 'dtree-node';
    if (isAffected) cls += ' dtree-affected';

    // Annotation
    var annotEl = '';
    if (node.annot) {
      if (node.annot.type === 'renamed') {
        annotEl = '<span class="dtree-annot">(was ' + esc(node.annot.from) + ')</span>';
      } else if (node.annot.type === 'merged') {
        annotEl = '<span class="dtree-annot">(+' + node.annot.from.length + ' merged: '
          + node.annot.from.map(esc).join(', ') + ')</span>';
      } else if (node.annot.type === 'moved') {
        annotEl = '<span class="dtree-annot">(moved)</span>';
      } else if (node.annot.type === 'deprecated') {
        annotEl = '<span class="dtree-annot dtree-deprecated">(deprecated)</span>';
        cls += ' dtree-deprecated-node';
      }
    }

    var cnt    = corpusCount(node.origName || node.name);
    var cntEl  = cnt > 0 ? '<span class="dtree-count">' + cnt + '</span>' : '';

    var toggleEl = hasChildren
      ? '<span class="dtree-toggle" data-node="' + esc(node.name) + '">' + (expanded ? '▾' : '▸') + '</span>'
      : '<span class="dtree-toggle dtree-leaf"></span>';

    html += '<div class="' + cls + '" data-depth="' + depth + '" style="padding-left:' + (depth * 16 + 4) + 'px">'
      + toggleEl
      + '<span class="dtree-name' + (node.annot && node.annot.type === 'deprecated' ? ' dtree-name-deprecated' : '') + '">'
      + esc(node.name) + '</span>'
      + cntEl + annotEl
      + '</div>';

    if (hasChildren) {
      html += '<div class="dtree-children" id="' + nodeId + '-children"'
        + (expanded ? '' : ' style="display:none"') + '>';
      children.forEach(function(child) { renderNode(child, depth + 1); });
      html += '</div>';
    }
  }

  // Render top-level nodes (parent === '')
  var topLevel = childMap[''] || [];
  topLevel.forEach(function(node) { renderNode(node, 0); });
  return html;
}

function renderTreeDiff() {
  var panel = document.getElementById('diff-panel');
  if (!panel) return;

  var ops = allOps();
  if (ops.length === 0) {
    panel.innerHTML = '<div class="preview-empty">Stage operations to see the post-operation tree.</div>';
    return;
  }

  var vnodes = buildVirtualTree();
  var html   = buildTreeAccordion(vnodes);

  panel.innerHTML = '<div class="dtree">' + html + '</div>';

  // Wire toggle clicks
  panel.querySelectorAll('.dtree-toggle:not(.dtree-leaf)').forEach(function(toggle) {
    toggle.addEventListener('click', function() {
      var nodeName  = toggle.dataset.node;
      var childrenEl = panel.querySelector('#dtree-' + nodeName.replace(/[^a-zA-Z0-9]/g, '_') + '-children');
      if (!childrenEl) return;
      var collapsed = childrenEl.style.display === 'none';
      childrenEl.style.display = collapsed ? '' : 'none';
      toggle.textContent = collapsed ? '▾' : '▸';
    });
  });
}

// ── Preview — corpus impact ───────────────────────────────────────────────────

function renderCorpusImpact() {
  var panel = document.getElementById('impact-panel');
  if (!panel) return;

  var ops = allOps();

  if (ops.length === 0) {
    panel.innerHTML = '<div class="preview-empty">Stage operations to see corpus segments.</div>';
    return;
  }

  var html = ops.map(function(op) {
    // For rename/merge: show sources + target if it already exists in tree
    // For move/deprecate: show sources only (target is a parent or status, not a code)
    var affectedCodes;
    if (op.type === 'move' || op.type === 'deprecate') {
      affectedCodes = op.sources.slice();
    } else {
      affectedCodes = op.sources.concat(
        getTree().some(function(n) { return n.name === op.target; }) ? [op.target] : []
      );
    }
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

  renderTreeDiff();
  renderCorpusImpact();
}

// ── Script ────────────────────────────────────────────────────────────────────

function generateScript() {
  var lines = ['#!/bin/bash', '# qc-refactor — generated script', ''];
  var hasCliOps = false;
  allOps().forEach(function(op) {
    if (op.type === 'rename') {
      lines.push('qc codes rename ' + shellQuote(op.sources[0]) + ' ' + shellQuote(op.target));
      hasCliOps = true;
    } else if (op.type === 'merge') {
      lines.push('qc codes rename ' + op.sources.map(shellQuote).join(' ') + ' ' + shellQuote(op.target));
      hasCliOps = true;
    }
    // move and deprecate are applied server-side; not emitted here
  });
  return { script: hasCliOps ? lines.join('\n') : null, hasCliOps: hasCliOps };
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

  var result = generateScript();

  if (!result.hasCliOps) {
    panel.innerHTML = '<div class="script-block">#!/bin/bash\n# qc-refactor — generated script\n</div>'
      + '<div class="script-note script-note-prominent">No <code>qc</code> CLI commands are required for the queued operations. Move and deprecate are applied directly by the server on execute: move rewrites <code>codebook.yaml</code> hierarchy; deprecate sets the status field in <code>codebook.json</code>.</div>';
    return;
  }

  var serverSideTypes = allOps()
    .filter(function(op) { return op.type === 'move' || op.type === 'deprecate'; })
    .map(function(op) { return op.type; })
    .filter(function(t, i, arr) { return arr.indexOf(t) === i; });

  panel.innerHTML = '<div class="script-block">'
    + '<button class="btn script-copy" id="copy-script">Copy</button>'
    + esc(result.script)
    + '</div>'
    + (serverSideTypes.length > 0
        ? '<div class="script-note script-note-prominent">Move and deprecate operations are applied directly by the server on execute — no <code>qc</code> CLI command is issued for these.</div>'
        : '');

  document.getElementById('copy-script').addEventListener('click', function() {
    navigator.clipboard.writeText(result.script).then(function() {
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

  var noteHtml = state.sessionNote
    ? '<div class="result-note">' + esc(state.sessionNote) + '</div>'
    : '';

  panel.innerHTML = noteHtml + state.results.map(function(r) {
    return '<div class="result-item ' + (r.ok ? 'ok' : 'err') + '">'
      + '<span class="result-icon">' + (r.ok ? '✓' : '✗') + '</span>'
      + '<div class="result-body">'
      + '<div class="result-cmd">' + esc(r.cmd) + '</div>'
      + (r.output ? '<div class="result-out">' + esc(r.output) + '</div>' : '')
      + '</div></div>';
  }).join('');
}

// ── Execute row ───────────────────────────────────────────────────────────────

// ── History ───────────────────────────────────────────────────────────────────

async function renderHistory() {
  var panel = document.getElementById('history-panel');
  if (!panel) return;
  if (state.panelTab !== 'history') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  panel.innerHTML = '<div class="history-loading">Loading…</div>';

  // Fetch refactor history via dedicated server endpoint
  var entries = [];
  try {
    var res  = await fetch(API + '/refactor/history?path=' + encodeURIComponent(SCHEME_PATH));
    var json = await res.json();
    entries  = json.entries || [];
  } catch(e) {
    panel.innerHTML = '<div class="script-empty">Could not load history.</div>';
    return;
  }

  if (entries.length === 0) {
    panel.innerHTML = '<div class="preview-empty">No refactor sessions recorded yet.</div>';
    return;
  }

  panel.innerHTML = entries.map(function(entry) {
    var ts      = entry.ts ? new Date(entry.ts).toLocaleString() : '';
    var ops     = entry.ops || [];
    var results = entry.results || [];
    var status  = entry.status || (results.every(function(r) { return r.ok !== false; }) ? 'ok' : 'failed');
    var statusIcon  = status === 'ok' ? '✓' : status === 'partial' ? '⚠' : '✗';
    var statusClass = status === 'ok' ? 'ok' : 'err';

    var opsHtml = ops.map(function(op, i) {
      var r    = results[i] || {};
      var srcs = (op.sources || []).join(', ');
      var arrow = op.type === 'deprecate' ? '→ deprecated' : '→ ' + esc(op.target || '');
      var opStatus = r.ok === false
        ? '<span class="history-op-status err">✗</span>'
        : '<span class="history-op-status ok">✓</span>';
      var errOut = (r.ok === false && r.output)
        ? '<div class="history-op-error">' + esc(r.output) + '</div>'
        : '';
      return '<div class="history-op">'
        + opStatus
        + '<span class="queue-item-badge badge-' + op.type + '">' + op.type + '</span>'
        + '<span class="history-op-desc">'
        + esc(srcs) + ' <span class="arrow">' + arrow + '</span>'
        + '</span>'
        + errOut
        + '</div>';
    }).join('');

    return '<div class="history-entry">'
      + '<div class="history-entry-header">'
      + '<span class="history-ts">' + esc(ts) + '</span>'
      + '<span class="history-status ' + statusClass + '">' + statusIcon + ' ' + status + '</span>'
      + '</div>'
      + (entry.summary ? '<div class="history-note">' + esc(entry.summary) + '</div>' : '')
      + '<div class="history-ops">' + opsHtml + '</div>'
      + '</div>';
  }).join('');
}

function updateSnapshotPreview() {
  // Snapshot preview removed — snapshots are created manually, not on execute.
}

function renderExecuteRow() {
  var n    = totalOps();
  var note = state.sessionNote.trim();
  var countEl = document.getElementById('queue-count');
  if (countEl) countEl.textContent = n === 0 ? 'Queue is empty' : n === 1 ? '1 operation staged' : n + ' operations staged';
  var btnEx = document.getElementById('btn-execute');
  var btnCl = document.getElementById('btn-clear');
  if (btnEx) btnEx.disabled = n === 0 || !note;
  if (btnCl) btnCl.disabled = n === 0;
  updateSnapshotPreview();
}

// ── Full render ───────────────────────────────────────────────────────────────

function render() {
  try {
    renderQueue();
    renderOpForm();
    renderPreview();
    renderScript();
    renderResults();
    renderHistory();
    renderSnapshots();
    renderExecuteRow();
  } catch(e) {
    console.error('[qc-refactor render]', e);
    var root = document.getElementById('qc-refactor-root');
    if (root) root.innerHTML = '<div style="padding:24px;color:var(--red);font-family:var(--mono);font-size:12px"><strong>Render error</strong><br>' + String(e.message||e) + '</div>';
  }
}

// ── Execute ───────────────────────────────────────────────────────────────────

async function executeQueue(summary) {
  state.sessionNote = summary;

  var payload = {
    operations:  allOps(),
    summary:     summary,
    script:      generateScript().script || '',
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
    state.snapshot   = null;

    // Refresh tree from server so pickers reflect changes without re-render
    await refreshTree();

    state.queue        = [];
    state.moveSelected = new Set();
    state.docsEdits    = {};
    state.expandedSegs = {};
    state.panelTab     = 'results';

    // Reload docs data so edits are reflected
    await loadDocs();

    document.querySelectorAll('.panel-tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.tab === 'results');
    });
    document.getElementById('preview-wrap')    && document.getElementById('preview-wrap').classList.add('hidden');
    document.getElementById('script-panel')    && document.getElementById('script-panel').classList.add('hidden');
    document.getElementById('history-panel')   && document.getElementById('history-panel').classList.add('hidden');
    document.getElementById('results-panel')   && document.getElementById('results-panel').classList.remove('hidden');

    render();
  } catch(e) {
    var rp = document.getElementById('results-panel');
    if (rp) {
      state.panelTab = 'results';
      document.querySelectorAll('.panel-tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === 'results');
      });
      document.getElementById('preview-wrap')  && document.getElementById('preview-wrap').classList.add('hidden');
      document.getElementById('script-panel')  && document.getElementById('script-panel').classList.add('hidden');
      document.getElementById('history-panel') && document.getElementById('history-panel').classList.add('hidden');
      rp.classList.remove('hidden');
      rp.innerHTML = '<div class="result-item err"><span class="result-icon">✗</span><div class="result-body"><div class="result-cmd">Execution failed</div><div class="result-out">' + esc(e.message) + '</div></div></div>';
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

// ── Snapshots ─────────────────────────────────────────────────────────────────

async function loadSnapshots() {
  state.snapshotsStatus = 'loading';
  renderSnapshots();
  try {
    var res  = await fetch(API + '/snapshots/list');
    var data = await res.json();
    state.snapshotsData   = data;
    state.snapshotsStatus = 'ok';
  } catch(e) {
    state.snapshotsStatus = 'error';
  }
  renderSnapshots();
}

async function createSnapshot() {
  var label = state.snapshotLabel.trim();
  var note  = state.snapshotNote.trim();
  try {
    var res  = await fetch(API + '/snapshots/create', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        action:           'snapshot',
        label:            label,
        note:             note,
        active_docs_path: SCHEME_PATH,
      }),
    });
    var data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Snapshot failed');
    state.snapshotLabel = '';
    state.snapshotNote  = '';
    await loadSnapshots();
  } catch(e) {
    console.error('[createSnapshot]', e);
  }
}

async function loadSnapshot(dir) {
  try {
    // Copy snapshot files over working files via server
    var res  = await fetch(API + '/snapshots/load', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ dir: dir }),
    });
    var data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Load failed');
    // Refresh tree and docs
    await refreshTree();
    await loadDocs();
    render();
  } catch(e) {
    console.error('[loadSnapshot]', e);
    showFormError('Could not load snapshot: ' + e.message);
  }
}

function renderSnapshots() {
  var panel = document.getElementById('snapshots-panel');
  var view  = document.getElementById('snapshots-view');
  var app   = document.getElementById('qc-refactor-root');
  if (!panel || !view) return;

  var isActive = state.appMode === 'snapshots';
  view.classList.toggle('hidden', !isActive);
  // Hide/show main app
  var appDiv = document.querySelector('#qc-refactor-root .app');
  if (appDiv) appDiv.classList.toggle('hidden', isActive);

  if (!isActive) return;

  if (state.snapshotsStatus === 'loading') {
    panel.innerHTML = '<div class="rec-feed-empty">Loading snapshots…</div>';
    return;
  }
  if (state.snapshotsStatus === 'error') {
    panel.innerHTML = '<div class="rec-feed-empty">Could not load snapshots.</div>';
    return;
  }

  var snapshots = (state.snapshotsData && state.snapshotsData.snapshots) || [];

  function makePreview() {
    var seg = state.snapshotLabel.trim().slice(0,30)
      .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    var now = new Date();
    var ts  = now.getFullYear()
      + String(now.getMonth()+1).padStart(2,'0')
      + String(now.getDate()).padStart(2,'0') + '-'
      + String(now.getHours()).padStart(2,'0')
      + String(now.getMinutes()).padStart(2,'0');
    return seg ? 'codebook_' + ts + '_' + seg : 'codebook_' + ts;
  }

  var feedHtml = '';
  if (snapshots.length === 0) {
    feedHtml = '<div class="rec-feed-empty">No snapshots yet.</div>';
  } else {
    feedHtml = snapshots.slice().reverse().map(function(s) {
      var label = s.label || s.dir.replace(/^codebook_[0-9]{8}-[0-9]{4}_?/, '');
      var ts    = s.timestamp ? s.timestamp.replace('-', ' ') : '';
      return '<div class="rec-feed-row rec-feed-snapshot">'
        + '<span class="rec-feed-ts">' + esc(ts) + '</span>'
        + '<span class="rec-feed-icon rec-feed-icon-snap">📷</span>'
        + '<span class="rec-feed-label">'
        + (label ? '<strong>' + esc(label) + '</strong> ' : '')
        + '<span class="rec-feed-dirname">' + esc(s.dir) + '</span>'
        + '</span>'
        + (s.note ? '<span class="rec-feed-note">' + esc(s.note) + '</span>' : '')
        + '<button class="btn-xs snap-load-btn" data-dir="' + esc(s.dir) + '">Open</button>'
        + '</div>';
    }).join('');
  }

  panel.innerHTML = ''
    + '<div class="rec-snap-zone">'
    +   '<div class="rec-snap-label-row">'
    +     '<input class="rec-snap-label" id="snap-label" type="text" placeholder="Short label for filename (optional)" value="' + esc(state.snapshotLabel) + '">'
    +     '<button class="btn primary rec-snap-btn" id="snap-save-btn">Save snapshot</button>'
    +   '</div>'
    +   '<textarea class="rec-snap-desc" id="snap-note" rows="2" placeholder="Description — rationale, what changed, analytical context (optional)">' + esc(state.snapshotNote) + '</textarea>'
    +   '<div class="rec-snap-preview" id="snap-preview">' + esc(makePreview()) + '</div>'
    + '</div>'
    + '<div class="rec-divider"></div>'
    + '<div class="rec-feed-zone">'
    +   feedHtml
    + '</div>';

  var labelInp  = document.getElementById('snap-label');
  var noteArea  = document.getElementById('snap-note');
  var previewEl = document.getElementById('snap-preview');

  if (labelInp) labelInp.addEventListener('input', function() {
    state.snapshotLabel = labelInp.value;
    if (previewEl) previewEl.textContent = makePreview();
  });
  if (noteArea) noteArea.addEventListener('input', function() {
    state.snapshotNote = noteArea.value;
  });
  document.getElementById('snap-save-btn').addEventListener('click', createSnapshot);

  panel.querySelectorAll('.snap-load-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (confirm('Load snapshot "' + btn.dataset.dir + '"?\nThis replaces your working codebook.yaml and codebook.json.')) {
        loadSnapshot(btn.dataset.dir);
      }
    });
  });
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────────

(async function() {
  // Load codebook docs and refresh tree from server
  await loadDocs();
  await refreshTree();

  // Op type tabs
  document.querySelectorAll('.op-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      state.activeTab = tab.dataset.type;
      if (tab.dataset.type !== 'move') state.moveSelected = new Set();
      document.querySelectorAll('.op-tab').forEach(function(t) {
        t.classList.toggle('active', t === tab);
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
      var pw  = document.getElementById('preview-wrap');
      var sp  = document.getElementById('script-panel');
      var rp  = document.getElementById('results-panel');
      var hp  = document.getElementById('history-panel');
      if (pw)  pw.classList.toggle('hidden',  state.panelTab !== 'preview');
      if (sp)  sp.classList.toggle('hidden',  state.panelTab !== 'script');
      if (rp)  rp.classList.toggle('hidden',  state.panelTab !== 'results');
      if (hp)  hp.classList.toggle('hidden',  state.panelTab !== 'history');
      renderPreview();
      renderScript();
      renderResults();
      renderHistory();
    });
  });

  // Mode bar
  document.querySelectorAll('.qr-mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      state.appMode = btn.dataset.mode;
      document.querySelectorAll('.qr-mode-btn').forEach(function(b) {
        b.classList.toggle('active', b === btn);
      });
      if (state.appMode === 'snapshots') {
        if (!state.snapshotsData) loadSnapshots();
        else renderSnapshots();
      } else {
        renderSnapshots(); // hides view
      }
    });
  });

  document.getElementById('btn-add').addEventListener('click', addOperation);

  document.getElementById('btn-clear').addEventListener('click', function() {
    state.queue        = [];
    state.moveSelected = new Set();
    state.docsEdits    = {};
    state.expandedSegs = {};
    render();
  });

  // Session note — update snapshot name preview on input
  var sessionNoteEl = document.getElementById('session-note');
  if (sessionNoteEl) {
    sessionNoteEl.addEventListener('input', function() {
      state.sessionNote = sessionNoteEl.value;
      updateSnapshotPreview();
      renderExecuteRow();
    });
  }

  document.getElementById('btn-execute').addEventListener('click', function() {
    var note = state.sessionNote.trim();
    if (!note) {
      sessionNoteEl && sessionNoteEl.focus();
      sessionNoteEl && sessionNoteEl.classList.add('note-required');
      setTimeout(function() {
        sessionNoteEl && sessionNoteEl.classList.remove('note-required');
      }, 1200);
      return;
    }
    executeQueue(note);
  });

  render();
}());

})();