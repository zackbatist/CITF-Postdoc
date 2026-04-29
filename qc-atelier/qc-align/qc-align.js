// qc-align.js
// Qualitative coding reflection tool.
// Data injected by qc-align-filter.lua:
//   DOC_NAMES, ALL_CODES, CORPUS_INDEX, CODE_COLORS,
//   CODEBOOK_TREE, COOC_DATA, ALIGN_CONFIG

window.onerror = function(msg, src, line, col, err) {
  console.error('[GLOBAL ERROR]', msg, 'at', src + ':' + line + ':' + col);
  if (err && err.stack) console.error(err.stack);
  return false;
};

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
    fetch(LOG_API + '/align/log', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(entry),
    }).catch(function(e) { console.warn('[align/log]', e); });
  }

  function sendToRefactorQueue(refactorOp) {
    fetch(LOG_API + '/refactor/queue', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ops: [refactorOp] }),
    }).catch(function(e) { console.warn('[refactor/queue]', e); });
  }

  // ── Prompt builders per audit mode ────────────────────────────────────────
  // ── Active code filter ───────────────────────────────────────────────────
  function isActiveCode(name, docsData) {
    if (!name || !String(name).slice(0,2).match(/^[0-9]{2}$/)) return false;
    var doc = docsData[name] || {};
    return doc.status !== 'deprecated';
  }

  // ── System prompt (shared across all audit modes) ─────────────────────────
  // Establishes the methodological context for the LLM.
  var SYSTEM_PROMPT = [
    'You are assisting with qualitative data analysis following constructivist grounded theory',
    '(Charmaz) and Saldana\'s coding methods.',
    '',
    'KEY PRINCIPLES:',
    '- Coding is iterative: initial/open coding produces many granular codes; focused coding',
    '  selects those with enough analytic weight to anchor emerging categories.',
    '- Multiple codes on the same passage is EXPECTED and CORRECT. Each code captures a',
    '  different analytical dimension. Co-occurrence is not a problem to eliminate.',
    '- Codes are researcher constructions grounded in data, not objective categories.',
    '- Codes use gerunds (process coding) to capture action and practice.',
    '- The goal is NOT to reduce the number of codes. The goal is to ensure each code is',
    '  doing DISTINCT ANALYTICAL WORK that will contribute to theory-building.',
    '- Constant comparison: every code is assessed relative to others and to the data.',
    '',
    'FOCUSED CODING asks: Does this code have enough analytic weight and conceptual clarity',
    'to survive into focused coding and anchor an emerging category? If two codes co-occur,',
    'the question is not "are they the same?" but "is each capturing a genuinely distinct',
    'analytical dimension that will matter for theory-building?"',
    '',
    'SUGGESTION TYPES for focus audit:',
    '- restructure-subcode: one code is a specific instance of another; the general one',
    '  could become a focused code with the specific one nested under it.',
    '- separate-dimension: these codes capture genuinely different analytical dimensions;',
    '  keep both, but document the distinction more explicitly.',
    '- candidate-category: this code has enough weight and recurrence to become a focused',
    '  code / emerging category. Flag it for promotion.',
    '- document-distinction: the codes are analytically valid but their distinction is',
    '  underdocumented, causing inconsistent application.',
    '- review-application: this code may be under- or over-applied relative to its scope.',
  ].join('\n');

  // ── Compact tree outline ──────────────────────────────────────────────────
  function buildCompactTreeOutline(docsData) {
    var lines = ['=== CODE SYSTEM OUTLINE (name | parent) ==='];
    var byPrefix = {};
    CODEBOOK_TREE.forEach(function(node) {
      if (!isActiveCode(node.name, docsData)) return;
      var p = node.prefix || 'other';
      if (!byPrefix[p]) byPrefix[p] = [];
      byPrefix[p].push(node);
    });
    Object.keys(byPrefix).sort().forEach(function(prefix) {
      lines.push('');
      lines.push('-- ' + prefix + ' --');
      byPrefix[prefix].forEach(function(node) {
        lines.push('  '.repeat(node.depth) + node.name +
          (node.parent ? ' < ' + node.parent : ''));
      });
    });
    return lines.join('\n');
  }

  // ── Docs for a specific set of codes ─────────────────────────────────────
  function buildCodesDocs(codeNames, docsData) {
    var lines = [];
    codeNames.forEach(function(name) {
      var node = CODEBOOK_TREE.find(function(n) { return n.name === name; });
      var doc  = docsData[name] || {};
      lines.push('');
      lines.push(name + (node && node.parent ? ' [parent: ' + node.parent + ']' : '') +
        ' (uses: ' + ((CORPUS_INDEX[name]||{}).total||0) + ')');
      if (doc.scope)       lines.push('  scope: '       + doc.scope);
      if (doc.rationale)   lines.push('  rationale: '   + doc.rationale);
      if (doc.usage_notes) lines.push('  usage_notes: ' + doc.usage_notes);
    });
    return lines.join('\n');
  }

  // ── Focal code excerpts ───────────────────────────────────────────────────
  function buildPairExcerpts(codeA, codeB) {
    var exA  = ((CORPUS_INDEX[codeA] || {}).excerpts || []).slice(0, 4);
    var exB  = ((CORPUS_INDEX[codeB] || {}).excerpts || []).slice(0, 4);
    var cooc = COOC_DATA.find(function(c) {
      return (c.code_a === codeA && c.code_b === codeB) ||
             (c.code_a === codeB && c.code_b === codeA);
    });
    var lines = [
      codeA + ' (uses: ' + ((CORPUS_INDEX[codeA]||{}).total||0) +
        ', shared docs with ' + codeB + ': ' + (cooc ? cooc.shared_docs : 0) + ')',
      'excerpts:',
    ];
    exA.forEach(function(e) {
      lines.push('  [' + e.doc + ':' + e.line + '] ' + e.text.slice(0, 200));
    });
    lines.push('');
    lines.push(codeB + ' (uses: ' + ((CORPUS_INDEX[codeB]||{}).total||0) + ')');
    lines.push('excerpts:');
    exB.forEach(function(e) {
      lines.push('  [' + e.doc + ':' + e.line + '] ' + e.text.slice(0, 200));
    });
    return lines.join('\n');
  }

  // ── Turn 1: discovery prompt ──────────────────────────────────────────────
  function buildDiscoveryPrompt(pairs, docsData) {
    var focalNames = [];
    pairs.forEach(function(p) {
      if (focalNames.indexOf(p.code_a) === -1) focalNames.push(p.code_a);
      if (focalNames.indexOf(p.code_b) === -1) focalNames.push(p.code_b);
    });
    var pairsText = pairs.map(function(p, i) {
      return '=== PAIR ' + (i+1) + ': ' + p.code_a + ' vs ' + p.code_b + ' ===\n' +
        buildPairExcerpts(p.code_a, p.code_b);
    }).join('\n\n');

    return [
      SYSTEM_PROMPT,
      '',
      buildCompactTreeOutline(docsData),
      '',
      '=== FOCAL CODE DOCUMENTATION ===',
      buildCodesDocs(focalNames, docsData),
      '',
      '=== FOCAL PAIRS ===',
      pairsText,
      '',
      'TASK (Turn 1 of 2 — Discovery):',
      'Before making suggestions, identify which OTHER codes in the outline above are',
      'relevant to understanding these pairs in focused coding terms. Consider:',
      '- Codes that might be at the same analytical level as the focal codes',
      '- Codes that might be more general categories that could subsume one of these',
      '- Codes that capture related processes or dimensions in adjacent areas',
      '',
      'Respond with JSON only:',
      '{',
      '  "relevant_codes": ["code names from the outline worth examining"],',
      '  "initial_observations": "one sentence per pair — what analytical relationship do you see?"',
      '}',
    ].join('\n');
  }

  // ── Turn 2: focused coding assessment prompt ──────────────────────────────
  function buildAssessmentPrompt(pairs, docsData, relevantCodes) {
    var focalNames = [];
    pairs.forEach(function(p) {
      if (focalNames.indexOf(p.code_a) === -1) focalNames.push(p.code_a);
      if (focalNames.indexOf(p.code_b) === -1) focalNames.push(p.code_b);
    });
    var allNames = focalNames.slice();
    (relevantCodes || []).forEach(function(name) {
      if (allNames.indexOf(name) === -1 &&
          CODEBOOK_TREE.some(function(n) { return n.name === name; })) {
        allNames.push(name);
      }
    });
    var pairsText = pairs.map(function(p, i) {
      return '=== PAIR ' + (i+1) + ': ' + p.code_a + ' vs ' + p.code_b + ' ===\n' +
        buildPairExcerpts(p.code_a, p.code_b);
    }).join('\n\n');

    return [
      SYSTEM_PROMPT,
      '',
      '=== RELEVANT CODE DOCUMENTATION ===',
      buildCodesDocs(allNames, docsData),
      '',
      '=== FOCAL PAIRS ===',
      pairsText,
      '',
      'TASK (Turn 2 of 2 — Focused Coding Assessment):',
      'For each pair, assess whether each code is doing distinct analytical work that',
      'warrants its own focused code, or whether the relationship between them suggests',
      'a restructuring that would strengthen the code system for theory-building.',
      '',
      'Remember: co-occurrence is NOT a problem. Multiple codes on the same passage is',
      'expected. Ask whether each code captures a genuinely distinct analytical dimension.',
      '',
      'Respond with a JSON array — one object per pair, in order:',
      '[{',
      '  "suggestion": "restructure-subcode" | "separate-dimension" | "candidate-category" | "document-distinction" | "review-application",',
      '  "target": "proposed parent code (for restructure-subcode only)",',
      '  "child": "code to move under target (restructure-subcode only)",',
      '  "related_codes": ["codes from the documentation above relevant to this assessment"],',
      '  "reason": "one sentence — cite the documented scope/rationale of each code",',
      '  "evidence_a": [{"doc":"...","line":0,"text":"..."}],',
      '  "evidence_b": [{"doc":"...","line":0,"text":"..."}]',
      '}]',
    ].join('\n');
  }

  async function runFocusAudit(codes, docsData, report) {
    var codeSet = new Set(codes);
    var pairs = COOC_DATA.filter(function(c) {
      return codeSet.has(c.code_a) && codeSet.has(c.code_b);
    });
    if (pairs.length === 0) {
      var arr = Array.from(codeSet);
      for (var i = 0; i < arr.length; i++)
        for (var j = i + 1; j < arr.length; j++)
          pairs.push({ code_a: arr[i], code_b: arr[j], shared_docs: 0 });
    }
    pairs = pairs.slice(0, state.testModel ? 3 : (ALIGN_CONFIG.max_pairs || 20));
    if (pairs.length === 0) return [];

    var discoveryPrompt  = buildDiscoveryPrompt(pairs, docsData);
    var turn2placeholder = '(generated after Turn 1)';

    // ── Prompt preview mode ──────────────────────────────────────────────────
    if (state.showPrompt) {
      state.promptPreview = { turn1: discoveryPrompt, turn2: turn2placeholder };
      if (report) { report.status = 'done'; report.suggestions = []; }
      render();
      return [];
    }

    // ── Mock mode ────────────────────────────────────────────────────────────
    if (state.testingMode) {
      if (report) { report.progress = 'Mock mode — generating fake suggestions…'; render(); }
      await new Promise(function(r) { setTimeout(r, 800); });
      return pairs.slice(0, 3).map(function(pair) {
        var types = ['restructure-subcode', 'separate-dimension', 'candidate-category', 'document-distinction', 'review-application'];
        var type  = types[Math.floor(Math.random() * types.length)];
        return {
          id:            pair.code_a + '__' + pair.code_b + '__mock',
          mode:          'focus',
          codes:         [pair.code_a, pair.code_b],
          type:          type,
          reason:        '[MOCK] ' + pair.code_a + ' and ' + pair.code_b + ' require focused coding assessment.',
          related_codes: codes.filter(function(c) { return c !== pair.code_a && c !== pair.code_b; }).slice(0, 2),
          evidence_a:    ((CORPUS_INDEX[pair.code_a] || {}).excerpts || []).slice(0, 2).map(function(e) { return Object.assign({ code: pair.code_a }, e); }),
          evidence_b:    ((CORPUS_INDEX[pair.code_b] || {}).excerpts || []).slice(0, 2).map(function(e) { return Object.assign({ code: pair.code_b }, e); }),
          status:        'pending',
          decision_note: '',
          refactor_op:   type === 'restructure-subcode' ? { type: 'move', sources: [pair.code_b], target: pair.code_a } : null,
        };
      });
    }

    // ── Real LLM mode ────────────────────────────────────────────────────────
    var model = state.testModel
      ? 'qwen2.5:7b'
      : (ALIGN_CONFIG.ollama_model || 'qwen3.5:35b');

    if (report) { report.progress = 'Turn 1 of 2 — building prompt…'; render(); }
    var estimatedTokens1 = Math.round(discoveryPrompt.length / 4);
    if (report) {
      report.progress = 'Turn 1 of 2 — discovery\\n' +
        'Sending ' + pairs.length + ' pair(s) + full tree outline (~' + estimatedTokens1.toLocaleString() + ' tokens)\\n' +
        'Asking model to identify relevant codes across the system…' +
        (state.testModel ? '\\n[fast model: qwen2.5:7b]' : '');
      render();
    }
    var discovery     = await ollamaJSONPrompt(discoveryPrompt, model);
    var relevantCodes = (discovery && discovery.relevant_codes) ? discovery.relevant_codes : [];
    console.log('[qc-align] Turn 1 identified', relevantCodes.length, 'relevant codes:', relevantCodes.slice(0,10));

    var assessmentPrompt = buildAssessmentPrompt(pairs, docsData, relevantCodes);
    // Update prompt preview for turn 2
    if (state.promptPreview) state.promptPreview.turn2 = assessmentPrompt;

    var estimatedTokens2 = Math.round(assessmentPrompt.length / 4);
    if (report) {
      report.progress = 'Turn 2 of 2 — assessment\\n' +
        'Turn 1 identified ' + relevantCodes.length + ' relevant code(s)\\n' +
        'Sending focal pairs + docs for ' + (relevantCodes.length + pairs.length * 2) + ' codes (~' + estimatedTokens2.toLocaleString() + ' tokens)\\n' +
        'Generating suggestions…' +
        (state.testModel ? '\\n[fast model: qwen2.5:7b]' : '');
      render();
    }
    var results = await ollamaJSONPrompt(assessmentPrompt, model);
    console.log('[qc-align] Turn 2 raw result:', JSON.stringify(results).slice(0, 500));

    if (!Array.isArray(results)) {
      if (results && results.suggestions) results = results.suggestions;
      else if (results && typeof results === 'object') results = [results];
      else return [];
    }

    return results.map(function(result, i) {
      var pair = pairs[i] || pairs[0];
      var sg   = result.suggestion || 'review-application';
      var refactorOp = null;
      if (sg === 'restructure-subcode') {
        refactorOp = { type: 'move', sources: [result.child || pair.code_b], target: result.target || pair.code_a };
      }
      var evidenceA = (result.evidence_a || []).map(function(e) { return Object.assign({ code: pair.code_a }, e); });
      var evidenceB = (result.evidence_b || []).map(function(e) { return Object.assign({ code: pair.code_b }, e); });
      return {
        id:            pair.code_a + '__' + pair.code_b,
        mode:          'focus',
        codes:         [pair.code_a, pair.code_b],
        type:          sg,
        reason:        result.reason        || '',
        related_codes: result.related_codes || relevantCodes,
        evidence_a:    evidenceA,
        evidence_b:    evidenceB,
        status:        'pending',
        decision_note: '',
        refactor_op:   refactorOp,
      };
    }).filter(function(s) { return s !== null; });
  }

  async function runReport(reportId) {
    var report = state.reports[reportId];
    if (!report) return;
    report.status    = 'running';
    report.startedAt = Date.now();
    report.progress  = 'Loading codebook documentation…';
    render();
    try {
      // Cache docs across runs — fetch once per session
      if (!state.docsData) {
        var docsRes = await fetch(LOG_API + '/docs/load?path=' + encodeURIComponent(ALIGN_CONFIG.scheme_path || ''));
        if (docsRes.ok) {
          var docsJson = await docsRes.json();
          state.docsData = docsJson.codes || {};
        } else {
          state.docsData = {};
        }
      }
      var docsData = state.docsData;
      var suggestions = [];
      if (report.mode === 'focus') {
        suggestions = await runFocusAudit(report.codes, docsData, report);
      } else if (report.mode === 'consistency') {
        suggestions = await runConsistencyAudit(report.codes, docsData, report);
      } else if (report.mode === 'restructure') {
        suggestions = await runRestructureAudit(report.codes, docsData, report);
      } else if (report.mode === 'corpus') {
        suggestions = await runCorpusAudit(report.codes, docsData, report);
      } else {
        suggestions = [{
          id:            reportId + '__s0',
          mode:          report.mode,
          codes:         report.codes.slice(0, 3),
          type:          'pending',
          reason:        report.mode + ' audit — full implementation coming',
          related_codes: [],
          evidence_a:    [],
          evidence_b:    [],
          status:        'pending',
          decision_note: '',
          refactor_op:   null,
        }];
      }
      report.suggestions = suggestions;
      report.status      = 'done';
      report.elapsedMs   = Date.now() - (report.startedAt || Date.now());
      report.chat        = report.chat || [];
      // Auto-save response for later replay
      if (suggestions.length > 0 && !state.testingMode) {
        fetch(LOG_API + '/align/responses/save', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            ts:          new Date().toISOString(),
            mode:        report.mode,
            codes:       report.codes,
            suggestions: suggestions,
            elapsedMs:   report.elapsedMs,
          }),
        }).catch(function(e) { console.warn('[align/responses/save]', e); });
      }
    } catch(err) {
      report.status = 'error';
      report.error  = err.message || String(err);
    }
    render();
  }

  async function runConsistencyAudit(codes, docsData, report) {
    if (report) { report.progress = 'Consistency audit — coming soon'; render(); }
    return [{ id: 'consistency_stub', mode: 'consistency', codes: codes.slice(0,2),
      type: 'review-application', reason: 'Consistency audit not yet implemented.',
      related_codes: [], evidence_a: [], evidence_b: [], status: 'pending', decision_note: '', refactor_op: null }];
  }

  async function runRestructureAudit(codes, docsData, report) {
    if (report) { report.progress = 'Restructure audit — coming soon'; render(); }
    return [{ id: 'restructure_stub', mode: 'restructure', codes: codes.slice(0,2),
      type: 'restructure-subcode', reason: 'Restructure audit not yet implemented.',
      related_codes: [], evidence_a: [], evidence_b: [], status: 'pending', decision_note: '', refactor_op: null }];
  }

  async function runCorpusAudit(codes, docsData, report) {
    if (report) { report.progress = 'Corpus audit — coming soon'; render(); }
    return [{ id: 'corpus_stub', mode: 'corpus', codes: codes.slice(0,2),
      type: 'review-application', reason: 'Corpus audit not yet implemented.',
      related_codes: [], evidence_a: [], evidence_b: [], status: 'pending', decision_note: '', refactor_op: null }];
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
      var result     = await ollamaJSONPrompt(prompt);
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
  async function ollamaJSONPrompt(prompt, model) {
    var useModel  = model || ALIGN_CONFIG.ollama_model || 'qwen3.5:35b';
    var ollamaUrl = (ALIGN_CONFIG.ollama_url || 'http://localhost:11434') + '/api/chat';
    var fullPrompt = prompt + '\n\nRespond ONLY with valid JSON, no markdown, no explanation.';
    try {
      var res = await fetch(ollamaUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          model:   useModel,
          stream:  false,
          think:   false,
          options: { temperature: 0, num_ctx: ALIGN_CONFIG.num_ctx || 49152 },
          messages: [{ role: 'user', content: fullPrompt }],
        }),
      });
      var data = await res.json();
      var text = (data.message && data.message.content) ? data.message.content : '';
      text = text.replace(/```json\n?|```\n?/g, '').trim();
      return JSON.parse(text);
    } catch(e) {
      console.warn('[ollamaJSONPrompt]', e);
      return null;
    }
  }

  const AUDIT_MODES = [
    { id: 'focus',       label: 'Focus',       desc: 'Does each code have distinct analytical weight? Pairs or sibling groups.' },
    { id: 'consistency', label: 'Consistency', desc: 'Is this code being applied in line with its documented scope?' },
    { id: 'restructure', label: 'Restructure', desc: 'Propose alternative tree architectures for a branch or the whole system.' },
    { id: 'corpus',      label: 'Corpus',      desc: 'Line splitting and code propagation — corpus integrity operations.' },
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
    // Audit mode fields
    auditMode:           'focus',
    auditScope:          [],
    auditScopeCollapsed: new Set(),
    leftSearch:          '',
    docsData:            null,
    // Testing controls
    testingMode:         false,
    showPrompt:          false,
    promptPreview:       null,
    testModel:           false,
    savedResponses:      null,   // list of saved response files
    showResponsePicker:  false,  // show response file picker
  };

  // ── Report object factory ──────────────────────────────────────────────────
  // Each report tracks its own status, LLM results, conversation, and decisions.

  function makeReport(codes) {
    const id = codes.slice().sort().join('|');
    if (state.reports[id]) {
      // Update mode if re-running with a different mode
      state.reports[id].mode = state.auditMode;
      return id;
    }
    state.reports[id] = {
      id,
      codes,
      mode:        state.auditMode,
      status:      'pending',
      error:       null,
      analysis:    null,
      suggestions: [],
      chat:        [],
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
        content: ('You are helping a qualitative researcher identify potential problems in their coding scheme.\n' +
      '\n' +
      'The following codes are from the category: ${label}\n' +
      '\n' +
      'CODE NAMES WITH TREE POSITION AND USE COUNTS:\n' +
      '${ctx}\n' +
      '\n' +
      'Identify pairs of codes that likely have thematic overlap, definitional ambiguity, or inconsistent application based on their names and positions in the hierarchy. Consider:\n' +
      '- Codes with similar or overlapping names\n' +
      '- Codes that are siblings in the tree but may be hard to distinguish\n' +
      '- Codes where one might be a special case of another but is coded separately\n' +
      '- Cross-category pairs if included — look for conceptual overlap across different facets\n' +
      '\n' +
      'Return a JSON array of objects. Include only pairs with genuine concern, up to 15 pairs:\n' +
      '[\n' +
      '  {\n' +
      '    "code_a": "exact_code_name",\n' +
      '    "code_b": "exact_code_name",\n' +
      '    "concern": "one sentence explaining the likely overlap or ambiguity",\n' +
      '    "severity": "high|medium|low"\n' +
      '  }\n' +
      ']\n' +
      '\n' +
      'Only include codes from the list above. If no pairs have meaningful overlap, return [].\n'),
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
      if (!state.reports[id].mode) state.reports[id].mode = 'focus';
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
        content: ('You are helping a qualitative researcher reflect on their coding practice.\n' +
      'Codes under discussion: ${report.codes.join(\', \')}\n' +
      '\n' +
      'CURRENT REPORT ANALYSIS:\n' +
      '${currentAnalysis}\n' +
      '\n' +
      'CORPUS EXCERPTS FOR CONTEXT:\n' +
      '${excerptContext}\n' +
      '\n' +
      'Engage thoughtfully with the researcher\'s questions and observations. Reference specific excerpts by [doc L##] when relevant. When the conversation leads to revised understanding of how codes are applied or new suggestions, also output an updated report JSON block at the END of your response using this exact format (the researcher\'s app will parse and apply it):\n' +
      '\n' +
      '<updated_analysis>\n' +
      '{\n' +
      '  "overview": "updated overview incorporating new insights",\n' +
      '  "how_applied": {\n' +
      '    "CODE_NAME": "updated description"\n' +
      '  },\n' +
      '  "new_suggestions": [\n' +
      '    {\n' +
      '      "type": "reassign|add-code|merge|delete|rename",\n' +
      '      "description": "...",\n' +
      '      "rationale": "...",\n' +
      '      "refs": [],\n' +
      '      "commands": []\n' +
      '    }\n' +
      '  ]\n' +
      '}\n' +
      '</updated_analysis>\n' +
      '\n' +
      'Only include <updated_analysis> when there are genuine revisions to make. Otherwise respond conversationally without it.\n'),
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
  const API     = 'http://localhost:' + (ALIGN_CONFIG.server_port     || ALIGN_CONFIG.log_server_port || 8080);

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
    try {
    const root = document.getElementById('qc-align-root');
    if (!root) return;
    root.innerHTML = '';

    const shell = h('div', { className: 'app-shell' });

    // Top bar
    const tb = h('div', { className: 'top-bar' },
      h('h1', {}, 'QC Align'),
      h('span', { className: 'subtitle' },
        `${DOC_NAMES.length} docs · ${ALL_CODES.length} codes`
      ),
      h('div', { className: 'top-bar-spacer' }),
      h('span', { className: 'model-badge' + (state.testModel ? ' model-badge-test' : '') },
        state.testModel ? 'qwen2.5:7b (test)' : (ALIGN_CONFIG.ollama_model || 'unknown model')),
      h('button', {
        className: 'topbar-theme-btn',
        title: 'Toggle light/dark mode',
        onClick: function() {
          var dark = document.body.classList.toggle('dark-mode');
          document.body.classList.toggle('light-mode', !dark);
          try { localStorage.setItem('qc.scheme.theme', dark ? 'dark' : 'light'); } catch(e) {}
        },
      }, '◑'),
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
    } catch(e) {
      console.error('[render error]', e.message, e.stack);
    }
  }

  // ── Left panel ─────────────────────────────────────────────────────────────

  async function loadSavedResponses() {
    try {
      var res  = await fetch(LOG_API + '/align/responses');
      var data = await res.json();
      state.savedResponses = data.responses || [];
    } catch(e) {
      state.savedResponses = [];
    }
    render();
  }

  function loadResponseFile(filename, responseData) {
    // Create a report from a saved response
    var id = makeReport(responseData.codes || []);
    var report = state.reports[id];
    report.mode        = responseData.mode || 'focus';
    report.suggestions = (responseData.suggestions || []).map(function(s) {
      return Object.assign({ status: 'pending', decision_note: '' }, s);
    });
    report.status    = 'done';
    report.elapsedMs = responseData.elapsedMs || 0;
    report.chat      = [];
    state.activeReportId    = id;
    state.activeTab         = 'report';
    state.showResponsePicker = false;
    render();
  }

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
      h('span', { className: 'audit-scope-count', id: 'audit-scope-count' },
        state.auditScope.length > 0 ? `(${state.auditScope.length} selected)` : '(all)'
      )
    ));

    const scopeSearch = h('input', {
      type: 'text',
      className: 'search-input',
      placeholder: 'Filter codes…',
      value: state.leftSearch || '',
      onInput: e => {
        state.leftSearch = e.target.value;
        const sl = document.getElementById('audit-scope-list');
        if (sl) { sl.innerHTML = ''; renderScopeNodes(CODEBOOK_TREE.filter(n => !n.parent), null, sl); }
      },
    });
    scopeSection.appendChild(scopeSearch);

    const scopeList = h('div', { className: 'audit-scope-list', id: 'audit-scope-list' });

    function renderScopeNodes(nodes, parentName, container) {
      const q = (state.leftSearch || '').toLowerCase();
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
              // Re-render scope list in-place
              const sl = document.getElementById('audit-scope-list');
              if (sl) { sl.innerHTML = ''; renderScopeNodes(CODEBOOK_TREE.filter(n => !n.parent), null, sl); }
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
          // Update count label only, no full render
          updateScopeCount();
          const clearBtn = document.getElementById('audit-scope-clear');
          if (clearBtn) clearBtn.disabled = state.auditScope.length === 0;
        });
        row.appendChild(cb);
        row.appendChild(h('span', { className: 'scope-label' }, node.name));
        const cnt = (CORPUS_INDEX[node.name] || {}).total;
        if (cnt) row.appendChild(h('span', { className: 'picker-count' }, String(cnt)));
        container.appendChild(row);

        if (!q && !isCollapsed && hasChildren) {
          const children = CODEBOOK_TREE.filter(n => n.parent === node.name);
          renderScopeNodes(children, node.name, container);
        }
      }
    }

    function updateScopeCount() {
      const el = document.getElementById('audit-scope-count');
      if (el) el.textContent = state.auditScope.length > 0
        ? '(' + state.auditScope.length + ' selected)'
        : '(all)';
    }

    const roots = CODEBOOK_TREE.filter(n => !n.parent);
    renderScopeNodes(roots, null, scopeList);
    scopeSection.appendChild(scopeList);
    panel.appendChild(scopeSection);

    // ── Action row: Clear + Run ───────────────────────────────────────────────
    const actionRow = h('div', { className: 'audit-action-row' });
    actionRow.appendChild(h('button', {
      className: 'btn audit-scope-clear',
      id: 'audit-scope-clear',
      onClick: () => {
        state.auditScope = [];
        updateScopeCount();
        const sl = document.getElementById('audit-scope-list');
        if (sl) { sl.innerHTML = ''; renderScopeNodes(CODEBOOK_TREE.filter(n => !n.parent), null, sl); }
        const cb = document.getElementById('audit-scope-clear');
        if (cb) cb.disabled = true;
      },
      disabled: state.auditScope.length === 0,
    }, 'Clear'));
    actionRow.appendChild(h('button', {
      className: 'btn primary audit-run-btn',
      onClick: () => {
        const codes = state.auditScope.length > 0
          ? state.auditScope.map(s => s.name || s)
          : CODEBOOK_TREE.map(n => n.name);
        const id = makeReport(codes);
        state.activeReportId = id;
        state.activeTab = 'report';
        runReport(id);
        render();
      },
    }, 'Run ' + ((AUDIT_MODES.find(m => m.id === state.auditMode) || {}).label || 'audit')));
    panel.appendChild(actionRow);

    // ── Testing controls ──────────────────────────────────────────────────────
    var testBar = h('div', { className: 'test-bar' });

    var mockBtn = h('button', {
      className: 'test-btn' + (state.testingMode ? ' active' : ''),
      title: 'Bypass LLM — use mock suggestions for UI testing',
      onClick: function() { state.testingMode = !state.testingMode; render(); },
    }, '🎭 Mock');

    var promptBtn = h('button', {
      className: 'test-btn' + (state.showPrompt ? ' active' : ''),
      title: 'Show prompt preview without running LLM',
      onClick: function() { state.showPrompt = !state.showPrompt; state.promptPreview = null; render(); },
    }, '📋 Prompt');

    var fastBtn = h('button', {
      className: 'test-btn' + (state.testModel ? ' active' : ''),
      title: 'Use qwen2.5:7b for fast testing (lower quality)',
      onClick: function() { state.testModel = !state.testModel; render(); },
    }, '⚡ Fast');

    var loadBtn = h('button', {
      className: 'test-btn' + (state.showResponsePicker ? ' active' : ''),
      title: 'Load a saved response file',
      onClick: function() {
        state.showResponsePicker = !state.showResponsePicker;
        if (state.showResponsePicker && !state.savedResponses) loadSavedResponses();
        render();
      },
    }, '📂 Load');

    testBar.appendChild(mockBtn);
    testBar.appendChild(promptBtn);
    testBar.appendChild(fastBtn);
    testBar.appendChild(loadBtn);
    panel.appendChild(testBar);

    // ── Response picker ───────────────────────────────────────────────────────
    if (state.showResponsePicker) {
      var pickerWrap = h('div', { className: 'response-picker' });
      if (!state.savedResponses) {
        pickerWrap.appendChild(h('div', { className: 'scope-queue-empty' }, 'Loading…'));
      } else if (state.savedResponses.length === 0) {
        pickerWrap.appendChild(h('div', { className: 'scope-queue-empty' }, 'No saved responses yet.'));
      } else {
        state.savedResponses.forEach(function(entry) {
          var row = h('div', { className: 'response-picker-row' });
          var info = h('div', { className: 'response-picker-info' });
          info.appendChild(h('span', { className: 'response-picker-mode' }, entry.mode));
          info.appendChild(h('span', { className: 'response-picker-ts' }, entry.ts.slice(0, 16).replace('T', ' ')));
          info.appendChild(h('span', { className: 'response-picker-codes' }, (entry.codes || []).length + ' codes · ' + entry.n_suggestions + ' suggestions'));
          row.appendChild(info);
          row.appendChild(h('button', {
            className: 'btn-xs',
            onClick: async function() {
              try {
                var res  = await fetch(LOG_API + '/docs/load-json?path=' +
                  encodeURIComponent(ALIGN_CONFIG.scheme_path.replace('codebook.json', 'align-responses/' + entry.filename)));
                var data = await res.json();
                loadResponseFile(entry.filename, data);
              } catch(e) {
                console.warn('[loadResponse]', e);
              }
            },
          }, 'Load'));
          pickerWrap.appendChild(row);
        });
      }
      panel.appendChild(pickerWrap);
    }

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
    for (const code of (report.codes || [])) chips.appendChild(codeChip(code));
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
    if (!report) { panel.appendChild(buildEmptyState()); return panel; }

    // Ensure required fields exist
    report.suggestions = report.suggestions || [];
    report.chat        = report.chat        || [];
    report.codes       = report.codes       || [];

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
    const progressLines = (report.progress || 'Initialising…').split('\n');
    const mainLine = progressLines[0];
    wrap.appendChild(h('p', { className: 'loading-progress' }, mainLine));
    progressLines.slice(1).forEach(function(line) {
      if (line) wrap.appendChild(h('p', { className: 'loading-detail' }, line));
    });
    if (report.startedAt) {
      const elapsed = Math.round((Date.now() - report.startedAt) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? mins + 'm ' + secs + 's' : secs + 's';
      wrap.appendChild(h('p', { className: 'loading-elapsed' }, timeStr + ' elapsed'));
    }
    if (report.status === 'running') {
      setTimeout(function() {
        const el = document.getElementById('loading-state-' + report.id);
        if (el && report.status === 'running') {
          const newState = buildLoadingState(report);
          newState.id = 'loading-state-' + report.id;
          el.parentNode && el.parentNode.replaceChild(newState, el);
        }
      }, 1000);
    }
    wrap.id = 'loading-state-' + report.id;
    return wrap;
  }

  // ── Report tab ─────────────────────────────────────────────────────────────

  function buildReportTab(report) {
    const analysis    = report.analysis    || null;
    const suggestions = report.suggestions || [];
    const codes       = report.codes       || [];
    const wrap = h('div', {});

    // Header
    const titleEl = h('div', { className: 'report-title' });
    for (const code of codes) titleEl.appendChild(codeChip(code));
    const meta = h('div', { className: 'report-meta' });
    meta.appendChild(h('span', {}, `${codes.length} codes · ${suggestions.length} suggestions`));
    if (report.elapsedMs) {
      const secs = Math.round(report.elapsedMs / 1000);
      const mins = Math.floor(secs / 60);
      const timeStr = mins > 0 ? mins + 'm ' + (secs % 60) + 's' : secs + 's';
      meta.appendChild(h('span', { className: 'report-elapsed' }, ' · ' + timeStr));
    }
    if (report.mode) {
      meta.appendChild(h('span', { className: 'report-mode-badge' }, report.mode));
    }
    wrap.appendChild(h('div', { className: 'report-header' }, titleEl, meta));

    if (!analysis && suggestions.length === 0) {
      // Show prompt preview if available
      if (state.promptPreview) {
        var pvWrap = h('div', { className: 'prompt-preview' });
        pvWrap.appendChild(h('div', { className: 'prompt-preview-label' }, 'Turn 1 — Discovery prompt'));
        pvWrap.appendChild(h('pre', { className: 'prompt-preview-text' }, state.promptPreview.turn1));
        if (state.promptPreview.turn2 && state.promptPreview.turn2 !== '(generated after Turn 1)') {
          pvWrap.appendChild(h('div', { className: 'prompt-preview-label' }, 'Turn 2 — Assessment prompt'));
          pvWrap.appendChild(h('pre', { className: 'prompt-preview-text' }, state.promptPreview.turn2));
        }
        wrap.appendChild(pvWrap);
      }
      return wrap;
    }

    // Overview
    if (analysis && analysis.overview) {
      const sec = h('div', { className: 'section' },
        h('div', { className: 'section-title' }, 'Overview'),
        h('div', { className: 'analysis-text' }, analysis.overview),
      );
      wrap.appendChild(sec);
    }

    // How each code is applied
    if (analysis && analysis.how_applied && Object.keys(analysis.how_applied).length > 0) {
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
    const card = h('div', { className: 'suggestion-card' + (s.status !== 'pending' ? ' ' + s.status : '') });

    // ── Header: suggestion type + codes ──────────────────────────────────────
    const header = h('div', { className: 'suggestion-header' });
    const TYPE_LABELS = {
      'restructure-subcode':  '↳ restructure',
      'separate-dimension':   '⊕ separate dimensions',
      'candidate-category':   '★ candidate category',
      'document-distinction': '✎ document distinction',
      'review-application':   '⚑ review application',
      'merge':                '⊃ merge',
      'rename':               '✎ rename',
    };
    header.appendChild(h('span', {
      className: 'suggestion-type stype-' + (s.type || '').replace(/[^a-z-]/g, ''),
    }, TYPE_LABELS[s.type] || s.type || 'suggestion'));

    const codesLabel = (s.codes || []).join(' + ');
    header.appendChild(h('span', { className: 'suggestion-codes' }, codesLabel));

    if (s.type === 'restructure-subcode' && s.refactor_op) {
      header.appendChild(h('span', { className: 'suggestion-arrow' },
        ' → move ' + (s.refactor_op.sources || []).join(', ') + ' under ' + s.refactor_op.target
      ));
    } else if ((s.type === 'merge' || s.type === 'rename') && s.refactor_op && s.refactor_op.target) {
      header.appendChild(h('span', { className: 'suggestion-arrow' }, ' → ' + s.refactor_op.target));
    }
    card.appendChild(header);

    // ── Evidence: side-by-side excerpts ──────────────────────────────────────
    const evA = s.evidence_a || [];
    const evB = s.evidence_b || [];
    if (evA.length > 0 || evB.length > 0) {
      const evGrid = h('div', { className: 'sg-evidence-grid' });

      const colA = h('div', { className: 'sg-ev-col' });
      colA.appendChild(h('div', { className: 'sg-ev-col-label' }, s.codes && s.codes[0] || 'A'));
      evA.slice(0, 3).forEach(function(e) {
        colA.appendChild(h('div', { className: 'sg-ev-item' },
          h('span', { className: 'sg-ev-ref' }, '[' + e.doc + ':' + e.line + '] '),
          h('span', { className: 'sg-ev-text' }, e.text)
        ));
      });

      const colB = h('div', { className: 'sg-ev-col' });
      colB.appendChild(h('div', { className: 'sg-ev-col-label' }, s.codes && s.codes[1] || 'B'));
      evB.slice(0, 3).forEach(function(e) {
        colB.appendChild(h('div', { className: 'sg-ev-item' },
          h('span', { className: 'sg-ev-ref' }, '[' + e.doc + ':' + e.line + '] '),
          h('span', { className: 'sg-ev-text' }, e.text)
        ));
      });

      evGrid.appendChild(colA);
      evGrid.appendChild(colB);
      card.appendChild(evGrid);
    }

    // ── Reason (minimal LLM text) ─────────────────────────────────────────────
    if (s.reason) {
      card.appendChild(h('div', { className: 'suggestion-rationale' }, s.reason));
    }

    // ── Related codes ─────────────────────────────────────────────────────────
    if (s.related_codes && s.related_codes.length > 0) {
      const relWrap = h('div', { className: 'sg-related' });
      relWrap.appendChild(h('span', { className: 'sg-related-label' }, 'Also consider: '));
      s.related_codes.forEach(function(rc) {
        relWrap.appendChild(h('span', { className: 'sg-related-code' }, rc));
      });
      card.appendChild(relWrap);
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    if (s.status === 'pending') {
      const noteInput = h('input', {
        type: 'text',
        className: 'sg-note-input',
        placeholder: 'Decision note (optional)…',
      });
      const actions = h('div', { className: 'suggestion-actions' });
      actions.appendChild(h('button', {
        className: 'btn-accept',
        onClick: function() {
          setSuggestionStatus(report.id, s.id, 'accepted', noteInput.value);
        },
      }, '✓ Accept'));
      actions.appendChild(h('button', {
        className: 'btn-reject',
        onClick: function() {
          setSuggestionStatus(report.id, s.id, 'rejected', noteInput.value);
        },
      }, '✗ Reject'));
      actions.appendChild(h('button', {
        className: 'btn-defer',
        onClick: function() {
          setSuggestionStatus(report.id, s.id, 'deferred', noteInput.value);
        },
      }, '⏸ Defer'));
      card.appendChild(noteInput);
      card.appendChild(actions);
    } else {
      const statusRow = h('div', { className: 'sg-status-row' });
      statusRow.appendChild(h('span', { className: 'sg-status-label' }, s.status));
      if (s.decision_note) statusRow.appendChild(h('span', { className: 'sg-decision-note' }, s.decision_note));
      statusRow.appendChild(h('button', {
        className: 'btn-undo',
        onClick: function() {
          s.status = 'pending';
          s.decision_note = '';
          render();
        },
      }, '↩'));
      card.appendChild(statusRow);
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
    // Restore theme from localStorage
    try {
      var saved = localStorage.getItem('qc.scheme.theme');
      if (saved === 'dark') document.body.classList.add('dark-mode');
      else document.body.classList.remove('dark-mode');
    } catch(e) {}
    await loadLogs();
    render();
    // initQueue disabled — use Run button in audit palette instead
  }

  if (document.getElementById('qc-align-root')) {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }

})();