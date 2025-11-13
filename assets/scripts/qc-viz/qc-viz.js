(function() {
  'use strict';
  
  const STATE_KEY = 'qc-viz-state';
  
  let state = {
    collapsed: {},
    categoryCollapsed: {},
    selectedCodes: {},
    showUncoded: false,
    selectedSpeakers: {}
  };
  
  function loadState() {
    try {
      const stored = localStorage.getItem(STATE_KEY);
      if (stored) {
        state = Object.assign(state, JSON.parse(stored));
      }
    } catch (e) {
      console.error('Could not load state:', e);
    }
  }
  
  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Could not save state:', e);
    }
  }
  
  function updateCategoryState(prefix) {
    const category = document.querySelector(`.filter-category[data-prefix="${prefix}"]`);
    const checkboxes = category.querySelectorAll('.code-checkbox');
    const checkedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    const totalCount = checkboxes.length;
    const hasFilter = checkedCount < totalCount;
    const noneSelected = checkedCount === 0;
    
    category.classList.toggle('has-filter', hasFilter && !noneSelected);
    category.classList.toggle('none-selected', noneSelected);
    
    const selectAllBtn = category.querySelector('.select-all-btn');
    selectAllBtn.textContent = checkedCount === totalCount ? 'None' : 'All';
    
    // Update status indicator
    let statusEl = category.querySelector('.category-status');
    if (!statusEl) {
      statusEl = document.createElement('span');
      statusEl.className = 'category-status';
      category.querySelector('.category-title').appendChild(statusEl);
    }
    
    if (checkedCount === totalCount) {
      statusEl.textContent = '(all)';
      statusEl.style.color = '#6c757d';
    } else if (checkedCount === 0) {
      statusEl.textContent = '(none)';
      statusEl.style.color = '#dc3545';
    } else {
      statusEl.textContent = `(${checkedCount}/${totalCount})`;
      statusEl.style.color = '#fd7e14';
    }
  }
  
  function updateAllCategoryStates() {
    document.querySelectorAll('.filter-category').forEach(cat => {
      updateCategoryState(cat.dataset.prefix);
    });
  }
  
  function updateAllFilters() {
    document.querySelectorAll('.code-tag').forEach(tag => {
      const code = tag.dataset.code;
      const prefix = tag.dataset.prefix;
      const isSelected = state.selectedCodes[prefix]?.[code] !== false;
      tag.classList.toggle('inactive', !isSelected);
    });
    
    // Handle rows - separate logic for coded vs uncoded, plus speaker filter
    document.querySelectorAll('.coding-table tbody tr').forEach(row => {
      const tags = row.querySelectorAll('.code-tag');
      const isUncoded = tags.length === 0;
      const speakerCell = row.querySelector('.speaker-cell');
      const speaker = speakerCell ? speakerCell.textContent.trim() : '';
      
      // Check speaker filter - true if speaker is selected
      const speakerMatch = state.selectedSpeakers[speaker] !== false;
      
      if (!speakerMatch) {
        row.classList.add('hidden');
      } else if (isUncoded) {
        // Uncoded rows: show/hide based on uncoded toggle
        row.classList.toggle('hidden', !state.showUncoded);
      } else {
        // Coded rows: show if any code is active
        const hasActiveCode = Array.from(tags).some(tag => !tag.classList.contains('inactive'));
        row.classList.toggle('hidden', !hasActiveCode);
      }
    });
    
    updateStats();
  }
  
  function updateSpeakerFilterSummary() {
    const checkboxes = document.querySelectorAll('.speaker-checkbox');
    const checkedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    const totalCount = checkboxes.length;
    const summary = document.querySelector('.speaker-filter-summary');
    
    if (summary) {
      if (checkedCount === totalCount) {
        summary.textContent = '(all)';
      } else if (checkedCount === 0) {
        summary.textContent = '(none)';
      } else {
        summary.textContent = `(${checkedCount}/${totalCount})`;
      }
    }
  }
  
  function updateStats() {
    document.querySelectorAll('.interview-section').forEach(section => {
      const table = section.querySelector('.coding-table');
      if (!table) return;
      
      const allRows = table.querySelectorAll('tbody tr');
      const visibleRows = table.querySelectorAll('tbody tr:not(.hidden)');
      
      const total = allRows.length;
      const visible = visibleRows.length;
      
      // Count coded vs uncoded
      const codedRows = Array.from(allRows).filter(row => row.querySelectorAll('.code-tag').length > 0);
      const uncodedRows = Array.from(allRows).filter(row => row.querySelectorAll('.code-tag').length === 0);
      const visibleCoded = Array.from(visibleRows).filter(row => row.querySelectorAll('.code-tag').length > 0);
      const visibleUncoded = Array.from(visibleRows).filter(row => row.querySelectorAll('.code-tag').length === 0);
      
      const summary = section.querySelector('.stats-summary');
      if (summary) {
        summary.textContent = `Showing ${visible} of ${total} lines (${visibleCoded.length}/${codedRows.length} coded, ${visibleUncoded.length}/${uncodedRows.length} uncoded)`;
      }
    });
  }
  
  function initializeFilters() {
    // Initialize selected codes from checkboxes
    document.querySelectorAll('.code-checkbox').forEach(cb => {
      const prefix = cb.dataset.prefix;
      const code = cb.dataset.code;
      
      if (!state.selectedCodes[prefix]) {
        state.selectedCodes[prefix] = {};
      }
      
      // Default: all codes selected
      if (state.selectedCodes[prefix][code] === undefined) {
        state.selectedCodes[prefix][code] = true;
        cb.checked = true;
      } else {
        cb.checked = state.selectedCodes[prefix][code];
      }
      
      cb.addEventListener('change', function() {
        state.selectedCodes[prefix][code] = this.checked;
        saveState();
        updateCategoryState(prefix);
        updateAllFilters();
      });
    });
    
    // Select/Deselect all buttons
    document.querySelectorAll('.select-all-btn').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const prefix = this.dataset.prefix;
        const allSelected = this.textContent === 'None';
        
        document.querySelectorAll(`.code-checkbox[data-prefix="${prefix}"]`).forEach(cb => {
          cb.checked = !allSelected;
          state.selectedCodes[prefix][cb.dataset.code] = !allSelected;
        });
        
        saveState();
        updateCategoryState(prefix);
        updateAllFilters();
      });
    });
    
    // Category header collapse
    document.querySelectorAll('.category-header').forEach(header => {
      header.addEventListener('click', function(e) {
        if (e.target.classList.contains('select-all-btn')) return;
        
        const category = this.closest('.filter-category');
        const prefix = category.dataset.prefix;
        const codesList = category.querySelector('.codes-list');
        
        this.classList.toggle('collapsed');
        codesList.classList.toggle('collapsed');
        
        state.categoryCollapsed[prefix] = this.classList.contains('collapsed');
        saveState();
      });
    });
    
    // Clear all filters
    document.getElementById('clear-all-filters')?.addEventListener('click', function() {
      document.querySelectorAll('.code-checkbox').forEach(cb => {
        cb.checked = true;
        state.selectedCodes[cb.dataset.prefix][cb.dataset.code] = true;
      });
      saveState();
      updateAllCategoryStates();
      updateAllFilters();
    });
    
    // Toggle uncoded segments
    const uncodedCheckbox = document.getElementById('show-uncoded');
    if (uncodedCheckbox) {
      uncodedCheckbox.checked = state.showUncoded || false;
      uncodedCheckbox.addEventListener('change', function() {
        state.showUncoded = this.checked;
        saveState();
        updateAllFilters();
      });
    }
    
    // Speaker filter
    const speakerFilterBtn = document.querySelector('.speaker-filter-label');
    const speakerDropdown = document.getElementById('speaker-filter-dropdown');
    
    if (speakerFilterBtn && speakerDropdown) {
      // Initialize speaker checkboxes
      document.querySelectorAll('.speaker-checkbox').forEach(cb => {
        const speaker = cb.dataset.speaker;
        
        if (!state.selectedSpeakers[speaker]) {
          state.selectedSpeakers[speaker] = true;
          cb.checked = true;
        } else {
          cb.checked = state.selectedSpeakers[speaker];
        }
        
        cb.addEventListener('change', function() {
          state.selectedSpeakers[speaker] = this.checked;
          saveState();
          updateSpeakerFilterSummary();
          updateAllFilters();
        });
      });
      
      // Toggle dropdown
      speakerFilterBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        speakerDropdown.classList.toggle('show');
      });
      
      // Close dropdown when clicking outside
      document.addEventListener('click', function(e) {
        if (!e.target.closest('.speaker-filter')) {
          speakerDropdown.classList.remove('show');
        }
      });
      
      // Prevent dropdown from closing when clicking inside
      speakerDropdown.addEventListener('click', function(e) {
        e.stopPropagation();
      });
      
      // Select all/none buttons
      document.getElementById('speaker-select-all')?.addEventListener('click', function() {
        document.querySelectorAll('.speaker-checkbox').forEach(cb => {
          cb.checked = true;
          state.selectedSpeakers[cb.dataset.speaker] = true;
        });
        saveState();
        updateSpeakerFilterSummary();
        updateAllFilters();
      });
      
      document.getElementById('speaker-select-none')?.addEventListener('click', function() {
        document.querySelectorAll('.speaker-checkbox').forEach(cb => {
          cb.checked = false;
          state.selectedSpeakers[cb.dataset.speaker] = false;
        });
        saveState();
        updateSpeakerFilterSummary();
        updateAllFilters();
      });
      
      updateSpeakerFilterSummary();
    }
  }
  
  function initializeCollapsibles() {
    document.querySelectorAll('.interview-header').forEach(header => {
      header.addEventListener('click', function() {
        const section = this.closest('.interview-section');
        const content = section.querySelector('.interview-content');
        const id = section.id;
        
        section.classList.toggle('collapsed');
        content.classList.toggle('collapsed');
        
        state.collapsed[id] = section.classList.contains('collapsed');
        saveState();
      });
    });
  }
  
  function restoreState() {
    // Restore collapsed sections
    Object.keys(state.collapsed).forEach(id => {
      if (state.collapsed[id]) {
        const section = document.getElementById(id);
        if (section) {
          section.classList.add('collapsed');
          section.querySelector('.interview-content').classList.add('collapsed');
        }
      }
    });
    
    // Restore collapsed categories
    Object.keys(state.categoryCollapsed).forEach(prefix => {
      if (state.categoryCollapsed[prefix]) {
        const category = document.querySelector(`.filter-category[data-prefix="${prefix}"]`);
        if (category) {
          category.querySelector('.category-header').classList.add('collapsed');
          category.querySelector('.codes-list').classList.add('collapsed');
        }
      }
    });
    
    updateAllCategoryStates();
  }
  
  function initializeExport() {
    const exportBtn = document.getElementById('export-btn');
    const exportMenu = document.getElementById('export-menu');
    
    if (exportBtn && exportMenu) {
      exportBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        exportMenu.classList.toggle('show');
      });
      
      document.addEventListener('click', function() {
        exportMenu.classList.remove('show');
      });
      
      exportMenu.addEventListener('click', function(e) {
        e.stopPropagation();
      });
    }
    
    document.querySelectorAll('.export-option').forEach(opt => {
      opt.addEventListener('click', function() {
        const format = this.dataset.format;
        exportData(format);
        document.getElementById('export-menu').classList.remove('show');
      });
    });
  }
  
  function getFilteredData() {
    const data = [];
    const filterParams = getActiveFilters();
    
    document.querySelectorAll('.interview-section').forEach(section => {
      const interviewName = section.querySelector('h2').textContent;
      
      section.querySelectorAll('.coding-table tbody tr:not(.hidden)').forEach(row => {
        const speaker = row.querySelector('.speaker-cell').textContent;
        const text = row.querySelector('.text-cell').textContent;
        const codes = Array.from(row.querySelectorAll('.code-tag:not(.inactive)'))
          .map(tag => tag.dataset.code);
        
        data.push({
          interview: interviewName,
          speaker: speaker,
          text: text,
          codes: codes.join(', ')
        });
      });
    });
    
    return { data, filterParams };
  }
  
  function getActiveFilters() {
    const filters = {};
    let hasAnyFilters = false;
    
    Object.keys(state.selectedCodes).forEach(prefix => {
      const allCodesForPrefix = Object.keys(state.selectedCodes[prefix]);
      const selectedCodesForPrefix = allCodesForPrefix.filter(code => state.selectedCodes[prefix][code]);
      
      // Only include if not all codes are selected (i.e., there's an actual filter)
      if (selectedCodesForPrefix.length < allCodesForPrefix.length) {
        filters[prefix] = selectedCodesForPrefix;
        hasAnyFilters = true;
      }
    });
    
    return hasAnyFilters ? filters : {};
  }
  
  function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
  }
  
  function exportData(format) {
    const { data, filterParams } = getFilteredData();
    
    switch(format) {
      case 'csv':
        exportCSV(data, filterParams);
        break;
      case 'json':
        exportJSON(data, filterParams);
        break;
      case 'excel':
        exportExcel(data, filterParams);
        break;
      case 'html':
        exportHTML(data, filterParams);
        break;
      case 'pdf':
        exportPDF(data, filterParams);
        break;
    }
  }
  
  function exportCSV(data, filterParams) {
    const timestamp = getTimestamp();
    let csv = '# Qualitative Coding Export\n';
    csv += '# Export Date: ' + new Date().toISOString() + '\n';
    csv += '# Total Records: ' + data.length + '\n';
    csv += '#\n';
    csv += '# Active Filters:\n';
    
    if (Object.keys(filterParams).length === 0) {
      csv += '# No filters applied (all codes visible)\n';
    } else {
      Object.keys(filterParams).sort().forEach(prefix => {
        csv += '# Category ' + prefix + ': ' + filterParams[prefix].length + ' codes selected\n';
        filterParams[prefix].forEach(code => {
          csv += '#   - ' + code + '\n';
        });
      });
    }
    
    csv += '#\n';
    csv += 'Interview,Speaker,Text,Codes\n';
    
    data.forEach(row => {
      csv += [
        '"' + row.interview.replace(/"/g, '""') + '"',
        '"' + row.speaker.replace(/"/g, '""') + '"',
        '"' + row.text.replace(/"/g, '""') + '"',
        '"' + row.codes.replace(/"/g, '""') + '"'
      ].join(',') + '\n';
    });
    
    downloadFile(csv, `coding-export-${timestamp}.csv`, 'text/csv');
  }
  
  function exportJSON(data, filterParams) {
    const timestamp = getTimestamp();
    
    // Format filter params for better readability
    const formattedFilters = {};
    if (Object.keys(filterParams).length > 0) {
      Object.keys(filterParams).forEach(prefix => {
        formattedFilters[prefix] = {
          categoryName: getCategoryName(prefix),
          selectedCodeCount: filterParams[prefix].length,
          selectedCodes: filterParams[prefix]
        };
      });
    }
    
    const output = {
      exportDate: new Date().toISOString(),
      recordCount: data.length,
      filterParameters: Object.keys(filterParams).length === 0 ? 
        "No filters applied (all codes visible)" : 
        formattedFilters,
      data: data
    };
    
    downloadFile(JSON.stringify(output, null, 2), `coding-export-${timestamp}.json`, 'application/json');
  }
  
  function getCategoryName(prefix) {
    const category = document.querySelector(`.filter-category[data-prefix="${prefix}"]`);
    if (category) {
      const titleSpan = category.querySelector('.category-title > span:first-child');
      if (titleSpan) {
        const text = titleSpan.textContent;
        return text.replace(/^\d+:\s*/, '');
      }
    }
    return prefix;
  }
  
  function exportExcel(data, filterParams) {
    const timestamp = getTimestamp();
    const wb = XLSX.utils.book_new();
    
    // Data sheet
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Coded Data');
    
    // Filter parameters sheet
    const filterInfo = [];
    filterInfo.push({
      'Property': 'Export Date',
      'Value': new Date().toISOString()
    });
    filterInfo.push({
      'Property': 'Record Count',
      'Value': data.length
    });
    filterInfo.push({
      'Property': '',
      'Value': ''
    });
    
    if (Object.keys(filterParams).length === 0) {
      filterInfo.push({
        'Property': 'Filters',
        'Value': 'No filters applied (all codes visible)'
      });
    } else {
      filterInfo.push({
        'Property': 'Active Filters',
        'Value': Object.keys(filterParams).length + ' categories filtered'
      });
      filterInfo.push({
        'Property': '',
        'Value': ''
      });
      
      Object.keys(filterParams).sort().forEach(prefix => {
        filterInfo.push({
          'Property': 'Category ' + prefix + ' (' + getCategoryName(prefix) + ')',
          'Value': filterParams[prefix].length + ' codes selected'
        });
        filterParams[prefix].forEach(code => {
          filterInfo.push({
            'Property': '',
            'Value': '  • ' + code
          });
        });
      });
    }
    
    const filterWs = XLSX.utils.json_to_sheet(filterInfo);
    XLSX.utils.book_append_sheet(wb, filterWs, 'Export Info');
    
    XLSX.writeFile(wb, `coding-export-${timestamp}.xlsx`);
  }
  
  function exportHTML(data, filterParams) {
    const timestamp = getTimestamp();
    let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Coding Export</title>';
    html += '<style>body{font-family:sans-serif;margin:2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}';
    html += 'th,td{border:1px solid #ddd;padding:8px;text-align:left;}th{background:#f2f2f2;}';
    html += '.metadata{background:#f8f9fa;padding:1rem;border-radius:4px;margin-bottom:1rem;}';
    html += '.metadata p{margin:0.5rem 0;}';
    html += '.filter-list{margin-left:1.5rem;}.filter-category{margin-top:0.5rem;font-weight:bold;}';
    html += '.filter-codes{margin-left:1.5rem;list-style-type:disc;}</style></head><body>';
    html += '<h1>Qualitative Coding Export</h1>';
    html += '<div class="metadata">';
    html += '<p><strong>Export Date:</strong> ' + new Date().toLocaleString() + '</p>';
    html += '<p><strong>Record Count:</strong> ' + data.length + '</p>';
    html += '<p><strong>Filter Parameters:</strong></p>';
    
    if (Object.keys(filterParams).length === 0) {
      html += '<p style="margin-left:1.5rem;"><em>No filters applied (all codes visible)</em></p>';
    } else {
      html += '<div class="filter-list">';
      Object.keys(filterParams).sort().forEach(prefix => {
        html += '<div class="filter-category">Category ' + prefix + ': ' + getCategoryName(prefix);
        html += ' (' + filterParams[prefix].length + ' codes selected)</div>';
        html += '<ul class="filter-codes">';
        filterParams[prefix].forEach(code => {
          html += '<li>' + code + '</li>';
        });
        html += '</ul>';
      });
      html += '</div>';
    }
    
    html += '</div>';
    html += '<table><thead><tr><th>Interview</th><th>Speaker</th><th>Text</th><th>Codes</th></tr></thead><tbody>';
    
    data.forEach(row => {
      html += '<tr><td>' + row.interview + '</td><td>' + row.speaker + '</td><td>' + row.text + '</td><td>' + row.codes + '</td></tr>';
    });
    
    html += '</tbody></table></body></html>';
    downloadFile(html, `coding-export-${timestamp}.html`, 'text/html');
  }
  
  function exportPDF(data, filterParams) {
    const timestamp = getTimestamp();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    
    let yPos = 20;
    
    doc.setFontSize(16);
    doc.text('Qualitative Coding Export', 14, yPos);
    yPos += 10;
    
    doc.setFontSize(10);
    doc.text('Export Date: ' + new Date().toLocaleString(), 14, yPos);
    yPos += 6;
    doc.text('Record Count: ' + data.length, 14, yPos);
    yPos += 8;
    
    doc.setFontSize(11);
    doc.text('Filter Parameters:', 14, yPos);
    yPos += 6;
    
    doc.setFontSize(9);
    if (Object.keys(filterParams).length === 0) {
      doc.text('No filters applied (all codes visible)', 20, yPos);
      yPos += 8;
    } else {
      Object.keys(filterParams).sort().forEach(prefix => {
        const categoryText = 'Category ' + prefix + ': ' + getCategoryName(prefix) + 
                           ' (' + filterParams[prefix].length + ' codes)';
        doc.text(categoryText, 20, yPos);
        yPos += 5;
        
        filterParams[prefix].forEach(code => {
          if (yPos > 270) {
            doc.addPage();
            yPos = 20;
          }
          doc.text('  • ' + code, 26, yPos);
          yPos += 4;
        });
        yPos += 3;
      });
    }
    
    yPos += 5;
    
    const tableData = data.map(row => [row.interview, row.speaker, row.text, row.codes]);
    
    doc.autoTable({
      startY: yPos,
      head: [['Interview', 'Speaker', 'Text', 'Codes']],
      body: tableData,
      styles: { fontSize: 8 },
      columnStyles: { 2: { cellWidth: 80 } }
    });
    
    doc.save(`coding-export-${timestamp}.pdf`);
  }
  
  function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  
  // Expose necessary functions and state to global scope for additional handlers
  window.state = state;
  window.saveState = saveState;
  window.updateAllCategoryStates = updateAllCategoryStates;
  window.updateAllFilters = updateAllFilters;
  
  document.addEventListener('DOMContentLoaded', function() {
    loadState();
    initializeFilters();
    initializeCollapsibles();
    initializeExport();
    restoreState();
    updateAllFilters();
  });
})();