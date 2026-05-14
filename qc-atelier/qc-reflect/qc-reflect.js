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

// Detect stubs: XX_Label pattern
function isStub(name) {
  return /^\d{2}_[A-Za-z][A-Za-z_]*$/.test(name || '');
}

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
  var codes = state.selectedCodes.filter(function(c){return !isStub(c.name);});
  if (codes.length === 0) { setProgress('No non-stub codes selected.'); return; }
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
    data:    reportData,
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
  var secs    = elapsed ? Math.round(elapsed / 1000) : 0;
  var mins    = Math.floor(secs / 60);
  var timeStr = mins > 0 ? mins + 'm ' + (secs%60) + 's' : secs + 's';
  var L = [];
  function push() { for (var i=0;i<arguments.length;i++) L.push(arguments[i]); }
  function prefixClass(name) { var m=name.match(/^(\d{2})/); return m?'code-chip .prefix-'+m[1]:'code-chip'; }
  function codeSpan(name) { return '['+name+']{.'+prefixClass(name)+'}'; }
  function markCodes(text) { return (text||'').replace(/\b(\d{2}_\w+)/g,function(n){return codeSpan(n);}); }
  function passageBlock(p) { return '> ['+p.doc+':'+p.line+']{.citation} '+(p.text||''); }
  function escText(s) { return (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
  function uid(parts) { return parts.map(function(p){return String(p).replace(/[^a-z0-9]/gi,'');}).join('').toLowerCase(); }

  var cc  = data.cross_code || {};
  var nNew = (cc.new_codes||[]).length;
  var nRed = (cc.redundancies||[]).length;
  var nTen = (cc.tensions||[]).length;

  // Front matter
  push('---','title: "QC Reflect \u2014 '+codeNames.join(', ')+'"',
    'date: "'+ts.slice(0,10)+'"','format:','  html:','    theme: cosmo',
    '    toc: true','    toc-depth: 2','    toc-location: left',
    '    smooth-scroll: true','    css: qc-reflect-report.css','---','');

  // Methods note
  push('::: {.callout-note collapse="true"}','## Methods note','',
    '**Codes analysed:** '+codeNames.map(codeSpan).join(', '),'',
    '**Generated:** '+ts.replace('T',' ').slice(0,16)+(elapsed?' \u00b7 '+timeStr:'')+' \u00b7 '+(REFLECT_CONFIG.ollama_model||'unknown')+' \u00b7 '+DOC_NAMES.length+' documents','',
    '**Companion:** [Abridged \u2192](abridged.html)',':::','');

  // OJS state
  push('```{ojs}','//| echo: false',
    'reportData = ('+JSON.stringify(data)+')',
    'mutable removals = []',
    'mutable newCodeEdits = reportData.cross_code.new_codes.map(nc => ({...nc, selected: false, passageSelections: nc.passages.map(() => false)}))',
    'mutable executed = false','mutable executing = false','mutable executeResult = null',
    '```','');

  // ── 1. Per-code analysis (tabset) ──────────────────────────────────────────
  push('## Per-code analysis','','::: {.panel-tabset}','');
  (data.per_code||[]).forEach(function(code) {
    push('### `'+code.name+'`','',markCodes(code.summary||''),'');
    if (code.misapplications && code.misapplications.length > 0) {
      push('**'+code.misapplications.length+' misapplication'+(code.misapplications.length!==1?'s':'')+' identified:**','');
      code.misapplications.forEach(function(m) {
        var id = uid([m.doc,m.line,code.name]);
        push('::: {.callout-warning}',
          '## ['+m.doc+':'+m.line+']{.citation}','',
          '> '+(m.text||''),'',markCodes(m.explanation||''),'',
          '```{ojs}','//| echo: false',
          'viewof remove_'+id+' = {',
          '  const row = document.createElement("div"); row.className = "action-check-row";',
          '  const cb = Object.assign(document.createElement("input"), {type:"checkbox"});',
          '  const lbl = Object.assign(document.createElement("label"), {textContent:"Remove this code from this passage"});',
          '  row.appendChild(cb); row.appendChild(lbl); row.value = false;',
          '  cb.addEventListener("change", () => { row.value = cb.checked; row.dispatchEvent(new Event("input")); });',
          '  return row;','}','```','',
          '```{ojs}','//| echo: false','{',
          '  const key = {doc:"'+m.doc+'",line:'+m.line+',code:"'+code.name+'"};',
          '  if (remove_'+id+') mutable removals = [...new Map([...removals,key].map(r=>[r.doc+":"+r.line+":"+r.code,r])).values()];',
          '  else mutable removals = removals.filter(r=>!(r.doc===key.doc&&r.line===key.line&&r.code===key.code));',
          '  return html`<span></span>`;',
          '}','```',':::','');
      });
    } else { push('*No misapplications identified.*',''); }
  });
  push(':::','');

  // ── 2. Cross-code observations ─────────────────────────────────────────────
  push('## Cross-code observations','');
  if (nRed > 0) {
    push('### Redundancies','');
    (cc.redundancies||[]).forEach(function(r) {
      push('**'+(r.codes||[]).map(codeSpan).join(' \u00d7 ')+'**','',markCodes(r.explanation||''),'');
      (r.passages||[]).forEach(function(p){push(passageBlock(p),'');});
    });
  }
  if (nTen > 0) {
    push('### Tensions','');
    (cc.tensions||[]).forEach(function(t) {
      push('**'+(t.codes||[]).map(codeSpan).join(' \u00d7 ')+'**','',markCodes(t.explanation||''),'');
      (t.passages||[]).forEach(function(p){push(passageBlock(p),'');});
    });
  }

  // ── 3. Suggested new codes ─────────────────────────────────────────────────
  if (nNew > 0) {
    push('## Suggested new codes','');
    (cc.new_codes||[]).forEach(function(nc, ncIdx) {
      push('::: {.callout-tip}','## '+nc.name,'',
        '**Rationale:** '+(nc.rationale||''),'','**Scope:**','',
        '```{ojs}','//| echo: false',
        'viewof scope_nc'+ncIdx+' = {',
        '  const ta = Object.assign(document.createElement("textarea"), {className:"code-doc-input",rows:2,value:newCodeEdits['+ncIdx+'].scope});',
        '  ta.addEventListener("input", () => { mutable newCodeEdits = newCodeEdits.map((e,j) => j==='+ncIdx+' ? {...e,scope:ta.value} : e); });',
        '  return ta;','}','```','');
      if (nc.passages && nc.passages.length > 0) {
        push('**Supporting passages \u2014 select to apply this code:**','');
        nc.passages.forEach(function(p, pIdx) {
          var pid = uid(['nc',ncIdx,'p',pIdx]);
          push('```{ojs}','//| echo: false',
            'viewof passage_'+pid+' = {',
            '  const row = document.createElement("div"); row.className = "action-check-row";',
            '  const cb = Object.assign(document.createElement("input"), {type:"checkbox"});',
            '  const lbl = document.createElement("label");',
            '  const cite_el = Object.assign(document.createElement("span"), {className:"citation", textContent:"['+p.doc+':'+p.line+']"});',
            '  lbl.appendChild(cite_el);',
            '  lbl.appendChild(document.createTextNode(" '+escText(p.text||'')+'"));',
            '  row.appendChild(cb); row.appendChild(lbl); row.value = false;',
            '  cb.addEventListener("change", () => { row.value = cb.checked; row.dispatchEvent(new Event("input")); });',
            '  return row;','}','```','',
            '```{ojs}','//| echo: false','{',
            '  mutable newCodeEdits = newCodeEdits.map((e,ni) => {',
            '    if (ni !== '+ncIdx+') return e;',
            '    const ps = [...e.passageSelections]; ps['+pIdx+'] = passage_'+pid+'; return {...e, passageSelections: ps};',
            '  });',
            '  return html`<span></span>`;',
            '}','```','');
        });
      }
      push('```{ojs}','//| echo: false',
        'viewof include_nc'+ncIdx+' = {',
        '  const row = document.createElement("div"); row.className = "action-check-row action-check-include";',
        '  const cb = Object.assign(document.createElement("input"), {type:"checkbox"});',
        '  const lbl = Object.assign(document.createElement("label"), {textContent:"Add this code to the codebook"});',
        '  row.appendChild(cb); row.appendChild(lbl); row.value = false;',
        '  cb.addEventListener("change", () => { row.value = cb.checked; row.dispatchEvent(new Event("input")); });',
        '  return row;','}','```','',
        '```{ojs}','//| echo: false',
        '{ mutable newCodeEdits = newCodeEdits.map((e,j) => j==='+ncIdx+' ? {...e,selected:include_nc'+ncIdx+'} : e); return html`<span></span>`; }',
        '```','',':::','');
    });
  }

  // ── 4. Bottom line ─────────────────────────────────────────────────────────
  var bl = data.bottom_line || {};
  push('## Bottom line','');
  if (bl.assessment) push('::: {.report-assessment}','',markCodes(bl.assessment),'',':::','');
  if (bl.recommendations && bl.recommendations.length) {
    push('**Recommendations:**','');
    bl.recommendations.forEach(function(r,i){push((i+1)+'. '+markCodes(r));});
    push('');
  }
  push('### Pending changes','',
    '```{ojs}','//| echo: false','{',
    '  const div = document.createElement("div");',
    '  const rc = removals.length;',
    '  const ac = newCodeEdits.reduce((n,e) => n+e.passageSelections.filter(Boolean).length, 0);',
    '  const nc = newCodeEdits.filter(e=>e.selected).length;',
    '  if (rc===0&&ac===0&&nc===0) {',
    '    div.appendChild(Object.assign(document.createElement("p"),{className:"report-ok",textContent:"No changes queued."}));',
    '    return div;',
    '  }',
    '  div.appendChild(Object.assign(document.createElement("p"),{className:"report-subhead",textContent:"Queued changes:"}));',
    '  const ul = document.createElement("ul");',
    '  removals.forEach(r=>{',
    '    const li=document.createElement("li");',
    '    li.append("Remove ",Object.assign(document.createElement("code"),{textContent:r.code})," from ",Object.assign(document.createElement("span"),{className:"citation",textContent:"["+r.doc+":"+r.line+"]"}));',
    '    ul.appendChild(li);',
    '  });',
    '  newCodeEdits.forEach(e=>{',
    '    if(e.selected){const li=document.createElement("li");li.append("Add new code ",Object.assign(document.createElement("strong"),{textContent:e.name})," to codebook");ul.appendChild(li);}',
    '    e.passages.forEach((p,i)=>{if(!e.passageSelections[i])return;const li=document.createElement("li");li.append("Apply ",Object.assign(document.createElement("strong"),{textContent:e.name})," to ",Object.assign(document.createElement("span"),{className:"citation",textContent:"["+p.doc+":"+p.line+"]"}));ul.appendChild(li);});',
    '  });',
    '  div.appendChild(ul);',
    '  const btn=Object.assign(document.createElement("button"),{className:"btn-execute",disabled:executing||executed});',
    '  btn.textContent=executing?"Executing\u2026":"Execute all changes";',
    '  btn.addEventListener("click",async()=>{',
    '    mutable executing=true;',
    '    const payload={label:"reflect",remove_codes:removals,',
    '      add_codes:newCodeEdits.flatMap(e=>e.passages.filter((_,i)=>e.passageSelections[i]).map(p=>({doc:p.doc,line:p.line,code:e.name,coder:"qc-reflect"}))),',
    '      new_codes:newCodeEdits.filter(e=>e.selected).map(e=>({name:e.name,scope:e.scope,rationale:e.rationale,provenance:"Suggested by qc-reflect"}))};',
    '    try{const res=await fetch("http://localhost:8080/reflect/corpus/apply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});',
    '      mutable executeResult=await res.json();mutable executed=true;}',
    '    catch(err){mutable executeResult={error:err.message};}',
    '    mutable executing=false;',
    '  });',
    '  div.appendChild(btn);',
    '  if(executeResult){',
    '    const rd=document.createElement("div"); rd.className="execute-result";',
    '    const addP = (cls,txt) => { const p=document.createElement("p"); p.className=cls; p.textContent=txt; rd.appendChild(p); };',
    '    if(executeResult.error) { addP("execute-error","\u274c "+executeResult.error); }',
    '    else { const r=executeResult.results;',
    '      addP("execute-ok","\u2713 Complete \u2014 removed: "+r.removed.length+", added: "+r.added.length+", new codes: "+r.new_codes.length);',
    '      if(r.errors.length) addP("execute-warn","\u26a0 "+r.errors.join("; "));',
    '      addP(executeResult.prerender_ok?"execute-ok":"execute-warn", executeResult.prerender_ok?"\u2713 Corpus regenerated":"\u26a0 Prerender: "+executeResult.prerender_err);',
    '      if(executeResult.backup) addP("execute-meta","Backup: "+executeResult.backup);',
    '    }',
    '    div.appendChild(rd);',
    '  }',
    '  return div;',
    '}','```','');

  return L.join('\n');
}


function buildQMDAbridged(codeNames, data, ts, basename) {
  var L = [];
  function push() { Array.prototype.forEach.call(arguments, function(l) { L.push(l); }); }

  function codeSpan(name) {
    var m = name.match(/^(\d{2})/);
    var cls = m ? 'code-chip .prefix-' + m[1] : 'code-chip';
    return '[' + name + ']{.' + cls + '}';
  }

  push(
    '---',
    'title: "QC Reflect \u2014 ' + codeNames.join(', ') + ' (abridged)"',
    'date: "' + ts.slice(0,10) + '"',
    'format:',
    '  html:',
    '    theme: cosmo',
    '    toc: false',
    '    css: qc-reflect-report.css',
    '---',
    '',
    '::: {.abridged-header}',
    codeNames.join(', ') + ' \u00b7 ' + ts.replace('T',' ').slice(0,16) + ' \u00b7 [Full report \u2192](' + basename + '.html)',
    ':::',
    '',
    '## Summary',
    ''
  );

  // Table
  push('| Code | What it captures | Key issue | Uses |');
  push('|:-----|:----------------|:----------|-----:|');
  (data.per_code || []).forEach(function(code) {
    var issues = (code.misapplications || []).length;
    push('| ' + codeSpan(code.name) + ' | ' + (code.summary || '').slice(0, 60) + '\u2026 | ' +
      (issues > 0 ? issues + ' misapplication' + (issues !== 1 ? 's' : '') : 'None identified') +
      ' | ' + ((code.uses || 0)) + ' |');
  });
  push('');

  // Misapplications flat list
  push('## Misapplications', '');
  (data.per_code || []).forEach(function(code) {
    (code.misapplications || []).forEach(function(m) {
      push('[' + m.doc + ':' + m.line + ']{.citation} \u00b7 ' + codeSpan(code.name) + ' \u2014 ' + m.explanation, '');
    });
  });

  // New codes
  var cc = data.cross_code || {};
  if (cc.new_codes && cc.new_codes.length > 0) {
    push('## Suggested new codes', '');
    cc.new_codes.forEach(function(nc) {
      push('**' + nc.name + '** \u2014 ' + (nc.rationale || ''), '');
      (nc.passages || []).slice(0, 2).forEach(function(p) {
        push('> [' + p.doc + ':' + p.line + ']{.citation} ' + p.text, '');
      });
    });
  }

  // Recommendations
  var bl = data.bottom_line || {};
  if (bl.recommendations && bl.recommendations.length) {
    push('## Recommendations', '');
    bl.recommendations.forEach(function(r, i) { push((i+1) + '. ' + markCodes(r)); });
    push('');
  }

  return L.join('\n');
}

function buildQMDAbridged(codeNames, data, ts, basename) {
  var L = [];
  function push() { Array.prototype.forEach.call(arguments, function(l) { L.push(l); }); }

  function codeSpan(name) {
    var m = name.match(/^(\d{2})/);
    var cls = m ? 'code-chip .prefix-' + m[1] : 'code-chip';
    return '[' + name + ']{.' + cls + '}';
  }

  push(
    '---',
    'title: "QC Reflect \u2014 ' + codeNames.join(', ') + ' (abridged)"',
    'date: "' + ts.slice(0,10) + '"',
    'format:',
    '  html:',
    '    theme: cosmo',
    '    toc: false',
    '    css: qc-reflect-report.css',
    '---',
    '',
    '::: {.abridged-header}',
    codeNames.join(', ') + ' \u00b7 ' + ts.replace('T',' ').slice(0,16) + ' \u00b7 [Full report \u2192](' + basename + '.html)',
    ':::',
    '',
    '## Summary',
    ''
  );

  // Table
  push('| Code | What it captures | Key issue | Uses |');
  push('|:-----|:----------------|:----------|-----:|');
  (data.per_code || []).forEach(function(code) {
    var issues = (code.misapplications || []).length;
    push('| ' + codeSpan(code.name) + ' | ' + (code.summary || '').slice(0, 60) + '\u2026 | ' +
      (issues > 0 ? issues + ' misapplication' + (issues !== 1 ? 's' : '') : 'None identified') +
      ' | ' + ((code.uses || 0)) + ' |');
  });
  push('');

  // Misapplications flat list
  push('## Misapplications', '');
  (data.per_code || []).forEach(function(code) {
    (code.misapplications || []).forEach(function(m) {
      push('[' + m.doc + ':' + m.line + ']{.citation} \u00b7 ' + codeSpan(code.name) + ' \u2014 ' + m.explanation, '');
    });
  });

  // New codes
  var cc = data.cross_code || {};
  if (cc.new_codes && cc.new_codes.length > 0) {
    push('## Suggested new codes', '');
    cc.new_codes.forEach(function(nc) {
      push('**' + nc.name + '** \u2014 ' + (nc.rationale || ''), '');
      (nc.passages || []).slice(0, 2).forEach(function(p) {
        push('> [' + p.doc + ':' + p.line + ']{.citation} ' + p.text, '');
      });
    });
  }

  // Recommendations
  var bl = data.bottom_line || {};
  if (bl.recommendations && bl.recommendations.length) {
    push('## Recommendations', '');
    bl.recommendations.forEach(function(r, i) { push((i+1) + '. ' + markCodes(r)); });
    push('');
  }

  return L.join('\n');
}

async function saveAndRender(codes, reportData, elapsed) {
  var codeNames = codes.map(function(c) { return c.name; });
  var ts        = new Date().toISOString();
  var secs      = elapsed ? Math.round(elapsed / 1000) : 0;
  var mins      = Math.floor(secs / 60);
  var timeStr   = mins > 0 ? mins + 'm ' + (secs%60) + 's' : secs + 's';

  // Generate basename (used to cross-link main ↔ abridged)
  var slug     = codeNames.join('-').slice(0, 40).replace(/[^a-z0-9-]/gi, '_');
  var tsShort  = ts.slice(0,16).replace(/[-:T]/g, '');
  var basename = 'reflect_' + tsShort + '_' + slug;

  var qmdMain     = buildQMD(codeNames, reportData, ts, elapsed);
  var qmdAbridged = buildQMDAbridged(codeNames, reportData, ts, basename);

  try {
    var res  = await fetch(API + '/reflect/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codes:           codeNames,
        label:           codeNames.join(' \u00b7 ').slice(0, 60),
        report_md:       qmdMain,
        report_md_abridged: qmdAbridged,
        report_json:     { data: reportData, elapsed: elapsed },
      }),
    });
    var result = await res.json();
    var report = activeReport();
    if (report && result.rendered && result.html_url) report.html_url = result.html_url;
    if (report && result.abridged_url) report.abridged_url = result.abridged_url;
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
// ── Suggestion engine ─────────────────────────────────────────────────────────
// Five methods, each returns [{codes, method, metric, score, rank_reason}]
// All run in-browser on baked data. Naming uses a small LLM call.

