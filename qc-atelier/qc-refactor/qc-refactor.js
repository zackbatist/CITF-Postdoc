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
  // Unified queue — all op types together (ops + doc entries)
  queue:       [],
  docEdits:    {},   // {codeName: {field: value}} — current edits, auto-queued on blur
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
  focusedDocCode: null,   // code focused for doc editing in op form
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
  // Load any ops queued from qc-align
  try {
    var qres = await fetch(API + '/docs/load-json?path=' + encodeURIComponent(
      SCHEME_PATH.replace(/codebook\.json$/, 'refactor-queue.json')
    ));
    if (qres.ok) {
      var qdata = await qres.json();
      var pendingOps = (qdata.ops || []);
      if (pendingOps.length > 0) {
        pendingOps.forEach(function(op) {
          op.id = state.nextId++;
          state.queue.push(op);
        });
        // Clear the queue file after loading
        await fetch(API + '/docs/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: SCHEME_PATH.replace(/codebook\.json$/, 'refactor-queue.json'),
            data: { ops: [] },
          }),
        });
        console.log('[qc-refactor] Loaded ' + pendingOps.length + ' op(s) from qc-align');
      }
    }
  } catch(e) {
    // Queue file may not exist yet — ignore
  }
}

async function refreshTree() {
  try {
    var res  = await fetch(API + '/refactor/tree');
    var data = await res.json();
    if (data.ok && data.tree) {
      _runtimeTree = data.tree;
      if (window.qcAutocompleteInit) {
        qcAutocompleteInit(_runtimeTree.map(function(n) { return n.name; }));
      }
      window._rich_codes = _runtimeTree.map(function(n) { return n.name; });
    }
  } catch(e) {
    console.warn('Could not refresh tree:', e);
  }
  // Also refresh stub codes from server
  try {
    var sres  = await fetch(API + '/codebook/stubs');
    var sdata = await sres.json();
    if (sdata.stubs) {
      window.STUB_CODES = new Set(sdata.stubs);
    }
  } catch(e) {}
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

// ── Code chip helper ─────────────────────────────────────────────────────────
// Returns an HTML string chip with branch colour left border.
// Used in innerHTML contexts. For DOM contexts use the shared codeChip().

function chipHtml(name) {
  var stub    = (typeof isStub === 'function') && isStub(name);
  var color   = (typeof getCodeColor === 'function') ? getCodeColor(name, {desaturate: !stub}) : '#757575';
  var node    = (typeof nodeByName === 'function') ? nodeByName(name) : null;
  var isStubN = stub || (node && node.status === 'stub');
  var isDep   = node && node.status === 'deprecated';
  var cls     = 'code-chip' + (isStubN ? ' stub' : '') + (isDep ? ' deprecated' : '');
  var icon    = isStubN ? '⊕ ' : '';
  return '<span class="' + cls + '" style="border-left-color:' + color + '">' + icon + esc(name) + '</span>';
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
  var pickerH = 400;
  var pickerW = Math.min(Math.max(rect.width, 280), window.innerWidth - rect.left - 10);
  var openUpward = rect.bottom + pickerH > window.innerHeight - 20;
  picker.style.position = 'fixed';
  picker.style.top      = openUpward ? Math.max(10, rect.top - pickerH - 2) + 'px' : rect.bottom + 2 + 'px';
  picker.style.left     = rect.left + 'px';
  picker.style.width    = pickerW + 'px';
  // Resize handle at bottom of picker
  var pickerResizeHandle = document.createElement('div');
  pickerResizeHandle.className = 'picker-resize-handle';
  picker.appendChild(pickerResizeHandle);

  var _pStartY, _pStartH;
  pickerResizeHandle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    _pStartY = e.clientY;
    _pStartH = picker.getBoundingClientRect().height;
    document.addEventListener('mousemove', _pOnDrag);
    document.addEventListener('mouseup', _pStopDrag);
  });
  function _pOnDrag(e) {
    var newH = Math.max(120, _pStartH + (e.clientY - _pStartY));
    picker.style.height = newH + 'px';
  }
  function _pStopDrag() {
    document.removeEventListener('mousemove', _pOnDrag);
    document.removeEventListener('mouseup', _pStopDrag);
  }

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

