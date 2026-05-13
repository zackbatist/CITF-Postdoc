// qc-scheme.js
// Injected globals: CODEBOOK_TREE, CORPUS_COUNTS, DOCS_DATA, DOCS_CONFIG

(function () {
'use strict';

const API = 'http://localhost:' + (DOCS_CONFIG.server_port || 8080);
var treeArr = Array.isArray(CODEBOOK_TREE) ? CODEBOOK_TREE.slice() : Object.values(CODEBOOK_TREE);

// ── State ─────────────────────────────────────────────────────────────────────

var state = {
  docs:           { codes: (Array.isArray(DOCS_DATA.codes) ? {} : (DOCS_DATA.codes || {})) },
  selected:       null,
  multiSelected:  new Set(),
  lastClicked:    null,
  multiView:      'table',
  tab:            'doc',
  expanded:       {},
  search:         '',
  excerpts:       {},
  saveStatus:     'saved',   // 'saved' | 'unsaved' | 'saving' | 'error'
  exportFormat:   'yaml',  // default
  exportSelected: null,
  statusInclude:  new Set(['active','experimental','deprecated','']),
  treeOverrides:  {},   // parent overrides — edited via in-editor Parent selector and bulk toolbar only; structural moves belong to qc-refactor
  importOpen:     false,
  importPath:     '',
  importStatus:   '',
  importMsg:      '',
  appMode:          'codebook', // 'codebook' | 'history' | 'snapshots'
  snapshotsData:     null,   // {snapshots:[...]} from server
  snapshotsStatus:   '',     // 'loading'|'ok'|'error'
  snapshotsMsg:      '',
  openedDocsPath:   DOCS_CONFIG ? DOCS_CONFIG.scheme_path : '',
  openedSnapshotDir: '',  // snapshot dir name of currently open file
  openSearch:       '',
  snapshotLabel:     '',
  snapshotNote:      '',
  snapshotLog:       [],         // [{ts, msg, ok}] — session log of snapshot actions
  tableSort:        {col: null, dir: 1},
  changelog:        [],    // [{ts, type, detail}] — document-level events
  changelogOpen:    false, // topbar changelog panel open
  // History tab state — two selected log entry keys for diff
  histSel:          [],    // up to 2 entry keys (code-level: 'code:N', doc-level: 'doc:N')
  histDiffMode:     'fields', // 'fields' | 'json'
  histCodeMode:     'timeline', // 'timeline' | 'compare'
  docHistMode:      'timeline',  // 'timeline' | 'compare'
  multiHistoryOpen: false,
  histVdiffMode:    'summary', // 'summary' | 'fields' | 'json'
  histVdiffFocusCode: null,
  docHistoryOpen:   false,    // editor shows doc history instead of code editor
  lightMode:        true, // default light; overridden by localStorage in restorePersistedState()
};

// ── Changelog helpers ─────────────────────────────────────────────────────────

function clNow() { return new Date().toISOString(); }

// ── localStorage persistence ──────────────────────────────────────────────────
var LS = {
  get: function(k)    { try { return localStorage.getItem('qc.scheme.'+k); } catch(e){ return null; } },
  set: function(k, v) { try { localStorage.setItem('qc.scheme.'+k, v); } catch(e){} },
  getJson: function(k){ try { var v=localStorage.getItem('qc.scheme.'+k); return v?JSON.parse(v):null; } catch(e){ return null; } },
  setJson: function(k,v){ try { localStorage.setItem('qc.scheme.'+k, JSON.stringify(v)); } catch(e){} },
  migrate: function() {
    // One-time migration from qccd.* to qc.scheme.*
    try {
      ['sidebarWidth','session'].forEach(function(k) { // 'theme' migrated to qca.theme (suite-wide)
        var old = localStorage.getItem('qccd.'+k);
        if (old !== null && localStorage.getItem('qc.scheme.'+k) === null) {
          localStorage.setItem('qc.scheme.'+k, old);
          localStorage.removeItem('qccd.'+k);
        }
      });
    } catch(e) {}
  },
};

// Persist theme whenever it changes
function persistTheme() {
  // Use shared qca.theme key (suite-wide, not tool-namespaced)
  try { localStorage.setItem('qca.theme', state.lightMode ? 'light' : 'dark'); } catch(e) {}
}

// Persist sidebar width
function persistSidebarWidth(px) {
  LS.set('sidebarWidth', String(px));
}

// Persist session state — called after any meaningful change
var _sessionTimer = null;
function scheduleSessionSave() {
  clearTimeout(_sessionTimer);
  _sessionTimer = setTimeout(function(){
    try {
      // Serialise only what we need to resume — not the full docs (server is source of truth)
      LS.setJson('session', {
        selected:        state.selected,
        tab:             state.tab,
        appMode:         state.appMode,
        openedDocsPath:  state.openedDocsPath,
        openedSnapshotDir:state.openedSnapshotDir,
        expanded:        state.expanded,
        sidebarWidth:    (function(){ var s=document.querySelector('.sidebar'); return s?s.offsetWidth:null; })(),
        // treeOverrides saved to server already; save here too for instant restore
        // treeOverrides not persisted to session — saved to server in save()
      });
    } catch(e){}
  }, 1200);
}

// Restore persistent state at boot (before first render)
// One-time migration: move qccd.* keys to qc.scheme.*
(function migrateLocalStorage() {
  try {
    var keys = Object.keys(localStorage);
    keys.forEach(function(k) {
      if (k.startsWith('qccd.')) {
        var newKey = 'qc.scheme.' + k.slice(5);
        if (!localStorage.getItem(newKey)) {
          localStorage.setItem(newKey, localStorage.getItem(k));
        }
        localStorage.removeItem(k);
      }
    });
  } catch(e) {}
})();

function restorePersistedState() {
  // Theme
  // Theme: use shared qcInitTheme() — reads qca.theme from localStorage
  state.lightMode = !qcInitTheme();

  // Sidebar width — applied after render via a brief delay
  var savedWidth = LS.get('sidebarWidth');
  if (savedWidth) {
    var w = parseInt(savedWidth);
    if (w >= 160 && w <= 520) {
      // Defer until DOM exists
      requestAnimationFrame(function(){
        var sb = document.querySelector('.sidebar');
        if (sb) sb.style.width = w + 'px';
      });
    }
  }

  // Session: restore nav state (selected code, tab, appMode, openedSnapshotDir)
  var sess = LS.getJson('session');
  if (sess) {
    // appMode intentionally not restored — always open to Codebook
    // Also clear legacy mode values from old sessions
    // appMode not restored — always open to Codebook (legacy 'snapshots'/'history' ignored)
    if (sess.tab)              state.tab              = sess.tab;
    if (sess.selected)         state.selected         = sess.selected;
    if (sess.openedDocsPath)   state.openedDocsPath   = sess.openedDocsPath;
    if (sess.openedSnapshotDir) state.openedSnapshotDir = sess.openedSnapshotDir;
    if (sess.expanded && typeof sess.expanded === 'object') {
      Object.assign(state.expanded, sess.expanded);
    }
    if (sess.treeOverrides && typeof sess.treeOverrides === 'object') {
      Object.assign(state.treeOverrides, sess.treeOverrides);
      rebuildIndices();
    }
    if (sess.sidebarWidth) {
      var w2 = parseInt(sess.sidebarWidth);
      if (w2 >= 160 && w2 <= 520) {
        requestAnimationFrame(function(){
          var sb = document.querySelector('.sidebar');
          if (sb) sb.style.width = w2 + 'px';
        });
      }
    }
  }
}

// Append a document-level event: type ∈ 'open'|'save'|'move'|'bulk-status'
function clDoc(type, detail) {
  state.changelog.push({ts: clNow(), type: type, detail: detail || ''});
}

// Append a per-code field edit to code._log (only when value actually changed)
// Full values stored — no truncation.
function clCode(code, field, fromVal, toVal) {
  if (!state.docs.codes[code]) return;
  if (!state.docs.codes[code]._log) state.docs.codes[code]._log = [];
  state.docs.codes[code]._log.push({
    ts:    clNow(),
    field: field,
    from:  fromVal !== undefined && fromVal !== null ? String(fromVal) : '',
    to:    toVal   !== undefined && toVal   !== null ? String(toVal)   : '',
  });
}

// ── History commit logic ──────────────────────────────────────────────────────
// "Last committed" value per code+field — what was in place at the last history entry.
// Separate from autosave: autosave fires every 800ms; history commits fire on blur
// or after HISTORY_DEBOUNCE ms of inactivity in the same field.

var HISTORY_DEBOUNCE = 2500; // ms of inactivity before a history entry is written
var _histCommitted = {};  // key: "codefield" → last committed string value
var _histTimers   = {};   // key: "codefield" → debounce timer id

function histKey(code, field) { return code + '' + field; }

// Get the last committed value for a code+field (falls back to baseline or empty)
function histCommitted(code, field) {
  var k = histKey(code, field);
  if (_histCommitted[k] !== undefined) return _histCommitted[k];
  // Use earliest _log entry's from value as baseline (replaces _baseline)
  var log = (state.docs.codes[code] && state.docs.codes[code]._log) || [];
  var earliest = log.find(function(e) { return e.field === field; });
  return earliest && earliest.from !== undefined ? String(earliest.from) : '';
}

// Schedule a history commit for code+field. Called on every input event.
// Resets the debounce timer; the commit fires after HISTORY_DEBOUNCE ms of quiet.
function scheduleHistCommit(code, field) {
  var k = histKey(code, field);
  clearTimeout(_histTimers[k]);
  _histTimers[k] = setTimeout(function() {
    flushHistCommit(code, field);
  }, HISTORY_DEBOUNCE);
}

// Immediately commit a history entry for code+field if value has changed.
// Called on blur and by the debounce timer.
function flushHistCommit(code, field) {
  var k = histKey(code, field);
  clearTimeout(_histTimers[k]);
  delete _histTimers[k];
  if (!state.docs.codes[code]) return;
  var current = String(state.docs.codes[code][field] || '');
  var committed = histCommitted(code, field);
  if (current === committed) return; // nothing changed since last commit
  clCode(code, field, committed, current);
  _histCommitted[k] = current;
}

// Flush all pending history commits immediately (e.g. before a snapshot save)
function flushAllHistCommits() {
  if (flushAllHistCommits._running) return;
  flushAllHistCommits._running = true;
  try {
    Object.keys(_histTimers).forEach(function(k) {
      clearTimeout(_histTimers[k]);
      delete _histTimers[k];
      var parts = k.split('');
      var code = parts[0], field = parts[1];
      if (!state.docs.codes[code]) return;
      var current = String(state.docs.codes[code][field] || '');
      var committed = histCommitted(code, field);
      if (current === committed) return;
      clCode(code, field, committed, current);
      _histCommitted[k] = current;
    });
  } finally {
    flushAllHistCommits._running = false;
  }
}



var _saveTimer = null;
function scheduleSave() {
  state.saveStatus = 'unsaved';
  refreshSaveIndicator();
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function(){ save(); }, 800);
}

for (var _n of treeArr) { if (_n.depth === 0) state.expanded[_n.name] = true; }

// ── Indices — rebuilt whenever overrides change ───────────────────────────────
// O(1) parent/children lookup instead of O(n) scans per row

var _childrenIdx = {};   // name -> [childName, ...]
var _parentIdx   = {};   // name -> parentName|''
var _depthIdx    = {};   // name -> depth (int)
var _subtreeCache= {};   // name -> [name, ...]  (invalidated on override change)

function rebuildIndices() {
  _childrenIdx = {}; _parentIdx = {}; _depthIdx = {}; _subtreeCache = {};
  treeArr.forEach(function(n){ _childrenIdx[n.name] = []; });
  treeArr.forEach(function(n){
    var p = (n.name in state.treeOverrides) ? state.treeOverrides[n.name] : (n.parent || '');
    _parentIdx[n.name] = p;
    if (p && _childrenIdx[p]) _childrenIdx[p].push(n.name);
  });
  // Compute depths iteratively (up to 50 levels, guards against cycles)
  treeArr.forEach(function(n){
    var d = 0, cur = _parentIdx[n.name], seen = new Set();
    while (cur && !seen.has(cur)) { seen.add(cur); d++; cur = _parentIdx[cur]; }
    _depthIdx[n.name] = d;
  });
}
rebuildIndices();

async function refreshTreeFromServer(snapshotDir) {
  try {
    var url = snapshotDir
      ? API + '/snapshots/tree?dir=' + encodeURIComponent(snapshotDir)
      : API + '/refactor/tree';
    var res  = await fetch(url);
    var data = await res.json();
    if (data.ok && data.tree && data.tree.length > 0) {
      treeArr.length = 0;
      data.tree.forEach(function(n) { treeArr.push(n); });
      treeArr.forEach(function(n) {
        if (n.depth === 0 && !(n.name in state.expanded)) {
          state.expanded[n.name] = true;
        }
      });
      rebuildIndices();
      // Reinitialise autocomplete with updated code names
      if (window.qcAutocompleteInit) {
        var _codes = treeArr.map(function(n) { return n.name; });
        window._rich_codes = _codes;
        qcAutocompleteInit(_codes);
      }
      renderSidebar();
      return true;
    }
  } catch(e) {
    console.warn('[qc-scheme] refreshTreeFromServer failed:', e);
  }
  return false;
}

function getChildren(name) {
  var ch = _childrenIdx[name];
  if (!ch) return [];
  var nodes = ch.map(function(n){ return treeArr.find(function(x){return x.name===n;}); }).filter(Boolean);
  return nodes.sort(function(a, b) {
    var da = getDoc(a.name); var db = getDoc(b.name);
    var sa = da.status || ''; var sb = db.status || '';
    var depA = sa === 'deprecated' ? 1 : 0;
    var depB = sb === 'deprecated' ? 1 : 0;
    if (depA !== depB) return depA - depB;
    return a.name.localeCompare(b.name);
  });
}
function getRoots() {
  return treeArr.filter(function(n){ return !_parentIdx[n.name]; }).sort(function(a, b) {
    var da = getDoc(a.name); var db = getDoc(b.name);
    var sa = da.status || ''; var sb = db.status || '';
    var depA = sa === 'deprecated' ? 1 : 0;
    var depB = sb === 'deprecated' ? 1 : 0;
    if (depA !== depB) return depA - depB;
    return a.name.localeCompare(b.name);
  });
}
function nodeParent(name) { return _parentIdx[name] !== undefined ? _parentIdx[name] : ''; }
function nodeDepth(name)  { return _depthIdx[name]  !== undefined ? _depthIdx[name]  : 0;  }
function getUses(name)    { return CORPUS_COUNTS[name] ? CORPUS_COUNTS[name].total : 0; }

function getSubtreeNames(name) {
  if (_subtreeCache[name]) return _subtreeCache[name];
  var out = [];
  function walk(n) { out.push(n); (_childrenIdx[n]||[]).forEach(walk); }
  walk(name);
  _subtreeCache[name] = out;
  return out;
}

// Flat visible order for shift-range
function wouldCycle(name, newParent) {
  if (!newParent) return false;
  if (newParent === name) return true;
  var cur = newParent, seen = new Set();
  while (cur) { if (cur === name) return true; if (seen.has(cur)) break; seen.add(cur); cur = _parentIdx[cur]; }
  return false;
}
function reparent(name, newParent) {
  if (wouldCycle(name, newParent)) return false;
  var oldParent = nodeParent(name) || 'root';
  state.treeOverrides[name] = newParent;
  rebuildIndices();
  var newParentLabel = newParent || 'root';
  clDoc('move', name + ': ' + oldParent + ' → ' + newParentLabel);
  // Also record in the code's own log so it appears in the History tab
  if (!state.docs.codes) state.docs.codes = {};
  if (!state.docs.codes[name]) state.docs.codes[name] = {};
  if (!state.docs.codes[name]._log) state.docs.codes[name]._log = [];
  state.docs.codes[name]._log.push({ts: clNow(), field: 'parent', from: oldParent, to: newParentLabel});
  scheduleSave();
  return true;
}

function getVisibleOrder() {
  var out = [];
  function walk(name) {
    out.push(name);
    if (state.expanded[name]) (_childrenIdx[name]||[]).forEach(walk);
  }
  if (state.search.trim()) {
    var q = state.search.toLowerCase();
    treeArr.filter(function(n){ return n.name.toLowerCase().indexOf(q) >= 0; }).forEach(function(n){ out.push(n.name); });
  } else {
    getRoots().forEach(function(r){ walk(r.name); });
  }
  return out;
}

// ── Multi-select ──────────────────────────────────────────────────────────────

function handleRowClick(name, e) {
  if (e.target.closest('.tree-pip-wrap')) return;

  if (e.metaKey || e.ctrlKey) {
    if (state.multiSelected.has(name)) {
      state.multiSelected.delete(name);
      if (state.multiSelected.size === 0) state.selected = state.lastClicked || null;
    } else {
      state.multiSelected.add(name);
      if (state.selected) { state.multiSelected.add(state.selected); state.selected = null; }
    }
    state.lastClicked = name;
    render();

  } else if (e.shiftKey && state.lastClicked) {
    var lastP = nodeParent(state.lastClicked), thisP = nodeParent(name);
    var visible = getVisibleOrder();
    var a = visible.indexOf(state.lastClicked), b = visible.indexOf(name);
    if (a !== -1 && b !== -1) {
      var lo = Math.min(a,b), hi = Math.max(a,b);
      if (state.selected) { state.multiSelected.add(state.selected); state.selected = null; }
      for (var i = lo; i <= hi; i++) {
        // Shift within same parent = full range; cross-parent = only same-parent nodes in range
        if (lastP === thisP) { if (nodeParent(visible[i]) === lastP) state.multiSelected.add(visible[i]); }
        else state.multiSelected.add(visible[i]);
      }
    }
    render();

  } else {
    // Plain click — surgical update: rebuild tree (preserving scroll) + swap editor only
    state.multiSelected.clear();
    if (getChildren(name).length) state.expanded[name] = !state.expanded[name];
    if (state.selected !== name) state.histSel = [];
    state.selected = name;
    // docHistoryOpen retired
    state.lastClicked = name;
    state.tab = 'doc';

    // Rebuild tree in-place (scroll preserved by renderSidebar)
    renderSidebar();

    // Swap editor panel only
    var editorEl = document.querySelector('.editor');
    if (editorEl) {
      editorEl.parentNode.replaceChild(buildEditor(), editorEl);
    } else {
      render();
    }
    fetchExcerpts(name);
  }
}

function clearMulti() { state.multiSelected.clear(); render(); }

// ── Doc helpers ───────────────────────────────────────────────────────────────

function getDoc(code) { return (state.docs.codes && state.docs.codes[code]) || {}; }

function setDoc(code, field, value) {
  if (!state.docs.codes || Array.isArray(state.docs.codes)) state.docs.codes = {};
  if (!state.docs.codes[code]) state.docs.codes[code] = {};
  state.docs.codes[code][field] = value;
  scheduleSave();
  // History entries for text fields are debounced — see scheduleHistCommit / flushHistCommit.
  // For discrete fields (status, parent) commit immediately on change.
  if (field === 'status' || field === 'parent') {
    var k = histKey(code, field);
    var committed = histCommitted(code, field);
    if (String(value) !== committed) {
      clCode(code, field, committed, String(value));
      _histCommitted[k] = String(value);
    }
  }
}

function hasDoc(code) {
  var d = state.docs.codes && state.docs.codes[code];
  return !!(d && (d.scope||d.rationale||d.usage_notes||d.provenance||(d.examples&&d.examples.length)));
}

// ── Export selection ──────────────────────────────────────────────────────────

function initExportSelected() {
  state.exportSelected = new Set(treeArr.map(function(n){ return n.name; }));
}

function getExportCodes() {
  return treeArr.filter(function(n){
    if (!state.exportSelected.has(n.name)) return false;
    return state.statusInclude.has(getDoc(n.name).status || '');
  });
}

function toggleSubtree(name, force) {
  var sub = getSubtreeNames(name);
  var allIn = sub.every(function(n){ return state.exportSelected.has(n); });
  var select = (force !== undefined) ? force : !allIn;
  sub.forEach(function(n){ if (select) state.exportSelected.add(n); else state.exportSelected.delete(n); });
}

function subtreeState(name) {
  var sub = getSubtreeNames(name);
  var count = sub.filter(function(n){ return state.exportSelected.has(n); }).length;
  if (count === sub.length) return 'all';
  if (count === 0) return 'none';
  return 'some';
}

// ── Save / load ───────────────────────────────────────────────────────────────

async function save() {
  state.saveStatus = 'saving';
  refreshSaveIndicator();
  try {
    var res = await fetch(API+'/docs/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ path:DOCS_CONFIG.scheme_path, data:state.docs, tree:treeArr, overrides:state.treeOverrides, changelog:state.changelog }),
    });
    if (!res.ok) throw new Error('HTTP '+res.status);
    state.saveStatus = 'saved';
  } catch(e) { console.error('[save]',e); state.saveStatus='error'; }
  refreshSaveIndicator();
}