// ── Helpers ───────────────────────────────────────────────────────────────────

function codeParent(name) {
  var node = CODEBOOK_TREE.find(function(n) { return n.name === name; });
  return node ? node.parent : null;
}

function codeSiblings(name) {
  var parent = codeParent(name);
  if (!parent) return [];
  return CODEBOOK_TREE
    .filter(function(n) { return n.parent === parent && n.name !== name; })
    .map(function(n) { return n.name; });
}

function codeChildren(name) {
  return CODEBOOK_TREE
    .filter(function(n) { return n.parent === name; })
    .map(function(n) { return n.name; });
}

function codeUses(name) {
  return (CORPUS_INDEX[name] || {}).total || 0;
}

function docsForCode(name) {
  // Returns set of docs this code appears in
  var docs = new Set();
  Object.keys(DOC_CODE_MATRIX).forEach(function(doc) {
    if (DOC_CODE_MATRIX[doc].indexOf(name) >= 0) docs.add(doc);
  });
  return docs;
}

// Jaccard similarity between two code's document sets
function jaccard(a, b) {
  var da = docsForCode(a);
  var db = docsForCode(b);
  var inter = 0;
  da.forEach(function(d) { if (db.has(d)) inter++; });
  var union = da.size + db.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── Method 1: Co-occurrence clustering ───────────────────────────────────────
// Groups codes by shared document patterns using Jaccard similarity.
// Cutoff: top quartile of pairwise Jaccard scores among active codes.
// Rank: mean intra-cluster Jaccard.

function suggestCooccurrence() {
  var codes = ALL_CODES.filter(function(c) { return codeUses(c) > 0 && !isStub(c); });
  if (codes.length < 3) return [];

  // Compute all pairwise Jaccard scores
  var pairs = [];
  for (var i = 0; i < codes.length; i++) {
    for (var j = i+1; j < codes.length; j++) {
      var score = jaccard(codes[i], codes[j]);
      if (score > 0) pairs.push({a: codes[i], b: codes[j], score: score});
    }
  }
  pairs.sort(function(x,y) { return y.score - x.score; });

  // Cutoff: top quartile
  var cutoff_idx = Math.floor(pairs.length * 0.75);
  var cutoff     = pairs.length > 0 ? pairs[cutoff_idx].score : 0;

  // Build adjacency at cutoff
  var adj = {};
  codes.forEach(function(c) { adj[c] = []; });
  pairs.slice(0, cutoff_idx).forEach(function(p) {
    adj[p.a].push({code: p.b, score: p.score});
    adj[p.b].push({code: p.a, score: p.score});
  });

  // Greedy clustering: take the highest-degree node, form a cluster with its neighbours
  var used   = new Set();
  var groups = [];
  codes.slice().sort(function(a,b) { return adj[b].length - adj[a].length; }).forEach(function(seed) {
    if (used.has(seed)) return;
    var neighbours = adj[seed].filter(function(n) { return !used.has(n.code); });
    if (neighbours.length < 2) return;
    var cluster = [seed].concat(neighbours.map(function(n) { return n.code; }));
    // Mean intra-cluster Jaccard
    var scores = [];
    for (var i = 0; i < cluster.length; i++)
      for (var j = i+1; j < cluster.length; j++)
        scores.push(jaccard(cluster[i], cluster[j]));
    var mean = scores.reduce(function(s,x){return s+x;},0) / scores.length;
    cluster.forEach(function(c) { used.add(c); });
    groups.push({
      codes:       cluster,
      method:      'co-occurrence',
      metric:      'Jaccard similarity',
      score:       mean,
      rank_reason: 'Mean Jaccard similarity within cluster: ' + mean.toFixed(3) +
                   ' (cutoff: top quartile ≥ ' + cutoff.toFixed(3) + ' across ' + pairs.length + ' pairs)',
    });
  });

  groups.sort(function(a,b) { return b.score - a.score; });
  return groups.slice(0, 5);
}

// ── Method 2: Tree proximity ──────────────────────────────────────────────────
// Groups codes that are siblings in the same branch.
// One group per branch that has ≥3 siblings with corpus uses.
// Rank: number of siblings with uses / total siblings (coverage).

function suggestTreeProximity() {
  // Find all parents that have ≥3 used children
  var parents = {};
  CODEBOOK_TREE.forEach(function(node) {
    if (!node.parent) return;
    if (!parents[node.parent]) parents[node.parent] = [];
    if (codeUses(node.name) > 0) parents[node.parent].push(node.name);
  });

  var groups = [];
  Object.keys(parents).forEach(function(parent) {
    var siblings = parents[parent];
    if (siblings.length < 3) return;
    var allChildren = codeChildren(parent);
    var coverage    = siblings.length / allChildren.length;
    groups.push({
      codes:       siblings,
      method:      'tree-proximity',
      metric:      'Branch coverage',
      score:       coverage,
      rank_reason: siblings.length + ' of ' + allChildren.length + ' children of ' + parent + ' have corpus applications (coverage: ' + (coverage*100).toFixed(0) + '%)',
    });
  });

  groups.sort(function(a,b) { return b.score - a.score; });
  return groups.slice(0, 5);
}

// ── Method 3: Undercoded (relative to siblings) ───────────────────────────────
// Finds branches where one or more codes are applied far less than their siblings.
// Also finds codes applied heavily in some documents but skipped in others.
// Rank: z-score of underuse relative to sibling mean.

function suggestUndercoded() {
  var parents = {};
  CODEBOOK_TREE.forEach(function(node) {
    if (!node.parent) return;
    if (!parents[node.parent]) parents[node.parent] = [];
    parents[node.parent].push(node.name);
  });

  var candidates = [];
  Object.keys(parents).forEach(function(parent) {
    var siblings = parents[parent];
    if (siblings.length < 3) return;
    var uses  = siblings.map(codeUses);
    var mean  = uses.reduce(function(s,x){return s+x;},0) / uses.length;
    var sd    = Math.sqrt(uses.map(function(x){return Math.pow(x-mean,2);}).reduce(function(s,x){return s+x;},0) / uses.length);
    if (sd === 0) return;

    siblings.forEach(function(code, i) {
      var z = (uses[i] - mean) / sd;
      if (z < -1.0 && mean > 2) { // meaningfully undercoded
        candidates.push({
          undercoded: code,
          siblings:   siblings,
          parent:     parent,
          z:          z,
          mean:       mean,
          uses:       uses[i],
        });
      }
    });
  });

  // Group by parent branch — surface the whole branch for comparison
  var seen = new Set();
  var groups = [];
  candidates.sort(function(a,b) { return a.z - b.z; }).forEach(function(c) {
    if (seen.has(c.parent)) return;
    seen.add(c.parent);
    groups.push({
      codes:       c.siblings,
      method:      'undercoded',
      metric:      'Z-score vs siblings',
      score:       Math.abs(c.z),
      rank_reason: c.undercoded + ' is undercoded (z=' + c.z.toFixed(2) + ', uses=' + c.uses + ') vs sibling mean of ' + c.mean.toFixed(1) + ' in branch ' + c.parent,
    });
  });

  return groups.slice(0, 5);
}

// ── Method 4: High document variance ─────────────────────────────────────────
// Finds codes applied heavily in some documents and barely in others.
// Ranks by coefficient of variation of per-document application counts.
// Cutoff: codes with CV > 1.0 (high relative dispersion) and ≥5 total uses.

function suggestHighVariance() {
  var code_doc_counts = {};
  Object.keys(DOC_CODE_MATRIX).forEach(function(doc) {
    DOC_CODE_MATRIX[doc].forEach(function(code) {
      if (!code_doc_counts[code]) code_doc_counts[code] = {};
      code_doc_counts[code][doc] = (code_doc_counts[code][doc] || 0) + 1;
    });
  });

  var scored = [];
  ALL_CODES.forEach(function(code) {
    var total = codeUses(code);
    if (total < 5) return;
    var counts = DOC_NAMES.map(function(doc) {
      return (code_doc_counts[code] && code_doc_counts[code][doc]) || 0;
    });
    var mean = total / DOC_NAMES.length;
    var sd   = Math.sqrt(counts.map(function(x){return Math.pow(x-mean,2);}).reduce(function(s,x){return s+x;},0) / DOC_NAMES.length);
    var cv   = mean > 0 ? sd / mean : 0;
    if (cv > 1.0) scored.push({code: code, cv: cv, total: total, mean: mean.toFixed(2)});
  });

  scored.sort(function(a,b) { return b.cv - a.cv; });

  // Group high-variance codes by branch proximity
  var groups = [];
  var used   = new Set();
  scored.forEach(function(item) {
    if (used.has(item.code)) return;
    var sibs = codeSiblings(item.code).filter(function(s) {
      return scored.some(function(x) { return x.code === s; });
    });
    var cluster = [item.code].concat(sibs).filter(function(c) { return !used.has(c); });
    if (cluster.length < 2) {
      // Include as solo with its branch for context
      var branch = [item.code].concat(codeSiblings(item.code).filter(function(s) { return codeUses(s) > 0; }));
      cluster = branch;
    }
    cluster.forEach(function(c) { used.add(c); });
    groups.push({
      codes:       cluster,
      method:      'high-variance',
      metric:      'Coefficient of variation',
      score:       item.cv,
      rank_reason: item.code + ' CV=' + item.cv.toFixed(2) + ' (mean ' + item.mean + ' applications/doc, total ' + item.total + '). CV > 1.0 indicates concentrated application across documents.',
    });
  });

  return groups.slice(0, 5);
}

// ── Method 5: LLM semantic grouping ──────────────────────────────────────────
// Separate async call — interprets statistical results + codebook structure.

async function suggestLLMSemantic(existingGroups) {
  var docsData = await loadDocs();

  // Build compact context
  var statsContext = existingGroups.map(function(g) {
    return g.method + ': ' + g.codes.join(', ') + ' (' + g.rank_reason + ')';
  }).join('\n');

  var treeLines = [];
  CODEBOOK_TREE.filter(function(n) { return isActiveCode(n.name); }).forEach(function(node) {
    treeLines.push('  '.repeat(node.depth) + node.name + ' (uses:' + node.uses + ')');
  });

  var docsLines = [];
  ALL_CODES.slice(0, 60).forEach(function(name) {
    var doc = docsData[name] || {};
    if (doc.scope || doc.rationale) {
      docsLines.push(name + ': ' + (doc.scope || doc.rationale || '').slice(0, 80));
    }
  });

  var prompt = [
    'You are assisting with qualitative data analysis using grounded theory (Charmaz/Saldana).',
    '',
    'STATISTICAL GROUPINGS ALREADY FOUND:',
    statsContext,
    '',
    'CODE TREE (excerpt):',
    treeLines.slice(0, 80).join('\n'),
    '',
    'CODE DOCUMENTATION (excerpt):',
    docsLines.slice(0, 40).join('\n'),
    '',
    'TASK: Suggest 3-5 analytically interesting groupings of codes to reflect on together.',
    'Focus on:',
    '- Codes whose documented scope may overlap or conflict',
    '- Codes that together capture a theoretical dimension not obvious from the tree structure',
    '- Codes that are conceptually related but statistically uncorrelated (interesting tension)',
    '- Avoid simply repeating the statistical groupings above',
    '',
    'For each grouping respond with JSON only:',
    '{"groups": [{"codes": ["code1","code2"], "name": "short label", "description": "1-2 sentence rationale", "method": "llm-semantic", "rank_reason": "why these codes are worth comparing"}]}',
  ].join('\n');

  var result = await ollamaJSON(prompt);
  return (result && result.groups) ? result.groups.map(function(g) {
    return Object.assign({score: 0, metric: 'LLM semantic'}, g);
  }) : [];
}

// ── Naming via small model ────────────────────────────────────────────────────

async function nameGroups(groups) {
  var namingModel = REFLECT_CONFIG.naming_model || REFLECT_CONFIG.ollama_model;
  var prompt = [
    'For each of the following code groupings, provide a short name (3-5 words) and a one-sentence description explaining why these codes are analytically interesting to compare.',
    '',
    'Groupings:',
    groups.map(function(g, i) {
      return i + '. Method: ' + g.method + '\n   Codes: ' + g.codes.join(', ') + '\n   Reason: ' + g.rank_reason;
    }).join('\n\n'),
    '',
    'Respond with JSON only:',
    '{"names": [{"name": "short label", "description": "one sentence"}]}',
  ].join('\n');

  var result = await ollamaJSON(prompt, namingModel);
  if (result && result.names) {
    result.names.forEach(function(n, i) {
      if (groups[i]) { groups[i].name = n.name; groups[i].description = n.description; }
    });
  }
  return groups;
}

// ── Main suggest function ─────────────────────────────────────────────────────

async function runSuggest(includeLLM) {
  state.suggesting   = true;
  state.suggestions  = null;
  state.suggestError = null;
  render();

  try {
    // Run all statistical methods
    setProgress('Running co-occurrence clustering…');
    render();
    var cooc = suggestCooccurrence();

    setProgress('Running tree proximity…');
    render();
    var tree = suggestTreeProximity();

    setProgress('Identifying undercoded codes…');
    render();
    var under = suggestUndercoded();

    setProgress('Computing document variance…');
    render();
    var variance = suggestHighVariance();

    var allGroups = cooc.concat(tree).concat(under).concat(variance);

    // Name all statistical groups
    setProgress('Naming groupings…');
    render();
    allGroups = await nameGroups(allGroups);

    if (includeLLM) {
      setProgress('Running LLM semantic analysis…');
      render();
      var llmGroups = await suggestLLMSemantic(allGroups);
      if (llmGroups.length > 0) {
        llmGroups = await nameGroups(llmGroups);
        allGroups = allGroups.concat(llmGroups);
      }
    }

    state.suggestions = allGroups;
    setProgress('');
  } catch(e) {
    state.suggestError = e.message || String(e);
    setProgress('');
  }

  state.suggesting = false;
  render();
}
// ── UI State ──────────────────────────────────────────────────────────────────
state.lightMode       = false;
state.suggesting      = false;
state.suggestions     = null;
state.suggestError    = null;
state.selectedSuggest = null;  // index into state.suggestions
state.layoutMode      = 'force'; // force | radial | grid
state.snapshotDir     = '';
state.snapshots       = null;
state.networkSim      = null;   // d3 simulation handle

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  try {
    var root = document.getElementById('qc-reflect-root');
    if (!root) return;
    root.innerHTML = '';
    document.body.classList.toggle('dark-mode', !state.lightMode);
    root.appendChild(buildShell());
  } catch(e) { console.error('[render]', e.message, e.stack); }
}

