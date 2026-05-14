// qc-shared.js
// Shared JavaScript utilities for the qc-atelier suite.
// Inlined into each tool's HTML by the Lua filter.

// ── Code colour utilities ─────────────────────────────────────────────────────
// CODE_COLORS and CODE_SCHEMA are injected by each filter from qc-atelier-config.yaml.

function getCodePrefix(name) {
  var m = (name || '').match(/^(\d{2})/);
  return m ? m[1] : null;
}

function isStub(name) {
  if (typeof getDoc === 'function') {
    var doc = getDoc(name);
    if (doc && doc.status === 'stub') return true;
  }
  if (typeof STUB_CODES !== 'undefined' && STUB_CODES.has(name)) return true;
  return /^\d{2}_[A-Za-z][A-Za-z_]*$/.test(name || '');
}

function getCodeColor(name, opts) {
  var prefix = getCodePrefix(name);
  var color  = (prefix && typeof CODE_COLORS !== 'undefined' && CODE_COLORS[prefix])
    ? CODE_COLORS[prefix]
    : null;

  if (!color && typeof CODEBOOK_TREE !== 'undefined') {
    var node = CODEBOOK_TREE.find(function(n) { return n.name === name; });
    while (node && node.parent) {
      var parentPrefix = getCodePrefix(node.parent);
      if (parentPrefix && CODE_COLORS && CODE_COLORS[parentPrefix]) {
        color = CODE_COLORS[parentPrefix];
        break;
      }
      node = CODEBOOK_TREE.find(function(n) { return n.name === node.parent; });
    }
  }

  if (!color) color = (typeof CODE_SCHEMA !== 'undefined' && CODE_SCHEMA.default_color) || '#757575';
  if (opts && opts.desaturate) color = desaturateHex(color, 0.45);
  return color;
}

function desaturateHex(hex, amount) {
  if (!hex || hex.length < 7) return hex;
  var r = parseInt(hex.slice(1,3),16);
  var g = parseInt(hex.slice(3,5),16);
  var b = parseInt(hex.slice(5,7),16);
  var grey = Math.round(0.299*r + 0.587*g + 0.114*b);
  r = Math.round(r + (grey - r) * amount);
  g = Math.round(g + (grey - g) * amount);
  b = Math.round(b + (grey - b) * amount);
  return '#' + [r,g,b].map(function(v){ return ('0'+Math.max(0,Math.min(255,v)).toString(16)).slice(-2); }).join('');
}

function codeDot(name, size) {
  var stub  = isStub(name);
  var color = getCodeColor(name, {desaturate: !stub});
  var dot   = document.createElement('span');
  var s     = size || 8;
  dot.className = 'code-color-dot';
  dot.style.cssText = 'display:inline-block;width:'+s+'px;height:'+s+'px;border-radius:50%;background:'+color+';flex-shrink:0;opacity:'+(stub?'1':'0.75');
  return dot;
}

function codeChip(name, opts) {
  opts = opts || {};
  var stub   = isStub(name);
  var color  = getCodeColor(name, {desaturate: !stub});
  var chip   = document.createElement('span');
  var status = opts.status || '';
  chip.className = 'code-chip' + (stub ? ' stub' : '') + (status === 'deprecated' ? ' deprecated' : '');
  chip.style.borderLeftColor = color;
  chip.title = name;
  var display = name;
  if (opts.truncate && display.length > opts.truncate) display = display.slice(0, opts.truncate) + '\u2026';
  chip.textContent = display;
  return chip;
}