async function loadDocs() {
  try {
    var res = await fetch(API+'/docs/load?path='+encodeURIComponent(DOCS_CONFIG.scheme_path));
    if (!res.ok) return;
    var data = await res.json();
    if (data.codes) {
      if (!state.docs.codes) state.docs.codes = {};
      Object.keys(data.codes).forEach(function(c){
        state.docs.codes[c] = data.codes[c];  // preserves _log if present

      });
    }
    if (data.overrides) { Object.assign(state.treeOverrides, data.overrides); rebuildIndices(); }
    // Restore document changelog
    if (Array.isArray(data.changelog)) state.changelog = data.changelog;
    // Warn on parent mismatches between codebook.yaml and codebook.json
    var mismatches = data.mismatches || [];
    if (mismatches.length > 0) {
      console.warn('[qc-scheme] Parent mismatches:', mismatches);
      var mismatchMsg = 'Parent mismatch between codebook.yaml and codebook.json:\n'
        + mismatches.map(function(m) {
            return '  ' + m.code + ': yaml=' + (m.yaml_parent||'(top)') + ', json=' + (m.json_parent||'(top)');
          }).join('\n');
      setTimeout(function() {
        var banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:9999;background:var(--yellow,#b45309);color:#fff;padding:8px 16px;border-radius:6px;font-size:11px;font-family:var(--mono);white-space:pre;max-width:80vw;cursor:pointer';
        banner.textContent = mismatchMsg;
        banner.onclick = function() { banner.remove(); };
        document.body.appendChild(banner);
        setTimeout(function() { banner.remove(); }, 8000);
      }, 500);
    }
    state.openedDocsPath = DOCS_CONFIG.scheme_path;
    state.saveStatus = 'saved';  // loading is not a change
    // Refresh tree from working codebook.yaml
    await refreshTreeFromServer(null);
    render();
  } catch(e) {}
}

async function importJson(path) {
  if (!path.trim()) { console.warn('[importJson] called with empty path'); return; }
  console.log('[importJson] loading:', path);
  state.importStatus = 'loading'; state.importMsg = ''; renderTopbar();
  try {
    var res = await fetch(API+'/docs/load-json?path='+encodeURIComponent(path.trim()));
    var data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'HTTP '+res.status);

    // Full replace — this is opening a document, not merging
    state.docs.codes = {};
    Object.keys(data.codes || {}).forEach(function(name) {
      var c = data.codes[name];
      var ovParent = (data.overrides || {})[name];
      state.docs.codes[name] = {
        status:      c.status      || '',
        scope:       c.scope       || '',
        rationale:   c.rationale   || '',
        usage_notes: c.usage_notes || '',
        provenance:  c.provenance  || '',
        examples:    c.examples    || [],
        _log:        Array.isArray(c._log) ? c._log : [],
        _baseline:   c._baseline || {
          status:      c.status      || '',
          scope:       c.scope       || '',
          rationale:   c.rationale   || '',
          usage_notes: c.usage_notes || '',
          provenance:  c.provenance  || '',
          parent:      ovParent !== undefined ? ovParent : (c.parent || ''),
        },
      };
    });

    // Restore overrides (parentage moves)
    state.treeOverrides = {};
    Object.assign(state.treeOverrides, data.overrides || {});
    rebuildIndices();

    // Restore document changelog (open event not appended — loading is not an edit)
    if (Array.isArray(data.changelog)) state.changelog = data.changelog;

    var codeN = Object.keys(state.docs.codes).length;
    var moveN  = Object.keys(state.treeOverrides).length;
    state.saveStatus   = 'saved';  // loading is not a change; suppress auto-save
    state.importStatus = 'ok';
    state.importMsg    = 'Loaded ' + codeN + ' codes' + (moveN ? ' · ' + moveN + ' moves' : '');
    // Track which file and snapshot dir is now open
    state.openedDocsPath = path.trim();
    state.openedSnapshotDir = data.active_dir || '';
    if (data.active_dir && state.snapshotsData) {
      state.snapshotsData.active_dir = data.active_dir;
    }
    state.importOpen   = false;
    // Refresh tree from the snapshot's codebook.yaml
    await refreshTreeFromServer(state.openedSnapshotDir || null);
    render();
  } catch(e) {
    state.importStatus = 'error';
    state.importMsg    = String(e.message||e);
    renderTopbar();
  }
}

async function fetchExcerpts(code) {
  if (state.excerpts[code] !== undefined) return;
  state.excerpts[code] = null;
  try {
    var res = await fetch(API+'/excerpts/fetch?code='+encodeURIComponent(code)+'&json_dir='+encodeURIComponent(DOCS_CONFIG.json_dir||'qc/json'));
    state.excerpts[code] = (await res.json()).excerpts || [];
  } catch(e) { state.excerpts[code] = []; }
  render();
}

// ── Export builders ───────────────────────────────────────────────────────────

// qc-compatible YAML: bare list tree, no doc fields
// Format:
//   - RootCode:
//     - ChildCode
//     - ParentChild:
//       - GrandchildCode

// Full YAML export — complete documentation fields, hierarchical structure
function buildFullYaml(codes) {
  var cs = {}; codes.forEach(function(n){ cs[n.name] = true; });
  var DOC_FIELDS = ['status','scope','rationale','usage_notes','provenance'];
  var lines = ['# codebook-full.yaml — full documentation export from qc-scheme', ''];

  function yamlStr(s) {
    if (!s) return "''";
    if (!/[:#\[\]{}|>&*!,?'"\\]/.test(s) && s.indexOf('\n') === -1) return s;
    // Block scalar for multiline
    if (s.indexOf('\n') !== -1) {
      return '|-\n      ' + s.replace(/\n/g, '\n      ');
    }
    return '"' + s.replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '"';
  }

  function walk(name, depth) {
    if (!cs[name]) { (_childrenIdx[name]||[]).forEach(function(c){ walk(c, depth); }); return; }
    var pad = '  '.repeat(depth);
    var d = getDoc(name);
    var children = (_childrenIdx[name]||[]).filter(function(c){ return cs[c]; });
    var hasFields = DOC_FIELDS.some(function(f){ return d[f]; });
    if (children.length || hasFields) {
      lines.push(pad + '- ' + name + ':');
      DOC_FIELDS.forEach(function(f){
        if (d[f]) lines.push(pad + '    ' + f + ': ' + yamlStr(d[f]));
      });
      if (children.length) {
        lines.push(pad + '    codes:');
        children.forEach(function(c){ walk(c, depth + 2); });
      }
    } else {
      lines.push(pad + '- ' + name);
    }
  }
  getRoots().forEach(function(r){ walk(r.name, 0); });
  return lines.join('\n') + '\n';
}
// Comprehensive JSON — always a full save of all codes + tree + overrides + logs.
function buildDocsJson() {
  var codes = {};
  treeArr.forEach(function(n) {
    var d = getDoc(n.name);
    codes[n.name] = {
      parent:      nodeParent(n.name) || null,
      depth:       nodeDepth(n.name),
      uses:        getUses(n.name),
      status:      d.status        || null,
      scope:       d.scope         || null,
      rationale:   d.rationale     || null,
      usage_notes: d.usage_notes   || null,
      provenance:  d.provenance    || null,
      examples:    (d.examples||[]).filter(function(e){return e.doc;}).map(function(e){
        return {doc:e.doc, line:e.line||null, note:e.note||null};
      }),
      _log:        (d._log && d._log.length) ? d._log : undefined,
    };
  });
  return JSON.stringify({
    exported:  new Date().toISOString(),
    codes:     codes,
    overrides: state.treeOverrides,
    changelog: state.changelog.length ? state.changelog : undefined,
  }, null, 2);
}

function buildMd(codes, isQmd) {
  var cs={}; codes.forEach(function(n){cs[n.name]=true;});
  var lines=isQmd?['---','title: "Codebook Documentation"','format: html','---','']:['# Codebook Documentation',''];
  function walk(name, depth) {
    if (!cs[name]) { (_childrenIdx[name]||[]).forEach(function(c){ walk(c, depth+1); }); return; }
    var hashes='#'.repeat(Math.min(depth+2,6)), d=getDoc(name), u=getUses(name);
    lines.push(hashes+' `'+name+'`');
    if(u) lines.push('*'+u+' corpus uses*','');
    if(d.scope)       lines.push('**Scope**','',d.scope,'');
    if(d.rationale)   lines.push('**Rationale**','',d.rationale,'');
    if(d.usage_notes) lines.push('**Usage notes**','',d.usage_notes,'');
    if(d.provenance)  lines.push('**History**','',d.provenance,'');
    if(d.status)      lines.push('**Status:** '+d.status,'');
    var exs=(d.examples||[]).filter(function(e){return e.doc;});
    if(exs.length){lines.push('**Examples**','');exs.forEach(function(e){lines.push('- `'+e.doc+'` L'+e.line+(e.note?' — '+e.note:''));});lines.push('');}
    (_childrenIdx[name]||[]).forEach(function(c){ walk(c, depth+1); });
  }
  getRoots().forEach(function(r){ walk(r.name, 0); });
  return lines.join('\n');
}

function buildCsv(codes) {
  function q(s){return '"'+String(s||'').replace(/"/g,'""')+'"';}
  var rows=[['code','parent','depth','uses','status','scope','rationale','usage_notes','provenance'].map(q).join(',')];
  codes.forEach(function(n){
    var d=getDoc(n.name);
    rows.push([n.name,nodeParent(n.name)||'',nodeDepth(n.name),getUses(n.name),d.status||'',d.scope||'',d.rationale||'',d.usage_notes||'',d.provenance||''].map(q).join(','));
  });
  return rows.join('\n');
}

// HTML export — clean standalone document
function buildHtml(codes) {
  var cs={}; codes.forEach(function(n){cs[n.name]=true;});
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>');}
  function fld(label,val){if(!val)return'';return'<div class="fld"><span class="lbl">'+label+'</span><div class="fv">'+esc(val)+'</div></div>';}
  var sections=[];
  function walk(name, depth) {
    if (!cs[name]) { (_childrenIdx[name]||[]).forEach(function(c){ walk(c, depth+1); }); return; }
    var d=getDoc(name), u=getUses(name), hn=Math.min(depth+2,6);
    var exs=(d.examples||[]).filter(function(e){return e.doc;});
    var statusHtml=d.status?'<span class="st st-'+d.status+'">'+d.status+'</span>':'';
    sections.push(
      '<section class="code d'+depth+'">'+
      '<h'+hn+'>'+esc(name)+statusHtml+(u?' <small>'+u+' uses</small>':'')+' </h'+hn+'>'+
      fld('Scope',d.scope)+fld('Rationale',d.rationale)+
      fld('Usage notes',d.usage_notes)+fld('History',d.provenance)+
      (exs.length?'<div class="fld"><span class="lbl">Examples</span><ul>'+exs.map(function(e){return'<li><code>'+esc(e.doc)+'</code> L'+e.line+(e.note?' — '+esc(e.note):'')+'</li>';}).join('')+'</ul></div>':'')+
      '</section>'
    );
    (_childrenIdx[name]||[]).forEach(function(c){ walk(c, depth+1); });
  }
  getRoots().forEach(function(r){ walk(r.name, 0); });
  var style='body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 24px;color:#1a1a2e;line-height:1.6}'+
    'h1{font-size:1.6em;border-bottom:2px solid #6d28d9;padding-bottom:8px}'+
    'h2,h3,h4,h5,h6{margin:1.8em 0 .3em;display:flex;align-items:center;gap:8px}'+
    'small{font-size:.72em;color:#888;font-weight:400}'+
    '.fld{margin:.3em 0 .9em}.lbl{font-size:.72em;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;display:block;margin-bottom:2px}'+
    '.fv{color:#333;white-space:pre-wrap}'+
    '.st{font-size:.65em;font-weight:700;padding:1px 8px;border-radius:10px;white-space:nowrap}'+
    '.st-active{background:#d1fae5;color:#065f46}.st-deprecated{background:#fee2e2;color:#991b1b}.st-experimental{background:#fef3c7;color:#92400e}'+
    '.code{border-left:3px solid #e5e7eb;padding-left:16px;margin-bottom:1.4em}'+
    '.d0{border-color:#6d28d9}.d1{border-color:#a78bfa}.d2{border-color:#c4b5fd}'+
    'ul{margin:.3em 0;padding-left:1.4em}li{margin:.15em 0}code{font-family:monospace;background:#f3f4f6;padding:1px 5px;border-radius:3px;font-size:.88em}'+
    '@media print{body{max-width:100%;margin:0}@page{margin:1.5cm}}';
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><title>Codebook Documentation</title><style>'+style+'</style></head><body>\n'+
    '<h1>Codebook Documentation</h1>\n<p style="color:#888;font-size:.85em">Generated '+new Date().toLocaleString()+'</p>\n'+
    sections.join('\n')+'\n</body></html>';
}

// PDF via jsPDF + autoTable
function buildPdf(codes) {
  var jspdf = window.jspdf;
  if (!jspdf) { alert('jsPDF not loaded — check network connection and reload.'); return; }
  var doc = new jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  var ts  = new Date().toLocaleString();

  doc.setFontSize(14); doc.setFont(undefined,'bold');
  doc.text('Codebook Documentation', 14, 16);
  doc.setFontSize(8); doc.setFont(undefined,'normal');
  doc.setTextColor(120); doc.text(ts, 14, 22); doc.setTextColor(0);

  var rows = [];
  function walk(name, depth) {
    var inSet = codes.some(function(c){ return c.name === name; });
    if (inSet) {
      var d = getDoc(name);
      rows.push([
        '  '.repeat(depth) + name,
        nodeParent(name) || '—',
        getUses(name) || '—',
        d.status || '—',
        d.scope        ? d.scope.slice(0,120)        : '—',
        d.rationale    ? d.rationale.slice(0,120)    : '—',
        d.usage_notes  ? d.usage_notes.slice(0,120)  : '—',
        d.provenance   ? d.provenance.slice(0,80)    : '—',
      ]);
    }
    (_childrenIdx[name]||[]).forEach(function(c){ walk(c, depth+1); });
  }
  getRoots().forEach(function(r){ walk(r.name, 0); });

  doc.autoTable({
    startY: 27,
    head: [['Code','Parent','Uses','Status','Scope','Rationale','Usage notes','History']],
    body: rows,
    styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [109,40,217], textColor: 255, fontStyle: 'bold', fontSize: 7 },
    columnStyles: {
      0: { cellWidth: 38, fontStyle: 'bold' },
      1: { cellWidth: 28 },
      2: { cellWidth: 10, halign: 'right' },
      3: { cellWidth: 18 },
      4: { cellWidth: 40 },
      5: { cellWidth: 40 },
      6: { cellWidth: 40 },
      7: { cellWidth: 35 },
    },
    alternateRowStyles: { fillColor: [248,246,255] },
    didParseCell: function(data) {
      if (data.section==='body' && data.column.index===3) {
        var v=data.cell.raw;
        if(v==='active')       { data.cell.styles.textColor=[5,150,105];  data.cell.styles.fontStyle='bold'; }
        if(v==='deprecated')   { data.cell.styles.textColor=[185,28,28];  data.cell.styles.fontStyle='bold'; }
        if(v==='experimental') { data.cell.styles.textColor=[146,64,14];  data.cell.styles.fontStyle='bold'; }
      }
    },
  });

  doc.save('qc-scheme-'+tsNow()+'.pdf');
}

function tsNow() {
  return new Date().toISOString().replace(/:/g,'-').slice(0,19);
}

function doExport(codes) {
  var fmt=state.exportFormat;
  var ts = tsNow();
  if (fmt==='pdf')       { buildPdf(codes); return; }
  if (fmt==='yaml')      { download(buildFullYaml(codes),  'codebook-'+ts+'.yaml',            'text/yaml'); return; }
  if (fmt==='md')        { download(buildMd(codes,false),  'qc-scheme-'+ts+'.md',     'text/markdown'); return; }
  if (fmt==='qmd')       { download(buildMd(codes,true),   'qc-scheme-'+ts+'.qmd',    'text/markdown'); return; }
  if (fmt==='html')      { download(buildHtml(codes),      'qc-scheme-'+ts+'.html',   'text/html'); return; }
  if (fmt==='csv')       { download(buildCsv(codes),       'qc-scheme-'+ts+'.csv',    'text/csv'); return; }
}

// Explicit JSON save-as: download the full docs JSON with the given filename.
// This is separate from the autosave (which writes server-side to scheme_path).

function download(content, filename, type) {
  var blob=new Blob([content],{type:type}), url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=filename; a.click(); URL.revokeObjectURL(url);
}

// ── DOM helper ────────────────────────────────────────────────────────────────

function h(tag, props) {
  var kids=Array.prototype.slice.call(arguments,2), el=document.createElement(tag);
  Object.keys(props||{}).forEach(function(k){
    var v=props[k];
    if(k==='className') el.className=v;
    else if(k==='style'&&typeof v==='object') Object.assign(el.style,v);
    else if(k.length>2&&k[0]==='o'&&k[1]==='n'&&typeof v==='function') el.addEventListener(k.slice(2).toLowerCase(),v);
    else if(k==='value'||k==='placeholder'||k==='rows'||k==='checked'||k==='disabled') el[k]=v;
    else el.setAttribute(k,v);
  });
  kids.forEach(function(kid){if(kid==null)return;el.appendChild(typeof kid==='string'?document.createTextNode(kid):kid);});
  return el;
}

function makePipSvg(innerR, innerFill, innerOpacity, ringR, ringColor, ringOpacity) {
  var ns='http://www.w3.org/2000/svg', sz=12, c=6;
  var svg=document.createElementNS(ns,'svg');
  svg.setAttribute('width',sz); svg.setAttribute('height',sz); svg.setAttribute('viewBox','0 0 '+sz+' '+sz);
  svg.style.display='block'; svg.style.flexShrink='0';
  if(ringR){
    var ring=document.createElementNS(ns,'circle');
    ring.setAttribute('cx',c);ring.setAttribute('cy',c);ring.setAttribute('r',ringR);
    ring.setAttribute('fill','none');ring.setAttribute('stroke',ringColor);ring.setAttribute('stroke-width','1.5');
    ring.setAttribute('opacity',String(ringOpacity));
    svg.appendChild(ring);
  }
  var dot=document.createElementNS(ns,'circle');
  dot.setAttribute('cx',c);dot.setAttribute('cy',c);dot.setAttribute('r',innerR);
  dot.setAttribute('fill',innerFill);dot.setAttribute('opacity',String(innerOpacity));
  svg.appendChild(dot);
  return svg;
}

function makeStatusDotSvg(color) {
  var ns='http://www.w3.org/2000/svg';
  var svg=document.createElementNS(ns,'svg');
  svg.setAttribute('width','8');svg.setAttribute('height','8');svg.setAttribute('viewBox','0 0 8 8');
  svg.style.display='block';svg.style.flexShrink='0';
  var dot=document.createElementNS(ns,'circle');
  dot.setAttribute('cx','4');dot.setAttribute('cy','4');dot.setAttribute('r','3.5');
  dot.setAttribute('fill',color);
  svg.appendChild(dot);
  return svg;
}

// ── Escape key ────────────────────────────────────────────────────────────────

// Theme applied in restorePersistedState() during boot
var _escBound = false;
function ensureEscListener() {
  if (_escBound) return;
  _escBound = true;
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && state.multiSelected.size > 0) clearMulti();
  });
}

// ── Render ────────────────────────────────────────────────────────────────────


function showRenderError(e) {
  var root = document.getElementById('qc-scheme-root');
  if (!root) return;
  var existing = root.querySelector('.render-error');
  if (existing) return; // Don't stack errors
  var el = document.createElement('div');
  el.className = 'render-error';
  el.innerHTML = '<strong>UI error</strong> — ' + (e && e.message ? e.message : String(e)) +
    '<br><small>Open the browser console for details. Reloading may help.</small>';
  root.insertBefore(el, root.firstChild);
}

function render() {
  try {
  var root=document.getElementById('qc-scheme-root'); if(!root) return;
  root.innerHTML='';
  var app=h('div',{className:'app'});
  app.appendChild(buildTopbar());
  if (state.appMode === 'history') {
    app.appendChild(buildRecordMain());
  } else {
    var split=h('div',{className:'split'});
    split.appendChild(buildSidebar());
    split.appendChild(buildEditor());
    app.appendChild(split);
  }
  root.appendChild(app);
  // Restore sidebar width after each render (render() rebuilds the sidebar DOM)
  var savedWidth = LS.get('sidebarWidth');
  if (savedWidth) {
    var w = parseInt(savedWidth);
    if (w >= 160 && w <= 520) {
      requestAnimationFrame(function(){
        var sb = document.querySelector('.sidebar');
        if (sb) sb.style.width = w + 'px';
      });
    }
  }
  scheduleSessionSave();
  } catch(e) { console.error('[render]', e); showRenderError(e); }
}