function buildShell() {
  var shell = h('div', {className: 'reflect-shell'});
  shell.appendChild(buildLeft());
  shell.appendChild(buildRight());
  return shell;
}

// ── Left column ───────────────────────────────────────────────────────────────

function buildLeft() {
  var col = h('div', {className: 'reflect-left'});

  // Strip: snapshot + theme
  var strip = h('div', {className: 'left-strip'});
  var pill  = h('div', {className: 'snapshot-pill'});
  if (state.snapshotDir) {
    var label = state.snapshotDir.replace(/^codebook_\d{8}-\d{4}-?/, '') || state.snapshotDir;
    pill.appendChild(h('span', {className: 'snapshot-label'}, '📷 ' + label));
    pill.appendChild(h('button', {
      className: 'snapshot-head-btn',
      onClick: function() { state.snapshotDir = ''; state.docsData = null; render(); }
    }, '↩ HEAD'));
  } else {
    pill.appendChild(h('span', {className: 'snapshot-label head'}, 'HEAD'));
  }
  strip.appendChild(pill);
  strip.appendChild(h('div', {className: 'strip-spacer'}));
  strip.appendChild(h('span', {className: 'model-badge'}, REFLECT_CONFIG.ollama_model || '?'));
  strip.appendChild(h('button', {
    className: 'theme-btn', title: 'Toggle light/dark',
    onClick: function() {
      state.lightMode = !qcToggleTheme();
      render();
    }
  }, qcIsDarkMode() ? '☀' : '☾'));
  col.appendChild(strip);

  // Suggest button row
  var btnRow = h('div', {className: 'suggest-btn-row'});
  btnRow.appendChild(h('button', {
    className: 'btn primary suggest-main-btn',
    disabled: state.suggesting,
    onClick: function() { runSuggest(false); }
  }, state.suggesting ? 'Analysing…' : 'Suggest groupings'));
  btnRow.appendChild(h('button', {
    className: 'btn',
    disabled: state.suggesting,
    title: 'Also run LLM semantic analysis',
    onClick: function() { runSuggest(true); }
  }, '+ LLM'));
  col.appendChild(btnRow);

  // Method legend
  var legend = h('div', {className: 'method-legend'});
  [
    {key:'co-occurrence',  label:'Co-occurrence',  tip:'Codes that appear together in the same documents more than chance would predict (Jaccard similarity)'},
    {key:'tree-proximity', label:'Tree proximity',  tip:'Codes that are siblings in the same codebook branch — useful for checking within-branch consistency'},
    {key:'undercoded',     label:'Undercoded',      tip:'Codes applied far less than their siblings (z-score < −1) — may be missed, ambiguous, or redundant'},
    {key:'high-variance',  label:'High variance',   tip:'Codes concentrated in a few documents (CV > 1) — may be participant-specific or inconsistently applied'},
    {key:'llm-semantic',   label:'LLM semantic',    tip:'Analytically interesting groupings identified by the LLM based on documented scope and conceptual relationships'},
  ].forEach(function(m) {
    var row = h('div', {className: 'legend-row', title: m.tip});
    row.appendChild(h('span', {className: 'legend-dot method-' + m.key.replace('-','_')}));
    row.appendChild(h('span', {className: 'legend-label'}, m.label));
    row.appendChild(h('span', {className: 'legend-tip'}, '?',));
    var tooltip = h('div', {className: 'legend-tooltip'}, m.tip);
    row.appendChild(tooltip);
    legend.appendChild(row);
  });
  col.appendChild(legend);

  // Suggestion list
  var list = h('div', {className: 'suggest-list'});

  if (state.suggesting) {
    var prog = h('div', {className: 'suggest-progress'});
    prog.appendChild(h('div', {className: 'spinner'}));
    prog.appendChild(h('span', {className: 'suggest-progress-text'}, state.progress || 'Analysing…'));
    list.appendChild(prog);
  } else if (state.suggestError) {
    list.appendChild(h('div', {className: 'suggest-error'}, 'Error: ' + state.suggestError));
  } else if (!state.suggestions) {
    list.appendChild(h('div', {className: 'suggest-empty'},
      'Click "Suggest groupings" to discover\ninteresting code sets.'));
  } else {
    var methods = ['co-occurrence','tree-proximity','undercoded','high-variance','llm-semantic'];
    methods.forEach(function(method) {
      var groups = state.suggestions
        .map(function(g,i){return {g:g,i:i};})
        .filter(function(x){return x.g.method===method;});
      if (!groups.length) return;

      groups.forEach(function(x, rank) {
        var g       = x.g;
        var idx     = x.i;
        var isActive = state.selectedSuggest === idx;
        var card = h('div', {
          className: 'suggest-card' + (isActive ? ' active' : ''),
          onClick: function() {
            state.selectedSuggest = isActive ? null : idx;
            render();
            if (!isActive) setTimeout(function(){ renderNetwork(idx); }, 50);
          }
        });

        var head = h('div', {className: 'suggest-card-head'});
        head.appendChild(h('span', {className: 'method-dot method-' + method.replace('-','_')}));
        head.appendChild(h('span', {className: 'suggest-card-name'}, g.name || g.codes.slice(0,3).join(' · ')));
        head.appendChild(h('span', {className: 'suggest-rank'}, '#'+(rank+1)));
        card.appendChild(head);

        if (g.description) {
          card.appendChild(h('div', {className: 'suggest-card-desc'}, g.description));
        }

        // Compact code list
        var codes = h('div', {className: 'suggest-card-codes'});
        var show  = g.codes.slice(0, 4);
        show.forEach(function(code) {
          codes.appendChild(h('span', {className: 'suggest-code-chip', title: code},
            code.length > 14 ? code.slice(0,14)+'…' : code));
        });
        if (g.codes.length > 4) {
          codes.appendChild(h('span', {className: 'suggest-code-more'}, '+' + (g.codes.length-4)));
        }
        card.appendChild(codes);

        // Score badge
        var meta = h('div', {className: 'suggest-card-meta'});
        meta.appendChild(h('span', {className: 'suggest-metric method-' + method.replace('-','_')}, g.metric || method));
        if (g.score) meta.appendChild(h('span', {className: 'suggest-score'}, g.score.toFixed(3)));
        card.appendChild(meta);

        list.appendChild(card);
      });
    });
  }

  col.appendChild(list);
  return col;
}

