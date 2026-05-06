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
  // Stubs: XX_Label — two-digit prefix, underscore, word-only label, no numeric suffix segment
  return /^\d{2}_[A-Za-z][A-Za-z_]*$/.test(name || '');
}

function getCodeColor(name, opts) {
  var prefix = getCodePrefix(name);
  var color  = (prefix && typeof CODE_COLORS !== 'undefined' && CODE_COLORS[prefix])
    ? CODE_COLORS[prefix]
    : ((typeof CODE_SCHEMA !== 'undefined' && CODE_SCHEMA.default_color) || '#757575');
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


// Attaches to all text inputs and textareas on the page.
// Type @ to trigger; continues capturing until a non-word character or Escape.
// Filters code names by prefix match first, then substring match.
// Arrow keys navigate, Enter/Tab selects, Escape cancels.
// The @ and typed query are replaced by the selected code name.

(function() {

var _ac_codes  = [];   // flat list of code name strings
var _ac_active = null; // { el, atPos, query, dropdown, selectedIdx }

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

  // Find the @ that started the current query
  var atPos = -1;
  for (var i = pos - 1; i >= 0; i--) {
    var ch = val[i];
    if (ch === '@') { atPos = i; break; }
    // Stop if we hit whitespace or a non-word char that isn't part of a code name
    if (/[\s,;()\[\]{}<>]/.test(ch)) break;
  }

  if (atPos === -1) {
    _dismiss();
    return;
  }

  var query = val.slice(atPos + 1, pos);
  _showDropdown(el, atPos, query);
}

function _onKeyDown(e) {
  if (!_ac_active) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _ac_active.selectedIdx = Math.min(
      _ac_active.selectedIdx + 1,
      _ac_active.dropdown.children.length - 1
    );
    _updateSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _ac_active.selectedIdx = Math.max(_ac_active.selectedIdx - 1, 0);
    _updateSelection();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (_ac_active.dropdown.children.length > 0) {
      e.preventDefault();
      _selectItem(_ac_active.selectedIdx);
    } else {
      _dismiss();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    _dismiss();
  }
}

function _onDocClick(e) {
  if (_ac_active && !_ac_active.dropdown.contains(e.target)) {
    _dismiss();
  }
}

function _filter(query) {
  if (!query) return _ac_codes.slice(0, 30);
  var q = query.toLowerCase();
  var prefix = [], sub = [];
  for (var i = 0; i < _ac_codes.length; i++) {
    var name = _ac_codes[i];
    var nl   = name.toLowerCase();
    if (nl.startsWith(q)) prefix.push(name);
    else if (nl.indexOf(q) >= 0) sub.push(name);
  }
  return prefix.concat(sub).slice(0, 30);
}

function _showDropdown(el, atPos, query) {
  // Reuse or create
  if (_ac_active && _ac_active.el === el) {
    _ac_active.atPos = atPos;
    _ac_active.query = query;
  } else {
    _dismiss();
    var dd = document.createElement('div');
    dd.className = 'qc-ac-dropdown';
    document.body.appendChild(dd);
    _ac_active = { el: el, atPos: atPos, query: query, dropdown: dd, selectedIdx: 0 };
  }

  var matches = _filter(query);
  var dd = _ac_active.dropdown;

  if (matches.length === 0) {
    _dismiss();
    return;
  }

  dd.innerHTML = matches.map(function(name, i) {
    var hl = _highlight(name, query);
    return '<div class="qc-ac-item' + (i === 0 ? ' qc-ac-selected' : '') + '" data-idx="' + i + '">' + hl + '</div>';
  }).join('');

  _ac_active.selectedIdx = 0;

  // Wire item clicks
  dd.querySelectorAll('.qc-ac-item').forEach(function(item) {
    item.addEventListener('mousedown', function(e) {
      e.preventDefault();
      _selectItem(parseInt(item.dataset.idx));
    });
  });

  // Position dropdown below cursor
  _positionDropdown(el);
}

function _highlight(name, query) {
  if (!query) return _esc(name);
  var idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return _esc(name);
  return _esc(name.slice(0, idx))
    + '<mark>' + _esc(name.slice(idx, idx + query.length)) + '</mark>'
    + _esc(name.slice(idx + query.length));
}

function _esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _updateSelection() {
  var items = _ac_active.dropdown.querySelectorAll('.qc-ac-item');
  items.forEach(function(item, i) {
    item.classList.toggle('qc-ac-selected', i === _ac_active.selectedIdx);
  });
  var sel = items[_ac_active.selectedIdx];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function _selectItem(idx) {
  if (!_ac_active) return;
  var items = _ac_active.dropdown.querySelectorAll('.qc-ac-item');
  var item  = items[idx];
  if (!item) return;

  var el    = _ac_active.el;
  var atPos = _ac_active.atPos;
  var val   = el.value;
  var pos   = el.selectionStart;

  // Replace @query with the code name
  el.value = val.slice(0, atPos) + item.textContent + val.slice(pos);
  var newPos = atPos + item.textContent.length;
  el.setSelectionRange(newPos, newPos);

  // Trigger change event so frameworks pick up the update
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  _dismiss();
  el.focus();
}

function _positionDropdown(el) {
  var dd   = _ac_active.dropdown;
  var rect = el.getBoundingClientRect();
  var top  = rect.bottom + window.scrollY;
  var left = rect.left   + window.scrollX;

  dd.style.position = 'absolute';
  dd.style.top      = top  + 'px';
  dd.style.left     = left + 'px';
  dd.style.width    = Math.max(220, rect.width) + 'px';
  dd.style.zIndex   = '9999';
}

function _dismiss() {
  if (_ac_active) {
    _ac_active.dropdown.remove();
    _ac_active = null;
  }
}

// Expose globally
window.qcAutocompleteInit = qcAutocompleteInit;

})();