function renderTopbar() {
  var tb=document.querySelector('.topbar-wrap,.topbar');
  if(!tb){render();return;}
  tb.parentNode.replaceChild(buildTopbar(),tb);
}

function renderMainPanel() {
  // Surgically replace the main panel (snapshots-main, history-main, or split)
  // without rebuilding the topbar.
  var app = document.querySelector('.app'); if(!app) { render(); return; }
  var old = app.querySelector('.main-panel, .split');
  if (!old) { render(); return; }
  var next;
  if (state.appMode === 'history') {
    next = buildRecordMain();
  } else {
    next = document.createElement('div');
    next.className = 'split';
    next.appendChild(buildSidebar());
    next.appendChild(buildEditor());
  }
  app.replaceChild(next, old);
}

function refreshSaveIndicator() {
  // Update the topbar status label in-place if possible
  var lbl = document.querySelector('.topbar-save-status');
  if (lbl) {
    var labels = {saved:'Saved', unsaved:'Unsaved', saving:'Saving…', error:'Save error'};
    lbl.textContent = labels[state.saveStatus]||'';
    lbl.className = 'topbar-save-status ss-'+state.saveStatus;
  }
  // Also keep the download button pulsing (export panel)
  var btn = document.querySelector('.ep-download-btn');
  if (!btn) return;
  btn.classList.toggle('ep-unsaved', state.saveStatus === 'unsaved' || state.saveStatus === 'saving');
  btn.classList.toggle('ep-error',   state.saveStatus === 'error');
}

function renderSidebar() {
  var tree=document.querySelector('.sidebar .tree'), ep=document.querySelector('.export-panel');
  if(!tree||!ep){render();return;}
  var treeScroll = tree.scrollTop;
  var newTree = buildTree();
  tree.parentNode.replaceChild(newTree, tree);
  // Defer until after browser lays out the new tree
  requestAnimationFrame(function(){ newTree.scrollTop = treeScroll; });
  ep.parentNode.replaceChild(buildExportPanel(),ep);
}

function renderExportPanel() {
  var old=document.querySelector('.export-panel'); if(!old) return;
  old.parentNode.replaceChild(buildExportPanel(),old);
}

// ── Topbar ────────────────────────────────────────────────────────────────────

function buildTopbar() {
  var docCount   = treeArr.filter(function(n){return hasDoc(n.name);}).length;
  var movedCount = Object.keys(state.treeOverrides).length;
  var multiN     = state.multiSelected.size;

  var saveLabel = {saved:'Saved', unsaved:'Unsaved', saving:'Saving…', error:'Save error'}[state.saveStatus]||'';
  var saveCls   = 'topbar-save-status ss-'+state.saveStatus;

  var bar = h('div',{className:'topbar'},
    h('span',{className:'topbar-brand'},'qc-scheme'),
    h('div',{className:'topbar-sep'}),
    h('span',{className:'topbar-stat'},
      treeArr.length+' codes · '+docCount+' documented'+
      (movedCount?' · '+movedCount+' moved':'')+
      (multiN>1?' · '+multiN+' selected':'')
    ),
(function() {
      var el = h('span', {className: 'topbar-context-pill'});
      if (state.openedSnapshotDir) {
        var label = state.openedSnapshotDir.replace(/^codebook_[0-9]{8}-[0-9]{4}-?/, '') || state.openedSnapshotDir;
        el.appendChild(h('span', {className: 'context-pill-label context-pill-snapshot'}, '📷 ' + label));
        var returnBtn = h('button', {className: 'btn-return-head'});
        returnBtn.textContent = '↩ HEAD';
        returnBtn.addEventListener('click', async function() {
          state.openedSnapshotDir = '';
          state.openedDocsPath    = DOCS_CONFIG ? DOCS_CONFIG.scheme_path : '';
          if (state.snapshotsData) state.snapshotsData.active_dir = null;
          await refreshTreeFromServer('');
          render();
        });
        el.appendChild(returnBtn);
      } else {
        el.appendChild(h('span', {className: 'context-pill-label context-pill-head'}, 'HEAD'));
      }
      return el;
    })(),
    h('div',{className:'topbar-space'}),
    h('button',{
      className:'btn topbar-theme-toggle',
      title: state.lightMode ? 'Switch to dark mode' : 'Switch to light mode',
      onClick:function(){
        state.lightMode = !qcToggleTheme();
        renderTopbar();
      },
    }, state.lightMode ? '☀  Light' : '☾  Dark'),
    multiN>1 ? h('button',{className:'btn',onClick:clearMulti},'Esc  Clear') : null,
    h('span',{className:saveCls}, saveLabel),
    h('button',{
      className:'btn'+(state.importOpen?' active':''),
      title:'Open a documentation file',
      onClick:function(){
        var opening = !state.importOpen;
        state.importOpen   = opening;
        state.importStatus = '';
        state.importMsg    = '';
        renderTopbar();
      },
    },'Open')
  );

  // Mode tabs row below the topbar
  var tabsRow = h('div',{className:'topbar-tabs'});
  [['codebook','Codebook'],['history','History']].forEach(function(pair){
    tabsRow.appendChild(h('button',{
      className:'topbar-mode-tab'+(state.appMode===pair[0]?' active':''),
      onClick:function(){
        if (state.appMode === pair[0]) return;
        state.appMode = pair[0];
        state.importOpen = false;
        if (pair[0] === 'history') {
          if (!state.snapshotsData) { state.snapshotsStatus='loading'; loadSnapshots(); }
        }
        render();
      },
    }, pair[1]));
  });

  var wrap = h('div',{className:'topbar-wrap'});
  wrap.appendChild(bar);
  wrap.appendChild(tabsRow);
  if (state.importOpen) wrap.appendChild(buildOpenPanel());
  return wrap;
}

// ── Changelog panel (document-level) ─────────────────────────────────────────

// Build a diff pane between two document-level changelog events.
// We reconstruct the "snapshot" of moved codes at each event point
// by replaying the changelog up to that index.
function buildDocDiffPane(evA, evB, idxA, idxB) {
  var pane = h('div',{className:'cl-diff-pane'});

  // Collect all move events up to each index to reconstruct overrides at that point
  function overridesAtIdx(upToIdx) {
    var ov = {};
    for (var i = 0; i <= upToIdx; i++) {
      var ev = state.changelog[i];
      if (ev.type === 'move') {
        // detail: "CodeName: OldParent → NewParent"
        var m = ev.detail.match(/^(.+?):\s*(.+?)\s*→\s*(.*)$/);
        if (m) ov[m[1].trim()] = m[3].trim() === 'root' ? '' : m[3].trim();
      }
    }
    return ov;
  }

  var loIdx = Math.min(idxA, idxB);
  var hiIdx = Math.max(idxA, idxB);
  var ovA = overridesAtIdx(loIdx);
  var ovB = overridesAtIdx(hiIdx);

  // Find changes
  var allKeys = new Set(Object.keys(ovA).concat(Object.keys(ovB)));
  var changes = [];
  allKeys.forEach(function(k){
    var vA = ovA[k] !== undefined ? (ovA[k] || 'root') : '—';
    var vB = ovB[k] !== undefined ? (ovB[k] || 'root') : '—';
    if (vA !== vB) changes.push({code:k, from:vA, to:vB});
  });

  var tsA = evA.ts ? evA.ts.slice(0,16).replace('T',' ') : '';
  var tsB = evB.ts ? evB.ts.slice(0,16).replace('T',' ') : '';
  pane.appendChild(h('div',{className:'cl-diff-hdr'},
    h('span',{className:'cl-diff-range'}, tsA + ' → ' + tsB)
  ));

  if (!changes.length) {
    pane.appendChild(h('div',{className:'cl-diff-empty'},'No structural changes between these events.'));
  } else {
    changes.forEach(function(c){
      var row = h('div',{className:'cl-diff-row'});
      row.appendChild(h('span',{className:'cl-diff-code'}, c.code));
      row.appendChild(h('span',{className:'cl-diff-from'}, c.from));
      row.appendChild(h('span',{className:'cl-diff-arrow'}, '→'));
      row.appendChild(h('span',{className:'cl-diff-to'},   c.to));
      pane.appendChild(row);
    });
  }
  return pane;
}


// ── Snapshots ─────────────────────────────────────────────────────────────────

async function loadSnapshots() {
  try {
    var res = await fetch(API+'/snapshots/list');
    var data = await res.json();
    state.snapshotsData   = data;
    // Restore the open dir into fresh snapshotsData
    if (state.openedSnapshotDir) state.snapshotsData.active_dir = state.openedSnapshotDir;
    state.snapshotsStatus = 'ok';
  } catch(e) {
    state.snapshotsStatus = 'error';
    state.snapshotsMsg    = String(e.message||e);
  }
  if (state.snapshotsOpen) renderTopbar();
  // If Open panel is showing, refresh its suggestions now that paths are loaded
  if (state.importOpen) {
    var dd = document.querySelector('.open-suggestions');
    var inputEl = document.querySelector('.open-input-wrap .fp-bar-input');
    if (dd && inputEl) renderSuggestions(dd, inputEl.value, inputEl);
  }
}

async function createSnapshot(label, note) {
  flushAllHistCommits(); // capture any in-progress text edits before snapshotting
  state.snapshotsStatus = 'loading';
  renderTopbar();
  try {
    var body = {
      action:           'snapshot',
      label:             label || '',
      note:              note || '',
      active_yaml_path: DOCS_CONFIG.scheme_path.replace(/codebook\.json$/, 'codebook.yaml'),
      active_docs_path:  DOCS_CONFIG.scheme_path,
      include_md:        true,
      tree:              treeArr,
      overrides:         state.treeOverrides,
    };
    console.log('[createSnapshot] body:', JSON.stringify({action:body.action, active_docs_path:body.active_docs_path}));
    var res  = await fetch(API+'/snapshots/create', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    var data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'HTTP '+res.status);
    clDoc('save', 'snapshot → ' + data.dir);
    // Refresh list
    var listRes  = await fetch(API+'/snapshots/list');
    state.snapshotsData   = await listRes.json();
    // New directory is now the open one
    state.snapshotsStatus = 'ok';
    var logMsg = 'Snapshot: '+data.dir;
    state.snapshotsMsg    = logMsg;
    state.snapshotLog.push({ts: new Date().toLocaleTimeString(), msg: logMsg, ok: true});
    state.snapshotLabel    = '';
    state.snapshotNote     = '';
    showSnapshotToast(data.dir);
  } catch(e) {
    state.snapshotsStatus = 'error';
    state.snapshotsMsg    = String(e.message||e);
    state.snapshotLog.push({ts: new Date().toLocaleTimeString(), msg: String(e.message||e), ok: false});
  }
  // Refresh both topbar (snapshot badge) and main panel (table + compare dropdowns)
  renderTopbar();
  renderMainPanel();
}



// ── Record tab — unified snapshot creation + chronological feed ───────────────

function buildRecordMain() {
  var wrap = h('div', {className: 'main-panel record-main'});

  // ── Top: snapshot creation ─────────────────────────────────────────────────
  var snapZone = h('div', {className: 'rec-snap-zone'});

  function updatePreview() {
    var preview = snapZone.querySelector('.rec-snap-preview');
    if (!preview) return;
    var seg = state.snapshotLabel.trim().slice(0,30)
      .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    var now = new Date();
    var ts = now.getFullYear().toString() +
      String(now.getMonth()+1).padStart(2,'0') +
      String(now.getDate()).padStart(2,'0') + '-' +
      String(now.getHours()).padStart(2,'0') +
      String(now.getMinutes()).padStart(2,'0');
    preview.textContent = seg ? 'codebook_' + ts + '-' + seg : 'codebook_' + ts;
  }

  var labelRow = h('div', {className: 'rec-snap-label-row'});

  var labelInp = h('input', {
    type: 'text',
    className: 'rec-snap-label',
    placeholder: 'Short label for filename (optional)',
    value: state.snapshotLabel,
    onInput: function(e) {
      state.snapshotLabel = e.target.value;
      updatePreview();
    },
  });

  var saveBtn = h('button', {
    className: 'btn primary rec-snap-btn',
    onClick: function() {
      createSnapshot(state.snapshotLabel.trim(), state.snapshotNote.trim());
    },
  }, 'Save snapshot');

  labelRow.appendChild(labelInp);
  labelRow.appendChild(saveBtn);
  snapZone.appendChild(labelRow);

  var descArea = h('textarea', {
    className: 'rec-snap-desc',
    placeholder: 'Description — rationale, what changed, analytical context (optional)',
    rows: 2,
    value: state.snapshotNote,
    onInput: function(e) { state.snapshotNote = e.target.value; },
  });
  snapZone.appendChild(descArea);

  var previewEl = h('div', {className: 'rec-snap-preview'});
  snapZone.appendChild(previewEl);
  setTimeout(updatePreview, 0);

  wrap.appendChild(snapZone);

  // ── Divider ────────────────────────────────────────────────────────────────
  wrap.appendChild(h('div', {className: 'rec-divider'}));

  // ── Bottom: unified feed ───────────────────────────────────────────────────
  var feedZone = h('div', {className: 'rec-feed-zone'});

  var feed = buildDocFeed();

  if (!feed.length) {
    feedZone.appendChild(h('div', {className: 'rec-feed-empty'}, 'No events recorded yet.'));
    wrap.appendChild(feedZone);
    return wrap;
  }

  var hintRow = h('div', {className: 'rec-feed-hint'},
    state.histSel.length === 0 ? 'Click an entry to inspect; click two to diff' :
    state.histSel.length === 1 ? 'Click another entry to diff' :
    'Comparing A (teal) and B (amber)'
  );
  if (state.histSel.length > 0) {
    var clearBtn = h('button', {
      className: 'btn-xs',
      style: {marginLeft: 'auto'},
      onClick: function() { state.histSel = []; renderMainPanel(); },
    }, 'Clear');
    hintRow.appendChild(clearBtn);
  }
  feedZone.appendChild(hintRow);

  var listWrap = h('div', {className: 'rec-feed-list'});
  var boundaries = getSessionBoundaries();
  var prevSessionLabel = null;

  var docHistSel = state.histSel.filter(function(k) {
    return k.startsWith('doc:') || k.startsWith('snap:') ||
      (k.startsWith('code:') && k.split(':').length === 3);
  });

  feed.forEach(function(item) {
    var sessLabel = sessionLabelAtTs(item.ts, boundaries);
    if (sessLabel && sessLabel !== prevSessionLabel) {
      prevSessionLabel = sessLabel;
      var marker = h('div', {className: 'ch-session-marker'});
      marker.appendChild(h('span', {className: 'ch-session-label'}, sessLabel));
      listWrap.appendChild(marker);
    }

    var key = item.kind === 'doc'      ? 'doc:' + item.docIdx
             : item.kind === 'snapshot' ? 'snap:' + item.dir
             : 'code:' + item.code + ':' + item.logIdx;

    var selPos = docHistSel.indexOf(key);
    var isSel  = selPos !== -1;
    var ord    = selPos + 1;

    var row = h('div', {
      className: 'rec-feed-row' +
        (item.kind === 'snapshot' ? ' rec-feed-snapshot' : '') +
        (item.kind === 'doc' && item.ev && item.ev.type === 'save' ? ' rec-feed-save' : '') +
        (isSel ? ' rec-feed-sel' : ''),
      style: isSel ? {background: selBg(ord), borderLeft: '3px solid ' + selBar(ord)} : {},
      onClick: function() {
        var feedKeys = state.histSel.filter(function(k) {
          return k.startsWith('doc:') || k.startsWith('snap:') ||
            (k.startsWith('code:') && k.split(':').length === 3);
        });
        var idx = feedKeys.indexOf(key);
        if (idx !== -1) { feedKeys.splice(idx, 1); }
        else { if (feedKeys.length >= 2) feedKeys.shift(); feedKeys.push(key); }
        var otherKeys = state.histSel.filter(function(k) {
          return !(k.startsWith('doc:') || k.startsWith('snap:') ||
            (k.startsWith('code:') && k.split(':').length === 3));
        });
        state.histSel = otherKeys.concat(feedKeys);
        renderMainPanel();
      },
    });

    if (isSel) row.appendChild(h('span', {className: 'cl-sel-badge'}, ord));

    var ts = item.ts ? item.ts.slice(0,16).replace('T',' ') : '';
    row.appendChild(h('span', {className: 'rec-feed-ts'}, ts));

    if (item.kind === 'snapshot') {
      row.appendChild(h('span', {className: 'rec-feed-icon rec-feed-icon-snap'}, '📸'));
      var snapLabel = item.dir.replace(/^codebook_[0-9]{8}-[0-9]{4}-?/, '');
      var labelEl = h('span', {className: 'rec-feed-label'});
      if (snapLabel) {
        labelEl.appendChild(h('strong', {}, snapLabel));
        labelEl.appendChild(document.createTextNode(' '));
        labelEl.appendChild(h('span', {className: 'rec-feed-dirname'}, item.dir));
      } else {
        labelEl.appendChild(document.createTextNode(item.dir));
      }
      row.appendChild(labelEl);
      if (item.note) row.appendChild(h('span', {className: 'rec-feed-note'}, item.note));
    } else if (item.kind === 'doc') {
      var icon = {open: '↗', save: '↓', move: '⇄', 'bulk-status': '◈'}[item.ev.type] || '·';
      row.appendChild(h('span', {className: 'rec-feed-icon'}, icon));
      var detail = item.ev.detail || item.ev.type || '';
      if (item.ev.type === 'open') detail = detail.replace(/.*[\/\\]/, '');
      row.appendChild(h('span', {className: 'rec-feed-detail'}, detail));
    } else {
      row.appendChild(h('span', {className: 'rec-feed-icon'}, '✎'));
      row.appendChild(h('span', {className: 'rec-feed-code'}, item.code));
      row.appendChild(h('span', {className: 'rec-feed-field'},
        (FIELD_LABELS && FIELD_LABELS[item.entry.field]) || item.entry.field));
      var fromVal = String(item.entry.from || '');
      var toVal   = String(item.entry.to   || '');
      var fromShort = fromVal.length > 60 ? fromVal.slice(0,60) + '…' : fromVal;
      var toShort   = toVal.length   > 60 ? toVal.slice(0,60)   + '…' : toVal;
      if (fromShort || toShort) {
        row.appendChild(h('span', {className: 'rec-feed-change'},
          (fromShort || '(empty)') + ' → ' + (toShort || '(empty)')));
      }
    }

    listWrap.appendChild(row);
  });

  feedZone.appendChild(listWrap);

  // ── Diff pane ──────────────────────────────────────────────────────────────
  var diffPane = h('div', {id: 'doc-hist-diff-pane', className: 'rec-diff-pane'});
  if (docHistSel.length >= 1) {
    diffPane.appendChild(buildDocDiffContent(docHistSel, feed));
  } else {
    diffPane.appendChild(h('div', {className: 'ch-diff-empty ch-diff-hint'},
      'Select events to inspect or compare.'));
  }
  feedZone.appendChild(diffPane);
  wrap.appendChild(feedZone);
  return wrap;
}