// ── Right column ──────────────────────────────────────────────────────────────

function buildRight() {
  var col = h('div', {className: 'reflect-right'});

  if (state.running) {
    col.appendChild(buildRunning());
    return col;
  }

  if (state.selectedSuggest !== null && state.suggestions) {
    col.appendChild(buildSuggestDetail(state.suggestions[state.selectedSuggest], state.selectedSuggest));
  } else if (state.reports.length > 0) {
    col.appendChild(buildRunHistory());
  } else {
    col.appendChild(buildCorpusOverview());
  }

  return col;
}

// ── Corpus overview ───────────────────────────────────────────────────────────

function buildCorpusOverview() {
  var pane = h('div', {className: 'right-pane overview-pane'});

  pane.appendChild(h('div', {className: 'pane-label'}, 'Corpus overview'));

  // Stats strip
  var stats = h('div', {className: 'overview-stats'});
  [
    {v: DOC_NAMES.length,  l: 'documents'},
    {v: ALL_CODES.length,  l: 'coded codes'},
    {v: CODEBOOK_TREE.filter(function(n){return !n.parent;}).length, l: 'top-level branches'},
    {v: COOC_DATA.length,  l: 'co-occurring pairs'},
  ].forEach(function(s) {
    var cell = h('div', {className: 'overview-stat'});
    cell.appendChild(h('div', {className: 'overview-stat-val'}, String(s.v)));
    cell.appendChild(h('div', {className: 'overview-stat-label'}, s.l));
    stats.appendChild(cell);
  });
  pane.appendChild(stats);

  // Treemap
  pane.appendChild(h('div', {className: 'pane-sublabel'}, 'Code use by branch'));
  var tmWrap = h('div', {className: 'treemap-wrap', id: 'corpus-treemap'});
  pane.appendChild(tmWrap);
  setTimeout(function() { renderTreemap(); }, 30);

  // Top co-occurring pairs
  pane.appendChild(h('div', {className: 'pane-sublabel'}, 'Strongest co-occurrences'));
  var pairs = h('div', {className: 'cooc-pairs'});
  COOC_DATA.slice(0, 8).forEach(function(p) {
    var row = h('div', {className: 'cooc-pair-row'});
    var j = p.shared_docs / Math.min(p.total_a||1, p.total_b||1);
    row.appendChild(h('span', {className: 'cooc-pair-codes', title: p.code_a + ' × ' + p.code_b},
      truncate(p.code_a,14) + ' × ' + truncate(p.code_b,14)));
    var bar = h('div', {className: 'cooc-bar-wrap'});
    bar.appendChild(h('div', {className: 'cooc-bar', style: {width: Math.round(j*100)+'%'}}));
    row.appendChild(bar);
    row.appendChild(h('span', {className: 'cooc-score'}, j.toFixed(2)));
    pairs.appendChild(row);
  });
  pane.appendChild(pairs);

  return pane;
}