// ── @ Code autocomplete ───────────────────────────────────────────────────────
(function() {

var _ac_codes  = [];
var _ac_active = null;

function qcAutocompleteInit(codeNames) {
  _ac_codes = codeNames || [];
  document.addEventListener('keydown', _onKeyDown, true);
  document.addEventListener('input',   _onInput,   false);
  document.addEventListener('click',   _onDocClick, false);
}

function _isTextField(el) {
  return el && (
    (el.tagName === 'INPUT'    && el.type === 'text') ||
    (el.tagName === 'TEXTAREA')
  );
}

function _onInput(e) {
  var el = e.target;
  if (!_isTextField(el)) return;
  var val = el.value;
  var pos = el.selectionStart;
  var atPos = -1;
  for (var i = pos - 1; i >= 0; i--) {
    var ch = val[i];
    if (ch === '@') { atPos = i; break; }
    if (/[\s,;()\[\]{}<>]/.test(ch)) break;
  }
  if (atPos === -1) { _dismiss(); return; }
  var query = val.slice(atPos + 1, pos);
  if (window._ac_wrap_mode && window._ac_wrap_mode.ta === el && query === '') return;
  _showDropdown(el, atPos, query);
}

function _onKeyDown(e) {
  if (!_ac_active) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _ac_active.selectedIdx = Math.min(_ac_active.selectedIdx + 1, _ac_active.dropdown.children.length - 1);
    _updateSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _ac_active.selectedIdx = Math.max(_ac_active.selectedIdx - 1, 0);
    _updateSelection();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (_ac_active.dropdown.children.length > 0) { e.preventDefault(); _selectItem(_ac_active.selectedIdx); }
    else { _dismiss(); }
  } else if (e.key === 'Escape') {
    e.preventDefault(); _dismiss();
  }
}

function _onDocClick(e) {
  if (_ac_active && !_ac_active.dropdown.contains(e.target)) _dismiss();
}

function _filter(query) {
  var codes = _ac_codes.length > 0 ? _ac_codes : (typeof ALL_CODES !== 'undefined' ? ALL_CODES : []);
  if (window._rich_codes && window._rich_codes.length > 0) codes = window._rich_codes;
  if (!query) return codes.slice(0, 30);
  var q = query.toLowerCase();
  var prefix = [], sub = [];
  for (var i = 0; i < codes.length; i++) {
    var name = codes[i];
    var nl   = name.toLowerCase();
    if (nl.startsWith(q)) prefix.push(name);
    else if (nl.indexOf(q) >= 0) sub.push(name);
  }
  return prefix.concat(sub).slice(0, 30);
}

function _showDropdown(el, atPos, query) {
  if (_ac_active && _ac_active.el === el) {
    _ac_active.atPos = atPos;
    _ac_active.query = query;
  } else {
    _dismiss();
    var dd = document.createElement('div');
    dd.className = 'qc-ac-dropdown';
    document.body.appendChild(dd);
    _ac_active = { el: el, atPos: atPos, query: query, dropdown: dd, selectedIdx: 0 };
    window._qcAcActive = true;
  }
  var matches = _filter(query);
  var dd = _ac_active.dropdown;
  if (matches.length === 0) { _dismiss(); return; }
  dd.innerHTML = matches.map(function(name, i) {
    var color = (typeof getCodeColor === 'function') ? getCodeColor(name, {desaturate: !(typeof isStub==='function'&&isStub(name))}) : '';
    var hl    = _highlight(name, query);
    var style = color ? 'border-left:4px solid '+color+';padding-left:6px;' : '';
    return '<div class="qc-ac-item' + (i === 0 ? ' qc-ac-selected' : '') + '" data-idx="' + i + '" style="' + style + '">' + hl + '</div>';
  }).join('');
  _ac_active.selectedIdx = 0;
  dd.addEventListener('mousedown', function(e) { e.preventDefault(); });
  dd.querySelectorAll('.qc-ac-item').forEach(function(item) {
    item.addEventListener('mousedown', function(e) { e.preventDefault(); _selectItem(parseInt(item.dataset.idx)); });
  });
  _positionDropdown(el);
}

function _highlight(name, query) {
  if (!query) return _esc(name);
  var idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return _esc(name);
  return _esc(name.slice(0, idx)) + '<mark>' + _esc(name.slice(idx, idx + query.length)) + '</mark>' + _esc(name.slice(idx + query.length));
}

function _esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _updateSelection() {
  var items = _ac_active.dropdown.querySelectorAll('.qc-ac-item');
  items.forEach(function(item, i) { item.classList.toggle('qc-ac-selected', i === _ac_active.selectedIdx); });
  var sel = items[_ac_active.selectedIdx];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function _selectItem(idx) {
  if (!_ac_active) return;
  var items = _ac_active.dropdown.querySelectorAll('.qc-ac-item');
  var item  = items[idx];
  if (!item) return;
  var el     = _ac_active.el;
  var val    = el.value;
  var isRich = el.classList.contains('rich-field-raw');
  var markup = isRich ? '[' + item.textContent + ']{.code}' : item.textContent;
  if (window._ac_wrap_mode && window._ac_wrap_mode.ta === el) {
    var wm  = window._ac_wrap_mode;
    el.value = val.slice(0, wm.start) + markup + val.slice(wm.end);
    var newPos = wm.start + markup.length;
    el.setSelectionRange(newPos, newPos);
    window._ac_wrap_mode = null;
  } else {
    var atPos = _ac_active.atPos;
    var pos   = el.selectionStart;
    el.value = val.slice(0, atPos) + markup + val.slice(pos);
    var newPos2 = atPos + markup.length;
    el.setSelectionRange(newPos2, newPos2);
  }
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  _dismiss();
  el.focus();
}

function _positionDropdown(el) {
  var dd   = _ac_active.dropdown;
  var rect = el.getBoundingClientRect();
  var left = rect.left + window.scrollX;
  dd.style.position = 'absolute';
  dd.style.top      = '0px';
  dd.style.left     = left + 'px';
  dd.style.width    = Math.max(220, rect.width) + 'px';
  dd.style.zIndex   = '9999';
  dd.style.visibility = 'hidden';
  var ddH = dd.offsetHeight || 200;
  var top = (rect.bottom + ddH > window.innerHeight)
    ? rect.top + window.scrollY - ddH - 4
    : rect.bottom + window.scrollY + 2;
  dd.style.top        = top + 'px';
  dd.style.visibility = 'visible';
}

function _dismiss() {
  if (_ac_active) {
    _ac_active.dropdown.remove();
    _ac_active = null;
    window._qcAcActive = false;
  }
}

window.qcAutocompleteInit = qcAutocompleteInit;
window._acShowDropdown = _showDropdown;
window._acDismiss      = _dismiss;
Object.defineProperty(window, '_ac_active', { get: function(){ return _ac_active; } });

})();

