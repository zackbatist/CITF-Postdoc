// qc-codebook-docs.js
// Injected globals: CODEBOOK_TREE, CORPUS_COUNTS, DOCS_DATA, DOCS_CONFIG

(function () {
'use strict';

const API = 'http://localhost:' + (DOCS_CONFIG.server_port || 8080);
const treeArr = Array.isArray(CODEBOOK_TREE) ? CODEBOOK_TREE : Object.values(CODEBOOK_TREE);

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
  exportFormat:   'yaml-qc',  // default
  exportSelected: null,
  statusInclude:  new Set(['active','experimental','deprecated','']),
  treeOverrides:  {},
  dragName:       null,
  dropTarget:     null,
  importOpen:     false,
  importPath:     '',
  importStatus:   '',
  importMsg:      '',
  saveOpen:         false,
  saveAsName:       '',
  tableSort:        {col: null, dir: 1},
  changelog:        [],    // [{ts, type, detail}] — document-level events
  changelogOpen:    false, // topbar changelog panel open
  // History tab state — two selected log entry keys for diff
  histSel:          [],    // up to 2 entry keys (code-level: 'code:N', doc-level: 'doc:N')
  histDiffMode:     'fields', // 'fields' | 'json'
  docHistoryOpen:   false,    // editor shows doc history instead of code editor
  lightMode:        false,
};

// ── Changelog helpers ─────────────────────────────────────────────────────────

function clNow() { return new Date().toISOString(); }

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

function getChildren(name) {
  var ch = _childrenIdx[name]; return ch ? ch.map(function(n){ return treeArr.find(function(x){return x.name===n;}); }).filter(Boolean) : [];
}
function getRoots() {
  return treeArr.filter(function(n){ return !_parentIdx[n.name]; });
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

// Flat visible order for shift-range
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
  if (e.target.closest('.tree-pip-wrap') || e.target.closest('.drag-handle')) return;

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
    // Plain click
    state.multiSelected.clear();
    if (getChildren(name).length) state.expanded[name] = !state.expanded[name];
    if (state.selected !== name) state.histSel = [];  // reset history selection on code change
    state.selected = name;
    state.docHistoryOpen = false;
    state.lastClicked = name;
    state.tab = 'doc';
    render();
    fetchExcerpts(name);
  }
}

function clearMulti() { state.multiSelected.clear(); render(); }

// ── Doc helpers ───────────────────────────────────────────────────────────────

function getDoc(code) { return (state.docs.codes && state.docs.codes[code]) || {}; }

function setDoc(code, field, value) {
  if (!state.docs.codes || Array.isArray(state.docs.codes)) state.docs.codes = {};
  if (!state.docs.codes[code]) state.docs.codes[code] = {};
  // Log only meaningful doc fields, not examples (too noisy)
  if (field !== 'examples') {
    var prev = state.docs.codes[code][field] || '';
    if (prev !== value) clCode(code, field, prev, value);
  }
  state.docs.codes[code][field] = value;
  scheduleSave();
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
      body: JSON.stringify({ path:DOCS_CONFIG.codebook_docs_path, data:state.docs, tree:treeArr, overrides:state.treeOverrides, changelog:state.changelog }),
    });
    if (!res.ok) throw new Error('HTTP '+res.status);
    state.saveStatus = 'saved';
  } catch(e) { console.error('[save]',e); state.saveStatus='error'; }
  refreshSaveIndicator();
}