function truncate(s, n) { return s.length > n ? s.slice(0,n)+'…' : s; }

function renderTreemap() {
  var wrap = document.getElementById('corpus-treemap');
  if (!wrap || typeof d3 === 'undefined') return;

  var W = wrap.offsetWidth || 500;
  var H = 220;

  // Build hierarchy: top-level branches → codes
  var roots = CODEBOOK_TREE.filter(function(n) { return !n.parent; });
  var children = roots.map(function(root) {
    var kids = CODEBOOK_TREE.filter(function(n) { return n.parent === root.name; });
    if (kids.length === 0) {
      return {name: root.name, value: root.uses || 1};
    }
    return {
      name: root.name,
      children: kids.map(function(k) { return {name: k.name, value: k.uses || 1}; })
    };
  });

  var hdata = {name: 'root', children: children};
  var root  = d3.hierarchy(hdata).sum(function(d) { return d.value || 0; });
  d3.treemap().size([W, H]).padding(2).round(true)(root);

  var svg = d3.select(wrap).append('svg')
    .attr('width', W).attr('height', H);

  var colors = d3.schemeTableau10;
  var topParents = {};
  root.leaves().forEach(function(leaf) {
    var anc = leaf.ancestors().find(function(a) { return a.depth === 1; });
    if (anc) topParents[leaf.data.name] = anc.data.name;
  });
  var colorMap = {};
  roots.forEach(function(r, i) { colorMap[r.name] = colors[i % colors.length]; });

  var cell = svg.selectAll('g').data(root.leaves()).enter().append('g')
    .attr('transform', function(d) { return 'translate('+d.x0+','+d.y0+')'; });

  cell.append('rect')
    .attr('width',  function(d) { return Math.max(0, d.x1-d.x0); })
    .attr('height', function(d) { return Math.max(0, d.y1-d.y0); })
    .attr('fill', function(d) {
      var p = topParents[d.data.name];
      return p ? colorMap[p] || '#666' : '#666';
    })
    .attr('fill-opacity', 0.7)
    .attr('rx', 2);

  cell.append('title').text(function(d) {
    return d.data.name + '\n' + d.data.value + ' uses';
  });

  cell.filter(function(d) { return (d.x1-d.x0) > 30 && (d.y1-d.y0) > 14; })
    .append('text')
    .attr('x', 3).attr('y', 11)
    .attr('font-size', '9px')
    .attr('fill', '#fff')
    .text(function(d) { return truncate(d.data.name.replace(/^\d{2}_/,''), 12); });
}

