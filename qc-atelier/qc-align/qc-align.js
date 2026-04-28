// qc-align.js
// Qualitative coding reflection tool.
// Data injected by qc-align-filter.lua:
//   DOC_NAMES, ALL_CODES, CORPUS_INDEX, CODE_COLORS,
//   CODEBOOK_TREE, COOC_DATA, ALIGN_CONFIG

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────


  // ── Hierarchy context builder ──────────────────────────────────────────────
  // Walks up the tree from a code name, collecting scope + rationale at each level.
  function buildHierarchyContext(codeName, docsData) {
    var context = [];
    var current = codeName;
    var visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      var node = CODEBOOK_TREE.find(function(n) { return n.name === current; });
      var doc  = (docsData && docsData[current]) || {};
      if (node) {
        context.unshift({
          name:      current,
          depth:     node.depth,
          scope:     doc.scope     || '',
          rationale: doc.rationale || '',
        });
        current = node.parent || null;
      } else {
        break;
      }
    }
    return context;
  }

  function hierarchyContextText(codeName, docsData) {
    var ctx = buildHierarchyContext(codeName, docsData);
    if (ctx.length <= 1) return '';
    return ctx.slice(0, -1).map(function(c) {
      return '[' + c.name + ']\n'
        + (c.scope     ? '  scope: '     + c.scope     + '\n' : '')
        + (c.rationale ? '  rationale: ' + c.rationale + '\n' : '');
    }).join('');
  }

  // ── Suggestion card helpers ────────────────────────────────────────────────
  function makeSuggestionId() {
    return 'sg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  function setSuggestionStatus(reportId, suggId, status, note) {
    var report = state.reports[reportId];
    if (!report) return;
    var sg = report.suggestions.find(function(s) { return s.id === suggId; });
    if (!sg) return;
    sg.status       = status;
    sg.decision_note = note || '';
    // Log to align-log
    logAlignEntry({
      mode:           report.mode,
      suggestion_id:  suggId,
      status:         status,
      decision_note:  note || '',
      refactor_op:    sg.refactor_op || null,
      db_ops:         sg.db_ops      || null,
      corpus_ops:     sg.corpus_ops  || null,
    });
    if (status === 'accepted' && sg.refactor_op) {
      sendToRefactorQueue(sg.refactor_op);
    }
    render();
  }

  function logAlignEntry(entry) {
    entry.ts = new Date().toISOString();
    fetch(API + '/align/log', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(entry),
    }).catch(function(e) { console.warn('[align/log]', e); });
  }

  function sendToRefactorQueue(refactorOp) {
    fetch(API + '/refactor/queue', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ops: [refactorOp] }),
    }).catch(function(e) { console.warn('[refactor/queue]', e); });
  }

  // ── Prompt builders per audit mode ────────────────────────────────────────
  function buildOverlapPrompt(codeA, codeB, docsData) {
    var docA = docsData[codeA] || {};
    var docB = docsData[codeB] || {};
    var excerA = (CORPUS_INDEX[codeA] || {}).excerpts || [];
    var excerB = (CORPUS_INDEX[codeB] || {}).excerpts || [];
    var coocEntry = COOC_DATA.find(function(c) {
      return (c.code_a === codeA && c.code_b === codeB) ||
             (c.code_a === codeB && c.code_b === codeA);
    });
    var shared = coocEntry ? coocEntry.shared_docs : 0;
    var hierA = hierarchyContextText(codeA, docsData);
    var hierB = hierarchyContextText(codeB, docsData);

    return [
      'TASK: Assess whether two codes have genuinely distinct analytical boundaries or collapse in practice.',
      '',
      hierA ? 'HIERARCHY CONTEXT FOR ' + codeA + ':\n' + hierA : '',
      '== CODE A: ' + codeA + ' ==',
      'scope: '       + (docA.scope       || '(undocumented)'),
      'rationale: '   + (docA.rationale   || '(undocumented)'),
      'usage_notes: ' + (docA.usage_notes || '(undocumented)'),
      'uses: '        + ((CORPUS_INDEX[codeA] || {}).total || 0),
      'sample excerpts:',
      excerA.slice(0, 5).map(function(e) { return '  [' + e.doc + ':' + e.line + '] ' + e.text; }).join('\n'),
      '',
      hierB ? 'HIERARCHY CONTEXT FOR ' + codeB + ':\n' + hierB : '',
      '== CODE B: ' + codeB + ' ==',
      'scope: '       + (docB.scope       || '(undocumented)'),
      'rationale: '   + (docB.rationale   || '(undocumented)'),
      'usage_notes: ' + (docB.usage_notes || '(undocumented)'),
      'uses: '        + ((CORPUS_INDEX[codeB] || {}).total || 0),
      'sample excerpts:',
      excerB.slice(0, 5).map(function(e) { return '  [' + e.doc + ':' + e.line + '] ' + e.text; }).join('\n'),
      '',
      'CO-OCCURRENCE: these codes appear in ' + shared + ' shared documents.',
      '',
      'Respond with a JSON object:',
      '{',
      '  "overlap": true|false,',
      '  "description": "one sentence summary",',
      '  "rationale": "analytical justification referencing hierarchy context",',
      '  "suggestion_type": "merge|rename|keep-separate",',
      '  "target_name": "suggested merged name if merge",',
      '  "evidence": [{"doc":"...","line":0,"text":"..."}]',
      '}',
    ].filter(Boolean).join('\n');
  }

  function buildBloatPrompt(parentCode, siblings, docsData) {
    var parentDoc = docsData[parentCode] || {};
    var hierCtx   = hierarchyContextText(parentCode, docsData);

    var siblingsText = siblings.map(function(name) {
      var doc   = docsData[name] || {};
      var excrs = (CORPUS_INDEX[name] || {}).excerpts || [];
      return [
        '-- ' + name + ' (uses: ' + ((CORPUS_INDEX[name]||{}).total||0) + ')',
        'scope: '     + (doc.scope     || '(undocumented)'),
        'rationale: ' + (doc.rationale || '(undocumented)'),
        'sample: '    + (excrs[0] ? excrs[0].text : '(none)'),
      ].join('\n');
    }).join('\n\n');

    return [
      'TASK: Assess whether the children of a parent code are genuinely distinct or whether some are redundant.',
      '',
      hierCtx ? 'HIERARCHY CONTEXT:\n' + hierCtx : '',
      '== PARENT: ' + parentCode + ' ==',
      'scope: '     + (parentDoc.scope     || '(undocumented)'),
      'rationale: ' + (parentDoc.rationale || '(undocumented)'),
      '',
      '== CHILDREN (' + siblings.length + ') ==',
      siblingsText,
      '',
      'Respond with a JSON object:',
      '{',
      '  "bloat_detected": true|false,',
      '  "description": "one sentence summary",',
      '  "rationale": "justification referencing parent scope",',
      '  "suggestions": [{"type":"merge|delete|keep","codes":["A","B"],"target":"merged name","reason":"..."}]',
      '}',
    ].filter(Boolean).join('\n');
  }

  // ── makeReport / runReport ────────────────────────────────────────────────
  var _reportCounter = 0;
  function makeReport(codes) {
    var id = 'report_' + (++_reportCounter);
    state.reports[id] = {
      id:          id,
      mode:        state.auditMode,
      codes:       codes,
      status:      'pending',
      suggestions: [],
      error:       null,
      ts:          new Date().toISOString(),
    };
    return id;
  }

  async function runReport(reportId) {
    var report = state.reports[reportId];
    if (!report) return;
    report.status = 'running';
    render();

    try {
      // Load docs for hierarchy context
      var docsRes  = await fetch(API + '/docs/load?path=' + encodeURIComponent(ALIGN_CONFIG.scheme_path));
      var docsData = {};
      if (docsRes.ok) {
        var docsJson = await docsRes.json();
        docsData = docsJson.codes || {};
      }

      var suggestions = [];

      if (report.mode === 'overlap') {
        suggestions = await runOverlapAudit(report.codes, docsData);
      } else if (report.mode === 'bloat') {
        suggestions = await runBloatAudit(report.codes, docsData);
      } else {
        // Other modes — placeholder
        suggestions = [{
          id:          makeSuggestionId(),
          mode:        report.mode,
          codes:       report.codes.slice(0, 3),
          type:        'pending',
          description: report.mode + ' audit — full implementation coming',
          rationale:   '',
          evidence:    [],
          status:      'pending',
          decision_note: '',
          refactor_op: null,
        }];
      }

      report.suggestions = suggestions;
      report.status = 'done';
    } catch(e) {
      report.status = 'error';
      report.error  = String(e.message || e);
    }
    render();
  }

  async function runOverlapAudit(codes, docsData) {
    // Find co-occurring pairs within scope
    var codeSet = new Set(codes);
    var pairs = COOC_DATA
      .filter(function(c) { return codeSet.has(c.code_a) && codeSet.has(c.code_b); })
      .slice(0, ALIGN_CONFIG.max_pairs || 40);

    var suggestions = [];
    for (var i = 0; i < Math.min(pairs.length, 10); i++) {
      var pair = pairs[i];
      var prompt = buildOverlapPrompt(pair.code_a, pair.code_b, docsData);
      var result = await ollamaJSON(prompt);
      if (!result) continue;
      suggestions.push({
        id:           makeSuggestionId(),
        mode:         'overlap',
        codes:        [pair.code_a, pair.code_b],
        type:         result.suggestion_type || 'keep-separate',
        description:  result.description || '',
        rationale:    result.rationale   || '',
        evidence:     result.evidence    || [],
        status:       'pending',
        decision_note: '',
        refactor_op:  result.suggestion_type === 'merge' ? {
          type:    'merge',
          sources: [pair.code_a, pair.code_b],
          target:  result.target_name || pair.code_b,
        } : null,
      });
    }
    return suggestions;
  }

  async function runBloatAudit(codes, docsData) {
    // Group selected codes by parent
    var codeSet  = new Set(codes);
    var byParent = {};
    CODEBOOK_TREE.forEach(function(node) {
      if (!codeSet.has(node.name)) return;
      var p = node.parent || '__root__';
      if (!byParent[p]) byParent[p] = [];
      byParent[p].push(node.name);
    });

    var suggestions = [];
    for (var parent in byParent) {
      var siblings = byParent[parent];
      if (siblings.length < 2) continue;
      var parentName = parent === '__root__' ? '' : parent;
      var prompt     = buildBloatPrompt(parentName, siblings, docsData);
      var result     = await ollamaJSON(prompt);
      if (!result || !result.bloat_detected) continue;
      (result.suggestions || []).forEach(function(sg) {
        if (sg.type === 'keep') return;
        suggestions.push({
          id:           makeSuggestionId(),
          mode:         'bloat',
          codes:        sg.codes || siblings,
          type:         sg.type  || 'merge',
          description:  sg.reason || result.description || '',
          rationale:    result.rationale || '',
          evidence:     [],
          status:       'pending',
          decision_note: '',
          refactor_op:  sg.type === 'merge' ? {
            type:    'merge',
            sources: sg.codes || [],
            target:  sg.target || '',
          } : null,
        });
      });
    }
    return suggestions;
  }

  // ── Suggestion card renderer ───────────────────────────────────────────────
  function buildSuggestionCard(sg, reportId) {
    var statusClass = {
      pending:  '',
      accepted: ' sg-accepted',
      rejected: ' sg-rejected',
      deferred: ' sg-deferred',
    }[sg.status] || '';

    var card = h('div', { className: 'sg-card' + statusClass });

    var header = h('div', { className: 'sg-header' });
    header.appendChild(h('span', { className: 'sg-badge sg-badge-' + sg.mode }, sg.mode));
    header.appendChild(h('span', { className: 'sg-codes' }, sg.codes.join(' + ')));
    if (sg.type && sg.type !== 'pending') {
      header.appendChild(h('span', { className: 'sg-type' }, sg.type));
    }
    card.appendChild(header);

    if (sg.description) card.appendChild(h('div', { className: 'sg-desc' }, sg.description));
    if (sg.rationale)   card.appendChild(h('div', { className: 'sg-rationale' }, sg.rationale));

    if (sg.evidence && sg.evidence.length > 0) {
      var evWrap = h('div', { className: 'sg-evidence' });
      sg.evidence.slice(0, 3).forEach(function(e) {
        evWrap.appendChild(h('div', { className: 'sg-ev-item' },
          h('span', { className: 'sg-ev-ref' }, '[' + e.doc + ':' + e.line + '] '),
          h('span', { className: 'sg-ev-text' }, e.text)
        ));
      });
      card.appendChild(evWrap);
    }

    if (sg.status === 'pending') {
      var noteInput = h('input', {
        type:        'text',
        className:   'sg-note-input',
        placeholder: 'Decision note (optional)…',
      });
      var actions = h('div', { className: 'sg-actions' });
      var acceptBtn = h('button', { className: 'btn primary sg-btn', onClick: function() {
        setSuggestionStatus(reportId, sg.id, 'accepted', noteInput.value);
      }}, '✓ Accept');
      var rejectBtn = h('button', { className: 'btn sg-btn', onClick: function() {
        setSuggestionStatus(reportId, sg.id, 'rejected', noteInput.value);
      }}, '✗ Reject');
      var deferBtn = h('button', { className: 'btn sg-btn', onClick: function() {
        setSuggestionStatus(reportId, sg.id, 'deferred', noteInput.value);
      }}, '⏸ Defer');
      actions.appendChild(acceptBtn);
      actions.appendChild(rejectBtn);
      actions.appendChild(deferBtn);
      card.appendChild(noteInput);
      card.appendChild(actions);
    } else {
      var statusRow = h('div', { className: 'sg-status-row' },
        h('span', { className: 'sg-status-label' }, sg.status),
        sg.decision_note ? h('span', { className: 'sg-decision-note' }, sg.decision_note) : null
      );
      card.appendChild(statusRow);
    }

    return card;
  }

  // ── ollamaJSON helper ──────────────────────────────────────────────────────
  async function ollamaJSON(prompt) {
    var model = ALIGN_CONFIG.ollama_model || 'qwen3:35b';
    var fullPrompt = prompt + '\n\nRespond ONLY with valid JSON, no markdown, no explanation.';
    try {
      var res = await fetch(API + '/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          model:  model,
          stream: false,
          think:  false,
          messages: [{ role: 'user', content: fullPrompt }],
        }),
      });
      var data = await res.json();
      var text = data.message && data.message.content ? data.message.content : '';
      text = text.replace(/```json\n?|```\n?/g, '').trim();
      return JSON.parse(text);
    } catch(e) {
      console.warn('[ollamaJSON]', e);
      return null;
    }
  }

  const AUDIT_MODES = [
    { id: 'overlap',          label: 'Overlap',          model: 'qwen3:35b', desc: 'Codes that blur together in practice' },
    { id: 'inconsistency',    label: 'Inconsistency',    model: 'qwen3:35b', desc: 'Codes applied against their documented intent' },
    { id: 'bloat',            label: 'Bloat',            model: 'qwen3:35b', desc: 'Redundant sibling codes under the same parent' },
    { id: 'restructure',      label: 'Restructure',      model: 'qwen3:35b', desc: 'Propose alternative tree organisations' },
    { id: 'line-split',       label: 'Line splitting',   model: 'qwen3:8b',  desc: 'Detect topically composite lines' },
    { id: 'code-propagation', label: 'Code propagation', model: 'qwen3:8b',  desc: 'Missing codes in adjacent conversational context' },
  ];

  const state = {
    activeReportId: null,      // currently shown report key
    activeTab:  'report',      // 'report' | 'excerpts' | 'chat' | 'export'
    reports:    {},            // reportId -> report object (see makeReport)
    queue:      [],            // ordered list of reportIds (auto-generated)
    queuePhase: 'idle',        // 'idle' | 'running' | 'done' | 'error'
    queueError: null,
    modalOpen:  false,
    customSelectedCodes: [],
    customSearchQuery: '',
  };

  // ── Report object factory ──────────────────────────────────────────────────
  // Each report tracks its own status, LLM results, conversation, and decisions.

  function makeReport(codes) {
    const id = codes.slice().sort().join('|');
    if (state.reports[id]) return id;
    state.reports[id] = {
      id,
      codes,
      status:      'pending',  // pending|running|done|error
      error:       null,
      analysis:    null,       // { overview, how_applied, overlaps, suggestions }
      suggestions: [],         // [{id, type, description, rationale, refs, commands, status}]
      chat:        [],         // [{role:'user'|'model', content}]
      chatRunning: false,
    };
    return id;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'style' && typeof v === 'object') { Object.assign(el.style, v); }
      else if (k.startsWith('on') && typeof v === 'function') { el.addEventListener(k.slice(2).toLowerCase(), v); }
      else if (k === 'className') { el.className = v; }
      else if (k === 'htmlFor')   { el.htmlFor = v; }
      else if (k === 'checked')   { el.checked = v; }
      else if (k === 'disabled')  { el.disabled = v; }
      else { el.setAttribute(k, v); }
    }
    for (const child of children) {
      if (child == null) continue;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  }

  function codeColor(code) { return CODE_COLORS[code] || '#757575'; }

  function codeChip(code) {
    return h('span', {
      className: 'code-chip',
      style: { background: codeColor(code) },
      title: code,
    }, code);
  }

  function statusDot(status) {
    return h('span', { className: `status-dot ${status}` });
  }

  function reportLabel(codes) {
    if (codes.length === 2) return codes.join(' × ');
    return codes.slice(0, 3).join(' × ') + (codes.length > 3 ? ` +${codes.length - 3}` : '');
  }

  // Sample up to N excerpts from a code, spread across docs for diversity
  function sampleExcerpts(code, maxN) {
    const all = (CORPUS_INDEX[code] || {}).excerpts || [];
    if (all.length <= maxN) return all;
    const result = [];
    const step = all.length / maxN;
    for (let i = 0; i < maxN; i++) {
      result.push(all[Math.floor(i * step)]);
    }
    return result;
  }

  // ── Ollama query ───────────────────────────────────────────────────────────

  async function ollamaChat(messages) {
    const res = await fetch(ALIGN_CONFIG.ollama_url + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:   ALIGN_CONFIG.ollama_model,
        messages,
        stream:  false,
        options: { temperature: 0.2, num_ctx: ALIGN_CONFIG.num_ctx },
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data.message?.content || data.response || '';
    if (!text) throw new Error('Empty response from Ollama: ' + JSON.stringify(data).slice(0, 200));
    return text;
  }

  async function ollamaJSON(messages) {
    const text = await ollamaChat(messages);
    const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON in response: ' + cleaned.slice(0, 300));
    return JSON.parse(cleaned.slice(start, end + 1));
  }

  // ── Ollama connectivity check ──────────────────────────────────────────────

  async function checkOllama() {
    const res = await fetch(ALIGN_CONFIG.ollama_url + '/api/tags');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    const base = ALIGN_CONFIG.ollama_model.split(':')[0];
    if (!models.some(m => m.startsWith(base))) {
      throw new Error(
        `Model "${ALIGN_CONFIG.ollama_model}" not found. ` +
        `Available: ${models.join(', ') || 'none'}. ` +
        `Run: ollama pull ${ALIGN_CONFIG.ollama_model}`
      );
    }
  }

  // ── Build LLM prompts for a report ────────────────────────────────────────

  function buildReportPrompt(codes) {
    // Use more excerpts — comprehensiveness is the goal
    const MAX_EX = Math.min(20, Math.floor(ALIGN_CONFIG.num_ctx / (codes.length * 350)));

    // Tree context
    const nodeMap = {};
    const _tree = Array.isArray(CODEBOOK_TREE) ? CODEBOOK_TREE : Object.values(CODEBOOK_TREE);
    for (const node of _tree) nodeMap[node.name] = node;

    const sections = codes.map(code => {
      const exs  = sampleExcerpts(code, MAX_EX);
      const info = CORPUS_INDEX[code] || {};
      const node = nodeMap[code];
      const treeInfo = node
        ? `Parent: ${node.parent || '(root)'}  |  Siblings: ${
            node.parent && nodeMap[node.parent]
              ? nodeMap[node.parent].children.filter(c => c !== code).slice(0,5).join(', ') || 'none'
              : 'n/a'
          }  |  Children: ${node.children.slice(0,5).join(', ') || 'none'}`
        : '(not in codebook tree)';
      const sharedDocs = codes.filter(c => c !== code).map(other => {
        const shared = coocBetween(code, other);
        return shared > 0 ? `${shared} shared docs with ${other}` : null;
      }).filter(Boolean).join(', ');
      const lines = exs.map((e, i) =>
        `  [${i+1}] ${e.doc} line ${e.line}: ${e.text.slice(0, 400)}`
      ).join('\n');
      return `### Code: ${code}\nTree position: ${treeInfo}\nTotal uses: ${info.total || 0} across ${(info.docs||[]).length} documents\nCo-occurrence: ${sharedDocs || 'none recorded'}\nExcerpts:\n${lines}`;
    }).join('\n\n');

    // ── Nearby codebook context for new-code suggestions ──────────────────────
    // Collect codes that share a parent or prefix with any code under review,
    // excluding the codes under review themselves. This lets the LLM check
    // whether a proposed new code already exists under a different name.
    const reviewSet = new Set(codes);
    const nearbySet = new Set();

    for (const code of codes) {
      const node = nodeMap[code];
      if (!node) continue;

      // Siblings (same parent)
      if (node.parent && nodeMap[node.parent]) {
        for (const sib of nodeMap[node.parent].children) {
          if (!reviewSet.has(sib)) nearbySet.add(sib);
        }
      }
      // Children
      for (const child of (node.children || [])) {
        if (!reviewSet.has(child)) nearbySet.add(child);
      }
      // Same-prefix codes (broader neighbourhood)
      const prefix = code.match(/^(\d\d)_/)?.[1];
      if (prefix) {
        for (const n of _tree) {
          if (n.prefix === prefix && !reviewSet.has(n.name)) nearbySet.add(n.name);
        }
      }
    }

    // Format nearby codes as a compact list with use counts
    const nearbyLines = [...nearbySet]
      .sort()
      .map(name => {
        const uses = CORPUS_INDEX[name]?.total || 0;
        const n = nodeMap[name];
        const parent = n?.parent || '';
        return `  ${name}  (uses: ${uses}${parent ? ', under: ' + parent : ''})`;
      })
      .join('\n');

    const nearbyContext = nearbySet.size > 0
      ? `NEARBY CODEBOOK ENTRIES (existing codes in the same region of the codebook — consult these before suggesting new codes):
${nearbyLines}`
      : '';

    const userMsg = `You are helping a qualitative researcher reflect on their coding practice.

The researcher wants a comprehensive analysis of how these codes are being applied and whether there are problems to fix.

CODES UNDER REVIEW: ${codes.join(', ')}

CORPUS EXCERPTS (numbered [doc line: text]):
${sections}

${nearbyContext}

Please produce a thorough analysis. For each code:
- Describe how it is actually being applied in practice, with reference to specific excerpts (cite as [doc L##])
- Note where its effective usage overlaps, blurs, or conflicts with the other codes under review — give concrete examples from the excerpts
- Flag any excerpts that appear to be miscoded or ambiguous

When suggesting new codes: first check the NEARBY CODEBOOK ENTRIES above. If a similar code already exists, suggest using or adapting it rather than creating a duplicate. If you do suggest a new code, explain why existing nearby codes are insufficient.

Return ONLY valid JSON in this exact structure (no markdown fences):
{
  "overview": "2-3 sentence summary of the main findings and most important issues",
  "how_applied": {
    "CODE_NAME": "Comprehensive description of how this code is used in practice. Include: its effective scope, characteristic patterns in the excerpts (cite specific ones as [doc L##]), and where it blurs with or differs from the other codes under review."
  },
  "suggestions": [
    {
      "type": "reassign|add-code|merge|delete|rename",
      "description": "What to do, clearly stated",
      "rationale": "Why — reference specific excerpts or patterns as evidence. For add-code: explain why no existing nearby code covers this.",
      "refs": [{"doc": "docname", "line": 123, "current_code": "old_code", "new_code": "new_code"}],
      "commands": ["qc codes rename old new"]
    }
  ]
}`;

    return [
      {
        role: 'system',
        content: 'You are a JSON API. Output ONLY valid JSON. No markdown fences, no explanation outside the JSON object. Start your response with { and end with }.',
      },
      { role: 'user', content: userMsg },
    ];
  }

  // ── Run analysis for a single report ──────────────────────────────────────

  async function runReport(reportId) {
    const report = state.reports[reportId];
    if (!report || report.status === 'done') return;

    report.status = 'running';
    render();

    try {
      const messages = buildReportPrompt(report.codes);
      const result   = await ollamaJSON(messages);

      // Normalise suggestions — assign stable IDs and initial status
      const suggestions = (result.suggestions || []).map((s, i) => ({
        ...s,
        id:     `${reportId}__s${i}`,
        status: 'pending',  // pending|accepted|rejected
        refs:   s.refs || [],
        commands: s.commands || [],
      }));

      report.analysis    = result;
      report.suggestions = suggestions;
      report.status      = 'done';

      // Seed the chat with the overview so it's immediately useful
      report.chat = [{
        role: 'model',
        content: result.overview || 'Analysis complete. Ask me anything about these codes.',
      }];

    } catch (err) {
      report.status = 'error';
      report.error  = err.message;
    }

    render();
  }

  // ── Initialise the auto-detected queue and kick off LLM passes ────────────

  // ── LLM-driven candidate ranking ─────────────────────────────────────────
  // Phase 1: one call per category group (within-category overlaps)
  // Phase 2: one cross-category call using top codes from each group
  // Results merged, deduped, capped at ALIGN_CONFIG.max_pairs

  function buildTreeContext(codes) {
    // Build a compact tree-context string for a set of codes
    const nodeMap = {};
    const _tree = Array.isArray(CODEBOOK_TREE) ? CODEBOOK_TREE : Object.values(CODEBOOK_TREE);
    for (const node of _tree) nodeMap[node.name] = node;
    return codes.map(code => {
      const node = nodeMap[code];
      if (!node) return code;
      const parentStr = node.parent ? ` (under: ${node.parent})` : '';
      const childStr  = node.children.length > 0 ? ` [children: ${node.children.slice(0,5).join(', ')}${node.children.length > 5 ? '…' : ''}]` : '';
      return `${code}${parentStr}${childStr} uses:${node.uses||0}`;
    }).join('\n');
  }

  function coocBetween(codeA, codeB) {
    for (const row of COOC_DATA) {
      const a = row.code_a < row.code_b ? row.code_a : row.code_b;
      const b = row.code_a < row.code_b ? row.code_b : row.code_a;
      const qa = codeA < codeB ? codeA : codeB;
      const qb = codeA < codeB ? codeB : codeA;
      if (a === qa && b === qb) return row.shared_docs;
    }
    return 0;
  }

  async function rankCandidatesLLM(codes, label) {
    const ctx = buildTreeContext(codes);
    const messages = [
      {
        role: 'system',
        content: 'You are a JSON API. Output ONLY valid JSON — no markdown, no explanation. Start with [ and end with ].',
      },
      {
        role: 'user',
        content: `You are helping a qualitative researcher identify potential problems in their coding scheme.

The following codes are from the category: ${label}

CODE NAMES WITH TREE POSITION AND USE COUNTS:
${ctx}

Identify pairs of codes that likely have thematic overlap, definitional ambiguity, or inconsistent application based on their names and positions in the hierarchy. Consider:
- Codes with similar or overlapping names
- Codes that are siblings in the tree but may be hard to distinguish
- Codes where one might be a special case of another but is coded separately
- Cross-category pairs if included — look for conceptual overlap across different facets

Return a JSON array of objects. Include only pairs with genuine concern, up to 15 pairs:
[
  {
    "code_a": "exact_code_name",
    "code_b": "exact_code_name",
    "concern": "one sentence explaining the likely overlap or ambiguity",
    "severity": "high|medium|low"
  }
]

Only include codes from the list above. If no pairs have meaningful overlap, return [].`,
      },
    ];

    const text = await ollamaChat(messages);
    const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const start = cleaned.indexOf('[');
    const end   = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_) { return []; }
  }

  async function initQueue() {
    if (state.queuePhase !== 'idle') return;

    try {
      await checkOllama();
    } catch (err) {
      state.queueError = err.message;
      state.queuePhase = 'error';
      render();
      return;
    }

    state.queuePhase = 'ranking';
    state.rankingStatus = 'Building candidate queue from codebook…';
    render();

    // Group corpus-active codes by category prefix
    // Guard: CODEBOOK_TREE must be an array (Lua serialisation can return {} for empty)
    const tree = Array.isArray(CODEBOOK_TREE) ? CODEBOOK_TREE : Object.values(CODEBOOK_TREE);
    const byPrefix = {};
    for (const node of tree) {
      if (!node.uses || node.uses === 0) continue;
      const prefix = node.prefix || node.name.match(/^(\d\d)_/)?.[1] || 'other';
      if (!byPrefix[prefix]) byPrefix[prefix] = [];
      byPrefix[prefix].push(node.name);
    }

    const allPairs = [];  // {code_a, code_b, concern, severity, source}
    const seen = new Set();

    function addPair(p, source) {
      const a = p.code_a < p.code_b ? p.code_a : p.code_b;
      const b = p.code_a < p.code_b ? p.code_b : p.code_a;
      const key = a + '|' + b;
      if (!seen.has(key) && ALL_CODES.includes(a) && ALL_CODES.includes(b)) {
        seen.add(key);
        allPairs.push({ code_a: a, code_b: b,
          concern: p.concern || '', severity: p.severity || 'medium',
          source, shared_docs: coocBetween(a, b) });
      }
    }

    // Phase 1: within-category passes
    const prefixes = Object.keys(byPrefix).sort();
    for (let i = 0; i < prefixes.length; i++) {
      const prefix = prefixes[i];
      const codes  = byPrefix[prefix];
      if (codes.length < 2) continue;
      state.rankingStatus = `Scanning category ${prefix}… (${i+1}/${prefixes.length})`;
      render();
      try {
        const pairs = await rankCandidatesLLM(codes, `${prefix}_* (${codes.length} codes)`);
        for (const p of pairs) addPair(p, 'within');
      } catch (e) { console.warn('Ranking error for', prefix, e); }
      await new Promise(r => setTimeout(r, 200));
    }

    // Phase 2: cross-category pass
    // Take up to 4 highest-use codes per prefix and run one combined call
    const topCodes = [];
    for (const prefix of prefixes) {
      const codes = (byPrefix[prefix] || [])
        .map(c => ({ name: c, uses: CORPUS_INDEX[c]?.total || 0 }))
        .sort((a, b) => b.uses - a.uses)
        .slice(0, 4)
        .map(x => x.name);
      topCodes.push(...codes);
    }
    if (topCodes.length >= 2) {
      state.rankingStatus = `Scanning cross-category overlaps…`;
      render();
      try {
        const pairs = await rankCandidatesLLM(topCodes, 'cross-category (top codes from each group)');
        // Only keep pairs that span different prefixes
        for (const p of pairs) {
          const pa = (p.code_a.match(/^(\d\d)_/) || ['',''])[1];
          const pb = (p.code_b.match(/^(\d\d)_/) || ['',''])[1];
          if (pa !== pb) addPair(p, 'cross');
        }
      } catch (e) { console.warn('Cross-category ranking error:', e); }
    }

    // Sort: high severity first, then by co-occurrence as tiebreak
    const severityScore = { high: 3, medium: 2, low: 1 };
    allPairs.sort((a, b) => {
      const sd = (severityScore[b.severity] || 0) - (severityScore[a.severity] || 0);
      if (sd !== 0) return sd;
      return b.shared_docs - a.shared_docs;
    });

    const maxPairs = ALIGN_CONFIG.max_pairs || 40;
    state.queue = [];
    for (const pair of allPairs.slice(0, maxPairs)) {
      const id = makeReport([pair.code_a, pair.code_b]);
      // Attach ranking metadata to report for display
      state.reports[id].rankingConcern  = pair.concern;
      state.reports[id].rankingSeverity = pair.severity;
      state.reports[id].rankingSource   = pair.source;
      state.queue.push(id);
    }

    state.queuePhase = 'running';
    state.rankingStatus = null;
    render();

    // Run deep analysis reports sequentially
    for (const id of state.queue) {
      await runReport(id);
      await new Promise(r => setTimeout(r, 400));
    }

    state.queuePhase = 'done';
    render();
  }

  // ── Chat with a report ─────────────────────────────────────────────────────

  async function sendChat(reportId, userText) {
    const report = state.reports[reportId];
    if (!report || report.chatRunning) return;

    report.chat.push({ role: 'user', content: userText });
    report.chatRunning = true;
    render();

    try {
      const excerptContext = report.codes.map(code => {
        const exs = sampleExcerpts(code, 8);
        return `Code "${code}":\n` + exs.map(e => `  [${e.doc} L${e.line}] ${e.text.slice(0,300)}`).join('\n');
      }).join('\n\n');

      const currentAnalysis = report.analysis
        ? JSON.stringify({ overview: report.analysis.overview, how_applied: report.analysis.how_applied }, null, 2)
        : '(no analysis yet)';

      const systemMsg = {
        role: 'system',
        content: `You are helping a qualitative researcher reflect on their coding practice.
Codes under discussion: ${report.codes.join(', ')}

CURRENT REPORT ANALYSIS:
${currentAnalysis}

CORPUS EXCERPTS FOR CONTEXT:
${excerptContext}

Engage thoughtfully with the researcher's questions and observations. Reference specific excerpts by [doc L##] when relevant. When the conversation leads to revised understanding of how codes are applied or new suggestions, also output an updated report JSON block at the END of your response using this exact format (the researcher's app will parse and apply it):

<updated_analysis>
{
  "overview": "updated overview incorporating new insights",
  "how_applied": {
    "CODE_NAME": "updated description"
  },
  "new_suggestions": [
    {
      "type": "reassign|add-code|merge|delete|rename",
      "description": "...",
      "rationale": "...",
      "refs": [],
      "commands": []
    }
  ]
}
</updated_analysis>

Only include <updated_analysis> when there are genuine revisions to make. Otherwise respond conversationally without it.`,
      };

      const history = report.chat.map(m => ({
        role: m.role === 'model' ? 'assistant' : 'user',
        content: m.content,
      }));

      const messages = [systemMsg, ...history];
      const reply = await ollamaChat(messages);

      // Parse optional updated_analysis block
      const updMatch = reply.match(/<updated_analysis>\s*([\s\S]*?)\s*<\/updated_analysis>/);
      let displayReply = reply;
      if (updMatch) {
        try {
          const parsed = JSON.parse(updMatch[1]);
          // Update the report analysis in-place
          if (parsed.overview)     report.analysis.overview     = parsed.overview;
          if (parsed.how_applied)  report.analysis.how_applied  = parsed.how_applied;
          // Append any new suggestions that aren't already present
          if (parsed.new_suggestions) {
            for (const s of parsed.new_suggestions) {
              const newId = `${reportId}__chat${report.suggestions.length}`;
              report.suggestions.push({ ...s, id: newId, status: 'pending',
                refs: s.refs || [], commands: s.commands || [] });
            }
          }
          // Strip the JSON block from the displayed reply
          displayReply = reply.replace(/<updated_analysis>[\s\S]*?<\/updated_analysis>/, '').trim();
          if (!displayReply) displayReply = '*(Report updated)*';
          report.chat.push({ role: 'model', content: displayReply, updatedReport: true });
        } catch (_) {
          report.chat.push({ role: 'model', content: reply });
        }
      } else {
        report.chat.push({ role: 'model', content: reply });
      }
    } catch (err) {
      report.chat.push({ role: 'model', content: `Error: ${err.message}` });
    }

    report.chatRunning = false;
    render();
  }

  // ── Save / load conversation logs via local server ────────────────────────
  // The companion qc-atelier-server.py handles POST /logs/save and GET /logs/list.

  const LOG_API = 'http://localhost:' + (ALIGN_CONFIG.log_server_port || 8080);

  async function saveLog(reportId) {
    const report = state.reports[reportId];
    if (!report) return;
    try {
      await fetch(LOG_API + '/logs/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:          report.id,
          codes:       report.codes,
          analysis:    report.analysis,
          suggestions: report.suggestions,
          chat:        report.chat,
          savedAt:     new Date().toISOString(),
        }),
      });
    } catch (e) { console.warn('saveLog failed:', e.message); }
  }

  async function loadLogs() {
    try {
      const res = await fetch(LOG_API + '/logs/list');
      if (!res.ok) return;
      const logs = await res.json();
      for (const log of logs) {
        if (log.codes && !state.reports[log.id]) {
          const id = makeReport(log.codes);
          Object.assign(state.reports[id], {
            status:      'done',
            analysis:    log.analysis,
            suggestions: log.suggestions || [],
            chat:        log.chat || [],
          });
        }
      }
    } catch (e) { console.warn('loadLogs failed:', e.message); }
  }

  // ── Generate shell script from accepted suggestions ────────────────────────

  function buildScript(report) {
    const accepted = report.suggestions.filter(s => s.status === 'accepted');
    if (!accepted.length) return '# No accepted suggestions yet.';

    const lines = [
      '#!/bin/bash',
      `# Generated by qc-align`,
      `# Report: ${report.codes.join(', ')}`,
      `# Date: ${new Date().toISOString()}`,
      '',
    ];

    for (const s of accepted) {
      lines.push(`# ${s.type}: ${s.description}`);
      if (s.refs && s.refs.length > 0) {
        lines.push(`# Affects ${s.refs.length} coded line(s)`);
      }
      for (const cmd of (s.commands || [])) {
        lines.push(cmd);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const root = document.getElementById('qc-align-root');
    if (!root) return;
    root.innerHTML = '';

    const shell = h('div', { className: 'app-shell' });

    // Top bar
    const tb = h('div', { className: 'top-bar' },
      h('h1', {}, 'QC Reflect'),
      h('span', { className: 'subtitle' },
        `${DOC_NAMES.length} docs · ${ALL_CODES.length} codes`
      ),
      h('div', { className: 'top-bar-spacer' }),
      h('span', { className: 'model-badge' }, ALIGN_CONFIG.ollama_model),
    );
    shell.appendChild(tb);

    const split = h('div', { className: 'main-split' });

    // Left panel
    split.appendChild(buildLeftPanel());

    // Right panel
    split.appendChild(buildRightPanel());

    shell.appendChild(split);
    root.appendChild(shell);

    // Modal
    if (state.modalOpen) {
      root.appendChild(buildModal());
    }
  }

  // ── Left panel ─────────────────────────────────────────────────────────────

  function buildLeftPanel() {
    const panel = h('div', { className: 'panel-left' });

    // ── Audit mode selector ──────────────────────────────────────────────────
    const modeSection = h('div', { className: 'audit-mode-section' });
    modeSection.appendChild(h('div', { className: 'audit-section-label' }, 'Audit mode'));
    for (const mode of AUDIT_MODES) {
      const btn = h('button', {
        className: 'audit-mode-btn' + (state.auditMode === mode.id ? ' active' : ''),
        title: mode.desc,
        onClick: () => { state.auditMode = mode.id; render(); },
      }, mode.label);
      modeSection.appendChild(btn);
    }
    panel.appendChild(modeSection);

    // ── Scope picker ─────────────────────────────────────────────────────────
    const scopeSection = h('div', { className: 'audit-scope-section' });
    scopeSection.appendChild(h('div', { className: 'audit-section-label' },
      'Scope ',
      h('span', { className: 'audit-scope-count' },
        state.auditScope.length > 0 ? `(${state.auditScope.length} selected)` : '(all)'
      )
    ));

    const scopeSearch = h('input', {
      type: 'text',
      className: 'search-input',
      placeholder: 'Filter codes…',
      value: state.leftSearch || '',
      onInput: e => { state.leftSearch = e.target.value; render(); },
    });
    scopeSection.appendChild(scopeSearch);

    const scopeList = h('div', { className: 'audit-scope-list' });
    const q = (state.leftSearch || '').toLowerCase();

    function renderScopeNodes(nodes, parentName) {
      for (const node of nodes) {
        if (q && !node.name.toLowerCase().includes(q)) continue;
        const isCollapsed = state.auditScopeCollapsed.has(node.name);
        const hasChildren = CODEBOOK_TREE.some(n => n.parent === node.name);
        const isSelected = state.auditScope.includes(node.name);

        const row = h('div', {
          className: 'audit-scope-row',
          style: { paddingLeft: (node.depth * 14 + 4) + 'px' },
        });

        if (!q && hasChildren) {
          const tog = h('button', {
            className: 'scope-toggle',
            onMouseDown: e => {
              e.preventDefault();
              if (isCollapsed) state.auditScopeCollapsed.delete(node.name);
              else state.auditScopeCollapsed.add(node.name);
              render();
            },
          }, isCollapsed ? '▶' : '▼');
          row.appendChild(tog);
        } else {
          row.appendChild(h('span', { className: 'scope-toggle-placeholder' }));
        }

        const cb = h('input', { type: 'checkbox', checked: isSelected });
        cb.addEventListener('change', () => {
          if (cb.checked) {
            if (!state.auditScope.includes(node.name)) state.auditScope.push(node.name);
          } else {
            state.auditScope = state.auditScope.filter(c => c !== node.name);
          }
          render();
        });
        row.appendChild(cb);
        row.appendChild(h('span', { className: 'scope-label' }, node.name));
        const cnt = (CORPUS_INDEX[node.name] || {}).total;
        if (cnt) row.appendChild(h('span', { className: 'picker-count' }, String(cnt)));
        scopeList.appendChild(row);

        if (!q && !isCollapsed && hasChildren) {
          const children = CODEBOOK_TREE.filter(n => n.parent === node.name);
          renderScopeNodes(children, node.name);
        }
      }
    }
    const roots = CODEBOOK_TREE.filter(n => !n.parent);
    renderScopeNodes(roots, null);
    scopeSection.appendChild(scopeList);

    const clearBtn = h('button', {
      className: 'btn audit-scope-clear',
      onClick: () => { state.auditScope = []; render(); },
      disabled: state.auditScope.length === 0,
    }, 'Clear selection');
    scopeSection.appendChild(clearBtn);
    panel.appendChild(scopeSection);

    // ── Run button ────────────────────────────────────────────────────────────
    const runBtn = h('button', {
      className: 'btn primary audit-run-btn',
      onClick: () => {
        const codes = state.auditScope.length > 0
          ? state.auditScope
          : CODEBOOK_TREE.map(n => n.name);
        const id = makeReport(codes);
        state.activeReportId = id;
        state.activeTab = 'report';
        runReport(id);
        render();
      },
    }, 'Run ' + (AUDIT_MODES.find(m => m.id === state.auditMode) || {}).label || 'audit');
    panel.appendChild(runBtn);

    // ── Session summary ───────────────────────────────────────────────────────
    const reports = Object.values(state.reports);
    if (reports.length > 0) {
      const accepted = reports.reduce((n, r) => n + r.suggestions.filter(s => s.status === 'accepted').length, 0);
      const rejected = reports.reduce((n, r) => n + r.suggestions.filter(s => s.status === 'rejected').length, 0);
      const deferred = reports.reduce((n, r) => n + r.suggestions.filter(s => s.status === 'deferred').length, 0);
      const summary = h('div', { className: 'audit-session-summary' },
        h('div', { className: 'audit-section-label' }, 'Session'),
        h('div', { className: 'audit-summary-row' },
          h('span', { className: 'summary-accepted' }, `✓ ${accepted} accepted`),
          h('span', { className: 'summary-rejected' }, `✗ ${rejected} rejected`),
          h('span', { className: 'summary-deferred' }, `⏸ ${deferred} deferred`),
        )
      );
      panel.appendChild(summary);
    }

    // ── Candidate list (existing overlap queue) ───────────────────────────────
    const candidateSection = h('div', { className: 'candidate-section' });
    if (state.queuePhase === 'error') {
      candidateSection.appendChild(h('div', { className: 'error-notice', style: { margin: '12px' } },
        state.queueError || 'Ollama error'
      ));
    }
    const customIds = Object.keys(state.reports).filter(id => !state.queue.includes(id));
    const allIds = [...customIds, ...state.queue];
    for (const id of allIds) {
      const report = state.reports[id];
      if (!report) continue;
      candidateSection.appendChild(buildCandidateItem(report));
    }
    if (allIds.length === 0 && state.queuePhase === 'idle') {
      candidateSection.appendChild(h('div', {
        className: 'loading-bar',
        onClick: initQueue,
        style: { cursor: 'pointer' },
      }, '▶ Click to start overlap analysis'));
    }
    panel.appendChild(candidateSection);

    return panel;
  }


  function buildCandidateItem(report) {
    const isActive = report.id === state.activeReportId;
    const item = h('div', {
      className: 'candidate-item' + (isActive ? ' active' : '') + (report.status === 'running' ? ' loading' : ''),
      onClick: () => {
        state.activeReportId = report.id;
        state.activeTab = 'report';
        render();
        // If not yet run, kick it off (for custom reports)
        if (report.status === 'pending') runReport(report.id);
      },
    });

    const chips = h('div', { className: 'candidate-codes' });
    for (const code of report.codes) chips.appendChild(codeChip(code));
    item.appendChild(chips);

    const meta = [];
    if (report.status === 'running') {
      meta.push(h('span', {}, h('span', { className: 'spinner-inline' }), 'Analysing…'));
    } else if (report.status === 'done') {
      meta.push(statusDot('done'));
      meta.push(document.createTextNode(
        `${report.suggestions.length} suggestion${report.suggestions.length !== 1 ? 's' : ''}`
      ));
    } else if (report.status === 'error') {
      meta.push(statusDot('error'));
      meta.push(document.createTextNode('Error'));
    } else {
      meta.push(statusDot('pending'));
      meta.push(document.createTextNode('Pending'));
    }
    // Show ranking concern as a subtitle if available
    if (report.rankingConcern) {
      const concernEl = h('div', {
        style: { fontSize: '10px', color: 'var(--text-dim)', marginTop: '3px',
                 fontStyle: 'italic', lineHeight: '1.4' }
      }, report.rankingConcern);
      item.appendChild(concernEl);
    }

    const metaEl = h('div', { className: 'candidate-meta' });
    for (const m of meta) {
      if (typeof m === 'string') metaEl.appendChild(document.createTextNode(m));
      else metaEl.appendChild(m);
    }
    item.appendChild(metaEl);

    return item;
  }

  // ── Right panel ────────────────────────────────────────────────────────────

  function buildRightPanel() {
    const panel = h('div', { className: 'panel-right' });

    if (!state.activeReportId || !state.reports[state.activeReportId]) {
      panel.appendChild(buildEmptyState());
      return panel;
    }

    const report = state.reports[state.activeReportId];

    // Tab bar
    const accepted = report.suggestions.filter(s => s.status === 'accepted').length;
    const tabs = [
      { id: 'report',   label: 'Analysis' },
      { id: 'excerpts', label: 'Excerpts' },
      { id: 'chat',     label: `Chat${report.chat.length > 1 ? ` (${report.chat.length})` : ''}` },
      { id: 'export',   label: `Export${accepted ? ` (${accepted})` : ''}` },
    ];

    const tabBar = h('div', { className: 'report-tabs' });
    for (const tab of tabs) {
      const btn = h('button', {
        className: 'report-tab' + (state.activeTab === tab.id ? ' active' : ''),
        onClick: () => { state.activeTab = tab.id; render(); },
      }, tab.label);
      tabBar.appendChild(btn);
    }
    panel.appendChild(tabBar);

    // Content
    const body = h('div', { className: 'report-body' });

    if (report.status === 'pending' || report.status === 'running') {
      body.appendChild(buildLoadingState(report));
    } else if (report.status === 'error') {
      body.appendChild(h('div', { className: 'error-notice' }, report.error || 'Analysis failed'));
    } else {
      if (state.activeTab === 'report')   body.appendChild(buildReportTab(report));
      if (state.activeTab === 'excerpts') body.appendChild(buildExcerptsTab(report));
      if (state.activeTab === 'export')   body.appendChild(buildExportTab(report));
    }

    // Chat always available once report exists (for context)
    if (state.activeTab === 'chat') {
      panel.appendChild(buildChatPanel(report));
      return panel;
    }

    panel.appendChild(body);
    return panel;
  }

  function buildEmptyState() {
    const wrap = h('div', { className: 'report-body' });
    wrap.appendChild(h('div', { className: 'empty-state' },
      h('div', { className: 'big-icon' }, '🔍'),
      h('h3', {}, 'Select a code pair to investigate'),
      h('p', {}, 'The queue on the left shows auto-detected overlaps ranked by co-occurrence. Click any pair to see the LLM analysis, or use "+ Custom" to compare arbitrary codes.'),
    ));
    return wrap;
  }

  function buildLoadingState(report) {
    const wrap = h('div', { className: 'empty-state' });
    wrap.appendChild(h('span', { className: 'spinner-inline' }));
    wrap.appendChild(h('p', {}, 'Analysing ' + reportLabel(report.codes) + '…'));
    return wrap;
  }

  // ── Report tab ─────────────────────────────────────────────────────────────

  function buildReportTab(report) {
    const { analysis, suggestions, codes } = report;
    const wrap = h('div', {});

    // Header
    const titleEl = h('div', { className: 'report-title' });
    for (const code of codes) titleEl.appendChild(codeChip(code));
    const meta = h('div', { className: 'report-meta' },
      `${codes.length} codes · ${suggestions.length} suggestions`
    );
    wrap.appendChild(h('div', { className: 'report-header' }, titleEl, meta));

    if (!analysis) return wrap;

    // Overview
    if (analysis.overview) {
      const sec = h('div', { className: 'section' },
        h('div', { className: 'section-title' }, 'Overview'),
        h('div', { className: 'analysis-text' }, analysis.overview),
      );
      wrap.appendChild(sec);
    }

    // How each code is applied
    if (analysis.how_applied && Object.keys(analysis.how_applied).length > 0) {
      const sec = h('div', { className: 'section' },
        h('div', { className: 'section-title' }, 'How Each Code Is Applied'),
      );
      for (const [code, desc] of Object.entries(analysis.how_applied)) {
        const block = h('div', { style: { marginBottom: '12px' } });
        block.appendChild(codeChip(code));
        block.appendChild(h('div', { className: 'analysis-text mt-4' }, desc));
        sec.appendChild(block);
      }
      wrap.appendChild(sec);
    }

    // Suggestions
    if (suggestions.length > 0) {
      const sec = h('div', { className: 'section' },
        h('div', { className: 'section-title' }, `Suggestions (${suggestions.length})`),
      );
      const list = h('div', { className: 'suggestion-list' });
      for (const s of suggestions) list.appendChild(buildSuggestionCard(s, report));
      sec.appendChild(list);
      wrap.appendChild(sec);
    }

    return wrap;
  }

  function buildSuggestionCard(s, report) {
    const card = h('div', { className: `suggestion-card ${s.status !== 'pending' ? s.status : ''}` });

    // Header row
    const typeEl = h('span', {
      className: `suggestion-type stype-${s.type.replace(/[^a-z-]/g,'')}`
    }, s.type);

    const descEl = h('div', { className: 'suggestion-desc' }, s.description);
    card.appendChild(h('div', { className: 'suggestion-header' }, typeEl, descEl));

    if (s.rationale) {
      card.appendChild(h('div', { className: 'suggestion-rationale' }, s.rationale));
    }

    // Refs
    if (s.refs && s.refs.length > 0) {
      const refText = s.refs.map(r =>
        `${r.doc} L${r.line}` + (r.current_code && r.new_code ? `: ${r.current_code} → ${r.new_code}` : '')
      ).join('  ·  ');
      card.appendChild(h('div', { className: 'suggestion-refs' }, refText));
    }

    // Commands
    if (s.commands && s.commands.length > 0) {
      card.appendChild(h('div', { className: 'suggestion-commands' },
        s.commands.join('\n')
      ));
    }

    // Actions
    if (s.status === 'pending') {
      const actions = h('div', { className: 'suggestion-actions' });
      actions.appendChild(h('button', {
        className: 'btn-accept',
        onClick: () => {
          s.status = 'accepted';
          saveLog(report.id);
          render();
        },
      }, '✓ Accept'));
      actions.appendChild(h('button', {
        className: 'btn-reject',
        onClick: () => {
          s.status = 'rejected';
          saveLog(report.id);
          render();
        },
      }, '✗ Reject'));
      card.appendChild(actions);
    } else {
      card.appendChild(h('button', {
        className: 'btn-undo',
        onClick: () => {
          s.status = 'pending';
          saveLog(report.id);
          render();
        },
      }, '↩ Undo'));
    }

    return card;
  }

  // ── Excerpts tab ───────────────────────────────────────────────────────────

  function buildExcerptsTab(report) {
    const wrap = h('div', {});

    for (const code of report.codes) {
      const info = CORPUS_INDEX[code] || {};
      const exs  = info.excerpts || [];

      const sec = h('div', { className: 'section' });
      sec.appendChild(h('div', { className: 'section-title' },
        `${code}  ·  ${info.total || 0} total uses`
      ));

      if (exs.length === 0) {
        sec.appendChild(h('div', { className: 'text-dim' }, 'No excerpts available.'));
      } else {
        const grid = h('div', { className: 'excerpt-grid' });
        for (const ex of exs) {
          const card = h('div', { className: 'excerpt-card' });
          card.appendChild(h('div', { className: 'excerpt-meta' },
            h('span', { className: 'excerpt-doc' }, ex.doc),
            h('span', { className: 'excerpt-line' }, `L${ex.line}`),
          ));
          card.appendChild(h('div', { className: 'excerpt-text' }, ex.text));
          const chips = h('div', { className: 'excerpt-codes' });
          chips.appendChild(codeChip(code));
          card.appendChild(chips);
          grid.appendChild(card);
        }
        sec.appendChild(grid);
      }

      wrap.appendChild(sec);
    }

    return wrap;
  }

  // ── Export tab ─────────────────────────────────────────────────────────────

  function buildExportTab(report) {
    const accepted = report.suggestions.filter(s => s.status === 'accepted');
    const wrap = h('div', { className: 'export-section' });

    if (accepted.length === 0) {
      wrap.appendChild(h('div', { className: 'info-notice' },
        'Accept suggestions in the Analysis tab to generate a shell script.'
      ));
    } else {
      const script = buildScript(report);
      wrap.appendChild(h('div', { className: 'section-title' },
        `${accepted.length} accepted change${accepted.length !== 1 ? 's' : ''}`
      ));
      wrap.appendChild(h('div', { className: 'script-preview' }, script));

      const dlBtn = h('button', {
        className: 'download-btn',
        onClick: () => {
          const blob = new Blob([script], { type: 'text/x-shellscript' });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href = url;
          a.download = `qc-align-${report.codes[0]}-${Date.now()}.sh`;
          a.click();
          URL.revokeObjectURL(url);
        },
      }, '⬇ Download .sh');
      wrap.appendChild(dlBtn);
    }

    // Save log button
    const saveBtn = h('button', {
      className: 'custom-btn mt-16',
      onClick: async () => {
        await saveLog(report.id);
        saveBtn.textContent = 'Saved ✓';
        setTimeout(() => { saveBtn.textContent = 'Save conversation log'; }, 2000);
      },
    }, 'Save conversation log');
    wrap.appendChild(saveBtn);

    return wrap;
  }

  // ── Chat panel ─────────────────────────────────────────────────────────────

  function buildChatPanel(report) {
    const wrap = h('div', { className: 'chat-wrap' });

    const msgs = h('div', { className: 'chat-messages', id: 'chat-messages' });

    if (report.status === 'pending' || report.status === 'running') {
      msgs.appendChild(h('div', { className: 'loading-bar' },
        h('span', { className: 'spinner-inline' }),
        'Waiting for analysis to complete before chatting…'
      ));
    } else if (report.chat.length === 0) {
      msgs.appendChild(h('div', { className: 'text-dim', style: { padding: '20px' } },
        'No messages yet. Ask anything about these codes.'
      ));
    } else {
      for (const msg of report.chat) {
        const bubble = h('div', { className: `chat-msg ${msg.role}` },
          h('div', { className: 'chat-avatar' }, msg.role === 'user' ? 'You' : 'AI'),
          h('div', { className: 'chat-bubble' + (msg.updatedReport ? ' updated-report' : '') },
            msg.content,
            ...(msg.updatedReport ? [h('div', { style: { fontSize: '10px', color: 'var(--green)', marginTop: '6px' } }, '↻ Report updated')] : [])
          ),
        );
        msgs.appendChild(bubble);
      }
    }

    if (report.chatRunning) {
      msgs.appendChild(h('div', { className: 'loading-bar' },
        h('span', { className: 'spinner-inline' }), 'Thinking…'
      ));
    }

    wrap.appendChild(msgs);

    // Input row
    const inputRow = h('div', { className: 'chat-input-row' });
    const textarea = h('textarea', {
      className: 'chat-input',
      placeholder: report.status !== 'done'
        ? 'Waiting for analysis…'
        : 'Ask about these codes, refine a suggestion, add context…',
      disabled: report.status !== 'done' || report.chatRunning,
      rows: '2',
    });

    const sendBtn = h('button', {
      className: 'send-btn',
      disabled: report.status !== 'done' || report.chatRunning,
      onClick: () => {
        const text = textarea.value.trim();
        if (!text) return;
        textarea.value = '';
        sendChat(state.activeReportId, text);
      },
    }, 'Send');

    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
      }
    });

    inputRow.appendChild(textarea);
    inputRow.appendChild(sendBtn);
    wrap.appendChild(inputRow);

    // Scroll to bottom
    setTimeout(() => {
      const el = document.getElementById('chat-messages');
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);

    return wrap;
  }

  // ── Custom code selector modal ─────────────────────────────────────────────

  function buildModal() {
    const overlay = h('div', {
      className: 'modal-overlay',
      onClick: e => { if (e.target === overlay) { state.modalOpen = false; render(); } },
    });

    const modal = h('div', { className: 'modal' });

    modal.appendChild(h('div', { className: 'modal-header' },
      h('h3', {}, 'Compare Custom Codes'),
      h('button', {
        className: 'modal-close',
        onClick: () => { state.modalOpen = false; render(); },
      }, '×'),
    ));

    const body = h('div', { className: 'modal-body' });

    // Selected codes display
    const selectedEl = h('div', { className: 'selected-codes-list' });
    if (state.customSelectedCodes.length === 0) {
      selectedEl.appendChild(h('span', { className: 'text-dim', style: { fontSize: '12px' } },
        'Select 2 or more codes…'
      ));
    } else {
      for (const code of state.customSelectedCodes) {
        const tag = h('span', {
          className: 'selected-code-tag',
          style: { background: codeColor(code) },
        },
          document.createTextNode(code),
          h('span', {
            className: 'remove-tag',
            onClick: () => {
              state.customSelectedCodes = state.customSelectedCodes.filter(c => c !== code);
              render();
            },
          }, '×'),
        );
        selectedEl.appendChild(tag);
      }
    }
    body.appendChild(selectedEl);

    // Search
    const searchEl = h('input', {
      type: 'text',
      className: 'code-picker-search',
      placeholder: 'Search codes…',
      value: state.customSearchQuery,
      onInput: e => { state.customSearchQuery = e.target.value; render(); },
    });
    body.appendChild(searchEl);

    // Code list
    const pickerList = h('div', { className: 'code-picker-list' });
    const q = state.customSearchQuery.toLowerCase();
    const filtered = ALL_CODES.filter(c => !q || c.toLowerCase().includes(q));

    for (const code of filtered.slice(0, 80)) {
      const isChecked = state.customSelectedCodes.includes(code);
      const item = h('div', {
        className: 'code-picker-item' + (isChecked ? ' checked' : ''),
        onClick: () => {
          if (isChecked) {
            state.customSelectedCodes = state.customSelectedCodes.filter(c => c !== code);
          } else {
            state.customSelectedCodes = [...state.customSelectedCodes, code];
          }
          render();
        },
      },
        h('span', { className: 'code-dot', style: { background: codeColor(code) } }),
        document.createTextNode(code),
      );
      pickerList.appendChild(item);
    }
    if (filtered.length > 80) {
      pickerList.appendChild(h('div', { className: 'text-dim', style: { padding: '8px', fontSize: '11px' } },
        `${filtered.length - 80} more — refine search`
      ));
    }
    body.appendChild(pickerList);
    modal.appendChild(body);

    // Footer
    const canInvestigate = state.customSelectedCodes.length >= 2;
    modal.appendChild(h('div', { className: 'modal-footer' },
      h('button', {
        className: 'custom-btn',
        disabled: !canInvestigate,
        style: canInvestigate ? {} : { opacity: 0.4, cursor: 'not-allowed' },
        onClick: async () => {
          if (!canInvestigate) return;
          const codes = [...state.customSelectedCodes];
          state.modalOpen = false;
          state.customSelectedCodes = [];

          // Check Ollama first
          try { await checkOllama(); } catch (err) {
            state.queueError = err.message;
            state.queuePhase = 'error';
            render();
            return;
          }

          const id = makeReport(codes);
          if (!state.queue.includes(id)) {
            // prepend to queue so it's visible at top
            state.queue = [id, ...state.queue];
          }
          state.activeReportId = id;
          state.activeTab = 'report';
          render();
          await runReport(id);
        },
      }, 'Investigate →'),
    ));

    overlay.appendChild(modal);
    return overlay;
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  async function boot() {
    await loadLogs();
    render();
    // Kick off the queue automatically
    initQueue();
  }

  if (document.getElementById('qc-align-root')) {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }

})();