// ── Code markup ───────────────────────────────────────────────────────────────

function parseCodeMarkup(text) {
  var frag = document.createDocumentFragment();
  var re   = /\[([^\]]+)\]\{\.code\}/g;
  var last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    frag.appendChild(codeChip(m[1], {truncate: 40}));
    last = re.lastIndex;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function makeRichField(opts) {
  opts = opts || {};
  var outer    = document.createElement('div');
  outer.className = 'rich-field-wrap ' + (opts.className || '');
  var rendered = document.createElement('div');
  rendered.className = 'rich-field-rendered';
  rendered.tabIndex  = 0;
  var ta = document.createElement('textarea');
  ta.className   = 'rich-field-raw';
  ta.rows        = opts.rows || 3;
  ta.value       = opts.value || '';
  ta.placeholder = opts.placeholder || '';

  function showRaw() {
    rendered.style.display = 'none';
    ta.style.display       = 'block';
    ta.focus();
  }

  function showRendered() {
    ta.style.display       = 'none';
    rendered.style.display = 'block';
    rendered.innerHTML     = '';
    rendered.appendChild(parseCodeMarkup(ta.value));
  }

  outer.appendChild(rendered);
  outer.appendChild(ta);
  showRendered();

  rendered.addEventListener('focus', showRaw);
  rendered.addEventListener('click', showRaw);
  ta.addEventListener('blur', function() {
    setTimeout(function() {
      if (ta.matches(':focus')) return;
      if (window._qcAcActive || window._ac_wrap_mode) return;
      showRendered();
    }, 300);
  });
  document.addEventListener('mousedown', function(e) {
    if (!outer.contains(e.target) && !document.querySelector('.qc-ac-dropdown')) {
      if (ta.style.display !== 'none') showRendered();
    }
  });
  ta.addEventListener('input',  function() { if (opts.onchange) opts.onchange(ta.value); });
  ta.addEventListener('change', function() { if (opts.onchange) opts.onchange(ta.value); });
  ta.addEventListener('keydown', function(e) {
    if (e.key !== '@') return;
    var selStart = ta.selectionStart;
    var selEnd   = ta.selectionEnd;
    var sel      = ta.value.slice(selStart, selEnd);
    if (sel.length > 0) {
      e.preventDefault();
      window._ac_wrap_mode = { ta: ta, start: selStart, end: selEnd + 1 };
      ta.value = ta.value.slice(0, selStart) + '@' + ta.value.slice(selStart);
      ta.setSelectionRange(selStart + 1, selStart + 1);
      if (window._acShowDropdown) window._acShowDropdown(ta, selStart, sel);
    }
  });
  ta.addEventListener('ac:select', function(e) {
    var name   = e.detail.name;
    var markup = '[' + name + ']{.code}';
    var val    = ta.value;
    if (_ac_wrap_mode && _ac_wrap_mode.ta === ta) {
      var wm = _ac_wrap_mode;
      ta.value = val.slice(0, wm.start) + markup + val.slice(wm.end);
      ta.setSelectionRange(wm.start + markup.length, wm.start + markup.length);
      _ac_wrap_mode = null;
    }
    if (opts.onchange) opts.onchange(ta.value);
  });

  outer.appendChild(rendered);
  outer.appendChild(ta);
  showRendered();

  outer._ta     = ta;
  outer._setVal = function(v) { ta.value = v; showRendered(); };
  outer._getVal = function() { return ta.value; };
  return outer;
}