function showSnapshotToast(dirName) {
  var existing = document.getElementById('snapshot-toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.id = 'snapshot-toast';
  toast.className = 'snapshot-toast';
  toast.textContent = 'Snapshot saved: ' + dirName;
  document.body.appendChild(toast);
  setTimeout(function() { toast.classList.add('snapshot-toast-show'); }, 10);
  setTimeout(function() {
    toast.classList.remove('snapshot-toast-show');
    setTimeout(function() { toast.remove(); }, 400);
  }, 3500);
}

function buildSnapshotsPanel() {
  var wrap = h('div',{className:'fp-bar-wrap sp-wrap'});

  // ── Primary action: Save snapshot ──
  var primaryRow = h('div',{className:'fp-bar sp-primary-row'});

  var saveBtn = h('button',{
    className:'btn primary sp-save-btn',
    disabled: state.snapshotsStatus==='loading',
    onClick: function(){
      var noteArea = document.querySelector('.sp-note-area');
      createSnapshot((noteArea ? noteArea.value.trim() : '') || state.snapshotNote.trim());
    },
  }, state.snapshotsStatus==='loading' ? 'Saving…' : 'Save snapshot');

  var noteArea = h('textarea',{
    className:'sp-note-area',
    placeholder:'Note (optional) — describe what changed…',
    rows: 2,
    value: state.snapshotNote,
    onInput: function(e){ state.snapshotNote = e.target.value; },
  });

  primaryRow.appendChild(saveBtn);
  primaryRow.appendChild(noteArea);
  wrap.appendChild(primaryRow);

  // ── Secondary action: Fork ──

  // ── Session log ──
  if (state.snapshotLog.length) {
    var logWrap = h('div',{className:'sp-log'});
    // Newest first
    state.snapshotLog.slice().reverse().forEach(function(entry){
      var row = h('div',{className:'sp-log-row'+(entry.ok?'':' sp-log-error')});
      row.appendChild(h('span',{className:'sp-log-ts'}, entry.ts));
      row.appendChild(h('span',{className:'sp-log-msg'}, entry.msg));
      logWrap.appendChild(row);
    });
    wrap.appendChild(logWrap);
  }

  // ── Snapshot list ──
  if (state.snapshotsStatus === 'loading' && !state.snapshotsData) {
    wrap.appendChild(h('div',{className:'fp-bar-subhint'},'Loading snapshots…'));
    return wrap;
  }

  var snapshots = (state.snapshotsData && state.snapshotsData.snapshots) || [];
  if (!snapshots.length) {
    wrap.appendChild(h('div',{className:'fp-bar-subhint'},'No snapshots yet. Save a snapshot to create the first one.'));
    return wrap;
  }

  var tableScroll = h('div',{className:'st-scroll'});
  var table = h('div',{className:'vt'});

  // Header
  var hdr = h('div',{className:'st-row st-hdr'});
  hdr.appendChild(h('span',{className:'st-cell st-ts'},'Timestamp'));
  hdr.appendChild(h('span',{className:'st-cell st-label'},'Label'));
  hdr.appendChild(h('span',{className:'st-cell st-note'},'Note'));
  hdr.appendChild(h('span',{className:'st-cell st-actions'},''));
  table.appendChild(hdr);

  // Rows sorted by timestamp descending
  var sortedSnapshots = snapshots.slice().sort(function(a,b){
    return b.timestamp < a.timestamp ? -1 : b.timestamp > a.timestamp ? 1 : 0;
  });
  sortedSnapshots.forEach(function(v){
    var vDocsPath = v.path + '/codebook.json';
    var isOpen = (state.snapshotsData && state.snapshotsData.active_dir === v.dir);
    var row = h('div',{className:'st-row'+(isOpen?' st-row-active':'')});
    var tsCell = h('span',{className:'st-cell st-ts', title:v.dir}, v.timestamp);
    if(isOpen) tsCell.appendChild(h('span',{className:'st-current-badge'},'Open'));
    row.appendChild(tsCell);
    row.appendChild(h('span',{className:'st-cell st-label'}, v.label || v.dir.replace(/^codebook_[0-9]{8}-[0-9]{4}_?/,'')||''));
    row.appendChild(h('span',{className:'st-cell st-note'}, v.note || ''));
    var acts = h('span',{className:'st-cell st-actions'});
    acts.appendChild(h('button',{
      className:'btn-xs'+(isOpen?' btn-xs-open':''),
      title: vDocsPath,
      onClick: (function(p, dir){ return function(){
        state.openedSnapshotDir = dir;
        if (state.snapshotsData) state.snapshotsData.active_dir = dir;
        state.snapshotsOpen = false;
        importJson(p);
      }; })(vDocsPath, v.dir),
    }, isOpen ? '✓ Open' : 'Open'));
    row.appendChild(acts);
    table.appendChild(row);
  });
  tableScroll.appendChild(table);
  wrap.appendChild(tableScroll);
  return wrap;
}

// ── Open panel ────────────────────────────────────────────────────────────────

function buildOpenPanel() {
  if (!state.snapshotsData && state.snapshotsStatus !== 'loading') {
    state.snapshotsStatus = 'loading';
    loadSnapshots();
  }

  var wrap = h('div',{className:'fp-bar-wrap op-wrap'});

  // ── Search input ──
  var searchRow = h('div',{className:'fp-bar op-search-row'});
  var searchInp = h('input',{
    type:'text', className:'fp-bar-input op-search-input',
    placeholder:'Filter by name, timestamp, or note…',
    value: state.openSearch || '',
    onInput: function(e){
      state.openSearch = e.target.value;
      // Re-render just the list
      var list = wrap.querySelector('.op-list');
      if (list) list.parentNode.replaceChild(buildOpenList(state.openSearch), list);
    },
  });
  searchInp.addEventListener('keydown', function(e){
    if (e.key==='Escape') { state.importOpen=false; renderTopbar(); }
  });
  searchRow.appendChild(searchInp);
  wrap.appendChild(searchRow);

  function buildOpenList(query) {
    var listWrap = h('div',{className:'op-list'});
    var snapshots = (state.snapshotsData && state.snapshotsData.snapshots) || [];
    if (state.snapshotsStatus === 'loading' && !snapshots.length) {
      listWrap.appendChild(h('div',{className:'op-empty'},'Loading…'));
      return listWrap;
    }
    if (!snapshots.length) {
      listWrap.appendChild(h('div',{className:'op-empty'},'No snapshots yet.'));
      return listWrap;
    }
    var q = (query||'').toLowerCase();
    var sorted = snapshots.slice().sort(function(a,b){
      return b.timestamp < a.timestamp ? -1 : b.timestamp > a.timestamp ? 1 : 0;
    });
    var filtered = q ? sorted.filter(function(v){
      return (v.chain+' '+v.timestamp+' '+(v.note||'')+(v.hash4||'')).toLowerCase().indexOf(q) !== -1;
    }) : sorted;
    if (!filtered.length) {
      listWrap.appendChild(h('div',{className:'op-empty'},'No matches.'));
      return listWrap;
    }
    filtered.forEach(function(v){
      var vDocsPath = v.path + '/codebook.json';
      var isOpen = (state.openedDocsPath === vDocsPath);
      var row = h('div',{className:'op-row'+(isOpen?' op-row-open':'')});
      // Load button on the LEFT
      var loadBtn = h('button',{
        className:'btn op-load-btn'+(isOpen?' btn-disabled':''),
        disabled: isOpen,
        onClick: (function(p, dir){ return function(){
          state.openedSnapshotDir = dir;
          if (state.snapshotsData) state.snapshotsData.active_dir = dir;
          state.importOpen = false;
          renderTopbar();
          importJson(p);
        }; })(vDocsPath, v.dir),
      }, isOpen ? '✓' : 'Load');
      row.appendChild(loadBtn);
      // Label to the right
      var lbl = h('div',{className:'op-row-lbl'});
      lbl.appendChild(h('span',{className:'op-row-chain'}, v.chain));
      lbl.appendChild(h('span',{className:'op-row-ts'}, v.timestamp));
      if(v.hash4) lbl.appendChild(h('span',{className:'op-row-hash'}, v.hash4));
      if(v.note)  lbl.appendChild(h('span',{className:'op-row-note-inline'}, v.note));
      row.appendChild(lbl);
      listWrap.appendChild(row);
    });
    return listWrap;
  }

  wrap.appendChild(buildOpenList(state.openSearch));

  // ── Status message ──
  if (state.importMsg) {
    wrap.appendChild(h('div',{
      className:'fp-bar-subhint '+(state.importStatus==='error'?'msg-error':''),
    }, state.importMsg));
  }

  setTimeout(function(){
    var i = wrap.querySelector('.op-search-input');
    if (i) i.focus();
  }, 0);

  return wrap;
}




// ── Sidebar ───────────────────────────────────────────────────────────────────

function buildSidebar() {
  var panel=h('div',{className:'sidebar'});

  // Resize handle
  var handle = h('div',{className:'sidebar-resize-handle'});
  handle.addEventListener('mousedown', function(e){
    e.preventDefault();
    handle.classList.add('dragging');
    var startX = e.clientX;
    var startW = panel.offsetWidth;
    function onMove(ev) {
      var newW = Math.max(160, Math.min(520, startW + ev.clientX - startX));
      panel.style.width = newW + 'px';
      persistSidebarWidth(newW);
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  panel.appendChild(handle);

  var inp=h('input',{type:'text',placeholder:'Search codes…',value:state.search,
    onInput:function(e){
      state.search=e.target.value;
      var tree=panel.querySelector('.tree');
      if(tree) tree.parentNode.replaceChild(buildTree(),tree);
      var ep=panel.querySelector('.export-panel'); if(ep) ep.parentNode.replaceChild(buildExportPanel(),ep);
    },
  });
  panel.appendChild(h('div',{className:'sidebar-search'},inp));
  panel.appendChild(buildTree());
  panel.appendChild(buildExportPanel());
  return panel;
}

function buildTree() {
  var tree=h('div',{className:'tree'});
  if(state.search.trim()){
    var q=state.search.toLowerCase();
    treeArr.filter(function(n){return n.name.toLowerCase().indexOf(q)>=0;}).forEach(function(n){tree.appendChild(buildRow(n,0));});
  } else {
    getRoots().forEach(function(r){renderSubtree(tree,r.name);});
  }
  return tree;
}

function renderSubtree(container, name) {
  var node=treeArr.find(function(n){return n.name===name;}); if(!node) return;
  container.appendChild(buildRow(node,null));
  if(state.expanded[name]){
    var wrap=h('div',{className:'tree-children open'});
    (_childrenIdx[name]||[]).forEach(function(c){renderSubtree(wrap,c);});
    container.appendChild(wrap);
  }
}

// ── Tree row ──────────────────────────────────────────────────────────────────

function buildRow(node, overrideDepth) {
  var depth=(overrideDepth!==null&&overrideDepth!==undefined)?overrideDepth:nodeDepth(node.name);
  var hasChildren=(_childrenIdx[node.name]||[]).length>0;
  var sel=subtreeState(node.name);
  var isMulti=state.multiSelected.has(node.name);
  var isSingle=state.selected===node.name && state.multiSelected.size===0;
  // Dim rows whose status is excluded from export
  var nodeStatus=getDoc(node.name).status||'';
  var isStatusDimmed=!state.statusInclude.has(nodeStatus);

  var rowClass='tree-row'+
    (isSingle?' active':'')+
    (isMulti?' multi-active':'')+
    (isStatusDimmed?' status-dimmed':'');

  var row=h('div',{
    className:rowClass,
    onClick:function(e){ e.stopPropagation(); if(window.getSelection&&window.getSelection().toString()) return; handleRowClick(node.name,e); },
  });

  for(var i=0;i<depth;i++) row.appendChild(h('span',{className:'tree-indent'}));

  row.appendChild(h('span',{className:'tree-toggle'+(state.expanded[node.name]?' open':'')},hasChildren?'▶':''));

  // Pip: export selector + status ring
  var statusColor={active:'#10b981',experimental:'#f59e0b',deprecated:'#ef4444'}[nodeStatus]||'';
  var innerFill=sel==='none'?'var(--text-faint)':((typeof getCodeColor==='function')?getCodeColor(node.name,{desaturate:!((typeof isStub==='function')&&isStub(node.name))}):'var(--accent)');
  var innerOpacity=sel==='none'?0.2:sel==='some'?0.5:1;
  var pipWrap=h('span',{
    className:'tree-pip-wrap',
    title:(nodeStatus?nodeStatus+' · ':'')+(sel==='all'?'click to deselect':'click to select'),
    onClick:function(e){e.stopPropagation();toggleSubtree(node.name,sel!=='all');renderSidebar();},
  });
  pipWrap.appendChild(makePipSvg(statusColor?3:4,innerFill,innerOpacity,statusColor?5.5:0,statusColor,sel==='none'?0.3:0.85));
  row.appendChild(pipWrap);

  var _isStubNode = (typeof isStub === 'function') && isStub(node.name);
  var _nodeColor  = (typeof getCodeColor === 'function') ? getCodeColor(node.name, {desaturate: !_isStubNode}) : '';
  var nameWrap = document.createElement('span');
  nameWrap.className = 'tree-name-wrap';
  nameWrap.style.borderLeftColor = _nodeColor;
  if (_isStubNode) {
    var iconSpan = document.createElement('span');
    iconSpan.className = 'tree-stub-icon';
    iconSpan.textContent = '⊕';
    nameWrap.appendChild(iconSpan);
  }
  var nameSpan = document.createElement('span');
  nameSpan.className = 'tree-name' + (_isStubNode ? ' tree-stub' : '');
  nameSpan.title = node.name;
  nameSpan.textContent = node.name;
  nameWrap.appendChild(nameSpan);
  row.appendChild(nameWrap);

  var docMissing = !hasDoc(node.name);
  if (docMissing) {
    row.appendChild(h('span',{
      title:'No documentation yet',
    }));
  }

  var rightGroup = h('span',{className:'tree-right'});
  if(hasChildren){
    var sub=getSubtreeNames(node.name);
    var selN=sub.filter(function(n){return state.exportSelected.has(n);}).length;
    rightGroup.appendChild(h('span',{className:'tree-count tree-sel-count'+(sel==='none'?' dim':'')},selN+'/'+sub.length));
  } else {
    var uses=getUses(node.name);
    rightGroup.appendChild(h('span',{className:'tree-count'},uses?String(uses):''));
  }

  row.appendChild(rightGroup);

  return row;
}


// ── Export panel ──────────────────────────────────────────────────────────────

function buildExportPanel() {
  var fmt=state.exportFormat, codes=getExportCodes();
  var docN=codes.filter(function(n){return hasDoc(n.name);}).length;
  var panel=h('div',{className:'export-panel'});

  // Status include pills — also dims matching rows in tree
  var filterRow=h('div',{className:'export-panel-filters'});
  [['active','#10b981'],['experimental','#f59e0b'],['deprecated','#ef4444'],['','var(--text-dim)']].forEach(function(pair){
    var s=pair[0],color=pair[1],included=state.statusInclude.has(s);
    var btn=h('button',{
      className:'status-filter-btn'+(included?'':' excluded'),
      title:(included?'Click to exclude':'Click to include')+' '+(s||'unset'),
      onClick:function(){
        if(state.statusInclude.has(s)) state.statusInclude.delete(s); else state.statusInclude.add(s);
        // Refresh sidebar rows + export panel (status dimming affects tree)
        var tree=document.querySelector('.sidebar .tree');
        var ep=document.querySelector('.export-panel');
        if(tree) tree.parentNode.replaceChild(buildTree(),tree);
        if(ep)   ep.parentNode.replaceChild(buildExportPanel(),ep);
      },
    });
    btn.appendChild(makeStatusDotSvg(color));
    btn.appendChild(document.createTextNode(s||'unset'));
    filterRow.appendChild(btn);
  });
  panel.appendChild(filterRow);

  var fmtRow=h('div',{className:'export-panel-fmts'});
  [
    ['yaml',      'YAML',       'Full YAML with all documentation fields'],
    ['md',        'MD',        'Markdown documentation'],
    ['qmd',       'QMD',       'Quarto document'],
    ['html',      'HTML',      'Standalone HTML page'],
    ['csv',       'CSV',       'Spreadsheet-friendly CSV'],
    ['pdf',       'PDF',       'Landscape table PDF'],
  ].forEach(function(p){
    var btn=h('button',{
      className:'ep-chip'+(fmt===p[0]?' active':''),
      title: p[2],
      onClick:function(){state.exportFormat=p[0];renderExportPanel();}
    },p[1]);
    fmtRow.appendChild(btn);
  });
  fmtRow.appendChild(h('button',{
    className:'ep-chip ep-export-btn',
    disabled:!codes.length,
    onClick:function(){doExport(getExportCodes());}
  },'Export'));
  panel.appendChild(fmtRow);
  return panel;
}

function buildEditor() {
  var multiN=state.multiSelected.size;
  if (multiN > 1) return buildMultiEditor(Array.from(state.multiSelected));


  if (!state.selected) {
    return h('div',{className:'editor'},h('div',{className:'editor-empty'},
      h('div',{className:'editor-empty-icon'},'{  }'),
      h('h3',{},'Select a code'),
      h('p',{},'⌘/Ctrl+click to multi-select · Shift+click for siblings range · Drag ⠿ to move')
    ));
  }

  var code=state.selected, effParent=nodeParent(code), uses=getUses(code);
  var clog = getDoc(code)._log || [];
  var editor=h('div',{className:'editor'});
  editor.appendChild(h('div',{className:'editor-header'},
    (function(){
      var nameEl = document.createElement('div');
      nameEl.className = 'editor-code-name';
      if (typeof getCodeColor === 'function') {
        var _stub = typeof isStub === 'function' && isStub(code);
        var _color = getCodeColor(code, {desaturate: !_stub});
        nameEl.style.borderLeft = '5px solid ' + _color;
        nameEl.style.paddingLeft = '8px';
        nameEl.style.fontWeight = _stub ? '600' : 'normal';
      }
      nameEl.textContent = code;
      return nameEl;
    })(),
    h('div',{className:'editor-code-meta'},
      'depth '+nodeDepth(code)+(effParent?' · under '+effParent:' · root')+
      (uses?' · '+uses+' uses':' · not in corpus')+
      ((code in state.treeOverrides)?' · moved':'')
    )
  ));
  editor.appendChild(h('div',{className:'tabs'},
    h('button',{className:'tab'+(state.tab==='doc'?' active':''),onClick:function(){state.tab='doc';render();}},'Documentation'),
    h('button',{className:'tab'+(state.tab==='examples'?' active':''),onClick:function(){state.tab='examples';render();fetchExcerpts(code);}},'Examples'),
    h('button',{className:'tab'+(state.tab==='history'?' active':''),onClick:function(){state.tab='history';render();}},
      'History'+(clog.length?' ('+clog.length+')':'')
    )
  ));
  var body=h('div',{className:'editor-body'});
  if(state.tab==='doc')     body.appendChild(buildDocTab(code));
  if(state.tab==='examples') body.appendChild(buildExamplesTab(code));
  if(state.tab==='history') body.appendChild(buildCodeHistoryTab(code));
  editor.appendChild(body);
  return editor;
}

// ── Multi-editor ──────────────────────────────────────────────────────────────

function buildMultiEditor(codes) {
  var editor=h('div',{className:'editor'});

  // Header
  var hdr=h('div',{className:'editor-header multi-header'});
  hdr.appendChild(h('div',{className:'editor-code-name'},codes.length+' codes selected'));

  // Chip row
  var chips=h('div',{className:'multi-chips'});
  codes.forEach(function(code){
    var chip=h('span',{className:'multi-chip'});
    chip.appendChild(document.createTextNode(code));
    chip.appendChild(h('button',{className:'multi-chip-remove',title:'Remove from selection',onClick:function(){
      state.multiSelected.delete(code);
      if(state.multiSelected.size===1){ state.selected=Array.from(state.multiSelected)[0]; state.multiSelected.clear(); }
      else if(state.multiSelected.size===0) state.selected=null;
      render();
    }},'×'));
    chips.appendChild(chip);
  });
  hdr.appendChild(chips);

  var parents=new Set(codes.map(function(c){return nodeParent(c);}));
  if(parents.size>1) hdr.appendChild(h('div',{className:'multi-cross-note'},'Codes from '+parents.size+' different parents'));
  editor.appendChild(hdr);

  // View toggle + bulk status + bulk parent
  var toolbar=h('div',{className:'multi-toolbar'});
  // History view toggle
  toolbar.appendChild(h('span',{className:'multi-toolbar-sep'}));
  toolbar.appendChild(h('button',{
    className:'btn'+(state.multiHistoryOpen?' btn-active':''),
    title:'Show combined history for selected codes',
    onClick:function(){
      state.multiHistoryOpen = !state.multiHistoryOpen;
      var body=document.querySelector('.editor-body');
      if(body){body.innerHTML='';body.appendChild(buildMultiBody(codes));}
    },
  }, state.multiHistoryOpen ? 'History ▲' : 'History ▼'));

  // Bulk status
  var statuses=codes.map(function(c){return getDoc(c).status||'';});
  var allSameStatus=statuses.every(function(s){return s===statuses[0];});
  var statusSel=h('select',{
    style:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text)',padding:'4px 6px',fontFamily:'var(--sans)',fontSize:'11px',outline:'none',cursor:'pointer'},
    onChange:function(e){
      var val=e.target.value;
      if(val==='__keep__') return;
      codes.forEach(function(c){setDoc(c,'status',val);});
      var body=document.querySelector('.editor-body');
      if(body){body.innerHTML='';body.appendChild(buildMultiBody(codes));}
      renderSidebar();
    },
  });
  var keepStatusOpt=document.createElement('option'); keepStatusOpt.value='__keep__';
  keepStatusOpt.textContent=allSameStatus?(statuses[0]||'unset'):'(mixed)';
  statusSel.appendChild(keepStatusOpt);
  ['','active','stub','experimental','deprecated'].forEach(function(s){
    var opt=document.createElement('option'); opt.value=s; opt.textContent='→ '+(s||'unset');
    statusSel.appendChild(opt);
  });

  toolbar.appendChild(h('span',{className:'multi-toolbar-label'},'Status'));
  toolbar.appendChild(statusSel);
  toolbar.appendChild(h('span',{className:'multi-toolbar-sep'}));

  toolbar.appendChild(h('div',{className:'topbar-space'}));

  // View toggle
  var viewWrap=h('div',{className:'view-toggle'});
  [['table','⊞'],['cards','▦']].forEach(function(p){
    viewWrap.appendChild(h('button',{
      className:'view-toggle-btn'+(state.multiView===p[0]?' active':''),
      title:p[0],
      onClick:function(){
        state.multiView=p[0];
        var body=document.querySelector('.editor-body');
        if(body){body.innerHTML='';body.appendChild(buildMultiBody(codes));}
        document.querySelectorAll('.view-toggle-btn').forEach(function(b){b.classList.remove('active');});
        this.classList.add('active');
      },
    },p[1]));
  });
  toolbar.appendChild(viewWrap);
  editor.appendChild(toolbar);

  var body=h('div',{className:'editor-body'});
  body.appendChild(buildMultiBody(codes));
  editor.appendChild(body);
  return editor;
}

var FIELDS=[
  {key:'scope',      label:'Scope'},
  {key:'rationale',  label:'Rationale'},
  {key:'usage_notes',label:'Usage notes'},
  {key:'provenance', label:'History'},
];

var TABLE_COLS = [
  {key:'name',   label:'Code'},
  {key:'status', label:'Status'},
  {key:'scope',       label:'Scope'},
  {key:'rationale',   label:'Rationale'},
  {key:'usage_notes', label:'Usage notes'},
  {key:'provenance',  label:'History'},
];

function buildMultiBody(codes) {
  var wrap = h('div',{className:'multi-body-wrap'});
  if (state.multiHistoryOpen) {
    wrap.appendChild(buildMultiCodeHistory(codes));
    return wrap;
  }
  wrap.appendChild(state.multiView==='table' ? buildTableView(codes) : buildCardsView(codes));
  return wrap;
}

function sortedTableCodes(codes) {
  var col = state.tableSort.col;
  var dir = state.tableSort.dir;
  if (!col) return codes.slice();
  return codes.slice().sort(function(a, b) {
    var av, bv;
    if (col === 'name') {
      av = a; bv = b;
    } else if (col === 'status') {
      var order = {active:0, experimental:1, deprecated:2, '':3};
      av = order[getDoc(a).status||''] !== undefined ? order[getDoc(a).status||''] : 3;
      bv = order[getDoc(b).status||''] !== undefined ? order[getDoc(b).status||''] : 3;
      return (av - bv) * dir;
    } else {
      av = (getDoc(a)[col] || '').toLowerCase();
      bv = (getDoc(b)[col] || '').toLowerCase();
      // Empty values sort last regardless of direction
      if (!av && bv) return 1;
      if (av && !bv) return -1;
    }
    if (typeof av === 'string') return av < bv ? -dir : av > bv ? dir : 0;
    return (av - bv) * dir;
  });
}

// ── Table view — codes as rows, fields as columns ─────────────────────────────

function buildTableView(codes) {
  var sorted = sortedTableCodes(codes);
  var wrap = h('div',{className:'multi-table-wrap'});
  var table = h('table',{className:'multi-table'});

  // Header row with sort toggles
  var thead = h('thead',{});
  var hr = h('tr',{});
  TABLE_COLS.forEach(function(col) {
    var isActive = state.tableSort.col === col.key;
    var dir = isActive ? state.tableSort.dir : 0;
    var arrow = isActive ? (dir === 1 ? ' ↑' : ' ↓') : '';
    var th = h('th',{
      className:'mt-col-hdr'+(isActive?' mt-col-sorted':'')+(col.key==='name'?' mt-code-hdr':col.key==='status'?' mt-status-hdr':''),
      title:'Sort by '+col.label,
      onClick:function(){
        if (state.tableSort.col === col.key) {
          if (state.tableSort.dir === 1) state.tableSort.dir = -1;
          else { state.tableSort.col = null; state.tableSort.dir = 1; }
        } else {
          state.tableSort.col = col.key;
          state.tableSort.dir = 1;
        }
        var body = document.querySelector('.editor-body');
        if (body) { body.innerHTML=''; body.appendChild(buildMultiBody(codes)); }
      },
    }, col.label + arrow);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  // One row per code
  var tbody = h('tbody',{});
  sorted.forEach(function(code) {
    var d = getDoc(code);
    var tr = h('tr',{
      className:'mt-row',
      onClick:function(){ state.multiSelected.clear(); state.selected=code; state.tab='doc'; render(); fetchExcerpts(code); },
    });
    // Code name — sticky left
    var nameTd = h('td',{className:'mt-code-name'});
    nameTd.appendChild(h('span',{className:'mt-code-label',title:code},code));
    tr.appendChild(nameTd);
    // Status — second column
    var status = d.status||'';
    var statusTd = h('td',{className:'mt-status-cell'});
    if (status) statusTd.appendChild(h('span',{className:'status-badge status-badge-'+status},status));
    else statusTd.appendChild(h('span',{className:'mt-empty'},'—'));
    tr.appendChild(statusTd);
    // Text fields
    FIELDS.forEach(function(f){
      var val = d[f.key]||'';
      tr.appendChild(h('td',{className:'mt-cell'+(val?'':' mt-empty')},
        val ? val.slice(0,140)+(val.length>140?'…':'') : '—'
      ));
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ── Cards view ────────────────────────────────────────────────────────────────

function buildCardsView(codes) {
  var wrap=h('div',{className:'multi-cards'});
  codes.forEach(function(code){
    var d=getDoc(code);
    var card=h('div',{className:'multi-card',onClick:function(){
      state.multiSelected.clear(); state.selected=code; state.tab='doc'; render(); fetchExcerpts(code);
    }});
    var cardHdr=h('div',{className:'multi-card-hdr'});
    cardHdr.appendChild(h('span',{className:'multi-card-name'},code));
    if(d.status){
      cardHdr.appendChild(h('span',{className:'status-badge status-badge-'+d.status},d.status));
    }
    card.appendChild(cardHdr);
    FIELDS.filter(function(f){return f.key!=='status';}).forEach(function(f){
      var val=d[f.key];
      if(!val) return;
      var row=h('div',{className:'multi-card-row'});
      row.appendChild(h('span',{className:'multi-card-label'},f.label));
      row.appendChild(h('span',{className:'multi-card-val'},val.length>120?val.slice(0,120)+'…':val));
      card.appendChild(row);
    });
    if(!hasDoc(code)) card.appendChild(h('div',{className:'multi-card-empty'},'No documentation yet'));
    wrap.appendChild(card);
  });
  return wrap;
}

// ── History shared helpers ───────────────────────────────────────────────────

var FIELD_LABELS = {
  status:'Status', scope:'Scope', rationale:'Rationale',
  usage_notes:'Usage notes', provenance:'History', parent:'Parent',
};
var DOC_FIELDS_ORDER = ['status','parent','scope','rationale','usage_notes','provenance'];

// Selection colours — A = teal, B = amber
var SEL_A_BG  = 'rgba(20,184,166,0.13)';  // teal tint
var SEL_B_BG  = 'rgba(251,191,36,0.13)';  // amber tint
var SEL_A_BAR = '#14b8a6';
var SEL_B_BAR = '#fbbf24';

function selBg(ord)  { return ord===1 ? SEL_A_BG  : SEL_B_BG; }
function selBar(ord) { return ord===1 ? SEL_A_BAR : SEL_B_BAR; }
function selLabel(ord) { return ord===1 ? 'A' : 'B'; }

// Iterative LCS — avoids call-stack overflow
function lcs(al, bl) {
  var m=al.length, n=bl.length;
  var dp=[]; for(var i=0;i<=m;i++){dp[i]=new Uint16Array(n+1);}
  for(var i=1;i<=m;i++) for(var j=1;j<=n;j++)
    dp[i][j]=al[i-1]===bl[j-1]?dp[i-1][j-1]+1:Math.max(dp[i-1][j],dp[i][j-1]);
  var ops=[]; var ii=m, jj=n;
  while(ii>0||jj>0){
    if(ii>0&&jj>0&&al[ii-1]===bl[jj-1]){ops.unshift({t:'ctx',s:al[ii-1]});ii--;jj--;}
    else if(jj>0&&(!ii||dp[ii][jj-1]>=dp[ii-1][jj])){ops.unshift({t:'add',s:bl[jj-1]});jj--;}
    else{ops.unshift({t:'del',s:al[ii-1]});ii--;}
  }
  return ops;
}

function buildLineDiff(a, b) {
  var al=(a||'').split('\n'), bl=(b||'').split('\n');
  var ops=lcs(al,bl);
  if(!ops) return [{type:'del',text:'(before, '+a.length+' chars)'},{type:'add',text:'(after, '+b.length+' chars)'}];
  return ops.map(function(o){return {type:o.t==='ctx'?'ctx':o.t==='add'?'add':'del', text:o.s};});
}

// Full-record for a code at a given log index (excludes _log/_baseline)
function codeRecordAtIdx(rawLog, baseline, logIdx) {
  var s = {};
  DOC_FIELDS_ORDER.forEach(function(f){ s[f] = (baseline && baseline[f] !== undefined) ? String(baseline[f]) : ''; });
  if(logIdx >= 0){
    for(var i=0; i<=logIdx && i<rawLog.length; i++){
      s[rawLog[i].field] = rawLog[i].to !== undefined ? String(rawLog[i].to) : '';
    }
  }
  return s;
}

// Full overrides map at a doc changelog index (reconstructed)
function overridesRecordAtIdx(upToIdx) {
  var base = {};
  treeArr.forEach(function(n){ base[n.name] = n.parent || ''; });
  for(var i=0; i<=upToIdx; i++){
    var ev = state.changelog[i];
    if(ev && ev.type==='move'){
      var m = ev.detail.match(/^(.+?):\s*(.+?)\s*→\s*(.*)$/);
      if(m) base[m[1].trim()] = m[3].trim()==='root'?'':m[3].trim();
    }
  }
  return base;
}

// ── JSON diff helpers ────────────────────────────────────────────────────────

// Plain full diff — shows all lines, no accordion (for small records like code docs)
function buildCodeJsonDiff(aStr, bStr) {
  var wrap = h('div',{className:'ch-json-diff'});
  var aLines = aStr.split('\n'), bLines = bStr.split('\n');
  // Raise limit for code records (small, ~8 lines)
  var ops = lcs(aLines, bLines);
  if(!ops.some(function(o){return o.t!=='ctx';})){
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'No differences.')); return wrap;
  }
  var pre=h('pre',{className:'ch-json-pre'});
  ops.forEach(function(op){
    var el=document.createElement('div');
    el.className='ch-json-line ch-json-'+op.t;
    el.textContent=(op.t==='add'?'+ ':op.t==='del'?'− ':'  ')+op.s;
    pre.appendChild(el);
  });
  wrap.appendChild(pre); return wrap;
}

// Accordion diff — collapses long unchanged runs (for large overrides maps)
function buildDocJsonDiff(aStr, bStr) {
  var wrap = h('div',{className:'ch-json-diff'});
  var aLines = aStr.split('\n'), bLines = bStr.split('\n');
  var ops = lcs(aLines, bLines);
  if(!ops.some(function(o){return o.t!=='ctx';})){
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'No differences.')); return wrap;
  }
  // Only use accordion when there are many unchanged lines (> 30 total)
  var ctxCount = ops.filter(function(o){return o.t==='ctx';}).length;
  if(ctxCount <= 30) {
    // Small enough — show all lines
    var pre=h('pre',{className:'ch-json-pre'});
    ops.forEach(function(op){
      var el=document.createElement('div');
      el.className='ch-json-line ch-json-'+op.t;
      el.textContent=(op.t==='add'?'+ ':op.t==='del'?'− ':'  ')+op.s;
      pre.appendChild(el);
    });
    wrap.appendChild(pre); return wrap;
  }
  // Accordion: 3 lines of context, collapse the rest
  var CONTEXT=3;
  var changed=new Set();
  for(var k=0;k<ops.length;k++){ if(ops[k].t!=='ctx') changed.add(k); }
  var shown=new Set();
  changed.forEach(function(ci){
    for(var k=Math.max(0,ci-CONTEXT);k<=Math.min(ops.length-1,ci+CONTEXT);k++) shown.add(k);
  });
  var pre2=h('pre',{className:'ch-json-pre'});
  var i=0;
  while(i<ops.length){
    if(shown.has(i)){
      var op=ops[i];
      var el=document.createElement('div');
      el.className='ch-json-line ch-json-'+op.t;
      el.textContent=(op.t==='add'?'+ ':op.t==='del'?'− ':'  ')+op.s;
      pre2.appendChild(el); i++;
    } else {
      var runStart=i;
      while(i<ops.length&&!shown.has(i)) i++;
      var runLen=i-runStart;
      var hidden=ops.slice(runStart,i);
      (function(hiddenLines,len){
        var collapsed=true;
        var btn=document.createElement('div');
        btn.className='ch-json-hunk';
        btn.textContent='@@ '+len+' unchanged lines';
        var expandedEls=hiddenLines.map(function(op){
          var el=document.createElement('div');
          el.className='ch-json-line ch-json-ctx';
          el.textContent='  '+op.s;
          el.style.display='none';
          return el;
        });
        btn.addEventListener('click',function(){
          collapsed=!collapsed;
          expandedEls.forEach(function(el){el.style.display=collapsed?'none':'block';});
          btn.textContent=collapsed?'@@ '+len+' unchanged lines':'@@ collapse';
          btn.classList.toggle('ch-json-hunk-open',!collapsed);
        });
        pre2.appendChild(btn);
        expandedEls.forEach(function(el){pre2.appendChild(el);});
      })(hidden,runLen);
    }
  }
  wrap.appendChild(pre2); return wrap;
}

// ── Word-level diff helper ───────────────────────────────────────────────────
// Produces an HTML fragment showing inline word-diff between two strings.
// Additions: green underline; deletions: red strikethrough.

function buildWordDiff(before, after) {
  var frag = document.createDocumentFragment();
  if (before === after) {
    frag.appendChild(document.createTextNode(before || '(empty)'));
    return frag;
  }
  if (!before) {
    var el = document.createElement('ins'); el.className = 'wd-add'; el.textContent = after || '(empty)';
    frag.appendChild(el); return frag;
  }
  if (!after) {
    var el = document.createElement('del'); el.className = 'wd-del'; el.textContent = before;
    frag.appendChild(el); return frag;
  }
  // Tokenise on word boundaries
  var tokA = before.match(/\S+|\s+/g) || [];
  var tokB = after.match(/\S+|\s+/g)  || [];
  var ops = lcs(tokA, tokB);
  ops.forEach(function(op) {
    var el;
    if (op.t === 'ctx') {
      el = document.createTextNode(op.s);
    } else if (op.t === 'add') {
      el = document.createElement('ins'); el.className = 'wd-add'; el.textContent = op.s;
    } else {
      el = document.createElement('del'); el.className = 'wd-del'; el.textContent = op.s;
    }
    frag.appendChild(el);
  });
  return frag;
}

// ── Cross-snapshot diff state ──────────────────────────────────────────────────
// Loaded snapshots for the snapshot comparison panel.
// Each entry: {dir, codes, overrides, saved} or null.

// state_vdiff entries have shape:
//   type:'snapshot'  → loaded from snapshot dir on disk; has .codes, .overrides, .dir, .label
//   type:'session'  → reconstructed from in-memory _log at a timestamp; has .snap, .ts, .label
var state_vdiff = { left: null, right: null, loading: false, error: '' };

// Collect all unique commit timestamps from every code's _log in the current session,
// deduplicated to minute precision so nearby edits group together.
function sessionCommitPoints() {
  var seen = {}, points = [];
  var codes = state.docs.codes || {};
  Object.keys(codes).forEach(function(code) {
    var log = codes[code]._log || [];
    log.forEach(function(entry) {
      var min = (entry.ts || '').slice(0, 16); // YYYY-MM-DDTHH:MM
      if (min && !seen[min]) {
        seen[min] = true;
        points.push({ ts: entry.ts, label: min.replace('T', ' ') });
      }
    });
  });
  // Newest first
  points.sort(function(a, b) { return b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : 0; });
  return points;
}

async function loadCompareEntry(side, value) {
  // value is "snapshot:dirName" or "session:timestamp"
  state_vdiff.loading = true;
  state_vdiff.error   = '';
  var parts = value.split(':');
  var type  = parts[0];
  var key   = parts.slice(1).join(':');

  try {
    if (type === 'snapshot') {
      var res  = await fetch(API + '/snapshots/read?dir=' + encodeURIComponent(key));
      var data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
      state_vdiff[side] = { type: 'snapshot', dir: key, codes: data.codes, overrides: data.overrides, label: key };
    } else {
      // Session point — reconstruct from in-memory log at this timestamp
      var snap = fullDocSnapshotAtTs(key);
      state_vdiff[side] = { type: 'session', ts: key, snap: snap, label: key.slice(0, 16).replace('T', ' ') };
    }
  } catch(e) {
    state_vdiff.error = String(e.message || e);
    state_vdiff[side] = null;
  }
  state_vdiff.loading = false;
  var old = document.querySelector('.hist-vdiff-pane');
  if (old) old.parentNode.replaceChild(buildSnapshotDiffPane(), old);
}

// Normalise a state_vdiff entry to {codes, overrides} for diffing.
// Snapshot entries already have .codes/.overrides from disk.
// Session entries have .snap which is {codeName: {field: value}} already keyed by code.
function vdiffCodes(entry) {
  if (!entry) return {};
  if (entry.type === 'session') {
    // Already flat {codeName: {field:val}} from fullDocSnapshotAtTs
    return entry.snap || {};
  }
  // Snapshot: codes object from disk. Flatten to same shape: top-level fields only.
  // parent comes from overrides, not from the code object itself.
  var raw = entry.codes || {};
  var ovr = entry.overrides || {};
  var out = {};
  Object.keys(raw).forEach(function(name) {
    var c = raw[name] || {};
    var flat = {};
    DOC_FIELDS_ORDER.forEach(function(f){
      if (f === 'parent') {
        flat.parent = ovr[name] !== undefined ? String(ovr[name]) : '';
      } else {
        flat[f] = c[f] !== undefined ? String(c[f] || '') : '';
      }
    });
    out[name] = flat;
  });
  return out;
}

function vdiffOverrides(entry) {
  if (!entry) return {};
  if (entry.type === 'snapshot') return entry.overrides || {};
  // Session: parent is already in the snap per-code
  return {};
}

// ── Snapshot diff pane ─────────────────────────────────────────────────────────

function buildSnapshotDiffPane() {
  var wrap = h('div',{className:'hist-vdiff-pane'});
  var snapshots     = (state.snapshotsData && state.snapshotsData.snapshots) || [];
  var sessionPts   = sessionCommitPoints();

  // Selectors
  var selRow = h('div',{className:'hist-vdiff-selrow'});
  function makeSelector(side, label) {
    var col = h('div',{className:'hist-vdiff-selcol'});
    col.appendChild(h('span',{className:'hist-vdiff-sellabel'}, label));
    var sel = h('select',{
      className:'hist-vdiff-sel',
      onChange: function(e) {
        if (e.target.value) loadCompareEntry(side, e.target.value);
        else { state_vdiff[side] = null; var old = document.querySelector('.hist-vdiff-pane'); if(old) old.parentNode.replaceChild(buildSnapshotDiffPane(),old); }
      },
    });
    var blank = document.createElement('option'); blank.value=''; blank.textContent='— select snapshot —';
    sel.appendChild(blank);

    // Group 1: saved snapshots
    if (snapshots.length) {
      var grpV = document.createElement('optgroup'); grpV.label = 'Saved snapshots';
      snapshots.forEach(function(v) {
        var opt = document.createElement('option');
        opt.value = 'snapshot:' + v.dir;
        opt.textContent = v.chain + '  ' + v.timestamp + (v.hash4 ? '  ' + v.hash4 : '');
        if (state_vdiff[side] && state_vdiff[side].type === 'snapshot' && state_vdiff[side].dir === v.dir) opt.selected = true;
        grpV.appendChild(opt);
      });
      sel.appendChild(grpV);
    }

    // Group 2: session commit points from _log
    if (sessionPts.length) {
      var grpS = document.createElement('optgroup'); grpS.label = 'Session commits';
      sessionPts.forEach(function(pt) {
        var opt = document.createElement('option');
        opt.value = 'session:' + pt.ts;
        opt.textContent = pt.label;
        if (state_vdiff[side] && state_vdiff[side].type === 'session' && state_vdiff[side].ts === pt.ts) opt.selected = true;
        grpS.appendChild(opt);
      });
      sel.appendChild(grpS);
    }

    col.appendChild(sel);
    if (state_vdiff[side]) {
      var typeBadge = state_vdiff[side].type === 'snapshot' ? 'snapshot' : 'session';
      col.appendChild(h('span',{className:'hist-vdiff-loaded'}, '✓ ' + typeBadge));
    }
    return col;
  }
  selRow.appendChild(makeSelector('left',  'Earlier'));
  selRow.appendChild(h('span',{className:'hist-vdiff-arrow'},'→'));
  selRow.appendChild(makeSelector('right', 'Later'));
  wrap.appendChild(selRow);

  if (state_vdiff.error) {
    wrap.appendChild(h('div',{className:'ch-diff-empty msg-error'}, state_vdiff.error));
    return wrap;
  }
  if (state_vdiff.loading) {
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'Loading…'));
    return wrap;
  }
  if (!state_vdiff.left || !state_vdiff.right) {
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'Select two snapshots to compare.'));
    return wrap;
  }

  // Build diff
  var leftCodes  = vdiffCodes(state_vdiff.left);
  var rightCodes = vdiffCodes(state_vdiff.right);
  // Use treeArr as the canonical code list — ensures both sides use the same namespace
  // Missing codes in either side are treated as empty (not absent)
  var allCodes   = new Set(treeArr.map(function(n){return n.name;}));
  // Also include any codes only in the snapshot files (added/removed vs current tree)
  Object.keys(leftCodes).concat(Object.keys(rightCodes)).forEach(function(k){ allCodes.add(k); });

  // Mode toggle: Summary | Fields | JSON
  var modeKey = 'histVdiffMode';
  if (!state[modeKey]) state[modeKey] = 'summary';
  var modeRow = h('div',{className:'hist-vdiff-modesrow'});
  ['summary','fields','json'].forEach(function(m) {
    modeRow.appendChild(h('button',{
      className:'ch-toggle-btn'+(state[modeKey]===m?' active':''),
      onClick: function(){
        state[modeKey] = m;
        var old = document.querySelector('.hist-vdiff-pane');
        if (old) old.parentNode.replaceChild(buildSnapshotDiffPane(), old);
      },
    }, m==='summary'?'Summary':m==='fields'?'Fields':'JSON'));
  });
  wrap.appendChild(modeRow);

  if (state[modeKey] === 'json') {
    // Full JSON diff of both snapshots
    var snap = function(codesObj, overridesObj) {
      var out = {};
      treeArr.forEach(function(n){
        var c = codesObj[n.name] || {};
        var rec = {};
        DOC_FIELDS_ORDER.forEach(function(f){ rec[f] = f==='parent' ? ((overridesObj||{})[n.name]||n.parent||'') : (c[f]||''); });
        out[n.name] = rec;
      });
      return out;
    };
    var sl = snap(leftCodes,  vdiffOverrides(state_vdiff.left));
    var sr = snap(rightCodes, vdiffOverrides(state_vdiff.right));
    wrap.appendChild(buildDocJsonDiff(JSON.stringify(sl,null,2), JSON.stringify(sr,null,2)));
    return wrap;
  }

  if (state[modeKey] === 'summary') {
    // Summary: list codes that changed, added, or removed
    var changed=[], added=[], removed=[];
    allCodes.forEach(function(code){
      var lc = leftCodes[code];
      var rc = rightCodes[code];
      if (!lc) { added.push(code); return; }
      if (!rc) { removed.push(code); return; }
      var diff = DOC_FIELDS_ORDER.some(function(f){
        return (lc[f]||'') !== (rc[f]||'');
      });
      if (diff) changed.push(code);
    });
    if (!changed.length && !added.length && !removed.length) {
      wrap.appendChild(h('div',{className:'ch-diff-empty'},'No differences between these snapshots.'));
      return wrap;
    }
    var summary = h('div',{className:'hist-vdiff-summary'});
    if (changed.length) {
      summary.appendChild(h('div',{className:'hist-vdiff-group-label'},'Modified ('+changed.length+')'));
      changed.sort().forEach(function(code){
        var row = h('div',{className:'hist-vdiff-sum-row'});
        row.appendChild(h('span',{className:'hist-vdiff-code'}, code));
        // Show which fields changed
        var lc = leftCodes[code] || {}, rc = rightCodes[code] || {};
        var changedFields = DOC_FIELDS_ORDER.filter(function(f){ return (lc[f]||'') !== (rc[f]||''); });
        row.appendChild(h('span',{className:'hist-vdiff-fields'}, changedFields.map(function(f){ return FIELD_LABELS[f]||f; }).join(', ')));
        // Click to switch to fields view for this code
        row.addEventListener('click', function(){
          state[modeKey] = 'fields';
          state.histVdiffFocusCode = code;
          var old = document.querySelector('.hist-vdiff-pane');
          if (old) old.parentNode.replaceChild(buildSnapshotDiffPane(), old);
        });
        summary.appendChild(row);
      });
    }
    if (added.length) {
      summary.appendChild(h('div',{className:'hist-vdiff-group-label hist-vdiff-add'},'Added in later snapshot ('+added.length+')'));
      added.sort().forEach(function(code){
        summary.appendChild(h('div',{className:'hist-vdiff-sum-row'}, h('span',{className:'hist-vdiff-code'},code)));
      });
    }
    if (removed.length) {
      summary.appendChild(h('div',{className:'hist-vdiff-group-label hist-vdiff-del'},'Removed in later snapshot ('+removed.length+')'));
      removed.sort().forEach(function(code){
        summary.appendChild(h('div',{className:'hist-vdiff-sum-row'}, h('span',{className:'hist-vdiff-code'},code)));
      });
    }
    wrap.appendChild(summary);
    return wrap;
  }

  // Fields view: one section per changed code
  if (!state.histVdiffFocusCode) state.histVdiffFocusCode = null;
  // Filter to changed codes only; if a specific code is focused show just that
  var codesWithDiffs = Array.from(allCodes).filter(function(code){
    var lc = leftCodes[code] || {}, rc = rightCodes[code] || {};
    return DOC_FIELDS_ORDER.some(function(f){ return (lc[f]||'') !== (rc[f]||''); });
  }).sort();

  if (!codesWithDiffs.length) {
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'No field differences.'));
    return wrap;
  }

  var focusSel = h('select',{className:'hist-vdiff-focus-sel', onChange:function(e){
    state.histVdiffFocusCode = e.target.value || null;
    var old = document.querySelector('.hist-vdiff-pane');
    if (old) old.parentNode.replaceChild(buildSnapshotDiffPane(), old);
  }});
  var allOpt = document.createElement('option'); allOpt.value=''; allOpt.textContent='All changed codes ('+codesWithDiffs.length+')';
  focusSel.appendChild(allOpt);
  codesWithDiffs.forEach(function(code){
    var opt = document.createElement('option'); opt.value=code; opt.textContent=code;
    if (state.histVdiffFocusCode === code) opt.selected=true;
    focusSel.appendChild(opt);
  });
  wrap.appendChild(h('div',{className:'hist-vdiff-focusrow'}, focusSel));

  var displayCodes = state.histVdiffFocusCode ? [state.histVdiffFocusCode] : codesWithDiffs;
  var fieldsWrap = h('div',{className:'hist-vdiff-fields-wrap'});
  displayCodes.forEach(function(code){
    var lc = leftCodes[code] || {}, rc = rightCodes[code] || {};
    var sec = h('div',{className:'hist-vdiff-code-sec'});
    sec.appendChild(h('div',{className:'hist-vdiff-code-hdr'}, code));
    DOC_FIELDS_ORDER.forEach(function(f){
      var lv = lc[f] || '', rv = rc[f] || '';
      if (lv === rv) return; // skip unchanged fields
      var frow = h('div',{className:'ch-diff-field'});
      frow.appendChild(h('div',{className:'ch-diff-field-label'}, FIELD_LABELS[f]||f));
      // Inline word diff
      var diffEl = h('div',{className:'wd-block'});
      diffEl.appendChild(buildWordDiff(lv, rv));
      frow.appendChild(diffEl);
      sec.appendChild(frow);
    });
    fieldsWrap.appendChild(sec);
  });
  wrap.appendChild(fieldsWrap);
  return wrap;
}

