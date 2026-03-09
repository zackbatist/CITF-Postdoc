// qc-audit.js
// Vanilla JS — no framework. Data is injected by the Lua filter as:
//   CODE_STATS, DOC_NAMES, CODEBOOK_CODES, CODEBOOK_TEXT, CO_OCCURRENCE, AUDIT_CONFIG

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  const state = {
    phase: 'idle',       // idle | running | done | error
    phaseLabel: '',
    analysis: null,
    changeStatuses: {},  // id -> 'accepted' | 'rejected'
    activeTab: 'overview',
    error: null,
  };

  // ── Derived stats from injected data ──────────────────────────────────────

  // Guard: CODEBOOK_CODES should be an array, but if the Lua filter emitted {}
  // (empty object) instead of [] (empty array), convert it gracefully.
  const _CODEBOOK_CODES_ARRAY = Array.isArray(CODEBOOK_CODES)
    ? CODEBOOK_CODES
    : Object.keys(CODEBOOK_CODES);

  function getCodeStats() {
    const sorted = Object.entries(CODE_STATS).sort((a, b) => b[1].total - a[1].total);
    const orphaned = _CODEBOOK_CODES_ARRAY.filter(c => !CODE_STATS[c] || CODE_STATS[c].total === 0);
    const rare = sorted.filter(([, s]) => s.total > 0 && s.total <= 2).map(([c]) => c);
    return { sorted, orphaned, rare };
  }

  // ── Ollama helpers ────────────────────────────────────────────────────────

  async function ollamaQuery(systemPrompt, userPrompt, passLabel) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let rawText = '';
      try {
        const res = await fetch(AUDIT_CONFIG.ollama_url + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: AUDIT_CONFIG.ollama_model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user',   content: userPrompt   },
            ],
            stream: false,
            options: { temperature: 0.1, num_ctx: 8192 },
          }),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error('HTTP ' + res.status + ': ' + errText.slice(0, 200));
        }
        const data = await res.json();
        rawText = data.message?.content || data.response || '';
        if (!rawText) throw new Error('Empty response. Keys: ' + Object.keys(data).join(','));

        // Strip markdown code fences if present
        rawText = rawText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

        // Extract outermost JSON object
        const start = rawText.indexOf('{');
        const end   = rawText.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON braces in: ' + rawText.slice(0, 200));
        return JSON.parse(rawText.slice(start, end + 1));
      } catch (err) {
        const msg = (passLabel || 'pass') + ' attempt ' + attempt + ': ' + err.message;
        console.warn('[qc-audit]', msg);
        state.lastOllamaError = msg;
        if (attempt === 3) return null;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  const SYS = 'You are a JSON API. Output ONLY a valid JSON object. No markdown, no explanation, no text outside the JSON. Start your response with { and end with }.';

  async function runAnalysis() {
    const { sorted, orphaned, rare } = getCodeStats();
    const docNames = DOC_NAMES.map(d => d.replace(/\.txt$/, ''));

    // Helper: compact code summary — just name + total, no doc breakdown
    // Keeps prompts within ~4k tokens even for large corpora
    const compactList = (entries, limit) =>
      entries.slice(0, limit)
        .map(([c, s]) => `${c}(${s.total})`)
        .join(', ');

    // For co-occurrence: top 20 pairs only
    const coocLines = CO_OCCURRENCE.slice(0, 20).map(r =>
      `${r.code_a}+${r.code_b}:${r.shared_docs}docs`
    ).join(', ');

    // Pass 1: duplicates / redundancy
    // Focus on high-usage codes and strong co-occurrences — most likely to have redundancy
    setPhaseLabel('Pass 1/4: Checking for duplicate and redundant codes…');
    const top80 = compactList(sorted, 80);
    const pass1 = await ollamaQuery(SYS, `Audit a qualitative coding project (${DOC_NAMES.length} docs, ${sorted.length} codes total).

Top codes by usage (name(count)): ${top80}

Top co-occurring pairs (codeA+codeB:sharedDocs): ${coocLines}

Find codes that are duplicates or near-synonyms (similar names, singular/plural, same concept). Focus on names that look similar or pairs with high co-occurrence.

Return ONLY:
{"issues":[{"type":"duplicate","severity":"high","codes":["code1","code2"],"description":"why similar","evidence":"co-occurrence or name similarity"}],"proposed_changes":[{"id":"c1","action":"merge","from":["code1","code2"],"to":"merged_name","rationale":"brief reason","affected_docs":[],"qc_commands":["qc codes rename code1 merged_name","qc codes rename code2 merged_name"]}]}`, 'pass1');

    // Pass 2: inconsistent coverage
    // Only look at codes appearing in 2..(N-1) docs, capped to 25 most informative
    setPhaseLabel('Pass 2/4: Checking for inconsistent coverage…');
    const partialCodes = sorted
      .filter(([, s]) => {
        const n = Object.keys(s.byDoc).length;
        return n > 1 && n < DOC_NAMES.length;
      })
      .slice(0, 25)
      .map(([c, s]) => {
        const present = Object.keys(s.byDoc).map(d => d.replace(/\.txt$/, '')).join(',');
        const absentCount = DOC_NAMES.length - Object.keys(s.byDoc).length;
        return `${c}: in [${present}], absent from ${absentCount} docs`;
      }).join('\n');

    const pass2 = await ollamaQuery(SYS, `Audit a qualitative coding project (${DOC_NAMES.length} docs: ${docNames.join(', ')}).

Codes present in some but not all documents:
${partialCodes}

Flag codes whose absence from certain docs looks like a coding oversight (not just because the topic doesn't apply). Return ONLY:
{"issues":[{"type":"inconsistent_coverage","severity":"medium","codes":["code1"],"description":"...","evidence":"..."}],"coverage_gaps":[{"description":"...","docs_missing":["doc"],"suggested_codes":["code"],"rationale":"..."}]}`, 'pass2');

    // Pass 3: orphaned / underused — send only the problematic codes, not full list
    setPhaseLabel('Pass 3/4: Checking for orphaned and underused codes…');
    const rareList  = rare.slice(0, 40).join(', ')  || 'none';
    const orphanList = orphaned.slice(0, 30).join(', ') || 'none';
    const pass3 = await ollamaQuery(SYS, `Audit a qualitative coding project.

Orphaned codes (in codebook, never used): ${orphanList}
Rarely used codes (1–2 uses total): ${rareList}
Total active codes: ${sorted.length}

Which orphaned codes should be deleted or merged, and which rare codes are too granular? Return ONLY:
{"issues":[{"type":"orphaned","severity":"medium","codes":["code1"],"description":"...","evidence":"..."}],"proposed_changes":[{"id":"c3","action":"delete","from":["code1"],"to":null,"rationale":"...","affected_docs":[],"qc_commands":["qc codes delete code1"]}]}`, 'pass3');

    // Pass 4: hierarchy / structure — send abbreviated codebook (top-level keys only)
    setPhaseLabel('Pass 4/4: Auditing codebook structure…');
    const pass4 = await ollamaQuery(SYS, `Audit a qualitative coding project.

Codebook structure (first 2000 chars):
${CODEBOOK_TEXT.slice(0, 2000)}

Top co-occurring code pairs: ${coocLines}

Identify structural problems: codes at wrong abstraction level, missing parent categories, or co-occurring codes that need a shared parent. Return ONLY:
{"issues":[{"type":"structural","severity":"low","codes":["code1"],"description":"...","evidence":"..."}],"structural_suggestions":[{"description":"...","before":"...","after":"..."}]}`, 'pass4');

    // Merge
    setPhaseLabel('Merging results…');

    // Surface Ollama errors if all passes failed
    const passResults = [pass1, pass2, pass3, pass4];
    if (passResults.every(p => p === null)) {
      const errDetail = state.lastOllamaError || 'All 4 Ollama passes returned null. Check that Ollama is running and the model is loaded.';
      console.error('[qc-audit] All passes failed. Last error:', errDetail);
      throw new Error(errDetail);
    }
    if (passResults.some(p => p === null)) {
      console.warn('[qc-audit] Some passes failed. Last error:', state.lastOllamaError);
    }

    const allIssues = [
      ...(pass1?.issues || []),
      ...(pass2?.issues || []),
      ...(pass3?.issues || []),
      ...(pass4?.issues || []),
    ];

    const allChanges = [
      ...(pass1?.proposed_changes || []),
      ...(pass3?.proposed_changes || []),
    ].map((c, i) => ({ ...c, id: `c${i + 1}` }));

    const allGaps = pass2?.coverage_gaps || [];
    const allStructural = pass4?.structural_suggestions || [];
    const highCount = allIssues.filter(i => i.severity === 'high').length;

    const health = allIssues.length === 0 ? 'excellent'
      : highCount > 4 ? 'poor'
      : highCount > 1 ? 'fair'
      : 'good';

    return {
      issues: allIssues,
      proposed_changes: allChanges,
      coverage_gaps: allGaps,
      structural_suggestions: allStructural,
      summary: {
        total_issues: allIssues.length,
        high_priority_merges: allChanges.filter(c => c.action === 'merge').length,
        coverage_gaps_found: allGaps.length,
        overall_health: health,
        narrative: `Found ${allIssues.length} issues across ${DOC_NAMES.length} documents and ${sorted.length} codes. ${highCount} high-severity issues require attention.`,
      },
    };
  }

  // ── Rendering helpers ─────────────────────────────────────────────────────

  const HEALTH_COLOR  = { poor: '#ef4444', fair: '#f59e0b', good: '#3b82f6', excellent: '#10b981' };
  const ACTION_COLOR  = { merge: '#8b5cf6', rename: '#3b82f6', delete: '#ef4444', restructure: '#f59e0b' };
  const SEV_COLOR     = { high: '#ef4444', medium: '#f59e0b', low: '#10b981' };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'className') {
        el.className = v;
      } else {
        el.setAttribute(k, v);
      }
    }
    for (const child of children) {
      if (child == null) continue;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  }

  function badge(text, color) {
    return h('span', {
      className: 'badge',
      style: { color, borderColor: color + '80', background: color + '28' },
    }, text);
  }

  function mono(text) {
    return h('code', { className: 'mono' }, text);
  }

  function accordion(title, count, accentColor, bodyContent, defaultOpen = true) {
    let open = defaultOpen;
    const body = h('div', { className: 'accordion-body' });
    body.appendChild(bodyContent);
    if (!open) body.style.display = 'none';

    const arrow = h('span', { className: 'accordion-arrow' }, open ? '▾' : '▸');
    const header = h('button', {
      className: 'accordion-header' + (open ? ' open' : ''),
      style: { borderColor: accentColor + '44' },
      onClick: () => {
        open = !open;
        arrow.textContent = open ? '▾' : '▸';
        header.className = 'accordion-header' + (open ? ' open' : '');
        body.style.display = open ? '' : 'none';
      },
    }, arrow, h('span', { className: 'accordion-title', style: { color: accentColor } }, title));

    if (count !== undefined) {
      header.appendChild(h('span', {
        className: 'accordion-count',
        style: { background: accentColor + '28', color: accentColor },
      }, String(count)));
    }

    const wrap = h('div', { className: 'accordion' });
    wrap.appendChild(header);
    wrap.appendChild(body);
    return wrap;
  }

  function issueCard(issue) {
    const sev = issue.severity || 'low';
    const card = h('div', { className: `issue-card ${sev}` });
    const header = h('div', { className: 'issue-header' });
    header.appendChild(badge(sev, SEV_COLOR[sev] || '#10b981'));
    header.appendChild(badge((issue.type || '').replace(/_/g, ' '), '#6b7280'));
    for (const c of (issue.codes || [])) header.appendChild(mono(c));
    card.appendChild(header);
    if (issue.description) card.appendChild(h('p', { className: 'issue-desc' }, issue.description));
    if (issue.evidence) card.appendChild(h('p', { className: 'issue-evidence' }, issue.evidence));
    return card;
  }

  function changeCard(change) {
    const color = ACTION_COLOR[change.action] || '#8b5cf6';
    const status = state.changeStatuses[change.id];
    const accepted = status === 'accepted';
    const rejected = status === 'rejected';

    const card = h('div', {
      className: 'change-card' + (rejected ? ' rejected' : ''),
      style: { border: `1px solid ${accepted ? color : rejected ? '#374151' : color + '55'}` },
    });

    const header = h('div', { className: 'change-header' });
    header.appendChild(badge(change.action, color));
    for (const c of (change.from || [])) header.appendChild(mono(c));
    if (change.to && change.action !== 'delete') {
      header.appendChild(h('span', { className: 'arrow' }, '→'));
      header.appendChild(mono(change.to));
    }
    card.appendChild(header);

    if (change.rationale) {
      card.appendChild(h('p', { className: 'change-rationale' }, change.rationale));
    }

    if (change.qc_commands?.length) {
      const block = h('div', { className: 'cmd-block' });
      for (const cmd of change.qc_commands) {
        block.appendChild(h('div', { className: 'cmd-line' },
          h('span', { className: 'cmd-prompt' }, '$ '), cmd));
      }
      card.appendChild(block);
    }

    if (change.affected_docs?.length) {
      card.appendChild(h('p', { className: 'change-docs' }, 'Affects: ' + change.affected_docs.join(', ')));
    }

    if (!accepted && !rejected) {
      const actions = h('div', { className: 'change-actions' });
      const acceptBtn = h('button', {
        className: 'accept-btn',
        style: { background: color + '22', color, borderColor: color },
        onClick: () => { state.changeStatuses[change.id] = 'accepted'; render(); },
      }, '✓ Accept');
      const rejectBtn = h('button', {
        className: 'reject-btn',
        onClick: () => { state.changeStatuses[change.id] = 'rejected'; render(); },
      }, '✗ Reject');
      actions.appendChild(acceptBtn);
      actions.appendChild(rejectBtn);
      card.appendChild(actions);
    } else if (accepted) {
      card.appendChild(h('p', { className: 'change-status', style: { color } }, '✓ Accepted — run commands above'));
    } else {
      card.appendChild(h('p', { className: 'change-status', style: { color: '#6b7280' } }, '✗ Rejected'));
    }

    return card;
  }

  function gapCard(gap) {
    const card = h('div', { className: 'gap-card' });
    if (gap.description) card.appendChild(h('p', { className: 'gap-desc' }, gap.description));

    if (gap.docs_missing?.length) {
      const row = h('div', { className: 'gap-meta' });
      row.appendChild(h('span', { className: 'gap-meta-label' }, 'Missing in:'));
      for (const d of gap.docs_missing) row.appendChild(h('span', { className: 'gap-doc' }, d));
      card.appendChild(row);
    }

    if (gap.suggested_codes?.length) {
      const row = h('div', { className: 'gap-meta' });
      row.appendChild(h('span', { className: 'gap-meta-label' }, 'Suggested:'));
      for (const c of gap.suggested_codes) row.appendChild(mono(c));
      card.appendChild(row);
    }

    if (gap.rationale) card.appendChild(h('p', { className: 'gap-rationale' }, gap.rationale));
    return card;
  }

  function structCard(s) {
    const card = h('div', { className: 'struct-card' });
    if (s.description) card.appendChild(h('p', { className: 'struct-desc' }, s.description));
    if (s.before) card.appendChild(h('p', { className: 'struct-before' }, 'Before: ' + s.before));
    if (s.after)  card.appendChild(h('p', { className: 'struct-after'  }, 'After: '  + s.after));
    return card;
  }

  // ── Tab content builders ──────────────────────────────────────────────────

  function buildOverviewTab(analysis) {
    const frag = document.createDocumentFragment();
    const summary = analysis.summary || {};
    const healthColor = HEALTH_COLOR[summary.overall_health] || '#6b7280';

    const panel = h('div', {
      className: 'summary-panel',
      style: { border: `1px solid ${healthColor}33` },
    });

    if (summary.narrative) {
      panel.appendChild(h('p', { className: 'summary-narrative' }, summary.narrative));
    }

    const statsRow = h('div', { className: 'summary-stats' });
    const statsData = [
      ['Issues found',    summary.total_issues,            '#ef4444'],
      ['Priority merges', summary.high_priority_merges,    '#8b5cf6'],
      ['Coverage gaps',   summary.coverage_gaps_found,     '#3b82f6'],
      ['Changes proposed',analysis.proposed_changes?.length || 0, '#f59e0b'],
    ];
    for (const [label, val, color] of statsData) {
      const item = h('div', {});
      item.appendChild(h('div', { className: 'summary-stat-num', style: { color } }, String(val ?? 0)));
      item.appendChild(h('div', { className: 'summary-stat-label' }, label));
      statsRow.appendChild(item);
    }
    panel.appendChild(statsRow);
    frag.appendChild(panel);

    if (analysis.structural_suggestions?.length) {
      const body = document.createDocumentFragment();
      for (const s of analysis.structural_suggestions) body.appendChild(structCard(s));
      const wrap = h('div', {}); wrap.appendChild(body);
      frag.appendChild(accordion('Structural suggestions', analysis.structural_suggestions.length, '#f59e0b', wrap));
    }

    return frag;
  }

  function buildIssuesTab(analysis) {
    const frag = document.createDocumentFragment();
    const severities = ['high', 'medium', 'low'];

    for (const sev of severities) {
      const items = (analysis.issues || []).filter(i => i.severity === sev);
      if (!items.length) continue;
      const body = document.createDocumentFragment();
      for (const issue of items) body.appendChild(issueCard(issue));
      const wrap = h('div', {}); wrap.appendChild(body);
      const title = sev.charAt(0).toUpperCase() + sev.slice(1) + ' severity';
      frag.appendChild(accordion(title, items.length, SEV_COLOR[sev], wrap));
    }

    if (!analysis.issues?.length) {
      frag.appendChild(h('p', { style: { color: '#6b7280', textAlign: 'center', padding: '40px' } }, 'No issues detected.'));
    }

    return frag;
  }

  function buildChangesTab(analysis) {
    const frag = document.createDocumentFragment();
    const accepted = (analysis.proposed_changes || []).filter(c => state.changeStatuses[c.id] === 'accepted');

    if (accepted.length) {
      const banner = h('div', { className: 'accepted-banner' });
      banner.appendChild(h('span', {}, `✓ ${accepted.length} change${accepted.length !== 1 ? 's' : ''} accepted`));
      const dlBtn = h('button', {
        className: 'download-btn',
        style: { marginLeft: 'auto' },
        onClick: generateScript,
      }, '⬇ Download Shell Script');
      banner.appendChild(dlBtn);
      frag.appendChild(banner);
    }

    for (const change of (analysis.proposed_changes || [])) {
      frag.appendChild(changeCard(change));
    }

    if (!analysis.proposed_changes?.length) {
      frag.appendChild(h('p', { style: { color: '#6b7280', textAlign: 'center', padding: '40px' } }, 'No changes proposed.'));
    }

    return frag;
  }

  function buildGapsTab(analysis) {
    const frag = document.createDocumentFragment();
    for (const gap of (analysis.coverage_gaps || [])) frag.appendChild(gapCard(gap));
    if (!analysis.coverage_gaps?.length) {
      frag.appendChild(h('p', { style: { color: '#6b7280', textAlign: 'center', padding: '40px' } }, 'No coverage gaps detected.'));
    }
    return frag;
  }

  function buildStatsTab() {
    const frag = document.createDocumentFragment();
    const { sorted } = getCodeStats();
    const maxCount = sorted[0]?.[1].total || 1;
    const total = sorted.reduce((s, [, v]) => s + v.total, 0);

    const grid = h('div', { className: 'stats-grid-top' });
    const statData = [
      ['Unique Codes', sorted.length, '#8b5cf6'],
      ['Documents',    DOC_NAMES.length, '#3b82f6'],
      ['Total Codings', total, '#10b981'],
    ];
    for (const [label, val, color] of statData) {
      const card = h('div', { className: 'stat-card', style: { borderColor: color + '44', border: `1px solid ${color}44` } });
      card.appendChild(h('div', { className: 'stat-card-num', style: { color } }, val.toLocaleString()));
      card.appendChild(h('div', { className: 'stat-card-label' }, label));
      grid.appendChild(card);
    }
    frag.appendChild(grid);

    const legend = h('div', { className: 'bar-legend' });
    legend.appendChild(h('span', {}, h('span', { style: { color: '#ef4444' } }, '■'), ' ≤2 (rare)'));
    legend.appendChild(h('span', {}, h('span', { style: { color: '#f59e0b' } }, '■'), ' 3–9'));
    legend.appendChild(h('span', {}, h('span', { style: { color: '#8b5cf6' } }, '■'), ' 10+'));
    frag.appendChild(legend);

    const list = h('div', { className: 'code-bar-list' });
    for (const [code, s] of sorted) {
      const row = h('div', { className: 'code-bar-row' });
      row.appendChild(h('div', { className: 'code-bar-label', title: code }, code));
      const track = h('div', { className: 'code-bar-track' });
      const fillColor = s.total <= 2 ? '#ef4444' : s.total < 10 ? '#f59e0b' : '#8b5cf6';
      track.appendChild(h('div', {
        className: 'code-bar-fill',
        style: { width: `${(s.total / maxCount) * 100}%`, background: fillColor },
      }));
      row.appendChild(track);
      row.appendChild(h('div', { className: 'code-bar-count' }, String(s.total)));
      row.appendChild(h('div', { className: 'code-bar-docs' }, Object.keys(s.byDoc).length + 'd'));
      list.appendChild(row);
    }
    frag.appendChild(list);
    return frag;
  }

  function buildExportTab(analysis) {
    const frag = document.createDocumentFragment();
    const accepted = (analysis.proposed_changes || []).filter(c => state.changeStatuses[c.id] === 'accepted');

    // Script section
    const scriptSection = h('div', { className: 'export-section' });
    scriptSection.appendChild(h('h3', { style: { color: '#10b981', marginTop: 0 } }, 'Shell script for accepted changes'));

    if (!accepted.length) {
      scriptSection.appendChild(h('p', { style: { color: '#6b7280', fontSize: '14px' } }, 'Accept changes in the Changes tab first.'));
    } else {
      const block = h('div', { className: 'script-block' });
      const cmds = accepted.flatMap(c => c.qc_commands || []);
      for (const cmd of cmds) {
        block.appendChild(h('div', { className: 'cmd-line' }, h('span', { className: 'cmd-prompt' }, '$ '), cmd));
      }
      scriptSection.appendChild(block);
      scriptSection.appendChild(h('button', { className: 'download-btn', onClick: generateScript }, '⬇ Download apply_qc_changes.sh'));
    }
    frag.appendChild(scriptSection);

    // Raw JSON
    const jsonSection = h('div', { className: 'export-section' });
    jsonSection.appendChild(h('h3', { style: { color: '#6b7280', marginTop: 0 } }, 'Raw analysis JSON'));
    jsonSection.appendChild(h('pre', { className: 'json-pre' }, JSON.stringify(analysis, null, 2)));
    frag.appendChild(jsonSection);

    return frag;
  }

  // ── Script download ───────────────────────────────────────────────────────

  function generateScript() {
    const analysis = state.analysis;
    if (!analysis) return;
    const accepted = (analysis.proposed_changes || []).filter(c => state.changeStatuses[c.id] === 'accepted');
    const lines = ['#!/bin/bash', '# Generated by QC Corpus Auditor', '# Run from your qc project root', ''];
    for (const c of accepted) {
      lines.push('# ' + c.rationale);
      for (const cmd of (c.qc_commands || [])) lines.push(cmd);
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'apply_qc_changes.sh';
    a.click();
  }

  // ── Phase label setter ────────────────────────────────────────────────────

  function setPhaseLabel(label) {
    state.phaseLabel = label;
    const el = document.getElementById('phase-label');
    if (el) el.textContent = label;
  }

  // ── Main render ───────────────────────────────────────────────────────────

  function render() {
    const root = document.getElementById('qc-audit-root');
    root.innerHTML = '';

    const analysis = state.analysis;
    const { sorted } = getCodeStats();
    const healthColor = analysis
      ? (HEALTH_COLOR[analysis.summary?.overall_health] || '#6b7280')
      : '#6b7280';

    // ── Header ──
    const header = h('div', { className: 'audit-header' });
    const titleWrap = h('div', {});
    titleWrap.appendChild(h('h1', {}, 'QC Corpus Audit'));
    titleWrap.appendChild(h('span', { className: 'meta' }, `${DOC_NAMES.length} docs · ${sorted.length} codes`));
    header.appendChild(titleWrap);

    if (analysis) {
      const healthBadge = h('div', {
        className: 'health-badge',
        style: { color: healthColor, borderColor: healthColor, background: healthColor + '22' },
      }, (analysis.summary?.overall_health || '—').toUpperCase());
      header.appendChild(healthBadge);

      const newBtn = h('button', { className: 'new-btn', onClick: () => { state.analysis = null; state.phase = 'idle'; state.changeStatuses = {}; render(); } }, '↺ Re-run');
      header.appendChild(newBtn);
    }

    root.appendChild(header);

    // ── Pre-run / spinner / results ──
    if (state.phase === 'idle') {
      renderWelcome(root);
      return;
    }

    if (state.phase === 'running') {
      renderSpinner(root);
      return;
    }

    if (state.phase === 'error') {
      renderError(root);
      return;
    }

    // Done — show tabs
    const TABS = [
      { id: 'overview', label: 'Overview' },
      { id: 'issues',   label: `Issues (${analysis.issues?.length || 0})` },
      { id: 'changes',  label: `Changes (${analysis.proposed_changes?.length || 0})` },
      { id: 'gaps',     label: `Gaps (${analysis.coverage_gaps?.length || 0})` },
      { id: 'stats',    label: 'Stats' },
      { id: 'export',   label: 'Export' },
    ];

    const tabBar = h('div', { className: 'tab-bar' });
    for (const tab of TABS) {
      const btn = h('button', {
        className: 'tab-btn' + (state.activeTab === tab.id ? ' active' : ''),
        onClick: () => { state.activeTab = tab.id; render(); },
      }, tab.label);
      tabBar.appendChild(btn);
    }
    root.appendChild(tabBar);

    const content = h('div', { className: 'tab-content' });

    if (state.activeTab === 'overview') content.appendChild(buildOverviewTab(analysis));
    if (state.activeTab === 'issues')   content.appendChild(buildIssuesTab(analysis));
    if (state.activeTab === 'changes')  content.appendChild(buildChangesTab(analysis));
    if (state.activeTab === 'gaps')     content.appendChild(buildGapsTab(analysis));
    if (state.activeTab === 'stats')    content.appendChild(buildStatsTab());
    if (state.activeTab === 'export')   content.appendChild(buildExportTab(analysis));

    root.appendChild(content);
  }

  function renderWelcome(root) {
    const { sorted } = getCodeStats();
    const total = sorted.reduce((s, [, v]) => s + v.total, 0);

    const wrap = h('div', { className: 'welcome' });
    wrap.appendChild(h('h2', {}, 'Ready to audit your corpus'));
    wrap.appendChild(h('p', {}, `This tool will analyse your codebook and ${DOC_NAMES.length} documents across ${sorted.length} codes using ${AUDIT_CONFIG.ollama_model} (Ollama). It runs four targeted passes and produces actionable suggestions.`));

    const statsGrid = h('div', { className: 'stats-grid' });
    for (const [label, val] of [['Documents', DOC_NAMES.length], ['Codes', sorted.length], ['Total codings', total]]) {
      const item = h('div', { className: 'stat-item' });
      item.appendChild(h('div', { className: 'stat-num' }, String(val.toLocaleString())));
      item.appendChild(h('div', { className: 'stat-label' }, label));
      statsGrid.appendChild(item);
    }
    wrap.appendChild(statsGrid);

    if (state.error) {
      wrap.appendChild(h('div', { className: 'error-box' }, state.error));
    }

    const runBtn = h('button', {
      className: 'run-btn-large',
      onClick: startAnalysis,
    }, 'Run Audit →');
    wrap.appendChild(runBtn);

    root.appendChild(wrap);
  }

  function renderSpinner(root) {
    const wrap = h('div', { className: 'spinner-wrap' });
    wrap.appendChild(h('div', { className: 'spinner' }));
    wrap.appendChild(h('p', { className: 'spinner-label', id: 'phase-label' }, state.phaseLabel || 'Starting…'));
    wrap.appendChild(h('p', { className: 'spinner-sub' }, 'Running 4 analysis passes via Ollama'));
    root.appendChild(wrap);
  }

  function renderError(root) {
    root.appendChild(h('div', { className: 'error-box', style: { margin: '40px 28px' } }, state.error));
  }

  // ── Start analysis ────────────────────────────────────────────────────────

  async function startAnalysis() {
    state.phase = 'running';
    state.phaseLabel = 'Connecting to Ollama…';
    state.error = null;
    state.lastOllamaError = null;
    render();

    // Quick connectivity check before running all 4 passes
    try {
      const ping = await fetch(AUDIT_CONFIG.ollama_url + '/api/tags', { method: 'GET' });
      if (!ping.ok) throw new Error('HTTP ' + ping.status);
      const tags = await ping.json();
      const models = (tags.models || []).map(m => m.name);
      const modelFound = models.some(m => m.startsWith(AUDIT_CONFIG.ollama_model.split(':')[0]));
      if (!modelFound) {
        state.error = `Model "${AUDIT_CONFIG.ollama_model}" not found in Ollama. Available: ${models.join(', ') || 'none'}. Run: ollama pull ${AUDIT_CONFIG.ollama_model}`;
        state.phase = 'idle';
        render();
        return;
      }
    } catch (pingErr) {
      state.error = `Cannot reach Ollama at ${AUDIT_CONFIG.ollama_url}. Is it running? Error: ${pingErr.message}`;
      state.phase = 'idle';
      render();
      return;
    }

    state.phaseLabel = 'Starting…';
    render();

    try {
      const result = await runAnalysis();
      state.analysis = result;
      state.phase = 'done';
      state.activeTab = 'overview';
    } catch (err) {
      state.error = 'Analysis failed: ' + err.message;
      state.phase = 'error';
    }

    render();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  function boot() {
    if (document.getElementById('qc-audit-root')) {
      render();
    } else {
      document.addEventListener('DOMContentLoaded', render);
    }
  }

  boot();

})();