async function loadDocs() {
  try {
    var res = await fetch(API+'/docs/load?path='+encodeURIComponent(DOCS_CONFIG.codebook_docs_path));
    if (!res.ok) return;
    var data = await res.json();
    if (data.codes) {
      if (!state.docs.codes) state.docs.codes = {};
      Object.keys(data.codes).forEach(function(c){
        state.docs.codes[c] = data.codes[c];  // preserves _log if present
        // Write baseline snapshot if none exists yet
        if (!state.docs.codes[c]._baseline) {
          state.docs.codes[c]._baseline = {
            status:      data.codes[c].status      || '',
            scope:       data.codes[c].scope       || '',
            rationale:   data.codes[c].rationale   || '',
            usage_notes: data.codes[c].usage_notes || '',
            provenance:  data.codes[c].provenance  || '',
            parent:      (data.overrides && data.overrides[c]) || data.codes[c].parent || '',
          };
        }
      });
    }
    if (data.overrides) { Object.assign(state.treeOverrides, data.overrides); rebuildIndices(); }
    // Restore document changelog
    if (Array.isArray(data.changelog)) state.changelog = data.changelog;
    clDoc('open', DOCS_CONFIG.codebook_docs_path.replace(/.*\//, '') + ' (autosave)');
    state.saveStatus = 'saved';
    render();
  } catch(e) {}
}

async function importJson(path) {
  if (!path.trim()) return;
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

    // Restore document changelog and append open event
    if (Array.isArray(data.changelog)) state.changelog = data.changelog;
    var fname = path.trim().replace(/.*\//, '');
    clDoc('open', fname);

    var codeN = Object.keys(state.docs.codes).length;
    var moveN  = Object.keys(state.treeOverrides).length;
    state.saveStatus   = 'unsaved';
    state.importStatus = 'ok';
    state.importMsg    = 'Loaded ' + codeN + ' codes' + (moveN ? ' · ' + moveN + ' moves' : '') + (data.exported ? ' · exported ' + data.exported.slice(0,10) : '');
    state.importOpen   = false;
    scheduleSave();
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
function buildQcYaml(codes) {
  var cs = {}; codes.forEach(function(n){ cs[n.name] = true; });
  var lines = ['# codebook.yaml — qc-compatible export from qc-codebook-docs', ''];
  function walk(name, depth) {
    if (!cs[name]) { (_childrenIdx[name]||[]).forEach(function(c){ walk(c, depth); }); return; }
    var pad = '  '.repeat(depth);
    var children = (_childrenIdx[name]||[]).filter(function(c){ return cs[c]; });
    if (children.length) {
      lines.push(pad + '- ' + name + ':');
      children.forEach(function(c){ walk(c, depth + 1); });
    } else {
      lines.push(pad + '- ' + name);
    }
  }
  getRoots().forEach(function(r){ walk(r.name, 0); });
  return lines.join('\n') + '\n';
}

// Full YAML export — complete documentation fields, hierarchical structure
function buildFullYaml(codes) {
  var cs = {}; codes.forEach(function(n){ cs[n.name] = true; });
  var DOC_FIELDS = ['status','scope','rationale','usage_notes','provenance'];
  var lines = ['# codebook-full.yaml — full documentation export from qc-codebook-docs', ''];

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

  doc.save('qc-codebook-docs-'+tsNow()+'.pdf');
}

function tsNow() {
  return new Date().toISOString().replace(/:/g,'-').slice(0,19);
}

function doExport(codes) {
  var fmt=state.exportFormat;
  var ts = tsNow();
  if (fmt==='pdf')       { buildPdf(codes); return; }
  if (fmt==='yaml-qc')   { download(buildQcYaml(codes),   'codebook-'+ts+'.yaml',           'text/yaml'); return; }
  if (fmt==='yaml-full') { download(buildFullYaml(codes),  'codebook-full-'+ts+'.yaml',      'text/yaml'); return; }
  if (fmt==='md')        { download(buildMd(codes,false),  'qc-codebook-docs-'+ts+'.md',     'text/markdown'); return; }
  if (fmt==='qmd')       { download(buildMd(codes,true),   'qc-codebook-docs-'+ts+'.qmd',    'text/markdown'); return; }
  if (fmt==='html')      { download(buildHtml(codes),      'qc-codebook-docs-'+ts+'.html',   'text/html'); return; }
  if (fmt==='csv')       { download(buildCsv(codes),       'qc-codebook-docs-'+ts+'.csv',    'text/csv'); return; }
}

// Explicit JSON save-as: download the full docs JSON with the given filename.
// This is separate from the autosave (which writes server-side to codebook_docs_path).
function saveJsonAs(name) {
  var fname = (name||'').trim();
  if (!fname) fname = 'qc-codebook-docs-'+tsNow()+'.json';
  if (!fname.endsWith('.json')) fname += '.json';
  download(buildDocsJson(), fname, 'application/json');
}

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

var _escBound = false;
function ensureEscListener() {
  if (_escBound) return;
  _escBound = true;
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && state.multiSelected.size > 0) clearMulti();
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  var root=document.getElementById('qc-codebook-docs-root'); if(!root) return;
  root.innerHTML='';
  var app=h('div',{className:'app'});
  app.appendChild(buildTopbar());
  var split=h('div',{className:'split'});
  split.appendChild(buildSidebar());
  split.appendChild(buildEditor());
  app.appendChild(split);
  root.appendChild(app);
}

function renderTopbar() {
  var tb=document.querySelector('.topbar-wrap,.topbar');
  if(!tb){render();return;}
  tb.parentNode.replaceChild(buildTopbar(),tb);
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
  tree.parentNode.replaceChild(buildTree(),tree);
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
    h('span',{className:'topbar-brand'},'qc-codebook-docs'),
    h('div',{className:'topbar-sep'}),
    h('span',{className:'topbar-stat'},
      treeArr.length+' codes · '+docCount+' documented'+
      (movedCount?' · '+movedCount+' moved':'')+
      (multiN>1?' · '+multiN+' selected':'')
    ),
    h('button',{
      className:'topbar-history-tab'+(state.docHistoryOpen?' active':''),
      title:'Document history',
      onClick:function(){
        state.docHistoryOpen = !state.docHistoryOpen;
        if (state.docHistoryOpen) { state.histSel = []; state.histDiffMode = 'fields'; }
        render();
      },
    }, 'History'),
    h('div',{className:'topbar-space'}),
    h('button',{
      className:'btn topbar-theme-toggle',
      title: state.lightMode ? 'Switch to dark mode' : 'Switch to light mode',
      onClick:function(){
        state.lightMode = !state.lightMode;
        document.body.classList.toggle('light-mode', state.lightMode);
        renderTopbar();
      },
    }, state.lightMode ? '☀' : '☾'),
    multiN>1 ? h('button',{className:'btn',onClick:clearMulti},'Esc  Clear') : null,
    h('span',{className:saveCls}, saveLabel),
    h('button',{
      className:'btn'+(state.importOpen?' active':''),
      title:'Open a JSON documentation file',
      onClick:function(){
        var opening = !state.importOpen;
        state.importOpen    = opening;
        state.saveOpen      = false;
        state.changelogOpen = false;
        state.importStatus  = '';
        state.importMsg     = '';
        renderTopbar();
      },
    },'Open'),
    h('button',{
      className:'btn'+(state.saveOpen?' active':''),
      title:'Save documentation as JSON',
      onClick:function(){
        var opening = !state.saveOpen;
        state.saveOpen      = opening;
        state.importOpen    = false;
        state.changelogOpen = false;
        if (opening) state.saveAsName = 'qc-codebook-docs-'+tsNow()+'.json';
        renderTopbar();
      },
    },'Save JSON')
  );

  var panelEl = null;
  if      (state.importOpen) panelEl = buildOpenPanel();
  else if (state.saveOpen)   panelEl = buildSavePanel();

  if (!panelEl) return bar;
  var wrap = h('div',{className:'topbar-wrap'});
  wrap.appendChild(bar);
  wrap.appendChild(panelEl);
  return wrap;
}

// ── Changelog panel (document-level) ─────────────────────────────────────────

function buildChangelogPanel() {
  var panel = h('div',{className:'cl-panel'});

  var hdr = h('div',{className:'cl-panel-hdr'});
  hdr.appendChild(h('span',{className:'cl-panel-title'},'Document history'));
  hdr.appendChild(h('span',{className:'cl-panel-hint'},
    state.histSel.length === 0 ? 'Click an event to inspect · click a second to diff' :
    state.histSel.length === 1 ? 'Click another event to compare' :
    'Showing diff between selected events'
  ));
  if (state.histSel.length > 0) {
    hdr.appendChild(h('button',{
      className:'btn-xs', style:{marginLeft:'auto'},
      onClick:function(){ state.histSel=[]; renderTopbar(); },
    }, 'Clear'));
  }
  panel.appendChild(hdr);

  if (!state.changelog.length) {
    panel.appendChild(h('div',{className:'cl-empty'},'No events recorded yet.'));
    return panel;
  }

  var body = h('div',{className:'cl-body'});

  // ── Event list ──
  var listCol = h('div',{className:'cl-list-col'});
  var reversed = state.changelog.slice().reverse();
  reversed.forEach(function(ev, ri) {
    var origIdx = state.changelog.length - 1 - ri;
    var key = 'doc:' + origIdx;
    var isSel = state.histSel.indexOf(key) !== -1;
    var selOrder = state.histSel.indexOf(key) + 1; // 0 if not selected
    var row = h('div',{
      className:'cl-row'+(isSel?' cl-row-sel':''),
      onClick:function(){
        var idx = state.histSel.indexOf(key);
        if (idx !== -1) {
          state.histSel.splice(idx, 1);
        } else {
          if (state.histSel.length >= 2) state.histSel.shift();
          state.histSel.push(key);
        }
        // Re-render just the panel
        var old = document.querySelector('.cl-panel');
        if (old) old.parentNode.replaceChild(buildChangelogPanel(), old);
      },
    });
    if (isSel) row.appendChild(h('span',{className:'cl-sel-badge'}, selOrder));
    var ts = ev.ts ? ev.ts.slice(0,16).replace('T',' ') : '';
    var icon = {open:'↓', save:'↑', move:'⇄', 'bulk-status':'●'}[ev.type] || '·';
    row.appendChild(h('span',{className:'cl-icon cl-icon-'+(ev.type||'other')}, icon));
    row.appendChild(h('span',{className:'cl-ts'}, ts));
    row.appendChild(h('span',{className:'cl-detail'}, ev.detail || ev.type));
    listCol.appendChild(row);
  });
  body.appendChild(listCol);

  // ── Diff pane (shown when 2 selected) ──
  if (state.histSel.length === 2) {
    var idxA = parseInt(state.histSel[0].split(':')[1]);
    var idxB = parseInt(state.histSel[1].split(':')[1]);
    var evA  = state.changelog[Math.min(idxA,idxB)];
    var evB  = state.changelog[Math.max(idxA,idxB)];
    body.appendChild(buildDocDiffPane(evA, evB, idxA, idxB));
  }

  panel.appendChild(body);
  return panel;
}

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


// ── Open panel ────────────────────────────────────────────────────────────────

function buildOpenPanel() {
  var panel = h('div',{className:'fp-bar'});

  var inp = h('input',{
    type:'text', className:'fp-bar-input',
    placeholder:'/absolute/path/to/qc-codebook-docs.json',
    value: state.importPath,
    onInput: function(e){ state.importPath = e.target.value; },
  });
  inp.addEventListener('keydown', function(e){
    if (e.key==='Enter')  importJson(state.importPath);
    if (e.key==='Escape') { state.importOpen=false; renderTopbar(); }
  });

  panel.appendChild(h('span',{className:'fp-bar-label'},'Open'));
  panel.appendChild(inp);
  panel.appendChild(h('button',{
    className:'btn primary',
    disabled: state.importStatus==='loading',
    onClick: function(){ importJson(state.importPath); },
  }, state.importStatus==='loading' ? 'Loading…' : 'Open'));
  if (state.importMsg) {
    panel.appendChild(h('span',{
      className:'fp-msg '+(state.importStatus==='error'?'msg-error':'msg-ok'),
    }, state.importMsg));
  }

  setTimeout(function(){
    var i = document.querySelector('.fp-bar-input');
    if (i && !i.value) i.focus();
  }, 0);
  return panel;
}

// ── Save panel ────────────────────────────────────────────────────────────────

function buildSavePanel() {
  var wrap = h('div',{className:'fp-bar-wrap'});
  var bar  = h('div',{className:'fp-bar'});

  var inp = h('input',{
    type:'text', className:'fp-bar-input',
    placeholder:'qc-codebook-docs-'+tsNow()+'.json',
    value: state.saveAsName,
    onInput: function(e){ state.saveAsName = e.target.value; },
  });
  inp.addEventListener('keydown', function(e){
    if (e.key==='Enter')  { saveJsonAs(state.saveAsName); clDoc('save', state.saveAsName); state.saveOpen=false; renderTopbar(); }
    if (e.key==='Escape') { state.saveOpen=false; renderTopbar(); }
  });

  bar.appendChild(h('span',{className:'fp-bar-label'},'Save as'));
  bar.appendChild(inp);
  bar.appendChild(h('button',{
    className:'btn primary',
    onClick:function(){
      saveJsonAs(state.saveAsName);
      clDoc('save', state.saveAsName || 'manual save');
      state.saveOpen = false;
      renderTopbar();
    },
  }, 'Download JSON'));
  wrap.appendChild(bar);
  wrap.appendChild(h('div',{className:'fp-bar-subhint'}, 'Snapshot of all codes, structure, and history'));

  setTimeout(function(){
    var i = document.querySelector('.fp-bar-input'); if (i) { i.focus(); i.select(); }
  }, 0);
  return wrap;
}



// ── Sidebar ───────────────────────────────────────────────────────────────────

function buildSidebar() {
  var panel=h('div',{className:'sidebar'});
  var inp=h('input',{type:'text',placeholder:'Search codes…',value:state.search,
    onInput:function(e){
      state.search=e.target.value;
      var tree=panel.querySelector('.tree'); panel.replaceChild(buildTree(),tree);
      var ep=panel.querySelector('.export-panel'); panel.replaceChild(buildExportPanel(),ep);
    },
  });
  panel.appendChild(h('div',{className:'sidebar-search'},inp));
  panel.appendChild(buildTree());
  panel.appendChild(buildExportPanel());
  return panel;
}

function buildTree() {
  var tree=h('div',{
    className:'tree',
    onDragover:function(e){ if(state.dragName) e.preventDefault(); },
    onDrop:function(e){ e.preventDefault(); }, // fallback; rows handle their own drops
  });
  if(state.search.trim()){
    var q=state.search.toLowerCase();
    treeArr.filter(function(n){return n.name.toLowerCase().indexOf(q)>=0;}).forEach(function(n){tree.appendChild(buildRow(n,0));});
  } else {
    if(state.dragName) tree.appendChild(buildDropZone('__root__'));
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
  var isDragging=state.dragName===node.name;
  var isDropTarget=state.dropTarget===node.name;
  var isMulti=state.multiSelected.has(node.name);
  var isSingle=state.selected===node.name && state.multiSelected.size===0;
  // Dim rows whose status is excluded from export
  var nodeStatus=getDoc(node.name).status||'';
  var isStatusDimmed=!state.statusInclude.has(nodeStatus);

  var rowClass='tree-row'+
    (isSingle?' active':'')+
    (isMulti?' multi-active':'')+
    (isDragging?' dragging':'')+
    (isDropTarget?' drop-target':'')+
    (isStatusDimmed?' status-dimmed':'');

  var row=h('div',{
    className:rowClass,
    onClick:function(e){ e.stopPropagation(); handleRowClick(node.name,e); },
    onDragover:function(e){
      if(!state.dragName||state.dragName===node.name||wouldCycle(state.dragName,node.name)) return;
      e.preventDefault(); e.stopPropagation();
      if(state.dropTarget!==node.name){
        // Remove highlight from previous target without re-render
        if(state.dropTarget){
          var prev=document.querySelector('.tree-row.drop-target');
          if(prev) prev.classList.remove('drop-target');
        }
        state.dropTarget=node.name;
        row.classList.add('drop-target');
      }
    },
    onDragleave:function(e){
      if(e.relatedTarget&&row.contains(e.relatedTarget)) return;
      if(state.dropTarget===node.name){
        state.dropTarget=null;
        row.classList.remove('drop-target');
      }
    },
    onDrop:function(e){
      e.preventDefault();e.stopPropagation();
      if(state.dragName&&state.dragName!==node.name){
        reparent(state.dragName,node.name);
        state.expanded[node.name]=true;
      }
      state.dragName=null;state.dropTarget=null;
      render();
    },
  });

  var handle=h('span',{
    className:'drag-handle', draggable:'true', title:'Drag to move',
    onDragstart:function(e){
      state.dragName=node.name; state.dropTarget=null;
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('text/plain',node.name);
      // Mark the dragging row visually without full re-render
      setTimeout(function(){ row.classList.add('dragging'); },0);
    },
    onDragend:function(){
      row.classList.remove('dragging');
      state.dragName=null; state.dropTarget=null;
      // Only re-render to remove drop-zone; no full rebuild needed if drop didn't happen
      var dz=document.querySelector('.drop-zone');
      if(dz) dz.remove();
    },
  },'⠿');
  row.appendChild(handle);

  for(var i=0;i<depth;i++) row.appendChild(h('span',{className:'tree-indent'}));

  row.appendChild(h('span',{className:'tree-toggle'+(state.expanded[node.name]?' open':'')},hasChildren?'▶':''));

  // Pip: export selector + status ring
  var statusColor={active:'#10b981',experimental:'#f59e0b',deprecated:'#ef4444'}[nodeStatus]||'';
  var innerFill=sel==='none'?'var(--text-faint)':'var(--accent)';
  var innerOpacity=sel==='none'?0.2:sel==='some'?0.5:1;
  var pipWrap=h('span',{
    className:'tree-pip-wrap',
    title:(nodeStatus?nodeStatus+' · ':'')+(sel==='all'?'click to deselect':'click to select'),
    onClick:function(e){e.stopPropagation();toggleSubtree(node.name,sel!=='all');renderSidebar();},
  });
  pipWrap.appendChild(makePipSvg(statusColor?3:4,innerFill,innerOpacity,statusColor?5.5:0,statusColor,sel==='none'?0.3:0.85));
  row.appendChild(pipWrap);

  var nameSpan = h('span',{className:'tree-name',title:node.name},node.name);
  row.appendChild(nameSpan);

  // Subtle undoc indicator: faint dot after name when no documentation at all
  var docMissing = !hasDoc(node.name);
  if (docMissing) {
    row.appendChild(h('span',{
      className:'tree-undoc-dot',
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
  rightGroup.appendChild(h('span',{
    className:'moved-badge',
    title: node.name in state.treeOverrides ? 'Moved from original position' : '',
    style: {visibility: node.name in state.treeOverrides ? 'visible' : 'hidden'},
  },'↕'));
  row.appendChild(rightGroup);

  return row;
}

function buildDropZone(target) {
  var zone = h('div',{
    className:'drop-zone',
    onDragover:function(e){
      if(!state.dragName) return; e.preventDefault();
      if(state.dropTarget!==target){
        if(state.dropTarget){
          var prev=document.querySelector('.tree-row.drop-target');
          if(prev) prev.classList.remove('drop-target');
        }
        state.dropTarget=target;
        zone.classList.add('active');
      }
    },
    onDragleave:function(e){
      if(e.relatedTarget&&zone.contains(e.relatedTarget)) return;
      if(state.dropTarget===target){ state.dropTarget=null; zone.classList.remove('active'); }
    },
    onDrop:function(e){
      e.preventDefault();
      if(state.dragName) reparent(state.dragName,'');
      state.dragName=null;state.dropTarget=null;
      render();
    },
  },'↑ Make root');
  return zone;
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
    ['yaml-qc',   'YAML·qc',   'qc-compatible bare list (structure only)'],
    ['yaml-full', 'YAML·full', 'Full YAML with all documentation fields'],
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
  panel.appendChild(fmtRow);

  var actRow=h('div',{className:'export-panel-action'});
  actRow.appendChild(h('span',{className:'export-panel-count'},codes.length+' selected · '+docN+' documented'));
  // Human-readable label for the button
  var fmtLabel = {'yaml-qc':'YAML (qc)', 'yaml-full':'YAML (full)', 'md':'MD', 'qmd':'QMD', 'html':'HTML', 'csv':'CSV', 'pdf':'PDF'}[fmt]||fmt.toUpperCase();
  var dlBtn=h('button',{
    className:'btn primary ep-download-btn'+(state.saveStatus!=='saved'?' ep-unsaved':'')+(state.saveStatus==='error'?' ep-error':''),
    disabled:!codes.length,
    onClick:function(){doExport(getExportCodes());}
  }, 'Export '+fmtLabel);
  actRow.appendChild(dlBtn);
  panel.appendChild(actRow);
  return panel;
}

function buildEditor() {
  var multiN=state.multiSelected.size;
  if (multiN > 1) return buildMultiEditor(Array.from(state.multiSelected));

  if (state.docHistoryOpen) {
    return buildDocHistoryEditor();
  }

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
    h('div',{className:'editor-code-name'},code),
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
  ['','active','experimental','deprecated'].forEach(function(s){
    var opt=document.createElement('option'); opt.value=s; opt.textContent='→ '+(s||'unset');
    statusSel.appendChild(opt);
  });

  toolbar.appendChild(h('span',{className:'multi-toolbar-label'},'Status'));
  toolbar.appendChild(statusSel);
  toolbar.appendChild(h('span',{className:'multi-toolbar-sep'}));

  // Bulk parent — only offer parents that are safe for ALL selected codes
  var safeParents=treeArr.filter(function(n){
    if(codes.indexOf(n.name)!==-1) return false; // can't parent to self
    return codes.every(function(c){ return !wouldCycle(c, n.name); });
  });
  var currentParents=new Set(codes.map(function(c){return nodeParent(c);}));
  var commonParent=currentParents.size===1?Array.from(currentParents)[0]:null;

  var parentSel=h('select',{
    style:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text)',padding:'4px 6px',fontFamily:'var(--sans)',fontSize:'11px',outline:'none',cursor:'pointer'},
    onChange:function(e){
      var val=e.target.value;
      if(val==='__keep__') return;
      codes.forEach(function(c){ reparent(c, val); });
      renderTopbar(); renderSidebar();
      // Rebuild toolbar to reflect new common parent
      var tb=document.querySelector('.multi-toolbar');
      if(tb) { var newTb=buildMultiToolbar(codes); tb.parentNode.replaceChild(newTb,tb); }
    },
  });
  var keepParentOpt=document.createElement('option'); keepParentOpt.value='__keep__';
  keepParentOpt.textContent=commonParent!==null?(commonParent||'(root)'):'(mixed)';
  parentSel.appendChild(keepParentOpt);
  var rootP=document.createElement('option'); rootP.value=''; rootP.textContent='→ (root)';
  parentSel.appendChild(rootP);
  safeParents.forEach(function(n){
    var opt=document.createElement('option'); opt.value=n.name; opt.textContent='→ '+n.name;
    parentSel.appendChild(opt);
  });

  toolbar.appendChild(h('span',{className:'multi-toolbar-label'},'Parent'));
  toolbar.appendChild(parentSel);
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
  return state.multiView==='table' ? buildTableView(codes) : buildCardsView(codes);
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
    if(!hasDoc(code)) card.appendChild(h('div',{className:'multi-card-empty'},'no documentation yet'));
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

// ── Code history tab ──────────────────────────────────────────────────────────

function buildCodeHistoryTab(code) {
  var wrap = h('div',{className:'code-history'});
  var rawLog   = getDoc(code)._log || [];
  var snapshot = getDoc(code)._baseline || {};

  var listWrap = h('div',{className:'ch-list'});
  var codeHistSel = state.histSel.filter(function(k){return k.startsWith('code:');});

  var hdrRow = h('div',{className:'ch-list-hdr'});
  hdrRow.appendChild(h('span',{className:'ch-list-hint'},
    codeHistSel.length===0 ? 'Click a version to inspect; click two to compare'
    : codeHistSel.length===1 ? 'Click another version to compare'
    : 'Comparing A (teal) and B (amber)'
  ));
  listWrap.appendChild(hdrRow);

  // Newest log entries first; snapshot (initial load) at bottom
  for(var ri = rawLog.length-1; ri >= 0; ri--){
    listWrap.appendChild(buildCodeHistoryRow(code, rawLog, snapshot, ri, codeHistSel));
  }
  listWrap.appendChild(buildCodeHistoryRow(code, rawLog, snapshot, -1, codeHistSel));
  wrap.appendChild(listWrap);

  var paneId = 'ch-diff-pane-'+code.replace(/\W/g,'_');
  var diffPane = h('div',{className:'ch-diff-pane', id:paneId});
  if(codeHistSel.length >= 1){
    diffPane.appendChild(buildCodeDiffContent(code, rawLog, snapshot));
  } else {
    diffPane.appendChild(h('div',{className:'ch-diff-empty ch-diff-hint'},'Select a version on the left to inspect it.'));
  }
  wrap.appendChild(diffPane);
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
    hdr.appendChild(h('span',{className:'ch-field ch-field-snapshot'}, 'state when first loaded'));
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
  var hint = document.querySelector('.ch-list-hdr .ch-list-hint');
  if(hint){
    hint.textContent = codeHistSel.length===0 ? 'Click a version to inspect; click two to compare'
                     : codeHistSel.length===1  ? 'Click another version to compare'
                     : 'Comparing A (teal) and B (amber)';
  }
  var paneId = 'ch-diff-pane-'+code.replace(/\W/g,'_');
  var pane = document.getElementById(paneId);
  if(pane){
    pane.innerHTML='';
    if(codeHistSel.length>=1) pane.appendChild(buildCodeDiffContent(code,rawLog,snapshot));
    else pane.appendChild(h('div',{className:'ch-diff-empty ch-diff-hint'},'Select a version on the left to inspect it.'));
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
    var toggle = h('div',{className:'ch-diff-toggle'});
    ['fields','json'].forEach(function(m){
      toggle.appendChild(h('button',{
        className:'ch-toggle-btn'+(state.histDiffMode===m?' active':''),
        onClick:function(){
          state.histDiffMode=m;
          var paneId='ch-diff-pane-'+code.replace(/\W/g,'_');
          var pane=document.getElementById(paneId);
          if(pane){pane.innerHTML='';pane.appendChild(buildCodeDiffContent(code,rawLog,snapshot));}
        },
      }, m==='fields'?'Fields':'JSON'));
    });
    hdr.appendChild(toggle);
  }
  wrap.appendChild(hdr);

  // Single version — show full record
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

  // Two-version: JSON view
  if(state.histDiffMode==='json'){
    wrap.appendChild(buildCodeJsonDiff(JSON.stringify(recA,null,2), JSON.stringify(recB,null,2)));
    return wrap;
  }

  // Two-version: Fields view — ALL fields, changed ones get before/after blocks
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

function buildDocHistoryEditor() {
  var editor = h('div',{className:'editor'});
  editor.appendChild(h('div',{className:'editor-header'},
    h('div',{className:'editor-code-name'},'Document history'),
    h('div',{className:'editor-code-meta'},'Document-level events: opens, saves, and code moves. Field edits are recorded in each code\'s own History tab.')
  ));
  var body = h('div',{className:'editor-body'});
  body.appendChild(buildDocHistoryContent());
  editor.appendChild(body);
  return editor;
}

function buildDocHistoryContent() {
  var wrap = h('div',{className:'code-history'});
  var docHistSel = state.histSel.filter(function(k){return k.startsWith('doc:');});

  // Build unified feed: structural changelog events + all per-code _log entries
  // Each entry: {ts, kind:'doc'|'code', docIdx (for kind=doc), code, logIdx (for kind=code), ev/entry}
  var feed = [];

  // Structural events
  state.changelog.forEach(function(ev, i){
    feed.push({ts: ev.ts||'', kind:'doc', docIdx:i, ev:ev});
  });

  // Per-code field edits from every code's _log
  if (state.docs.codes) {
    Object.keys(state.docs.codes).forEach(function(code){
      var log = state.docs.codes[code]._log;
      if (!Array.isArray(log)) return;
      log.forEach(function(entry, i){
        feed.push({ts: entry.ts||'', kind:'code', code:code, logIdx:i, entry:entry});
      });
    });
  }

  if (!feed.length) {
    wrap.appendChild(h('div',{className:'code-history-empty'},
      'No events yet. Open a code and start editing — changes appear here.'));
    return wrap;
  }

  // Sort newest first
  feed.sort(function(a,b){ return b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : 0; });

  var listWrap = h('div',{className:'ch-list'});
  var hdrRow = h('div',{className:'ch-list-hdr'});
  hdrRow.appendChild(h('span',{className:'ch-list-hint'},
    docHistSel.length===0 ? 'Click an event to inspect; click two to compare'
    : docHistSel.length===1 ? 'Click another event to compare'
    : 'Comparing A (teal) and B (amber)'
  ));
  listWrap.appendChild(hdrRow);

  feed.forEach(function(item){
    // Key encodes enough to reconstruct the item
    var key = item.kind==='doc'
      ? 'doc:'+item.docIdx
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
          return k.startsWith('doc:') || (k.startsWith('code:') && k.split(':').length===3);
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
          return !(k.startsWith('doc:') || (k.startsWith('code:') && k.split(':').length===3));
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

    if(item.kind==='doc'){
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
  wrap.appendChild(listWrap);

  var diffPane = h('div',{className:'ch-diff-pane', id:'doc-hist-diff-pane'});
  if(docHistSel.length>=1) diffPane.appendChild(buildDocDiffContent(docHistSel, feed));
  else diffPane.appendChild(h('div',{className:'ch-diff-empty ch-diff-hint'},'Select events to inspect or compare.'));
  wrap.appendChild(diffPane);
  return wrap;
}

function refreshDocHistory() {
  var docHistSel = state.histSel.filter(function(k){
    return k.startsWith('doc:') || (k.startsWith('code:') && k.split(':').length===3);
  });
  // also re-read for the hint update below
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
    hint.textContent = docHistSel.length===0?'Click an event to inspect; click two to compare'
                     : docHistSel.length===1?'Click another event to compare'
                     : 'Comparing A (teal) and B (amber)';
  }
  var pane = document.getElementById('doc-hist-diff-pane');
  if(pane){
    pane.innerHTML='';
    // Rebuild feed for diff (needed to locate items)
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

function buildDocDiffContent(docHistSel, feed) {
  if(!docHistSel.length) return h('div',{});
  var keyA = docHistSel[0];
  var keyB = docHistSel[1] || null;
  var isSingle = !keyB;

  function findItem(key) {
    if(!feed) return null;
    return feed.find(function(item){
      var k = item.kind==='doc' ? 'doc:'+item.docIdx : 'code:'+item.code+':'+item.logIdx;
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

  // Always show earlier → later regardless of click order
  var tsA2 = itemA.ts || '', tsB2 = itemB.ts || '';
  var earlyItem = tsA2 <= tsB2 ? itemA : itemB;
  var lateItem  = tsA2 <= tsB2 ? itemB : itemA;
  var earlyLbl=h('span',{className:'ch-hdr-sel ch-hdr-sel-a'}, 'Earlier  '+earlyItem.ts.slice(0,16).replace('T',' '));
  var lateLbl =h('span',{className:'ch-hdr-sel ch-hdr-sel-b'}, 'Later  ' +lateItem.ts.slice(0,16).replace('T',' '));
  var lblRow=h('span',{className:'ch-hdr-labels'});
  lblRow.appendChild(earlyLbl); lblRow.appendChild(h('span',{className:'ch-hdr-arrow'},'→')); lblRow.appendChild(lateLbl);
  hdr.appendChild(lblRow);

  var bothCode = itemA.kind==='code' && itemB.kind==='code' && itemA.code===itemB.code;
  var bothDoc  = itemA.kind==='doc'  && itemB.kind==='doc';

  // Fields toggle only when same-kind; JSON always available
  var modes = (bothCode || bothDoc) ? ['fields','json'] : ['json'];
  if(state.histDiffMode==='fields' && modes.indexOf('fields')===-1) state.histDiffMode='json';
  var toggle=h('div',{className:'ch-diff-toggle'});
  modes.forEach(function(m){
    toggle.appendChild(h('button',{
      className:'ch-toggle-btn'+(state.histDiffMode===m?' active':''),
      onClick:function(){
        state.histDiffMode=m;
        var pane=document.getElementById('doc-hist-diff-pane');
        if(pane){pane.innerHTML=''; var f2=buildDocFeed(); pane.appendChild(buildDocDiffContent(docHistSel,f2));}
      },
    }, m==='fields'?'Fields':'JSON'));
  });
  hdr.appendChild(toggle);
  wrap.appendChild(hdr);

  // JSON diff — always possible; build full-document snapshots at each item's timestamp
  // so the two sides are always structurally comparable regardless of event type.
  if(state.histDiffMode==='json' || (!bothCode && !bothDoc)){
    // Sort by timestamp so earlier is always the "before" side
    var tsA2 = itemA.ts || '', tsB2 = itemB.ts || '';
    var earlyItem = tsA2 <= tsB2 ? itemA : itemB;
    var lateItem  = tsA2 <= tsB2 ? itemB : itemA;
    var snapEarly = fullDocSnapshotAtTs(earlyItem.ts);
    var snapLate  = fullDocSnapshotAtTs(lateItem.ts);
    wrap.appendChild(buildDocJsonDiff(JSON.stringify(snapEarly,null,2), JSON.stringify(snapLate,null,2)));
    return wrap;
  }

  // Fields diff — same code
  if(bothCode){
    var rawLog2  = (state.docs.codes[itemA.code]||{})._log || [];
    var snapshot2= (state.docs.codes[itemA.code]||{})._baseline || {};
    var earlyIdx = itemA.logIdx < itemB.logIdx ? itemA.logIdx : itemB.logIdx;
    var lateIdx  = itemA.logIdx < itemB.logIdx ? itemB.logIdx : itemA.logIdx;
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
        var bb3=h('div',{className:'ch-diff-before-blk'});
        bb3.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-a'},'A — before'));
        bb3.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-del'+(vA===''?' ch-diff-value-empty':'')},vA===''?'(empty)':vA));
        frow.appendChild(bb3);
        var ab3=h('div',{className:'ch-diff-after-blk'});
        ab3.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-b'},'B — after'));
        ab3.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-add'+(vB===''?' ch-diff-value-empty':'')},vB===''?'(empty)':vB));
        frow.appendChild(ab3);
      }
      wrap.appendChild(frow);
    });
    return wrap;
  }

  // Fields diff — same doc (structural changes)
  var loD = earlyItem.docIdx !== undefined ? earlyItem.docIdx : (itemA.docIdx < itemB.docIdx ? itemA.docIdx : itemB.docIdx);
  var hiD = lateItem.docIdx  !== undefined ? lateItem.docIdx  : (itemA.docIdx < itemB.docIdx ? itemB.docIdx : itemA.docIdx);
  var ovA2=overridesRecordAtIdx(loD), ovB2=overridesRecordAtIdx(hiD);
  var changed3=[];
  var allC=new Set(Object.keys(ovA2).concat(Object.keys(ovB2)));
  allC.forEach(function(k){
    var vA=ovA2[k]||'(root)', vB=ovB2[k]||'(root)';
    if(vA!==vB) changed3.push({code:k,from:vA,to:vB});
  });
  if(!changed3.length){
    wrap.appendChild(h('div',{className:'ch-diff-empty'},'No structural changes between these events.'));
  } else {
    changed3.forEach(function(c){
      var fr=h('div',{className:'ch-diff-field'});
      fr.appendChild(h('div',{className:'ch-diff-field-label'},c.code));
      var bb4=h('div',{className:'ch-diff-before-blk'});
      bb4.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-a'},'A'));
      bb4.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-del'},c.from));
      fr.appendChild(bb4);
      var ab4=h('div',{className:'ch-diff-after-blk'});
      ab4.appendChild(h('div',{className:'ch-diff-blk-label ch-blk-label-b'},'B'));
      ab4.appendChild(h('div',{className:'ch-diff-blk-val ch-diff-blk-add'},c.to));
      fr.appendChild(ab4);
      wrap.appendChild(fr);
    });
  }
  return wrap;
}




// ── Doc tab ───────────────────────────────────────────────────────────────────

function buildDocTab(code) {
  var doc=getDoc(code), effParent=nodeParent(code);
  var wrap=h('div',{});

  function textField(key,label,hint,placeholder,rows){
    var ta=h('textarea',{placeholder:placeholder,rows:rows||3,value:doc[key]||'',
      onInput:function(e){ setDoc(code,key,e.target.value); },
    });
    var lbl=h('div',{className:'field-label'},label);
    if(hint) lbl.appendChild(h('span',{className:'field-hint'},hint));
    return h('div',{className:'field'},lbl,ta);
  }

  wrap.appendChild(textField('scope',      'Scope',       'What this code captures and where it ends',        'What does this code cover?',3));
  wrap.appendChild(textField('rationale',  'Rationale',   'Why this code exists; when to apply vs. siblings', 'When to use this? How does it differ from nearby codes?',3));
  wrap.appendChild(textField('usage_notes','Usage notes', 'Edge cases, what to exclude, common confusions',   'What are the tricky cases? What should NOT be coded here?',3));
  wrap.appendChild(textField('provenance', 'History',     'When created, split from, merged with',            'e.g. Split from X in Oct 2025…',2));

  var statusSel=h('select',{
    style:{background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text)',padding:'5px 8px',fontFamily:'var(--sans)',fontSize:'12px',outline:'none',cursor:'pointer'},
    onChange:function(e){setDoc(code,'status',e.target.value);renderSidebar();},
  });
  ['','active','experimental','deprecated'].forEach(function(s){
    var opt=document.createElement('option'); opt.value=s; opt.textContent=s||'(unset)';
    if((doc.status||'')===s) opt.selected=true;
    statusSel.appendChild(opt);
  });
  wrap.appendChild(h('div',{className:'field'},h('div',{className:'field-label'},'Status'),statusSel));

  // Parent selector — compact width
  var moveWrap=h('div',{className:'field'});
  moveWrap.appendChild(h('div',{className:'field-label'},'Parent'));
  var parentSel=h('select',{
    className:'parent-sel',
    onChange:function(e){
      var newP=e.target.value;
      if(!reparent(code,newP)) e.target.value=effParent;
      else renderSidebar();
    },
  });
  var rootOpt=document.createElement('option'); rootOpt.value=''; rootOpt.textContent='(root)';
  if(!effParent) rootOpt.selected=true;
  parentSel.appendChild(rootOpt);
  treeArr.forEach(function(n){
    if(n.name===code||wouldCycle(code,n.name)) return;
    var opt=document.createElement('option'); opt.value=n.name; opt.textContent=n.name;
    if(n.name===effParent) opt.selected=true;
    parentSel.appendChild(opt);
  });
  moveWrap.appendChild(parentSel);
  wrap.appendChild(moveWrap);
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

function boot(){ initExportSelected(); ensureEscListener(); render(); loadDocs(); }
if(document.getElementById('qc-codebook-docs-root')) boot();
else document.addEventListener('DOMContentLoaded',boot);

})();