// ── Theme (dark/light mode) ───────────────────────────────────────────────────
// Standard across all tools: body.dark-mode class (light is default),
// localStorage key 'qca.theme', falls back to prefers-color-scheme.

function qcInitTheme() {
  var saved;
  try { saved = localStorage.getItem('qca.theme'); } catch(e) {}
  var dark = (saved === 'dark') || (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark-mode', dark);
  return dark;
}

function qcToggleTheme() {
  var isDark = document.body.classList.toggle('dark-mode');
  try { localStorage.setItem('qca.theme', isDark ? 'dark' : 'light'); } catch(e) {}
  return isDark;
}

function qcIsDarkMode() {
  return document.body.classList.contains('dark-mode');
}

// ── Snapshot context pill ─────────────────────────────────────────────────────
// Injects a read-only snapshot indicator into the nav/topbar of any tool.
// Shows active snapshot dir (stripped of timestamp prefix), or "HEAD".
// Call after DOM ready: qcSnapshotPill(containerEl, apiBase)

function qcSnapshotPill(containerEl, apiBase) {
  var pill = document.createElement('span');
  pill.className = 'qc-snapshot-pill';
  var label = document.createElement('span');
  label.className = 'qc-snapshot-pill-label is-head';
  label.textContent = 'HEAD';
  pill.appendChild(label);
  containerEl.appendChild(pill);

  var base = apiBase || 'http://localhost:8080';
  fetch(base + '/snapshots/list')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var active = data && data.active_dir;
      if (active) {
        var display = active.replace(/^codebook_\d{8}-\d{4}-?/, '') || active;
        label.textContent = '\uD83D\uDCF7 ' + display;
        label.className = 'qc-snapshot-pill-label is-snapshot';
      } else {
        label.textContent = 'HEAD';
        label.className = 'qc-snapshot-pill-label is-head';
      }
    })
    .catch(function() {});

  return pill;
}