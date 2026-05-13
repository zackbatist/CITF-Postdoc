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
        label.textContent = '\u{1F4F7} ' + display;
        label.className = 'qc-snapshot-pill-label is-snapshot';
      } else {
        label.textContent = 'HEAD';
        label.className = 'qc-snapshot-pill-label is-head';
      }
    })
    .catch(function() {});

  return pill;
}