// ── Suggestion detail ─────────────────────────────────────────────────────────

function buildSuggestDetail(g, idx) {
  var pane = h('div', {className: 'right-pane detail-pane'});

  // Header
  var hdr = h('div', {className: 'detail-header'});
  hdr.appendChild(h('div', {className: 'detail-name'}, g.name || 'Grouping'));
  hdr.appendChild(h('span', {className: 'detail-method method-' + g.method.replace('-','_')}, g.method));
  pane.appendChild(hdr);

  if (g.description) {
    pane.appendChild(h('div', {className: 'detail-desc'}, g.description));
  }

  // Rank reason
  pane.appendChild(h('div', {className: 'detail-reason'}, g.rank_reason));

  // All codes
  var codesRow = h('div', {className: 'detail-codes'});
  g.codes.forEach(function(code) {
    codesRow.appendChild(h('span', {className: 'detail-code-chip', title: code}, code));
  });
  pane.appendChild(codesRow);

  // Layout toggle for network
  var layoutRow = h('div', {className: 'layout-row'});
  layoutRow.appendChild(h('span', {className: 'layout-label'}, 'Layout:'));
  ['force','radial','grid'].forEach(function(mode) {
    var btn = h('button', {
      className: 'layout-btn' + (state.layoutMode === mode ? ' active' : ''),
      onClick: function() { state.layoutMode = mode; renderNetwork(idx); }
    }, mode.charAt(0).toUpperCase() + mode.slice(1));
    layoutRow.appendChild(btn);
  });
  pane.appendChild(layoutRow);

  // Network canvas
  var netWrap = h('div', {className: 'network-wrap', id: 'network-canvas'});
  pane.appendChild(netWrap);
  setTimeout(function() { renderNetwork(idx); }, 50);

  // Method-specific chart
  var chartWrap = h('div', {className: 'chart-wrap', id: 'method-chart'});
  pane.appendChild(chartWrap);
  setTimeout(function() { renderMethodChart(g, chartWrap); }, 80);

  // Run Reflect button
  var runRow = h('div', {className: 'detail-run-row'});
  runRow.appendChild(h('button', {
    className: 'run-reflect-btn',
    disabled: state.running,
    onClick: function() {
      state.selectedCodes = g.codes.map(function(c) { return {name:c, auto:true}; });
      runReport();
    }
  }, '▶ Run Reflect on this grouping'));
  pane.appendChild(runRow);

  // Run history
  if (state.reports.length > 0) {
    pane.appendChild(h('div', {className: 'pane-sublabel'}, 'Previous runs'));
    state.reports.slice(0,3).forEach(function(r) { pane.appendChild(buildRunCard(r)); });
  }

  return pane;
}

// ── Network visualisation ─────────────────────────────────────────────────────