// ── Per-code Timeline view ────────────────────────────────────────────────────
// Shows the evolution of each field as a sequence of annotated change steps
// with inline word-level diffs between consecutive states.

function buildCodeTimeline(code, rawLog, snapshot) {
  var wrap = h('div',{className:'cht-wrap'});

  if (!rawLog.length) {
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'No edits recorded for this code yet.'));
    return wrap;
  }

  // Build the full sequence of states: baseline → log[0] → log[1] → … → log[N-1]
  var states = [];
  // state[-1] = baseline
  states.push({idx:-1, ts: rawLog.length>0 ? 'Before '+rawLog[0].ts.slice(0,10) : 'Initial state', field: null, rec: codeRecordAtIdx(rawLog, snapshot, -1)});
  rawLog.forEach(function(entry, i){
    states.push({idx:i, ts:entry.ts.slice(0,16).replace('T',' '), field:entry.field, rec:codeRecordAtIdx(rawLog, snapshot, i)});
  });

  // For each field, show timeline of changes
  DOC_FIELDS_ORDER.forEach(function(f){
    // Collect only the steps where this field changed
    var steps = [];
    for (var i = 1; i < states.length; i++) {
      if (states[i].field === f) {
        steps.push({ts: states[i].ts, before: states[i-1].rec[f]||'', after: states[i].rec[f]||''});
      }
    }
    if (!steps.length) return; // field never changed — skip

    var fieldBlock = h('div',{className:'cht-field'});
    fieldBlock.appendChild(h('div',{className:'cht-field-label'}, FIELD_LABELS[f]||f));

    // Show current value
    var current = states[states.length-1].rec[f] || '';
    var currentEl = h('div',{className:'cht-current'+(current?'':' cht-empty')});
    currentEl.appendChild(h('span',{className:'cht-current-label'},'Current'));
    currentEl.appendChild(h('span',{className:'cht-current-val'}, current||'(empty)'));
    fieldBlock.appendChild(currentEl);

    // Show each change step, newest first
    steps.slice().reverse().forEach(function(step){
      var stepEl = h('div',{className:'cht-step'});
      stepEl.appendChild(h('span',{className:'cht-step-ts'}, step.ts));
      var diffEl = h('div',{className:'wd-block'});
      diffEl.appendChild(buildWordDiff(step.before, step.after));
      stepEl.appendChild(diffEl);
      fieldBlock.appendChild(stepEl);
    });

    // Show baseline value
    var baselineVal = states[0].rec[f] || '';
    var baseEl = h('div',{className:'cht-baseline'});
    baseEl.appendChild(h('span',{className:'cht-baseline-label'}, states[0].ts));
    baseEl.appendChild(h('span',{className:'cht-baseline-val'+(baselineVal?'':' cht-empty')}, baselineVal||'(empty)'));
    fieldBlock.appendChild(baseEl);

    wrap.appendChild(fieldBlock);
  });

  if (!wrap.querySelector('.cht-field')) {
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'No field edits recorded.'));
  }

  return wrap;
}