async function renderOpForm() {
  var form = document.getElementById('op-form');
  closePicker();
  form.innerHTML = '';
  // Always use latest tree — await so pickers reflect current yaml
  await refreshTree();

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
      '<div class="op-form-row op-form-row-picker"><div id="move-picker-container" class="picker-full-height"></div></div>',
    ].join('');

    if (!state.moveSelected) state.moveSelected = new Set();
    buildMultiPickerWithDocs('move-picker-container', state.moveSelected, function() {});

    // Parent row appended outside picker grid, pinned at bottom of form
    var parentRow = document.createElement('div');
    parentRow.className = 'op-form-row op-form-row-parent';
    parentRow.style.cssText = 'flex-shrink:0;padding:10px 12px;border-top:1px solid var(--border-dim);';
    parentRow.innerHTML = '<label>New parent <span class="label-hint">(empty = top level)</span></label>'
      + codeInputHTML('move-parent', 'select parent…', false);
    form.appendChild(parentRow);
    // Refresh tree from server before wiring picker to get latest codes
    refreshTree().then(function() {
      wireCodeInput('move-parent', null, false);
    });
  }

  if (type === 'deprecate') {
    form.innerHTML += [
      '<div class="op-form-row op-form-row-picker"><div id="deprecate-picker-container" class="picker-full-height"></div></div>',
      '<p class="form-hint">Sets status to "deprecated" in codebook.json. No qc CLI command is run.</p>',
    ].join('');

    if (!state.deprecateSelected) state.deprecateSelected = new Set();
    buildMultiPickerWithDocs('deprecate-picker-container', state.deprecateSelected, function() {});
  }

  if (type === 'stub') {
    form.innerHTML += [
      '<div class="op-form-row"><label>Stub name</label>',
      '<input class="op-input" id="stub-label" placeholder="e.g. Activities" autocomplete="off">',
      '</div>',
      '<div class="op-form-row"><label>Parent (optional)</label>',
      codeInputHTML('stub-parent', 'none — top level', false),
      '</div>',
      '<div class="op-form-row"><label>Status</label>',
      '<select class="doc-field-select" id="stub-status">',
        '<option value="stub">stub</option>',
        '<option value="active">active</option>',
        '<option value="">unset</option>',
      '</select>',
      '</div>',
      '<p class="form-hint">Creates a new branch node in codebook.yaml. Status can be set to stub, active, or left unset.</p>',
      '<div class="op-form-stub-docs" id="stub-docs-fields"></div>',
    ].join('');

    wireCodeInput('stub-parent', function() {}, false);

    // Build doc fields for the new stub inline
    var stubDocsEl = document.getElementById('stub-docs-fields');
    if (stubDocsEl && typeof makeRichField === 'function') {
      var stubDocValues = state._stubDocDraft || {};
      DOC_FIELDS.filter(function(k) { return k !== 'status'; }).forEach(function(key) {
        var label = DOC_FIELD_LABELS[key] || key;
        var ph    = DOC_FIELD_PLACEHOLDERS[key] || '';
        var fieldWrap = document.createElement('div');
        fieldWrap.className = 'op-form-row';
        var lbl = document.createElement('label');
        lbl.textContent = label;
        fieldWrap.appendChild(lbl);
        var rf = makeRichField({
          value: stubDocValues[key] || '',
          rows: 2, placeholder: ph,
          onchange: function(v) {
            if (!state._stubDocDraft) state._stubDocDraft = {};
            state._stubDocDraft[key] = v;
          },
        });
        fieldWrap.appendChild(rf);
        stubDocsEl.appendChild(fieldWrap);
      });
    }
  }
}

// ── Shared multi-select picker with doc accordion ─────────────────────────────
// Used by Move and Deprecate. selectedSet is a Set of selected code names.
// onSelectionChange called when checkbox changes.