function renderNetwork(idx) {
  var wrap = document.getElementById('network-canvas');
  if (!wrap || typeof d3 === 'undefined') return;
  wrap.innerHTML = '';

  if (state.networkSim) { state.networkSim.stop(); state.networkSim = null; }

  var g      = state.suggestions[idx];
  var W      = wrap.offsetWidth || 500;
  var H      = 280;
  var coreSet = new Set(g.codes);

  // Build node set: core + 1-hop neighbours via COOC_DATA
  var nodeSet = new Set(g.codes);
  var edgeMap = {};
  COOC_DATA.forEach(function(p) {
    if (coreSet.has(p.code_a) || coreSet.has(p.code_b)) {
      var j = p.shared_docs / Math.max(1, Math.min(p.total_a||1, p.total_b||1));
      if (j > 0.05) {
        nodeSet.add(p.code_a); nodeSet.add(p.code_b);
        var key = [p.code_a,p.code_b].sort().join('||');
        edgeMap[key] = {source:p.code_a, target:p.code_b, weight:j, shared:p.shared_docs};
      }
    }
  });

  var nodes = Array.from(nodeSet).map(function(c) {
    return {id:c, core:coreSet.has(c), uses: (CORPUS_INDEX[c]||{}).total||0};
  });
  var links = Object.values(edgeMap);

  var svg = d3.select(wrap).append('svg').attr('width',W).attr('height',H);

  // Defs for arrow / glow
  var defs = svg.append('defs');
  defs.append('filter').attr('id','glow')
    .append('feGaussianBlur').attr('stdDeviation','2').attr('result','blur');

  var g_el = svg.append('g');

  // Zoom
  svg.call(d3.zoom().scaleExtent([0.3,3]).on('zoom', function(event) {
    g_el.attr('transform', event.transform);
  }));

  var linkSel = g_el.append('g').selectAll('line').data(links).enter().append('line')
    .attr('stroke', function(d) { return d.weight > 0.3 ? 'rgba(124,106,247,0.6)' : 'rgba(124,106,247,0.2)'; })
    .attr('stroke-width', function(d) { return Math.max(0.5, d.weight * 4); });

  var nodeSel = g_el.append('g').selectAll('g').data(nodes).enter().append('g')
    .style('cursor','pointer')
    .call(d3.drag()
      .on('start', function(event,d) { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on('drag',  function(event,d) { d.fx=event.x; d.fy=event.y; })
      .on('end',   function(event,d) { if (!event.active) sim.alphaTarget(0); d.fx=null; d.fy=null; })
    );

  nodeSel.append('circle')
    .attr('r', function(d) { return d.core ? Math.max(6, Math.min(16, 4+Math.sqrt(d.uses))) : Math.max(3, Math.min(10, 2+Math.sqrt(d.uses))); })
    .attr('fill', function(d) { return d.core ? 'var(--accent)' : 'var(--surface2)'; })
    .attr('stroke', function(d) { return d.core ? 'rgba(124,106,247,0.8)' : 'var(--border)'; })
    .attr('stroke-width', function(d) { return d.core ? 2 : 1; })
    .attr('fill-opacity', function(d) { return d.core ? 0.9 : 0.5; });

  nodeSel.append('text')
    .attr('dy', function(d) { return d.core ? -Math.max(6,Math.min(16,4+Math.sqrt(d.uses)))-3 : -5; })
    .attr('text-anchor','middle')
    .attr('font-size', function(d) { return d.core ? '10px' : '8px'; })
    .attr('fill', function(d) { return d.core ? 'var(--text)' : 'var(--text-faint)'; })
    .text(function(d) { return truncate(d.id, 12); });

  nodeSel.append('title').text(function(d) { return d.id + '\n' + d.uses + ' uses'; });

  function applyLayout() {
    if (state.layoutMode === 'grid') {
      // Fixed grid — core codes in a centred grid, no simulation
      if (state.networkSim) { state.networkSim.stop(); state.networkSim = null; }
      var core = nodes.filter(function(n){return n.core;});
      var cols  = Math.ceil(Math.sqrt(core.length));
      var cw    = W / (cols+1), ch = H / (Math.ceil(core.length/cols)+1);
      core.forEach(function(n,i) { n.x = cw*(i%cols+1); n.y = ch*(Math.floor(i/cols)+1); });
      var nonCore = nodes.filter(function(n){return !n.core;});
      nonCore.forEach(function(n,i) { n.x = W*0.1+Math.random()*W*0.8; n.y = H*0.1+Math.random()*H*0.8; });
      nodeSel.attr('transform', function(d) { return 'translate('+d.x+','+d.y+')'; });
      linkSel
        .attr('x1',function(d){return nodes.find(function(n){return n.id===d.source;}).x||0;})
        .attr('y1',function(d){return nodes.find(function(n){return n.id===d.source;}).y||0;})
        .attr('x2',function(d){return nodes.find(function(n){return n.id===d.target;}).x||0;})
        .attr('y2',function(d){return nodes.find(function(n){return n.id===d.target;}).y||0;});
      return;
    }

    if (state.layoutMode === 'radial') {
      var core2 = nodes.filter(function(n){return n.core;});
      var r2    = Math.min(W,H)*0.25;
      core2.forEach(function(n,i) {
        var ang = (2*Math.PI*i/core2.length)-Math.PI/2;
        n.fx = W/2 + r2*Math.cos(ang);
        n.fy = H/2 + r2*Math.sin(ang);
      });
    } else {
      nodes.forEach(function(n) { n.fx = null; n.fy = null; });
    }

    if (state.networkSim) state.networkSim.stop();
    var sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(function(d){return d.id;}).distance(function(d){return 80*(1-d.weight);}).strength(function(d){return d.weight*0.8;}))
      .force('charge', d3.forceManyBody().strength(-120))
      .force('center', d3.forceCenter(W/2, H/2))
      .force('collision', d3.forceCollide(18))
      .on('tick', function() {
        linkSel
          .attr('x1',function(d){return d.source.x;}).attr('y1',function(d){return d.source.y;})
          .attr('x2',function(d){return d.target.x;}).attr('y2',function(d){return d.target.y;});
        nodeSel.attr('transform',function(d){return 'translate('+d.x+','+d.y+')';});
      });

    state.networkSim = sim;
  }

  applyLayout();
}

// ── Method-specific chart ─────────────────────────────────────────────────────

function renderMethodChart(g, wrap) {
  if (!wrap || typeof d3 === 'undefined') return;
  wrap.innerHTML = '';

  var W  = wrap.offsetWidth || 500;
  var H  = 160;
  var method = g.method;

  if (method === 'undercoded' || method === 'tree-proximity') {
    // Deviation bar chart: use count vs sibling mean
    var codes   = g.codes;
    var uses    = codes.map(function(c) { return {code:c, uses: codeUses(c)}; });
    var mean    = uses.reduce(function(s,x){return s+x.uses;},0) / uses.length;
    uses.sort(function(a,b){return b.uses-a.uses;});

    var margin = {top:10, right:20, bottom:30, left:10};
    var iW = W - margin.left - margin.right;
    var iH = H - margin.top  - margin.bottom;

    var svg = d3.select(wrap).append('svg').attr('width',W).attr('height',H);
    var g_el = svg.append('g').attr('transform','translate('+margin.left+','+margin.top+')');

    var x = d3.scaleBand().domain(uses.map(function(d){return d.code;})).range([0,iW]).padding(0.15);
    var y = d3.scaleLinear().domain([0,d3.max(uses,function(d){return d.uses;})*1.15]).range([iH,0]);

    g_el.selectAll('rect').data(uses).enter().append('rect')
      .attr('x',function(d){return x(d.code);})
      .attr('y',function(d){return y(d.uses);})
      .attr('width',x.bandwidth())
      .attr('height',function(d){return iH-y(d.uses);})
      .attr('fill',function(d){return d.uses < mean*0.5 ? 'var(--red)' : 'var(--accent)';})
      .attr('fill-opacity',0.7)
      .attr('rx',2);

    // Mean line
    g_el.append('line').attr('x1',0).attr('x2',iW).attr('y1',y(mean)).attr('y2',y(mean))
      .attr('stroke','var(--yellow)').attr('stroke-width',1.5).attr('stroke-dasharray','4,3');
    g_el.append('text').attr('x',iW+2).attr('y',y(mean)+3).attr('font-size','9px').attr('fill','var(--yellow)').text('mean');

    g_el.selectAll('text.label').data(uses).enter().append('text')
      .attr('x',function(d){return x(d.code)+x.bandwidth()/2;})
      .attr('y',iH+12).attr('text-anchor','middle').attr('font-size','8px').attr('fill','var(--text-faint)')
      .text(function(d){return truncate(d.code.replace(/^\d{2}_/,''),10);});

    g_el.selectAll('text.val').data(uses).enter().append('text')
      .attr('x',function(d){return x(d.code)+x.bandwidth()/2;})
      .attr('y',function(d){return y(d.uses)-3;})
      .attr('text-anchor','middle').attr('font-size','9px').attr('fill','var(--text-dim)')
      .text(function(d){return d.uses;});

  } else if (method === 'high-variance') {
    // Sparklines: one per code, showing use count per document
    var codes2 = g.codes.slice(0,6);
    var rowH   = Math.floor(H / codes2.length);
    var svg    = d3.select(wrap).append('svg').attr('width',W).attr('height',H);
    var labelW = 100;

    codes2.forEach(function(code, i) {
      var vals = DOC_NAMES.map(function(doc) {
        return (DOC_CODE_MATRIX[doc] && DOC_CODE_MATRIX[doc].indexOf(code) >= 0) ? 1 : 0;
      });
      var y0   = i * rowH;
      var x    = d3.scaleLinear().domain([0,DOC_NAMES.length-1]).range([labelW,W-10]);
      var yMax = d3.max(vals) || 1;
      var y    = d3.scaleLinear().domain([0,yMax]).range([y0+rowH-4, y0+4]);

      svg.append('text').attr('x',4).attr('y',y0+rowH/2+4)
        .attr('font-size','9px').attr('fill','var(--text-dim)')
        .text(truncate(code.replace(/^\d{2}_/,''),14));

      var line = d3.line().x(function(_,j){return x(j);}).y(function(d){return y(d);}).curve(d3.curveStepAfter);
      svg.append('path').datum(vals).attr('d',line)
        .attr('stroke','var(--accent)').attr('stroke-width',1.5).attr('fill','none').attr('opacity',0.8);

      // Area fill
      var area = d3.area().x(function(_,j){return x(j);}).y0(y(0)).y1(function(d){return y(d);}).curve(d3.curveStepAfter);
      svg.append('path').datum(vals).attr('d',area)
        .attr('fill','var(--accent)').attr('opacity',0.15);

      if (i < codes2.length-1) {
        svg.append('line').attr('x1',0).attr('x2',W).attr('y1',y0+rowH).attr('y2',y0+rowH)
          .attr('stroke','var(--border-dim)').attr('stroke-width',0.5);
      }
    });

  } else if (method === 'co-occurrence') {
    // Pairwise Jaccard matrix heatmap
    var codes3 = g.codes.slice(0,8);
    var n      = codes3.length;
    var cell   = Math.min(Math.floor((Math.min(W,H)-40)/n), 40);
    var mW     = cell*n+80, mH = cell*n+80;
    var svg    = d3.select(wrap).append('svg').attr('width',Math.min(W,mW)).attr('height',Math.min(H+60,mH));
    var off    = 60;

    var color = d3.scaleSequential(d3.interpolateBlues).domain([0,1]);

    codes3.forEach(function(ca,i) {
      codes3.forEach(function(cb,j) {
        var jv = i===j ? 1 : jaccard(ca,cb);
        svg.append('rect').attr('x',off+j*cell).attr('y',off+i*cell).attr('width',cell-1).attr('height',cell-1)
          .attr('fill',color(jv)).attr('rx',2);
        if (jv > 0.1) {
          svg.append('text').attr('x',off+j*cell+cell/2).attr('y',off+i*cell+cell/2+3)
            .attr('text-anchor','middle').attr('font-size','8px').attr('fill','#000').attr('opacity',0.7)
            .text(jv.toFixed(2));
        }
      });
      // Row labels
      svg.append('text').attr('x',off-3).attr('y',off+i*cell+cell/2+3)
        .attr('text-anchor','end').attr('font-size','8px').attr('fill','var(--text-faint)')
        .text(truncate(ca.replace(/^\d{2}_/,''),10));
      // Col labels
      svg.append('text')
        .attr('transform','translate('+(off+i*cell+cell/2)+','+(off-3)+') rotate(-30)')
        .attr('text-anchor','start').attr('font-size','8px').attr('fill','var(--text-faint)')
        .text(truncate(ca.replace(/^\d{2}_/,''),10));
    });

  } else {
    // Generic: horizontal bar chart of use counts
    var codes4 = g.codes;
    var uses4   = codes4.map(function(c){return {code:c,uses:codeUses(c)};}).sort(function(a,b){return b.uses-a.uses;});
    var svg     = d3.select(wrap).append('svg').attr('width',W).attr('height',H);
    var barH    = Math.min(20, Math.floor((H-20)/codes4.length));
    var maxU    = d3.max(uses4,function(d){return d.uses;}) || 1;
    var labelW2 = 130;

    uses4.forEach(function(d,i) {
      var y = 10 + i*barH;
      var bw = Math.max(2,(d.uses/maxU)*(W-labelW2-20));
      svg.append('text').attr('x',labelW2-4).attr('y',y+barH*0.7)
        .attr('text-anchor','end').attr('font-size','9px').attr('fill','var(--text-dim)')
        .text(truncate(d.code.replace(/^\d{2}_/,''),18));
      svg.append('rect').attr('x',labelW2).attr('y',y+1).attr('width',bw).attr('height',barH-3)
        .attr('fill','var(--accent)').attr('fill-opacity',0.6).attr('rx',2);
      svg.append('text').attr('x',labelW2+bw+4).attr('y',y+barH*0.7)
        .attr('font-size','9px').attr('fill','var(--text-faint)').text(d.uses);
    });
  }
}

// ── Run history ───────────────────────────────────────────────────────────────

function buildRunHistory() {
  var pane = h('div', {className: 'right-pane'});
  pane.appendChild(h('div', {className: 'pane-label'}, 'Recent runs'));
  state.reports.forEach(function(r) { pane.appendChild(buildRunCard(r)); });
  return pane;
}

function buildRunCard(r) {
  var secs = r.elapsed ? Math.round(r.elapsed/1000) : 0;
  var mins = Math.floor(secs/60);
  var timeStr = mins > 0 ? mins+'m '+(secs%60)+'s' : secs+'s';
  var card = h('div', {className: 'run-card'});
  card.appendChild(h('div', {className: 'run-card-label'}, r.label || r.codes.join(' · ')));
  card.appendChild(h('div', {className: 'run-card-meta'},
    r.ts.slice(0,16).replace('T',' ') + (r.elapsed?' · '+timeStr:'') + ' · '+r.codes.length+' codes'));
  if (r.error) card.appendChild(h('div', {className: 'run-card-error'}, r.error));
  var btns = h('div', {className: 'run-card-btns'});
  if (r.html_url) {
    var a = document.createElement('a');
    a.href=r.html_url; a.target='_blank'; a.className='run-card-btn primary'; a.textContent='↗ Report';
    btns.appendChild(a);
  }
  if (r.abridged_url) {
    var b = document.createElement('a');
    b.href=r.abridged_url; b.target='_blank'; a.className='run-card-btn'; b.textContent='Abridged';
    btns.appendChild(b);
  }
  if (r.html_url||r.abridged_url) card.appendChild(btns);
  return card;
}

// ── Running ───────────────────────────────────────────────────────────────────

function buildRunning() {
  var wrap = h('div', {className: 'running-pane'});
  wrap.appendChild(h('div', {className: 'spinner'}));
  var lines = (state.progress||'').split('\n');
  lines.forEach(function(line,i) {
    if (!line.trim()) return;
    wrap.appendChild(h('div', {
      className:'run-log',
      style:{color:i===0?'var(--text-dim)':'var(--text-faint)',fontSize:i===0?'13px':'11px'}
    }, line));
  });
  if (state.startedAt) {
    var el = Math.round((Date.now()-state.startedAt)/1000);
    var mn = Math.floor(el/60);
    wrap.appendChild(h('div',{className:'run-elapsed'},(mn>0?mn+'m '+(el%60)+'s':el+'s')+' elapsed'));
    setTimeout(function(){if(state.running)render();},1000);
  }
  return wrap;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function codeUses(name) { return (CORPUS_INDEX[name]||{}).total||0; }

async function boot() {
  state.lightMode = !qcInitTheme();
  render();
  // Initialise shared nav right side
  var _nav = document.querySelector('.qc-nav');
  if (_nav) qcInitNav(_nav, {
    apiBase: 'http://localhost:' + (REFLECT_CONFIG.server_port || 8080),
    onTheme: function() { state.lightMode = !qcIsDarkMode(); render(); }
  });
}

if (document.getElementById('qc-reflect-root')) { boot(); }
else { document.addEventListener('DOMContentLoaded', boot); }

})();