// ── Multi-code history view ───────────────────────────────────────────────────

function buildMultiCodeHistory(codes) {
  var wrap = h('div',{className:'mch-wrap'});

  // Build combined sorted feed for these codes only
  var feed = [];
  codes.forEach(function(code){
    var log = (getDoc(code)._log) || [];
    log.forEach(function(entry, i){
      feed.push({ts:entry.ts||'', code:code, logIdx:i, entry:entry});
    });
  });
  // Also include structural events affecting these codes
  state.changelog.forEach(function(ev, i){
    if (ev.type === 'move') {
      var m = ev.detail.match(/^(.+?):\s/);
      if (m && codes.indexOf(m[1].trim()) !== -1) {
        feed.push({ts:ev.ts||'', code:m[1].trim(), logIdx:null, entry:null, ev:ev});
      }
    }
  });
  feed.sort(function(a,b){ return b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : 0; });

  if (!feed.length) {
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'No edits recorded for the selected codes.'));
    return wrap;
  }

  // Activity summary: counts per code
  var counts = {};
  codes.forEach(function(c){ counts[c] = 0; });
  feed.forEach(function(item){ if(item.code) counts[item.code] = (counts[item.code]||0)+1; });
  var summaryRow = h('div',{className:'mch-summary'});
  codes.forEach(function(c){
    var chip = h('span',{className:'mch-chip'+(counts[c]>0?'':' mch-chip-none')});
    chip.appendChild(h('span',{className:'mch-chip-name'}, c));
    if (counts[c]>0) chip.appendChild(h('span',{className:'mch-chip-count'}, counts[c]));
    summaryRow.appendChild(chip);
  });
  wrap.appendChild(summaryRow);

  // Feed list with snapshot boundary markers
  var listWrap = h('div',{className:'mch-list'});
  feed.forEach(function(item){
    var row = h('div',{className:'mch-row'});
    var ts = item.ts.slice(0,16).replace('T',' ');
    row.appendChild(h('span',{className:'mch-ts'}, ts));
    row.appendChild(h('span',{className:'mch-code'}, item.code));
    if (item.ev) {
      row.appendChild(h('span',{className:'mch-field'}, 'Moved'));
      row.appendChild(h('span',{className:'mch-detail'}, item.ev.detail||''));
    } else {
      row.appendChild(h('span',{className:'mch-field'}, FIELD_LABELS[item.entry.field]||item.entry.field));
      var fv = item.entry.from !== undefined ? String(item.entry.from) : '';
      var tv = item.entry.to   !== undefined ? String(item.entry.to)   : '';
      var fromLbl = fv===''?'(empty)':fv.length>40?fv.slice(0,40)+'…':fv;
      var toLbl   = tv===''?'(empty)':tv.length>40?tv.slice(0,40)+'…':tv;
      var prev = h('span',{className:'mch-preview'});
      prev.appendChild(document.createTextNode(fromLbl+' → '+toLbl));
      row.appendChild(prev);
    }
    listWrap.appendChild(row);
  });
  wrap.appendChild(listWrap);
  return wrap;
}

// ── Session boundary annotation ───────────────────────────────────────────────
// The changelog's 'open' events mark where one working session began.
// Used to annotate the history feed with snapshot/session labels.

function getSessionBoundaries() {
  var boundaries = [];
  state.changelog.forEach(function(ev){
    if (ev.type === 'open') {
      boundaries.push({ts: ev.ts, label: ev.detail || 'session'});
    }
  });
  return boundaries;
}

function sessionLabelAtTs(ts, boundaries) {
  // Return the label of the most recent 'open' event before this ts
  var label = '';
  boundaries.forEach(function(b){ if (b.ts <= ts) label = b.label; });
  return label;
}


// ── Code history tab ──────────────────────────────────────────────────────────

function buildCodeHistoryTab(code) {
  var wrap = h('div',{className:'code-history'});
  var rawLog   = getDoc(code)._log || [];
  var snapshot = getDoc(code)._baseline || {};

  // Subtabs: Timeline | Compare   +   Fields/JSON toggle aligned with diff pane
  var modeRow = h('div',{className:'tabs ch-subtabs'});
  var tabsGroup = h('div',{className:'ch-subtabs-tabs'});
  ['timeline','compare'].forEach(function(m){
    tabsGroup.appendChild(h('button',{
      className:'tab'+(state.histCodeMode===m?' active':''),
      onClick:function(){
        state.histCodeMode = m;
        var edBody = document.querySelector('.editor-body');
        if (edBody) { edBody.innerHTML = ''; edBody.appendChild(buildCodeHistoryTab(code)); }
        else renderMainPanel();
      },
    }, m==='timeline' ? 'Timeline' : 'Compare'));
  });
  modeRow.appendChild(tabsGroup);
  if (state.histCodeMode === 'compare') {
    var togGroup = h('div',{className:'ch-subtabs-toggle'});
    ['fields','json'].forEach(function(m){
      togGroup.appendChild(h('button',{
        className:'ch-toggle-btn'+(state.histDiffMode===m?' active':''),
        onClick:function(){
          state.histDiffMode = m;
          var edBody = document.querySelector('.editor-body');
          if (edBody) { edBody.innerHTML = ''; edBody.appendChild(buildCodeHistoryTab(code)); }
          else renderMainPanel();
        },
      }, m==='fields'?'Fields':'JSON'));
    });
    modeRow.appendChild(togGroup);
  }
  wrap.appendChild(modeRow);

  if (state.histCodeMode === 'timeline') {
    wrap.appendChild(buildCodeTimeline(code, rawLog, snapshot));
    return wrap;
  }

  // ── Compare mode: interactive list + diff pane ──
  var listWrap = h('div',{className:'ch-list'});
  var codeHistSel = state.histSel.filter(function(k){return k.startsWith('code:');});

  var hdrRow = h('div',{className:'ch-list-hdr'});
  hdrRow.appendChild(h('span',{className:'ch-list-hint'},
    codeHistSel.length===0 ? 'Click a snapshot to inspect; click two to compare'
    : codeHistSel.length===1 ? 'Click another snapshot to compare'
    : 'Comparing A (teal) and B (amber)'
  ));
  listWrap.appendChild(hdrRow);

  for(var ri = rawLog.length-1; ri >= 0; ri--){
    listWrap.appendChild(buildCodeHistoryRow(code, rawLog, snapshot, ri, codeHistSel));
  }
  listWrap.appendChild(buildCodeHistoryRow(code, rawLog, snapshot, -1, codeHistSel));

  if (codeHistSel.length >= 2) {
    var cTogFoot = h('div',{className:'ch-toggle-footer'});
    ['fields','json'].forEach(function(m){
      cTogFoot.appendChild(h('button',{
        className:'ch-toggle-btn'+(state.histDiffMode===m?' active':''),
        onClick:function(){
          state.histDiffMode = m;
          cTogFoot.querySelectorAll('.ch-toggle-btn').forEach(function(b){
            b.className='ch-toggle-btn'+(b.textContent.toLowerCase()===m?' active':'');
          });
          var pId='ch-diff-pane-'+code.replace(/\W/g,'_');
          var pEl=document.getElementById(pId);
          if(pEl){pEl.innerHTML='';pEl.appendChild(buildCodeDiffContent(code,rawLog,snapshot));}
        },
      }, m==='fields'?'Fields':'JSON'));
    });
    listWrap.appendChild(cTogFoot);
  }

  var body = h('div',{className:'ch-body'});
  body.appendChild(listWrap);

  var paneId = 'ch-diff-pane-'+code.replace(/\W/g,'_');
  var diffPane = h('div',{className:'ch-diff-pane', id:paneId});
  if(codeHistSel.length >= 1){
    diffPane.appendChild(buildCodeDiffContent(code, rawLog, snapshot));
  } else {
    diffPane.appendChild(h('div',{className:'ch-diff-empty ch-diff-hint'},'Select a snapshot on the left to inspect it.'));
  }
  body.appendChild(diffPane);
  wrap.appendChild(body);
  return wrap;
}

function buildCodeHistoryRow(code, rawLog, snapshot, logIdx, codeHistSel) {
  var key = 'code:'+logIdx;
  var selPos = codeHistSel.indexOf(key); // -1 not selected; 0 = A; 1 = B
  var isSel  = selPos !== -1;
  var ord    = selPos + 1; // 1 or 2 if selected

  var rowStyle = isSel ? {background:selBg(ord), borderLeft:'3px solid '+selBar(ord)} : {};
  var row = h('div',{
    className:'ch-entry'+(isSel?' ch-entry-sel':''),
    style: rowStyle,
    onClick:function(){
      var existing = state.histSel.filter(function(k){return !k.startsWith('code:');});
      var codeKeys = state.histSel.filter(function(k){return k.startsWith('code:');});
      var idx = codeKeys.indexOf(key);
      if(idx !== -1) codeKeys.splice(idx,1);
      else { if(codeKeys.length>=2) codeKeys.shift(); codeKeys.push(key); }
      state.histSel = existing.concat(codeKeys);
      refreshCodeHistory(code, rawLog, snapshot);
    },
  });
  row.dataset.key = key;

  var hdr = h('div',{className:'ch-entry-hdr'});
  // Coloured A/B pill when selected; plain circle placeholder when not
  var badgeCls = isSel ? 'ch-sel-badge ch-sel-badge-'+ord : 'ch-sel-badge ch-sel-badge-empty';
  hdr.appendChild(h('span',{className:badgeCls}, isSel ? selLabel(ord) : ''));

  if(logIdx === -1){
    // Show timestamp of oldest log entry (first change recorded), or just "Initial state"
    var snapTs = rawLog.length > 0 ? rawLog[0].ts.slice(0,10) : '';
    hdr.appendChild(h('span',{className:'ch-ts'}, snapTs ? 'Before '+snapTs : 'Initial state'));
    hdr.appendChild(h('span',{className:'ch-field ch-field-snapshot'}, 'State when first loaded'));
  } else {
    var entry = rawLog[logIdx];
    hdr.appendChild(h('span',{className:'ch-ts'}, entry.ts ? entry.ts.slice(0,16).replace('T',' ') : ''));
    hdr.appendChild(h('span',{className:'ch-field'}, FIELD_LABELS[entry.field]||entry.field));
  }
  row.appendChild(hdr);

  if(logIdx >= 0){
    var entry = rawLog[logIdx];
    var fv = entry.from !== undefined ? String(entry.from) : '';
    var tv = entry.to   !== undefined ? String(entry.to)   : '';
    var fromLabel = fv==='' ? '(empty)' : (fv.length>60 ? fv.slice(0,60)+'…' : fv);
    var toLabel   = tv==='' ? '(empty)' : (tv.length>60 ? tv.slice(0,60)+'…' : tv);
    var prev = h('div',{className:'ch-preview'});
    prev.appendChild(h('span',{className:'ch-from'}, fromLabel));
    prev.appendChild(h('span',{className:'ch-arrow'},'→'));
    prev.appendChild(h('span',{className:'ch-to'}, toLabel));
    row.appendChild(prev);
  }
  return row;
}