function buildMultiPickerWithDocs(containerId, selectedSet, onSelectionChange) {
  var container = document.getElementById(containerId);
  if (!container) return;

  // Search input
  var searchInput = document.createElement('input');
  searchInput.className = 'multi-picker-search';
  searchInput.style.cssText = 'width:100%;box-sizing:border-box;';
  searchInput.placeholder = 'Search codes…';
  searchInput.autocomplete = 'off';

  // List
  var listEl = document.createElement('div');
  listEl.className = 'multi-picker-list';
  listEl.style.flex = '1';
  listEl.style.minHeight = '0';

  // No chips row — selection visible via checkboxes in picker

  // Doc accordion
  var accHdr = document.createElement('div');
  accHdr.className = 'picker-doc-accordion-hdr';
  accHdr.innerHTML = '<span class="picker-doc-accordion-label">Documentation</span><span class="picker-doc-accordion-arrow">▸</span>';
  var accBody = document.createElement('div');
  accBody.className = 'picker-doc-accordion-body hidden';

  var accordionOpen = false;

  // Resize handle between picker and doc section
  var resizeHandle = document.createElement('div');
  resizeHandle.className = 'picker-resize-handle';
  resizeHandle.style.display = 'none';

  var _dragStartY = null, _dragStartH = null;
  resizeHandle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    _dragStartY = e.clientY;
    _dragStartH = listEl.getBoundingClientRect().height;
    document.addEventListener('mousemove', _onDrag);
    document.addEventListener('mouseup', _stopDrag);
  });
  function _onDrag(e) {
    var delta = e.clientY - _dragStartY;
    var newH = Math.max(60, _dragStartH + delta);
    listEl.style.flex = 'none';
    listEl.style.height = newH + 'px';
    container.style.gridTemplateRows = newH + 'px auto auto 1fr';
    accBody.style.maxHeight = '';
  }
  function _stopDrag() {
    document.removeEventListener('mousemove', _onDrag);
    document.removeEventListener('mouseup', _stopDrag);
  }

  accHdr.addEventListener('click', function() {
    accordionOpen = !accordionOpen;
    accBody.classList.toggle('hidden', !accordionOpen);
    accHdr.querySelector('.picker-doc-accordion-arrow').textContent = accordionOpen ? '▾' : '▸';
    resizeHandle.style.display = accordionOpen ? 'block' : 'none';
    if (!accordionOpen) { listEl.style.flex = '1'; listEl.style.height = ''; }
    if (accordionOpen && state.focusedDocCode) renderDocAccordionBody(accBody, state.focusedDocCode);
  });

  function renderDocAccordionBody(body, codeName) {
    body.innerHTML = '';
    var hdr = document.createElement('div');
    hdr.className = 'picker-doc-code-hdr';
    hdr.innerHTML = chipHtml(codeName);
    body.appendChild(hdr);

    // For move form: show new parent field at top of accordion
    if (state.activeTab === 'move') {
      var parentWrap = document.createElement('div');
      parentWrap.className = 'doc-field';
      var parentLbl = document.createElement('div');
      parentLbl.className = 'doc-field-label';
      parentLbl.textContent = 'New parent';
      var parentHint = document.createElement('span');
      parentHint.className = 'doc-field-hint';
      parentHint.textContent = ' — empty = top level';
      parentLbl.appendChild(parentHint);
      parentWrap.appendChild(parentLbl);
      parentWrap.innerHTML += codeInputHTML('move-parent', 'select parent…', false);
      body.appendChild(parentWrap);
      refreshTree().then(function() { wireCodeInput('move-parent', null, false); });
    }

    DOC_FIELDS.forEach(function(key) {
      var label = DOC_FIELD_LABELS[key] || key;
      var ph    = DOC_FIELD_PLACEHOLDERS[key] || '';
      var curVal = getDocFieldValue(codeName, key);

      var fieldWrap = document.createElement('div');
      fieldWrap.className = 'doc-field';
      var lbl = document.createElement('div');
      lbl.className = 'doc-field-label';
      lbl.textContent = label;
      fieldWrap.appendChild(lbl);

      if (key === 'status') {
        var sel = document.createElement('select');
        sel.className = 'doc-field-select';
        ['', 'active', 'stub', 'experimental', 'deprecated'].forEach(function(s) {
          var opt = document.createElement('option');
          opt.value = s; opt.textContent = s || '(unset)';
          if (curVal === s) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', function() { onDocFieldChange(codeName, key, sel.value); });
        fieldWrap.appendChild(sel);
      } else if (typeof makeRichField === 'function') {
        var rf = makeRichField({
          value: curVal, rows: 2, placeholder: ph,
          onchange: function(v) { onDocFieldChange(codeName, key, v); },
        });
        fieldWrap.appendChild(rf);
      } else {
        var ta = document.createElement('textarea');
        ta.className = 'doc-field-ta'; ta.rows = 2; ta.value = curVal; ta.placeholder = ph;
        ta.addEventListener('change', function() { onDocFieldChange(codeName, key, ta.value); });
        fieldWrap.appendChild(ta);
      }
      body.appendChild(fieldWrap);
    });
  }


  function renderList(query) {
    var nodes = getTree();
    query = (query || '').toLowerCase();

    function isVis(node) {
      if (query) return node.name.toLowerCase().indexOf(query) >= 0;
      var cur = node.parent;
      while (cur) {
        if (state.pickerCollapsed.has(cur)) return false;
        var p = nodes.find(function(n) { return n.name === cur; });
        cur = p ? p.parent : null;
      }
      return true;
    }

    function hasKids(name) {
      return nodes.some(function(n) { return n.parent === name; });
    }

    var shown = nodes.filter(isVis);
    listEl.innerHTML = '';

    shown.forEach(function(node) {
      var row = document.createElement('div');
      row.className = 'multi-picker-item' + (state.focusedDocCode === node.name ? ' picker-focused' : '');
      row.style.paddingLeft = (node.depth * 14 + 4) + 'px';

      // Triangle — only for collapse/expand, larger hit area
      var triangleWrap = document.createElement('span');
      triangleWrap.className = 'multi-picker-toggle-wrap';
      if (!query && hasKids(node.name)) {
        var collapsed = state.pickerCollapsed.has(node.name);
        triangleWrap.innerHTML = '<button class="multi-picker-toggle" data-name="' + esc(node.name) + '" tabindex="-1">'
          + (collapsed ? '▶' : '▼') + '</button>';
        triangleWrap.querySelector('.multi-picker-toggle').addEventListener('mousedown', function(e) {
          e.stopPropagation();
          e.preventDefault();
          if (state.pickerCollapsed.has(node.name)) state.pickerCollapsed.delete(node.name);
          else state.pickerCollapsed.add(node.name);
          renderList(searchInput.value);
        });
      } else {
        triangleWrap.innerHTML = '<span class="multi-picker-toggle-placeholder"></span>';
      }

      // Checkbox — independent of focus
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'multi-picker-cb';
      cb.checked = selectedSet.has(node.name);
      cb.addEventListener('change', function(e) {
        e.stopPropagation();
        if (cb.checked) {
          selectedSet.add(node.name);
          // If stub, also select all descendants
          if (isStub(node.name)) {
            var allNodes = getTree();
            function selectDescendants(parentName) {
              allNodes.forEach(function(n) {
                if (n.parent === parentName) {
                  selectedSet.add(n.name);
                  selectDescendants(n.name);
                }
              });
            }
            selectDescendants(node.name);
          }
        } else {
          selectedSet.delete(node.name);
          // If stub, also deselect all descendants
          if (isStub(node.name)) {
            var allNodes2 = getTree();
            function deselectDescendants(parentName) {
              allNodes2.forEach(function(n) {
                if (n.parent === parentName) {
                  selectedSet.delete(n.name);
                  deselectDescendants(n.name);
                }
              });
            }
            deselectDescendants(node.name);
          }
        }
        renderList(searchInput.value);
        onSelectionChange();
      });

      // Name — click focuses doc pane, does not toggle checkbox
      var nameEl = document.createElement('span');
      nameEl.className = 'picker-name-el';
      var stub = isStub(node.name);
      var color = getCodeColor(node.name, {desaturate: !stub});
      nameEl.innerHTML = (stub ? '<span style="font-size:10px;margin-right:2px;opacity:0.8;">⊕</span>' : '')
        + '<span style="border-left:3px solid ' + color + ';padding-left:4px;font-size:12px;color:var(--text);">' + esc(node.name) + '</span>';

      nameEl.addEventListener('click', function(e) {
        e.stopPropagation();
        state.focusedDocCode = node.name;
        // Update focus highlight
        listEl.querySelectorAll('.multi-picker-item').forEach(function(r) {
          r.classList.toggle('picker-focused', r.dataset.code === node.name);
        });
        row.classList.add('picker-focused');
      if (accordionOpen) renderDocAccordionBody(accBody, node.name);
      });
      row.dataset.code = node.name;

      var cnt = corpusCount(node.name);
      var cntEl = document.createElement('span');
      cntEl.className = 'picker-count';
      if (cnt > 0) cntEl.textContent = cnt;

      row.appendChild(triangleWrap);
      row.appendChild(cb);
      row.appendChild(nameEl);
      row.appendChild(cntEl);
      listEl.appendChild(row);
    });
  }

  var wrap = document.createElement('div');
  wrap.className = 'multi-picker-wrap';
  wrap.style.cssText = 'display:flex;flex-direction:column;min-height:0;overflow:hidden;';
  wrap.appendChild(searchInput);
  wrap.appendChild(listEl);

  container.style.cssText = 'display:grid;grid-template-rows:1fr auto auto auto;flex:1;min-height:0;overflow:hidden;';
  container.appendChild(wrap);
  container.appendChild(resizeHandle);
  container.appendChild(accHdr);
  container.appendChild(accBody);
  resizeHandle.style.display = 'none';

  searchInput.addEventListener('input', function() { renderList(this.value); });
  renderList('');
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

    if (op.type === 'stub' && sources.length === 1) {
      var stubName = sources[0];
      var stubParent = target || '';
      if (!_runtimeTree.find(function(n) { return n.name === stubName; })) {
        _runtimeTree.push({ name: stubName, parent: stubParent, depth: 0, prefix: stubName.slice(0, 2), status: op.status || 'stub' });
      }
    }
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

  // Also update treeArr to match runtime tree for picker consistency
  if (typeof treeArr !== "undefined") {
    treeArr.length = 0;
    _runtimeTree.forEach(function(n) { treeArr.push(n); });
    rebuildIndices();
  }
}

// ── Queue conflict validation ─────────────────────────────────────────────────
// Detects logical conflicts between staged operations.
// Returns an array of conflict descriptions, empty if none.

function validateQueueConflicts(proposedOp) {
  var conflicts = [];
  var ops = allOps();

  // Build the effective name map after all queued ops
  // (what each source code will be called after pending renames/merges)
  var renamedTo = {};   // oldName -> newName
  var mergedInto = {};  // oldName -> targetName
  var deprecated = {}; // name -> true
  var moved = {};       // name -> newParent

  ops.forEach(function(op) {
    if (op.type === 'rename') {
      renamedTo[op.sources[0]] = op.target;
    } else if (op.type === 'merge') {
      op.sources.forEach(function(s) { mergedInto[s] = op.target; });
    } else if (op.type === 'deprecate') {
      deprecated[op.sources[0]] = true;
    } else if (op.type === 'move') {
      moved[op.sources[0]] = op.target;
    }
  });

  function effectiveName(name) {
    if (renamedTo[name]) return renamedTo[name];
    if (mergedInto[name]) return mergedInto[name];
    return name;
  }

  var prop = proposedOp;
  var propSources = prop.sources || [];
  var propTarget  = prop.target  || '';

  propSources.forEach(function(src) {
    // Source was already renamed
    if (renamedTo[src]) {
      conflicts.push(src + ' has already been renamed to ' + renamedTo[src] + ' in the queue.');
    }
    // Source was already merged away
    if (mergedInto[src]) {
      conflicts.push(src + ' has already been merged into ' + mergedInto[src] + ' in the queue.');
    }
    // Source is deprecated — structural ops on deprecated codes are suspicious
    if (deprecated[src] && (prop.type === 'rename' || prop.type === 'merge' || prop.type === 'move')) {
      conflicts.push(src + ' is queued for deprecation — applying a ' + prop.type + ' after deprecation may be unintentional.');
    }
  });

  // Target of rename/merge conflicts with a pending rename source
  if (propTarget && (prop.type === 'rename' || prop.type === 'merge')) {
    if (renamedTo[propTarget]) {
      conflicts.push('Target ' + propTarget + ' has already been renamed to ' + renamedTo[propTarget] + ' in the queue.');
    }
    if (mergedInto[propTarget]) {
      conflicts.push('Target ' + propTarget + ' has already been merged into ' + mergedInto[propTarget] + ' in the queue.');
    }
  }

  // Duplicate operation
  ops.forEach(function(op) {
    if (op.type === prop.type &&
        JSON.stringify(op.sources.slice().sort()) === JSON.stringify(propSources.slice().sort()) &&
        op.target === propTarget) {
      conflicts.push('An identical operation is already in the queue.');
    }
  });

  return conflicts;
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
    // Filter out codes that are descendants of other selected codes
    // (they will move with their ancestor via _do_move block collection)
    var srcsSet = new Set(srcs);
    function isDescendantOfSelected(name) {
      var node = nodeByName(name);
      while (node && node.parent) {
        if (srcsSet.has(node.parent)) return true;
        node = nodeByName(node.parent);
      }
      return false;
    }
    var filteredSrcs = srcs.filter(function(s) { return !isDescendantOfSelected(s); });
    filteredSrcs.forEach(function(src) {
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
    var srcs = Array.from(state.deprecateSelected || []);
    if (srcs.length === 0) { showFormError('Please select at least one code to deprecate.'); return; }
    srcs.forEach(function(src) {
      state.queue.push({ id: state.nextId++, type: 'deprecate', sources: [src], target: src });
    });
    state.deprecateSelected = new Set();
    state.expandedSegs = {};
    renderQueue();
    renderPreview();
    renderScript();
    renderExecuteRow();
    renderOpForm();
    return;
  }

  if (type === 'stub') {
    var label  = ((document.getElementById('stub-label')  || {}).value || '').trim().replace(/\s+/g, '_');
    var parent = ((document.getElementById('stub-parent') || {}).value || '').trim();
    var status = ((document.getElementById('stub-status') || {}).value || 'stub');
    if (!label || !/^[A-Za-z][A-Za-z_]*$/.test(label)) { showFormError('Label must start with a letter and contain only letters and underscores.'); return; }
    var stubName = label;
    var existingCodes = getTree().map(function(n) { return n.name; });
    if (existingCodes.indexOf(stubName) >= 0) { showFormError(stubName + ' already exists.'); return; }
    op = { id: state.nextId++, type: 'stub', sources: [stubName], target: parent || '', status: status };
    // If doc fields were filled in, queue a doc entry contingent on stub creation
    var draft = state._stubDocDraft || {};
    var hasDocs = Object.keys(draft).some(function(k) { return draft[k]; });
    if (hasDocs) {
      state.queue.push(op);
      state.queue.push({ id: state.nextId++, type: 'docs', code: stubName, fields: Object.assign({status: status}, draft) });
      state._stubDocDraft = {};
      state.expandedSegs = {};
      applyOpsToRuntimeTree(allOps());
      renderQueue(); renderPreview(); renderScript(); renderExecuteRow(); renderOpForm();
      return;
    }
    state._stubDocDraft = {};
  }

  if (op) {
    var conflicts = validateQueueConflicts(op);
    if (conflicts.length > 0) {
      showFormError('⚠ Conflict: ' + conflicts[0]);
      return;
    }
    state.queue.push(op);
    state.expandedSegs = {};
    applyOpsToRuntimeTree(allOps());
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
  var srcs = op.sources.map(chipHtml).join('<span class="arrow">, </span>');

  if (op.type === 'rename') {
    return srcs + '<span class="arrow"> → </span>' + chipHtml(op.target);
  }
  if (op.type === 'merge') {
    return srcs + '<span class="arrow"> → </span>' + chipHtml(op.target);
  }
  if (op.type === 'move') {
    return srcs + '<span class="arrow"> → </span>'
      + (op.target ? chipHtml(op.target) : '<em>(top level)</em>');
  }
  if (op.type === 'deprecate') {
    return srcs + '<span class="arrow"> → </span><em>deprecated</em>';
  }
  if (op.type === 'stub') {
    return '<em>create stub</em> ' + srcs
      + (op.target ? '<span class="arrow"> under </span>' + chipHtml(op.target) : '<span class="arrow"> (top level)</span>');
  }
  return '';
}

// ── Doc queue helpers ─────────────────────────────────────────────────────────

// Returns the current stored value for a field (edited or original)
function getDocFieldValue(codeName, key) {
  if (state.docEdits[codeName] && state.docEdits[codeName][key] !== undefined)
    return state.docEdits[codeName][key];
  return getCodeDoc(codeName)[key] || '';
}

// Called when a doc field changes. Updates docEdits and auto-queues.
function onDocFieldChange(codeName, key, value) {
  // Only queue if value actually differs from stored
  var stored = getCodeDoc(codeName)[key] || '';
  if (value === stored) return;
  if (!state.docEdits[codeName]) state.docEdits[codeName] = {};
  state.docEdits[codeName][key] = value;
  upsertDocQueueEntry(codeName);
  renderQueue();
  renderExecuteRow();
}

// Add or update a doc entry in the queue for a given code.
// Only creates entry if at least one field differs from stored value.
function upsertDocQueueEntry(codeName) {
  var edits = state.docEdits[codeName] || {};
  var stored = getCodeDoc(codeName);
  var hasChange = Object.keys(edits).some(function(k) {
    return edits[k] !== (stored[k] || '');
  });

  var existing = state.queue.findIndex(function(e) {
    return e.type === 'docs' && e.code === codeName;
  });

  if (hasChange) {
    var entry = { id: existing >= 0 ? state.queue[existing].id : state.nextId++, type: 'docs', code: codeName, fields: edits };
    if (existing >= 0) state.queue[existing] = entry;
    else state.queue.push(entry);
  } else {
    // No change — remove any existing doc entry
    if (existing >= 0) state.queue.splice(existing, 1);
  }
}

// Build the name resolution map for execution order.
// Returns {originalName -> finalName} where finalName is null if deleted.
function buildNameResolutionMap() {
  var map = {};
  state.queue.forEach(function(op) {
    if (op.type === 'docs') return;
    if (op.type === 'rename') {
      map[op.sources[0]] = op.target;
    } else if (op.type === 'merge') {
      op.sources.forEach(function(s) { map[s] = op.target; });
      // Sources other than target are deleted
      op.sources.filter(function(s) { return s !== op.target; }).forEach(function(s) {
        map[s] = null;
      });
    } else if (op.type === 'move' || op.type === 'deprecate') {
      op.sources.forEach(function(s) { if (!map[s]) map[s] = s; });
    } else if (op.type === 'stub') {
      // New code — no mapping needed
    }
  });
  return map;
}

// Build the doc entry list for execution, with resolved names.
// Returns [{code, fields}] — filtered and renamed.
function buildDocExecutionList() {
  var nameMap = buildNameResolutionMap();
  var docEntries = state.queue.filter(function(e) { return e.type === 'docs'; });
  var result = [];
  var warned = [];

  docEntries.forEach(function(entry) {
    var finalName = nameMap.hasOwnProperty(entry.code) ? nameMap[entry.code] : entry.code;
    if (finalName === null) {
      // Code gets deleted — warn
      warned.push(entry.code);
      return;
    }
    // Check if this code is a stub being created in this queue
    var isNewStub = state.queue.some(function(op) {
      return op.type === 'stub' && op.sources[0] === entry.code;
    });
    result.push({ code: finalName, fields: entry.fields, isNewStub: isNewStub });
  });

  return { entries: result, warned: warned };
}


function renderQueue() {
  var list = document.getElementById('queue-list');
  if (!list) return;

  if (state.queue.length === 0) {
    list.innerHTML = '<div class="queue-empty">No operations staged.</div>';
    return;
  }

  // Build queue items as DOM elements for rich content
  list.innerHTML = '';
  state.queue.forEach(function(op) {
    var type   = op.type;
    var itemEl = document.createElement('div');
    itemEl.className = 'queue-item';
    itemEl.dataset.id = op.id;

    // Doc-only entry — compact display
    if (type === 'docs') {
      var editedKeys = Object.keys(op.fields || {}).filter(function(k) {
        return op.fields[k] !== (getCodeDoc(op.code)[k] || '');
      });
      var hdr = document.createElement('div');
      hdr.className = 'queue-item-header';
      hdr.innerHTML = '<span class="queue-item-badge badge-docs">docs</span>'
        + '<div class="queue-item-desc">' + chipHtml(op.code)
        + '<span class="queue-docs-fields">' + editedKeys.map(function(k) {
            return DOC_FIELD_LABELS[k] || k;
          }).join(' · ') + '</span></div>';
      var rmBtn2 = document.createElement('button');
      rmBtn2.className = 'queue-item-remove';
      rmBtn2.dataset.id = op.id;
      rmBtn2.textContent = '×';
      hdr.appendChild(rmBtn2);
      itemEl.appendChild(hdr);
      list.appendChild(itemEl);
      return;
    }

    // Header row
    var hdr = document.createElement('div');
    hdr.className = 'queue-item-header';
    hdr.innerHTML = '<span class="queue-item-badge badge-' + type + '">' + type + '</span>'
      + '<div class="queue-item-desc">' + opDesc(op) + '</div>';

    // Buttons
    var btnWrap = document.createElement('div');
    btnWrap.className = 'queue-item-btns';
    var docBtn = document.createElement('button');
    docBtn.className = 'queue-item-doc-btn';
    docBtn.dataset.id = op.id;
    docBtn.textContent = 'docs';
    var editBtn = document.createElement('button');
    editBtn.className = 'queue-item-edit';
    editBtn.dataset.id = op.id;
    editBtn.dataset.type = type;
    editBtn.title = 'Edit';
    editBtn.textContent = '✎';
    var rmBtn = document.createElement('button');
    rmBtn.className = 'queue-item-remove';
    rmBtn.dataset.id = op.id;
    rmBtn.dataset.type = type;
    rmBtn.title = 'Remove';
    rmBtn.textContent = '×';
    btnWrap.appendChild(docBtn);
    btnWrap.appendChild(editBtn);
    btnWrap.appendChild(rmBtn);
    hdr.appendChild(btnWrap);
    itemEl.appendChild(hdr);

    // Doc panel (hidden by default)
    var docPanel = document.createElement('div');
    docPanel.className = 'queue-item-doc-panel hidden';
    docPanel.dataset.id = op.id;

    // Determine which fields to show based on op type
    var fieldsToShow = DOC_FIELDS;
    var lockedStatus = null;
    if (type === 'deprecate') lockedStatus = 'deprecated';

    // For each source code, build doc fields
    var codesForDoc = op.sources.slice();
    if (op.type === 'rename' || op.type === 'merge') {
      // Also show target if it exists
      if (op.target && (typeof effectiveName === "function") && nodeByName(effectiveName(op.target))) codesForDoc.push(op.target);
    }

    codesForDoc.forEach(function(codeName) {
      var codeSection = document.createElement('div');
      codeSection.className = 'queue-doc-code-section';
      var sectionHdr = document.createElement('div');
      sectionHdr.className = 'queue-doc-code-hdr';
      sectionHdr.innerHTML = chipHtml(codeName);
      codeSection.appendChild(sectionHdr);

      fieldsToShow.forEach(function(key) {
        var label = DOC_FIELD_LABELS[key] || key;
        var hint  = DOC_FIELD_HINTS[key]  || '';
        var ph    = DOC_FIELD_PLACEHOLDERS[key] || '';
        var curVal = (state.docsEdits[codeName] && state.docsEdits[codeName][key] !== undefined)
          ? state.docsEdits[codeName][key]
          : (getCodeDoc(codeName)[key] || '');

        // Status field: locked for deprecate
        if (key === 'status') {
          if (lockedStatus) {
            var lockEl = document.createElement('div');
            lockEl.className = 'doc-field';
            lockEl.innerHTML = '<div class="doc-field-label">' + esc(label) + '</div>'
              + '<div class="doc-field-locked">deprecated (locked)</div>';
            codeSection.appendChild(lockEl);
          } else {
            var statusWrap = document.createElement('div');
            statusWrap.className = 'doc-field';
            statusWrap.innerHTML = '<div class="doc-field-label">' + esc(label) + '</div>';
            var sel = document.createElement('select');
            sel.className = 'doc-field-select';
            ['', 'active', 'stub', 'experimental', 'deprecated'].forEach(function(s) {
              var opt = document.createElement('option');
              opt.value = s; opt.textContent = s || '(unset)';
              if ((curVal || '') === s) opt.selected = true;
              sel.appendChild(opt);
            });
            sel.addEventListener('change', function() {
              if (!state.docsEdits[codeName]) state.docsEdits[codeName] = {};
              state.docsEdits[codeName][key] = sel.value;
            });
            statusWrap.appendChild(sel);
            codeSection.appendChild(statusWrap);
          }
          return;
        }

        // Rich text fields
        if (typeof makeRichField === 'function') {
          var fieldWrap = document.createElement('div');
          fieldWrap.className = 'doc-field';
          var lbl = document.createElement('div');
          lbl.className = 'doc-field-label';
          lbl.textContent = label;
          if (hint) {
            var hintSpan = document.createElement('span');
            hintSpan.className = 'doc-field-hint';
            hintSpan.textContent = ' — ' + hint;
            lbl.appendChild(hintSpan);
          }
          var rf = makeRichField({
            value: curVal,
            rows: 3,
            placeholder: ph,
            onchange: function(v) {
              if (!state.docsEdits[codeName]) state.docsEdits[codeName] = {};
              state.docsEdits[codeName][key] = v;
            },
          });
          fieldWrap.appendChild(lbl);
          fieldWrap.appendChild(rf);
          codeSection.appendChild(fieldWrap);
        } else {
          var fieldWrap2 = document.createElement('div');
          fieldWrap2.className = 'doc-field';
          fieldWrap2.innerHTML = '<div class="doc-field-label">' + esc(label) + '</div>'
            + '<textarea class="doc-field-ta" rows="3" placeholder="' + esc(ph) + '">' + esc(curVal) + '</textarea>';
          codeSection.appendChild(fieldWrap2);
        }
      });
      docPanel.appendChild(codeSection);
    });

    itemEl.appendChild(docPanel);
    list.appendChild(itemEl);
  });

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

  list.querySelectorAll('.queue-item-doc-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.dataset.id;
      var panel = list.querySelector('.queue-item-doc-panel[data-id="' + id + '"]');
      if (!panel) return;
      var isOpen = !panel.classList.contains('hidden');
      // Close all other panels first
      list.querySelectorAll('.queue-item-doc-panel').forEach(function(p) {
        p.classList.add('hidden');
      });
      list.querySelectorAll('.queue-item-doc-btn').forEach(function(b) {
        b.classList.remove('active');
      });
      if (!isOpen) {
        panel.classList.remove('hidden');
        btn.classList.add('active');
      }
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

function allOps()   { return state.queue.filter(function(e) { return e.type !== 'docs'; }); }
function totalOps() { return allOps().length; }

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

  // Add stub nodes to the virtual tree
  state.queue.filter(function(op) { return op.type === 'stub'; }).forEach(function(op) {
    vnodes.push({
      name:   op.sources[0],
      parent: op.target || null,
      depth:  0,
      uses:   0,
      annot:  { type: 'new-stub' },
    });
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

    // Annotation with type badge and inline context
    var annotEl = '';
    var typeBadge = '';
    var contextEl = '';
    if (node.annot) {
      var atype = node.annot.type;
      typeBadge = '<span class="dtree-badge dtree-badge-' + atype + '">' + atype + '</span>';
      if (atype === 'renamed') {
        annotEl = '<span class="dtree-annot">was ' + chipHtml(node.annot.from) + '</span>';
      } else if (atype === 'merged') {
        annotEl = '<span class="dtree-annot">+' + node.annot.from.length + ' merged: '
          + node.annot.from.map(chipHtml).join(', ') + '</span>';
      } else if (atype === 'moved') {
        // Show where it moved from
        var origNode = (typeof CODEBOOK_TREE !== 'undefined') && CODEBOOK_TREE.find(function(n) { return n.name === (node.origName || node.name); });
        var fromParent = origNode ? origNode.parent : '';
        annotEl = '<span class="dtree-annot">moved from ' + (fromParent ? chipHtml(fromParent) : '<em>top level</em>') + '</span>';
      } else if (atype === 'deprecated') {
        annotEl = '<span class="dtree-annot dtree-deprecated">deprecated</span>';
        cls += ' dtree-deprecated-node';
      }
      // Inline context: show siblings under new/current parent
      if (atype !== 'deprecated') {
        var siblings = (childMap[node.parent] || []).filter(function(s) { return s.name !== node.name; }).slice(0, 3);
        if (siblings.length > 0) {
          contextEl = '<div class="dtree-context">siblings: '
            + siblings.map(function(s) { return chipHtml(s.name); }).join(' ')
            + (siblings.length < (childMap[node.parent] || []).length - 1 ? ' <span class="dtree-context-more">+' + ((childMap[node.parent] || []).length - 1 - siblings.length) + ' more</span>' : '')
            + '</div>';
        }
      }
    }

    var cnt    = corpusCount(node.origName || node.name);
    var cntEl  = cnt > 0 ? '<span class="dtree-count">' + cnt + '</span>' : '';

    var toggleEl = hasChildren
      ? '<span class="dtree-toggle" data-node="' + esc(node.name) + '">' + (expanded ? '▾' : '▸') + '</span>'
      : '<span class="dtree-toggle dtree-leaf"></span>';

    var stubN = (typeof isStub === 'function') && isStub(node.name);
    var nodeColor = (typeof getCodeColor === 'function') ? getCodeColor(node.name, {desaturate: !stubN}) : '';
    var nameStyle = nodeColor ? 'border-left:4px solid ' + nodeColor + ';padding-left:5px;' : '';
    var isDep = node.annot && node.annot.type === 'deprecated';

    html += '<div class="' + cls + '" data-depth="' + depth + '" style="padding-left:' + (depth * 16 + 4) + 'px">'
      + toggleEl
      + typeBadge
      + '<span class="dtree-name' + (isDep ? ' dtree-name-deprecated' : '') + (stubN ? ' dtree-stub' : '') + '" style="' + nameStyle + '">'
      + (stubN ? '⊕ ' : '') + esc(node.name) + '</span>'
      + cntEl + annotEl
      + '</div>'
      + (contextEl ? '<div style="padding-left:' + (depth * 16 + 28) + 'px">' + contextEl + '</div>' : '');

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
              // Find co-occurring codes on same document+line
              var coSegs = [];
              var seen = new Set([codeName]);
              if (typeof CORPUS_DATA !== 'undefined') {
                Object.keys(CORPUS_DATA).forEach(function(otherCode) {
                  if (seen.has(otherCode)) return;
                  var otherSegs = CORPUS_DATA[otherCode] || [];
                  for (var i = 0; i < otherSegs.length; i++) {
                    if (otherSegs[i].document === s.document && otherSegs[i].line === s.line) {
                      coSegs.push(otherCode);
                      seen.add(otherCode);
                      break;
                    }
                  }
                });
              }
              var coChips = coSegs.map(chipHtml).join(' ');
              return '<div class="seg-item">'
                + '<div class="seg-header">'
                + '<span class="seg-loc">' + esc(s.document) + '</span>'
                + '<span class="seg-line">line ' + s.line + '</span>'
                + '</div>'
                + '<div class="seg-text seg-line-highlight">' + esc(s.text) + '</div>'
                + (coSegs.length > 0 ? '<div class="seg-co-codes">' + coChips + '</div>' : '')
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
      + '<div class="script-note script-note-prominent">No <code>qc</code> CLI commands are required for the queued operations. Move, deprecate, and stub creation are applied directly by the server on execute.</div>';
    return;
  }

  var serverSideTypes = allOps()
    .filter(function(op) { return op.type === 'move' || op.type === 'deprecate' || op.type === 'stub'; })
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

  // Resolve doc entries for execution
  var docExec = buildDocExecutionList();
  if (docExec.warned.length > 0) {
    var warnMsg = 'The following codes have doc edits but will be deleted by a merge operation:\n'
      + docExec.warned.join(', ') + '\nThese doc edits will be discarded. Continue?';
    if (!confirm(warnMsg)) return;
  }

  // Separate structural ops from doc-only entries
  var structuralOps = state.queue.filter(function(e) { return e.type !== 'docs'; });

  var payload = {
    operations:  structuralOps,
    summary:     summary,
    script:      generateScript().script || '',
    scheme_path: SCHEME_PATH,
    docs_edits:  state.docsEdits,
    doc_entries: docExec.entries,
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


// ── Column resize ─────────────────────────────────────────────────────────────
function wireColResize(handleId, leftSelector) {
  var handle = document.getElementById(handleId);
  if (!handle) return;
  var leftEl = document.querySelector(leftSelector);
  if (!leftEl) return;

  var _startX, _startW;
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    _startX = e.clientX;
    _startW = leftEl.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  function onMove(e) {
    var delta = e.clientX - _startX;
    var newW = Math.max(180, _startW + delta);
    leftEl.style.width = newW + 'px';
    leftEl.style.minWidth = newW + 'px';
  }
  function onUp() {
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}

(async function() {
  // Load codebook docs and refresh tree from server
  await loadDocs();
  await refreshTree();
  // Make code list available to makeRichField autocomplete
  if (typeof CODEBOOK_TREE !== 'undefined') {
    window._rich_codes = CODEBOOK_TREE.map(function(n) { return n.name; });
  }

  // Initialise shared nav right side
  var _nav = document.querySelector('.qc-nav');
  if (_nav) qcInitNav(_nav, { apiBase: 'http://localhost:' + (REFACTOR_CONFIG ? REFACTOR_CONFIG.server_port : 8080) });

  // Column resize
  wireColResize('col-resize-1', '.op-panel-wrap');
  wireColResize('col-resize-2', '.queue-panel');

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