function refreshCodeHistory(code, rawLog, snapshot) {
  var codeHistSel = state.histSel.filter(function(k){return k.startsWith('code:');});
  // Update row highlights
  document.querySelectorAll('.ch-entry').forEach(function(el){
    var key = el.dataset && el.dataset.key; if(!key) return;
    var selPos = codeHistSel.indexOf(key);
    var isSel  = selPos !== -1;
    var ord    = selPos + 1;
    el.classList.toggle('ch-entry-sel', isSel);
    el.style.background      = isSel ? selBg(ord)  : '';
    el.style.borderLeft      = isSel ? '3px solid '+selBar(ord) : '2px solid transparent';
    var badge = el.querySelector('.ch-sel-badge');
    if(badge){
      badge.textContent = isSel ? selLabel(ord) : '';
      badge.className = isSel ? 'ch-sel-badge ch-sel-badge-'+ord : 'ch-sel-badge ch-sel-badge-empty';
    }
  });
  // Update hint
  var hint = document.querySelector('.ch-list-hdr .ch-list-hint');
  if(hint){
    hint.textContent = codeHistSel.length===0 ? 'Click a snapshot to inspect; click two to compare'
                     : codeHistSel.length===1  ? 'Click another snapshot to compare'
                     : 'Comparing A (teal) and B (amber)';
  }
  // Update diff pane
  var paneId = 'ch-diff-pane-'+code.replace(/\W/g,'_');
  var pane = document.getElementById(paneId);
  if(pane){
    pane.innerHTML='';
    if(codeHistSel.length>=1) pane.appendChild(buildCodeDiffContent(code,rawLog,snapshot));
    else pane.appendChild(h('div',{className:'ch-diff-empty ch-diff-hint'},'Select a snapshot on the left to inspect it.'));
  }
}

function buildCodeDiffContent(code, rawLog, snapshot) {
  var codeHistSel = state.histSel.filter(function(k){return k.startsWith('code:');});
  if(!codeHistSel.length) return h('div',{});

  var idxA = parseInt(codeHistSel[0].split(':')[1]);
  var idxB = codeHistSel[1]!==undefined ? parseInt(codeHistSel[1].split(':')[1]) : null;
  var isSingle = idxB===null;
  var lo = isSingle ? idxA : Math.min(idxA,idxB);
  var hi = isSingle ? idxA : Math.max(idxA,idxB);

  // Determine which index is A and which is B (matches selection order)
  var aIdx = parseInt(codeHistSel[0].split(':')[1]);
  var bIdx = codeHistSel[1]!==undefined ? parseInt(codeHistSel[1].split(':')[1]) : aIdx;

  var recA = codeRecordAtIdx(rawLog, snapshot, aIdx);
  var recB = isSingle ? recA : codeRecordAtIdx(rawLog, snapshot, bIdx);

  var tsA = aIdx===-1 ? (rawLog.length>0?'Before '+rawLog[0].ts.slice(0,10):'Initial state') : (rawLog[aIdx]?rawLog[aIdx].ts.slice(0,16).replace('T',' '):'');
  var tsB = bIdx===-1 ? (rawLog.length>0?'Before '+rawLog[0].ts.slice(0,10):'Initial state') : (rawLog[bIdx]?rawLog[bIdx].ts.slice(0,16).replace('T',' '):'');

  var wrap = h('div',{className:'ch-diff-content'});

  // Header
  var hdr = h('div',{className:'ch-diff-hdr'});
  if(isSingle){
    var ts = aIdx===-1?(rawLog.length>0?'Before '+rawLog[0].ts.slice(0,10):'Initial state'):tsA;
    hdr.appendChild(h('span',{className:'ch-diff-range'}, ts));
    if(aIdx!==-1 && rawLog[aIdx]){
      hdr.appendChild(h('span',{className:'ch-diff-field-tag'}, FIELD_LABELS[rawLog[aIdx].field]||rawLog[aIdx].field));
    }
  } else {
    // Coloured A/B labels in header
    var aLbl = h('span',{className:'ch-hdr-sel ch-hdr-sel-a'}, 'A  '+tsA);
    var bLbl = h('span',{className:'ch-hdr-sel ch-hdr-sel-b'}, 'B  '+tsB);
    hdr.appendChild(h('span',{className:'ch-diff-range'}, '')); // spacer
    var lblRow = h('span',{className:'ch-hdr-labels'}); lblRow.appendChild(aLbl); lblRow.appendChild(h('span',{},' → ')); lblRow.appendChild(bLbl);
    hdr.insertBefore(lblRow, hdr.firstChild);
    // Toggle moved to list header
  }
  wrap.appendChild(hdr);

  // Single snapshot — show full record
  if(isSingle){
    DOC_FIELDS_ORDER.forEach(function(f){
      var val = recA[f] !== undefined ? String(recA[f]) : '';
      var frow = h('div',{className:'ch-diff-field'});
      frow.appendChild(h('div',{className:'ch-diff-field-label'}, FIELD_LABELS[f]||f));
      frow.appendChild(h('div',{className:'ch-diff-value'+(val===''?' ch-diff-value-empty':'')}, val===''?'(empty)':val));
      wrap.appendChild(frow);
    });
    return wrap;
  }

  // Two-snapshot: JSON view
  if(state.histDiffMode==='json'){
    wrap.appendChild(buildCodeJsonDiff(JSON.stringify(recA,null,2), JSON.stringify(recB,null,2)));
    return wrap;
  }

  // Two-snapshot: Fields view — ALL fields, changed ones get before/after blocks
  DOC_FIELDS_ORDER.forEach(function(f){
    var vA = recA[f] !== undefined ? String(recA[f]) : '';
    var vB = recB[f] !== undefined ? String(recB[f]) : '';
    var changed = vA !== vB;

    var frow = h('div',{className:'ch-diff-field'+(changed?'':' ch-diff-field-unchanged')});
    frow.appendChild(h('div',{className:'ch-diff-field-label'+(changed?'':' ch-diff-field-label-unch')}, FIELD_LABELS[f]||f));

    if(!changed){
      frow.appendChild(h('div',{className:'ch-diff-value ch-diff-value-unch'+(vA===''?' ch-diff-value-empty':'')}, vA===''?'(empty)':vA));
    } else {
      // Before block (A)
      var beforeBlk = h('div',{className:'ch-diff-before-blk'});
      beforeBlk.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-a'},'A — before'));
      if(vA.indexOf('\n')===-1 && vA.length < 400){
        beforeBlk.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-del'+(vA===''?' ch-diff-value-empty':'')}, vA===''?'(empty)':vA));
      } else {
        var preA=h('pre',{className:'ch-diff-blk-pre ch-diff-blk-del'}); preA.textContent=vA||'(empty)'; beforeBlk.appendChild(preA);
      }
      frow.appendChild(beforeBlk);

      // After block (B)
      var afterBlk = h('div',{className:'ch-diff-after-blk'});
      afterBlk.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-b'},'B — after'));
      if(vB.indexOf('\n')===-1 && vB.length < 400){
        afterBlk.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-add'+(vB===''?' ch-diff-value-empty':'')}, vB===''?'(empty)':vB));
      } else {
        // Long text: line diff
        var lines = buildLineDiff(vA, vB);
        var preB = h('pre',{className:'ch-diff-blk-pre'});
        lines.forEach(function(ln){
          var el=document.createElement('div');
          el.className='ch-diff-line ch-diff-'+ln.type;
          el.textContent=(ln.type==='add'?'+ ':ln.type==='del'?'− ':'  ')+ln.text;
          preB.appendChild(el);
        });
        afterBlk.appendChild(preB);
      }
      frow.appendChild(afterBlk);
    }
    wrap.appendChild(frow);
  });
  return wrap;
}

// ── Document history editor ───────────────────────────────────────────────────


function buildDocTimeline() {
  // Read-only chronological event list — no selection, no diffing
  var wrap = h('div',{className:'doc-timeline-scroll'});
  var feed = buildDocFeed();
  if (!feed.length) {
    wrap.appendChild(h('div',{className:'code-history-empty'},'No events recorded yet.'));
    return wrap;
  }
  var boundaries = getSessionBoundaries();
  var prevLabel = null;
  feed.forEach(function(item){
    var sessLabel = sessionLabelAtTs(item.ts, boundaries);
    if (sessLabel && sessLabel !== prevLabel) {
      prevLabel = sessLabel;
      var marker = h('div',{className:'ch-session-marker'});
      marker.appendChild(h('span',{className:'ch-session-label'}, sessLabel));
      wrap.appendChild(marker);
    }
    var row = h('div',{className:'dctl-row'});
    var ts = (item.ts||'').slice(0,16).replace('T',' ');
    row.appendChild(h('span',{className:'dctl-ts'}, ts));
    if (item.kind === 'doc') {
      var icon = {open:'↓', save:'↑', move:'⇄', 'bulk-status':'●'}[item.ev.type] || '·';
      row.appendChild(h('span',{className:'cl-icon cl-icon-'+(item.ev.type||'other')}, icon));
      row.appendChild(h('span',{className:'dctl-type'}, item.ev.type));
      // For open events trim to just the filename/dir, not the full path
      var detail = item.ev.detail || '';
      if (item.ev.type === 'open') detail = detail.replace(/.*[\/\\]/, '');
      row.appendChild(h('span',{className:'dctl-detail'}, detail));
    } else {
      row.appendChild(h('span',{className:'cl-icon cl-icon-edit'}, '✎'));
      row.appendChild(h('span',{className:'dctl-code'}, item.code));
      row.appendChild(h('span',{className:'dctl-field'}, FIELD_LABELS[item.entry.field]||item.entry.field));
      var fv = String(item.entry.from||''), tv = String(item.entry.to||'');
      var fromLbl = fv===''?'(empty)':fv.length>40?fv.slice(0,40)+'…':fv;
      var toLbl   = tv===''?'(empty)':tv.length>40?tv.slice(0,40)+'…':tv;
      var prev = h('span',{className:'dctl-preview'});
      prev.appendChild(h('span',{className:'ch-from'}, fromLbl));
      prev.appendChild(h('span',{className:'ch-arrow'},'→'));
      prev.appendChild(h('span',{className:'ch-to'}, toLbl));
      row.appendChild(prev);
    }
    wrap.appendChild(row);
  });
  return wrap;
}

function buildDocHistoryContent() {
  var wrap = h('div',{className:'code-history'});

  // Subtabs: Timeline | Compare   +   Fields/JSON toggle aligned with diff pane
  var topModeRow = h('div',{className:'tabs ch-subtabs'});
  var docTabsGroup = h('div',{className:'ch-subtabs-tabs'});
  [['timeline','Timeline'],['compare','Compare']].forEach(function(pair){
    docTabsGroup.appendChild(h('button',{
      className:'tab'+(state.docHistMode===pair[0]?' active':''),
      onClick:function(){
        state.docHistMode = pair[0];
        renderMainPanel();
      },
    }, pair[1]));
  });
  topModeRow.appendChild(docTabsGroup);
  if (state.docHistMode === 'compare') {
    var docTogGroup = h('div',{className:'ch-subtabs-toggle'});
    ['fields','json'].forEach(function(m){
      docTogGroup.appendChild(h('button',{
        className:'ch-toggle-btn'+(state.histDiffMode===m?' active':''),
        onClick:function(){
          state.histDiffMode = m;
          renderMainPanel();
        },
      }, m==='fields'?'Fields':'JSON'));
    });
    topModeRow.appendChild(docTogGroup);
  }
  wrap.appendChild(topModeRow);

  if (state.docHistMode === 'timeline') {
    wrap.appendChild(buildDocTimeline());
    return wrap;
  }

  // ── Compare mode: interactive feed + diff pane ──

  var docHistSel = state.histSel.filter(function(k){ return k.startsWith('doc:') || k.startsWith('snap:') || (k.startsWith('code:') && k.split(':').length===3); });

  // Build unified feed: session edits + structural events + snapshots
  var feed = [];
  state.changelog.forEach(function(ev, i){
    feed.push({ts: ev.ts||'', kind:'doc', docIdx:i, ev:ev});
  });
  if (state.docs.codes) {
    Object.keys(state.docs.codes).forEach(function(code){
      var log = state.docs.codes[code]._log;
      if (!Array.isArray(log)) return;
      log.forEach(function(entry, i){
        feed.push({ts: entry.ts||'', kind:'code', code:code, logIdx:i, entry:entry});
      });
    });
  }
  // Add snapshots — sorted newest first, pinned at top of their timestamp slot
  var snapSnapshots = (state.snapshotsData && state.snapshotsData.snapshots) || [];
  snapSnapshots.forEach(function(v){
    // Use saved timestamp as a sortable ISO string (YYYYMMDD-HHMM → approximate)
    var ts = v.timestamp ? v.timestamp.slice(0,4)+'-'+v.timestamp.slice(4,6)+'-'+v.timestamp.slice(6,8)+'T'+v.timestamp.slice(9,11)+':'+v.timestamp.slice(11,13)+':00' : '';
    feed.push({ts: ts, kind:'snapshot', dir:v.dir, chain:v.chain, timestamp:v.timestamp, hash4:v.hash4, note:v.note});
  });

  if (!feed.length) {
    wrap.appendChild(h('div',{className:'code-history-empty'},
      'No events yet. Open a code and start editing — changes appear here.'));
    return wrap;
  }

  feed.sort(function(a,b){ return b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : 0; });

  // Compute session boundaries for labelling
  var boundaries = getSessionBoundaries();
  var prevSessionLabel = null;

  var listWrap = h('div',{className:'ch-list'});
  var hdrRow = h('div',{className:'ch-list-hdr'});
  hdrRow.appendChild(h('span',{className:'ch-list-hint'},
    docHistSel.length===0 ? 'Click an entry to inspect; click two to diff'
    : docHistSel.length===1 ? 'Click another entry to diff'
    : 'Comparing A (teal) and B (amber)'
  ));
  listWrap.appendChild(hdrRow);

  feed.forEach(function(item){
    // Inject session boundary marker when session changes
    var sessLabel = sessionLabelAtTs(item.ts, boundaries);
    if (sessLabel && sessLabel !== prevSessionLabel) {
      prevSessionLabel = sessLabel;
      var marker = h('div',{className:'ch-session-marker'});
      marker.appendChild(h('span',{className:'ch-session-label'}, sessLabel));
      listWrap.appendChild(marker);
    }

    // Key encodes enough to reconstruct the item
    var key = item.kind==='doc'      ? 'doc:'+item.docIdx
            : item.kind==='snapshot' ? 'snap:'+item.dir
            : 'code:'+item.code+':'+item.logIdx;
    var selPos = docHistSel.indexOf(key);
    var isSel  = selPos !== -1;
    var ord    = selPos + 1;
    var rowStyle2 = isSel ? {background:selBg(ord), borderLeft:'3px solid '+selBar(ord)} : {};

    var row = h('div',{
      className:'ch-entry ch-entry-doc'+(isSel?' ch-entry-sel':''),
      style: rowStyle2,
      onClick:function(){
        // Read current feed-selection keys from state (not stale closure)
        var feedKeys = state.histSel.filter(function(k){
          return k.startsWith('doc:') || k.startsWith('snap:') || (k.startsWith('code:') && k.split(':').length===3);
        });
        var idx = feedKeys.indexOf(key);
        if(idx !== -1) {
          feedKeys.splice(idx, 1);
        } else {
          if(feedKeys.length >= 2) feedKeys.shift();
          feedKeys.push(key);
        }
        // Preserve any per-code History tab keys (code:N format), replace feed keys
        var otherKeys = state.histSel.filter(function(k){
          return !(k.startsWith('doc:') || k.startsWith('snap:') || (k.startsWith('code:') && k.split(':').length===3));
        });
        state.histSel = otherKeys.concat(feedKeys);
        refreshDocHistory();
      },
    });
    row.dataset.key = key;

    var hdrEl = h('div',{className:'ch-entry-hdr'});
    var badgeCls = isSel ? 'ch-sel-badge ch-sel-badge-'+ord : 'ch-sel-badge ch-sel-badge-empty';
    hdrEl.appendChild(h('span',{className:badgeCls}, isSel?selLabel(ord):''));

    var ts = (item.ts||'').slice(0,16).replace('T',' ');

    if(item.kind==='snapshot'){
      hdrEl.appendChild(h('span',{className:'cl-icon cl-icon-save'}, '◈'));
      hdrEl.appendChild(h('span',{className:'ch-ts'}, item.timestamp||''));
      hdrEl.appendChild(h('span',{className:'ch-field'}, item.chain));
      if(item.hash4) hdrEl.appendChild(h('span',{className:'op-row-hash'}, item.hash4));
      row.appendChild(hdrEl);
      if(item.note) row.appendChild(h('div',{className:'ch-preview ch-doc-detail'}, item.note));
    } else if(item.kind==='doc'){
      var icon = {open:'↓', save:'↑', move:'⇄', 'bulk-status':'●'}[item.ev.type] || '·';
      hdrEl.appendChild(h('span',{className:'cl-icon cl-icon-'+(item.ev.type||'other')}, icon));
      hdrEl.appendChild(h('span',{className:'ch-ts'}, ts));
      hdrEl.appendChild(h('span',{className:'ch-field ch-field-doctype'}, item.ev.type));
      row.appendChild(hdrEl);
      row.appendChild(h('div',{className:'ch-preview'},
        h('span',{className:'ch-doc-detail'}, item.ev.detail||'')));
    } else {
      var entry = item.entry;
      hdrEl.appendChild(h('span',{className:'cl-icon cl-icon-edit'}, '✎'));
      hdrEl.appendChild(h('span',{className:'ch-ts'}, ts));
      hdrEl.appendChild(h('span',{className:'ch-field'}, FIELD_LABELS[entry.field]||entry.field));
      hdrEl.appendChild(h('span',{className:'ch-doc-detail'}, ' · '+item.code));
      row.appendChild(hdrEl);
      // Preview: from → to (truncated for display only)
      var fv = entry.from !== undefined ? String(entry.from) : '';
      var tv = entry.to   !== undefined ? String(entry.to)   : '';
      var fromLbl = fv===''?'(empty)':fv.length>50?fv.slice(0,50)+'…':fv;
      var toLbl   = tv===''?'(empty)':tv.length>50?tv.slice(0,50)+'…':tv;
      var prev = h('div',{className:'ch-preview'});
      prev.appendChild(h('span',{className:'ch-from'}, fromLbl));
      prev.appendChild(h('span',{className:'ch-arrow'},'→'));
      prev.appendChild(h('span',{className:'ch-to'}, toLbl));
      row.appendChild(prev);
    }

    listWrap.appendChild(row);
  });
  var docBody = h('div',{className:'ch-body'});
  docBody.appendChild(listWrap);

  var diffPane = h('div',{className:'ch-diff-pane', id:'doc-hist-diff-pane'});
  if(docHistSel.length>=1) diffPane.appendChild(buildDocDiffContent(docHistSel, feed));
  else diffPane.appendChild(h('div',{className:'ch-diff-empty ch-diff-hint'},'Select events to inspect or compare.'));
  docBody.appendChild(diffPane);
  wrap.appendChild(docBody);
  return wrap;
}

function refreshDocHistory() {
  var docHistSel = state.histSel.filter(function(k){
    return k.startsWith('doc:') || k.startsWith('snap:') || (k.startsWith('code:') && k.split(':').length===3);
  });
  document.querySelectorAll('.ch-entry-doc').forEach(function(el){
    var key = el.dataset && el.dataset.key; if(!key) return;
    var selPos = docHistSel.indexOf(key);
    var isSel  = selPos !== -1;
    var ord    = selPos + 1;
    el.classList.toggle('ch-entry-sel', isSel);
    el.style.background = isSel ? selBg(ord)  : '';
    el.style.borderLeft = isSel ? '3px solid '+selBar(ord) : '2px solid transparent';
    var badge = el.querySelector('.ch-sel-badge');
    if(badge){ badge.textContent=isSel?selLabel(ord):''; badge.className=isSel?'ch-sel-badge ch-sel-badge-'+ord:'ch-sel-badge ch-sel-badge-empty'; }
  });
  var hint = document.querySelector('.ch-list-hdr .ch-list-hint');
  if(hint){
    hint.textContent = docHistSel.length===0?'Click an entry to inspect; click two to diff'
                     : docHistSel.length===1?'Click another entry to diff'
                     : 'Comparing A (teal) and B (amber)';
  }
  var pane = document.getElementById('doc-hist-diff-pane');
  if(pane){
    pane.innerHTML='';
    var feed = buildDocFeed();
    if(docHistSel.length>=1) pane.appendChild(buildDocDiffContent(docHistSel, feed));
    else pane.appendChild(h('div',{className:'ch-diff-empty ch-diff-hint'},'Select events to inspect or compare.'));
  }
}

// Build the merged feed (same logic as in buildDocHistoryContent, extracted for reuse)
function buildDocFeed() {
  var feed = [];
  state.changelog.forEach(function(ev, i){
    feed.push({ts:ev.ts||'', kind:'doc', docIdx:i, ev:ev});
  });
  if (state.docs.codes) {
    Object.keys(state.docs.codes).forEach(function(code){
      var log = state.docs.codes[code]._log;
      if (!Array.isArray(log)) return;
      log.forEach(function(entry, i){
        feed.push({ts:entry.ts||'', kind:'code', code:code, logIdx:i, entry:entry});
      });
    });
  }
  // Include snapshots so findItem can locate snap: keys
  var snapSnapshots = (state.snapshotsData && state.snapshotsData.snapshots) || [];
  snapSnapshots.forEach(function(v){
    var ts = v.timestamp ? v.timestamp.slice(0,4)+'-'+v.timestamp.slice(4,6)+'-'+v.timestamp.slice(6,8)+'T'+v.timestamp.slice(9,11)+':'+v.timestamp.slice(11,13)+':00' : '';
    feed.push({ts:ts, kind:'snapshot', dir:v.dir, chain:v.chain, timestamp:v.timestamp, hash4:v.hash4, note:v.note});
  });
  feed.sort(function(a,b){ return b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : 0; });
  return feed;
}

// Full document snapshot at a given wall-clock timestamp.
// Reconstructs every code's field values by replaying each code's _log up to ts,
// and every code's parent by replaying the structural changelog up to ts.
// Returns a plain object keyed by code name, sorted — so diffs are comparable
// regardless of what kind of feed item was selected.
function fullDocSnapshotAtTs(ts) {
  var snap = {};
  var codes = state.docs.codes || {};
  // Build parent map up to ts by replaying changelog
  var parentMap = {};
  treeArr.forEach(function(n){ parentMap[n.name] = n.parent || ''; });
  state.changelog.forEach(function(ev){
    if(ev.ts > ts) return;
    if(ev.type === 'move') {
      var m = ev.detail.match(/^(.+?):\s*(.+?)\s*→\s*(.*)$/);
      if(m) parentMap[m[1].trim()] = m[3].trim()==='root'?'':m[3].trim();
    }
  });
  // Apply treeOverrides that were set before any log (baseline structure)
  // Already folded into parentMap via treeArr defaults; overrides captured above.

  // Build each code's field values up to ts
  treeArr.forEach(function(n){
    var code = n.name;
    var raw  = codes[code];
    var baseline = (raw && raw._baseline) || {};
    var rec = {};
    DOC_FIELDS_ORDER.filter(function(f){return f!=='parent';}).forEach(function(f){
      rec[f] = baseline[f] !== undefined ? String(baseline[f]) : '';
    });
    // Replay _log entries up to ts
    if(raw && Array.isArray(raw._log)){
      raw._log.forEach(function(entry){
        if(entry.ts > ts) return;
        if(entry.field !== 'parent') rec[entry.field] = entry.to !== undefined ? String(entry.to) : '';
      });
    }
    rec.parent = parentMap[code] || '';
    snap[code] = rec;
  });
  return snap;
}

// Get a full-document flat snapshot for any feed item (session event or snapshot)
function buildDocDiffContent(docHistSel, feed) {
  if(!docHistSel.length) return h('div',{});
  var keyA = docHistSel[0];
  var keyB = docHistSel[1] || null;
  var isSingle = !keyB;

  function findItem(key) {
    if(!feed) return null;
    return feed.find(function(item){
      var k = item.kind==='doc'      ? 'doc:'+item.docIdx
            : item.kind==='snapshot' ? 'snap:'+item.dir
            : 'code:'+item.code+':'+item.logIdx;
      return k === key;
    }) || null;
  }

  var itemA = findItem(keyA);
  var itemB = keyB ? findItem(keyB) : null;

  var wrap = h('div',{className:'ch-diff-content'});
  var hdr  = h('div',{className:'ch-diff-hdr'});

  function itemLabel(item) {
    if(!item) return '—';
    var ts = (item.ts||'').slice(0,16).replace('T',' ');
    if(item.kind==='doc') return ts+' '+item.ev.type;
    return ts+' '+item.code+' / '+(FIELD_LABELS[item.entry.field]||item.entry.field);
  }

  if(isSingle){
    hdr.appendChild(h('span',{className:'ch-diff-range'}, itemLabel(itemA)));
    wrap.appendChild(hdr);
    if(!itemA){ wrap.appendChild(h('div',{className:'ch-diff-empty'},'Item not found.')); return wrap; }
    if(itemA.kind==='doc'){
      wrap.appendChild(h('div',{className:'ch-diff-field'},
        h('div',{className:'ch-diff-field-label'},'Event'),
        h('div',{className:'ch-diff-value'}, itemA.ev.type+' — '+(itemA.ev.detail||''))
      ));
      if(itemA.ev.type==='move'){
        // Show full structure at this changelog point
        var ov = overridesRecordAtIdx(itemA.docIdx);
        wrap.appendChild(h('div',{className:'ch-diff-field-label',style:{marginTop:'12px'}},'Tree structure at this point'));
        var pre=h('pre',{className:'ch-json-pre ch-ov-snap'}); pre.textContent=JSON.stringify(ov,null,2); wrap.appendChild(pre);
      }
    } else {
      // Code field edit — show full code record at this log index
      var rawLog  = (state.docs.codes[itemA.code]||{})._log || [];
      var snapshot= (state.docs.codes[itemA.code]||{})._baseline || {};
      wrap.appendChild(h('div',{className:'ch-diff-field'},
        h('div',{className:'ch-diff-field-label'},'Code'),
        h('div',{className:'ch-diff-value'}, itemA.code)
      ));
      wrap.appendChild(h('div',{className:'ch-diff-field'},
        h('div',{className:'ch-diff-field-label'}, FIELD_LABELS[itemA.entry.field]||itemA.entry.field)
      ));
      var fv = itemA.entry.from !== undefined ? String(itemA.entry.from) : '';
      var tv = itemA.entry.to   !== undefined ? String(itemA.entry.to)   : '';
      var bb2=h('div',{className:'ch-diff-before-blk'});
      bb2.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-a'},'Before'));
      bb2.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-del'+(fv===''?' ch-diff-value-empty':'')}, fv===''?'(empty)':fv));
      wrap.appendChild(bb2);
      var ab2=h('div',{className:'ch-diff-after-blk'});
      ab2.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-b'},'After'));
      ab2.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-add'+(tv===''?' ch-diff-value-empty':'')}, tv===''?'(empty)':tv));
      wrap.appendChild(ab2);
    }
    return wrap;
  }

  // Two items selected
  if(!itemA||!itemB){
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'Could not locate both items.')); return wrap;
  }

  // Always sort earlier → later for consistent diff direction
  var tsA2 = itemA.ts || '', tsB2 = itemB.ts || '';
  var earlyItem = tsA2 <= tsB2 ? itemA : itemB;
  var lateItem  = tsA2 <= tsB2 ? itemB : itemA;
  var bothCode  = itemA.kind==='code' && itemB.kind==='code' && itemA.code===itemB.code;

  var earlyLbl = h('span',{className:'ch-hdr-sel ch-hdr-sel-a'}, 'Earlier  '+earlyItem.ts.slice(0,16).replace('T',' '));
  var lateLbl  = h('span',{className:'ch-hdr-sel ch-hdr-sel-b'}, 'Later  '  +lateItem.ts.slice(0,16).replace('T',' '));
  var lblRow   = h('span',{className:'ch-hdr-labels'});
  lblRow.appendChild(earlyLbl);
  lblRow.appendChild(h('span',{className:'ch-hdr-arrow'},'→'));
  lblRow.appendChild(lateLbl);
  hdr.appendChild(lblRow);
  wrap.appendChild(hdr);

  // Get snapshots for both items (handles session events and snapshots)
  function resolveSnap(item) {
    if (item.kind === 'snapshot') {
      // Check cache
      if (!state._snapCache) state._snapCache = {};
      if (state._snapCache[item.dir]) return state._snapCache[item.dir];
      // Trigger async load and show loading message
      fetch(API+'/snapshots/read?dir='+encodeURIComponent(item.dir)).then(function(r){return r.json();}).then(function(d){
        if (!state._snapCache) state._snapCache = {};
        state._snapCache[item.dir] = vdiffCodes({type:'snapshot', codes:d.codes, overrides:d.overrides});
        // Re-render diff pane
        var pane = document.getElementById('doc-hist-diff-pane');
        if (pane) { pane.innerHTML=''; var f2=buildDocFeed(); pane.appendChild(buildDocDiffContent(docHistSel,f2)); }
      }).catch(function(){});
      return null; // not yet loaded
    }
    return fullDocSnapshotAtTs(item.ts);
  }

  if(state.histDiffMode==='json'){
    var snapEJ = resolveSnap(earlyItem);
    var snapLJ = resolveSnap(lateItem);
    if (!snapEJ || !snapLJ) {
      wrap.appendChild(h('div',{className:'ch-diff-empty'},'Loading snapshot…')); return wrap;
    }
    wrap.appendChild(buildDocJsonDiff(JSON.stringify(snapEJ,null,2), JSON.stringify(snapLJ,null,2)));
    return wrap;
  }

  // Fields view — always available; uses full-doc snapshots so works for any pair
  if(bothCode){
    // Same code: precise per-field diff using the code's own _log
    var rawLog2   = (state.docs.codes[itemA.code]||{})._log || [];
    var snapshot2 = (state.docs.codes[itemA.code]||{})._baseline || {};
    var earlyIdx  = itemA.logIdx < itemB.logIdx ? itemA.logIdx : itemB.logIdx;
    var lateIdx   = itemA.logIdx < itemB.logIdx ? itemB.logIdx : itemA.logIdx;
    var recA2 = codeRecordAtIdx(rawLog2, snapshot2, earlyIdx);
    var recB2 = codeRecordAtIdx(rawLog2, snapshot2, lateIdx);
    DOC_FIELDS_ORDER.forEach(function(f){
      var vA=recA2[f]!==undefined?String(recA2[f]):'';
      var vB=recB2[f]!==undefined?String(recB2[f]):'';
      var changed=vA!==vB;
      var frow=h('div',{className:'ch-diff-field'+(changed?'':' ch-diff-field-unchanged')});
      frow.appendChild(h('div',{className:'ch-diff-field-label'+(changed?'':' ch-diff-field-label-unch')},FIELD_LABELS[f]||f));
      if(!changed){
        frow.appendChild(h('div',{className:'ch-diff-value ch-diff-value-unch'+(vA===''?' ch-diff-value-empty':'')},vA===''?'(empty)':vA));
      } else {
        var bb=h('div',{className:'ch-diff-before-blk'});
        bb.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-a'},'Before'));
        bb.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-del'+(vA===''?' ch-diff-value-empty':'')},vA||'(empty)'));
        frow.appendChild(bb);
        var ab=h('div',{className:'ch-diff-after-blk'});
        ab.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-b'},'After'));
        ab.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-add'+(vB===''?' ch-diff-value-empty':'')},vB||'(empty)'));
        frow.appendChild(ab);
      }
      wrap.appendChild(frow);
    });
    return wrap;
  }

  // General case: show per-code changed fields across full-doc snapshots
  var snapAF = resolveSnap(earlyItem);
  var snapBF = resolveSnap(lateItem);
  if (!snapAF || !snapBF) {
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'Loading snapshot…')); return wrap;
  }
  var codesChanged = treeArr.filter(function(n){
    var cA=snapAF[n.name]||{}, cB=snapBF[n.name]||{};
    return DOC_FIELDS_ORDER.some(function(f){ return (cA[f]||'')!==(cB[f]||''); });
  });
  if(!codesChanged.length){
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'No field differences between these events.'));
    return wrap;
  }
  codesChanged.forEach(function(n){
    var cA=snapAF[n.name]||{}, cB=snapBF[n.name]||{};
    var codeSec=h('div',{className:'hist-vdiff-code-sec'});
    codeSec.appendChild(h('div',{className:'hist-vdiff-code-hdr'},n.name));
    DOC_FIELDS_ORDER.forEach(function(f){
      var vA=cA[f]||'', vB=cB[f]||'';
      if(vA===vB) return;
      var frow=h('div',{className:'ch-diff-field'});
      frow.appendChild(h('div',{className:'ch-diff-field-label'},FIELD_LABELS[f]||f));
      var bb=h('div',{className:'ch-diff-before-blk'});
      bb.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-a'},'Before'));
      bb.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-del'+(vA===''?' ch-diff-value-empty':'')},vA||'(empty)'));
      frow.appendChild(bb);
      var ab=h('div',{className:'ch-diff-after-blk'});
      ab.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-b'},'After'));
      ab.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-add'+(vB===''?' ch-diff-value-empty':'')},vB||'(empty)'));
      frow.appendChild(ab);
      codeSec.appendChild(frow);
    });
    wrap.appendChild(codeSec);
  });
  return wrap;
}




// ── Doc tab ───────────────────────────────────────────────────────────────────

function buildDocTab(code) {
  var doc=getDoc(code), effParent=nodeParent(code);
  var wrap=h('div',{});

  function textField(key,label,hint,placeholder,rows){
    var richField = (typeof makeRichField === 'function') ? makeRichField({
      value: doc[key] || '',
      rows: rows || 3,
      placeholder: placeholder,
      onchange: function(v) {
        setDoc(code, key, v);
        scheduleHistCommit(code, key);
      },
    }) : null;
    var ta = richField ? richField._ta : h('textarea',{placeholder:placeholder,rows:rows||3,value:doc[key]||'',
      onInput:function(e){
        setDoc(code,key,e.target.value);
        scheduleHistCommit(code, key);
      },
      onBlur:function(e){
        flushHistCommit(code, key);
      },
    });
    var lbl=h('div',{className:'field-label'},label);
    if(hint) lbl.appendChild(h('span',{className:'field-hint'},hint));
    var fieldEl = richField || ta;
    return h('div',{className:'field'},lbl,fieldEl);
  }

  wrap.appendChild(textField('scope',      'Scope',       'What this code captures and where it ends',        'What does this code cover?',3));
  wrap.appendChild(textField('rationale',  'Rationale',   'Why this code exists; when to apply vs. siblings', 'When to use this? How does it differ from nearby codes?',3));
  wrap.appendChild(textField('usage_notes','Usage notes', 'Edge cases, what to exclude, common confusions',   'What are the tricky cases? What should NOT be coded here?',3));
  wrap.appendChild(textField('provenance', 'History',     'When created, split from, merged with',            'e.g. Split from X in Oct 2025…',2));

  var statusSel=h('select',{
    style:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text)',padding:'5px 8px',fontFamily:'var(--sans)',fontSize:'12px',outline:'none',cursor:'pointer'},
    onChange:function(e){setDoc(code,'status',e.target.value);renderSidebar();},
  });
  ['','active','stub','experimental','deprecated'].forEach(function(s){
    var opt=document.createElement('option'); opt.value=s; opt.textContent=s||'(unset)';
    if((doc.status||'')===s) opt.selected=true;
    statusSel.appendChild(opt);
  });
  wrap.appendChild(h('div',{className:'field'},h('div',{className:'field-label'},'Status'),statusSel));

  return wrap;
}

// ── Examples tab ──────────────────────────────────────────────────────────────

function buildExamplesTab(code) {
  var fetched=state.excerpts[code], pinned=getDoc(code).examples||[], pinnedSet={};
  pinned.forEach(function(p){pinnedSet[p.doc+':'+p.line]=true;});
  var corpus=(fetched||[]).slice(0,20);
  var wrap=h('div',{className:'examples-cols'});

  var left=h('div',{});
  left.appendChild(h('div',{className:'examples-col-title'},'Corpus ('+corpus.length+')'));
  if(fetched===null){
    left.appendChild(h('div',{},h('span',{className:'spinner'}),' Loading…'));
  } else if(!corpus.length){
    left.appendChild(h('div',{className:'dim-note'},'No corpus excerpts.'));
  } else {
    corpus.forEach(function(ex){
      var key=ex.doc+':'+ex.line;
      var card=h('div',{className:'excerpt'+(pinnedSet[key]?' pinned':'')});
      card.appendChild(h('div',{className:'excerpt-meta'},ex.doc+'  L'+ex.line));
      card.appendChild(h('div',{className:'excerpt-text'},ex.text.slice(0,280)));
      if(!pinnedSet[key]){
        card.appendChild(h('div',{className:'excerpt-actions'},h('button',{className:'btn-xs pin',onClick:function(){
          var exs=(getDoc(code).examples||[]).slice(); exs.push({doc:ex.doc,line:ex.line,note:'',text:ex.text});
          setDoc(code,'examples',exs); render();
        }},'+ Pin')));
      } else {
        card.appendChild(h('div',{style:{fontSize:'10px',color:'var(--accent)',marginTop:'4px',fontFamily:'var(--mono)'}},'✓ pinned'));
      }
      left.appendChild(card);
    });
  }

  var right=h('div',{});
  right.appendChild(h('div',{className:'examples-col-title'},'Pinned ('+pinned.length+')'));
  if(!pinned.length) right.appendChild(h('div',{className:'dim-note'},'Pin excerpts from the left.'));
  pinned.forEach(function(ex,i){
    var card=h('div',{className:'excerpt pinned'});
    card.appendChild(h('div',{className:'excerpt-meta'},ex.doc+'  L'+ex.line));
    if(ex.text) card.appendChild(h('div',{className:'excerpt-text'},ex.text.slice(0,280)));
    card.appendChild(h('input',{type:'text',className:'excerpt-note',placeholder:'Why is this canonical?',value:ex.note||'',
      onInput:function(e){var exs=(getDoc(code).examples||[]).slice();exs[i]=Object.assign({},exs[i],{note:e.target.value});setDoc(code,'examples',exs);}
    }));
    card.appendChild(h('div',{className:'excerpt-actions'},h('button',{className:'btn-xs del',onClick:function(){
      var exs=(getDoc(code).examples||[]).slice(); exs.splice(i,1); setDoc(code,'examples',exs); render();
    }},'✕ Remove')));
    right.appendChild(card);
  });
  wrap.appendChild(left); wrap.appendChild(right);
  return wrap;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  if (typeof CODEBOOK_TREE !== "undefined") window._rich_codes = CODEBOOK_TREE.map(function(n){return n.name;});
  LS.migrate();
  initExportSelected();
  ensureEscListener();
  restorePersistedState();
  // Await tree refresh before first render so treeArr reflects current yaml,
  // not the snapshot baked at render time. Prevents ghost rows on load.
  await refreshTreeFromServer(null);
  render();
  // Poll for tree changes every 5 seconds
  setInterval(function() { refreshTreeFromServer(null); }, 5000);

  // Determine which docs file to load
  var sess = LS.getJson('session');
  var savedPath = sess && sess.openedDocsPath;
  var defaultPath = DOCS_CONFIG.scheme_path;

  if (savedPath && savedPath !== defaultPath) {
    // Try to resume from the saved path
    fetch(API+'/docs/load-json?path='+encodeURIComponent(savedPath))
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.error) throw new Error(data.error);
        // Success — load as if the user opened it
        importJson(savedPath);
      })
      .catch(function(err){
        // File not accessible — fall back to default and show a notice
        showStartupNotice(
          'Could not resume from last session (' + savedPath.replace(/.*[\/\\]/,'') + '): ' + (err.message||err) +
          '. Loading default codebook instead.'
        );
        loadDocs();
      });
  } else {
    loadDocs();
  }
}

function showStartupNotice(msg) {
  // Render a dismissible banner above the main content
  var banner = document.createElement('div');
  banner.className = 'startup-notice';
  banner.innerHTML = '<span>' + msg + '</span>';
  var close = document.createElement('button');
  close.textContent = '✕';
  close.className = 'startup-notice-close';
  close.addEventListener('click', function(){ banner.remove(); });
  banner.appendChild(close);
  var root = document.getElementById('qc-scheme-root');
  if (root) root.insertBefore(banner, root.firstChild);
}
if(document.getElementById('qc-scheme-root')) boot();
else document.addEventListener('DOMContentLoaded',boot);
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='hidden'){if(_saveTimer){clearTimeout(_saveTimer);_saveTimer=null;}save();}
});
window.addEventListener('pagehide',function(){
  if(_saveTimer){clearTimeout(_saveTimer);_saveTimer=null;}save();
});

})();