(function() {
  'use strict';
  
  const STATE_KEY = 'coding-viz-state';
  
  let state = {
    collapsed: {},
    categoryCollapsed: {},
    selectedCodes: {}
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
  
  document.addEventListener('DOMContentLoaded', function() {
    loadState();
    initializeFilters();
    initializeCollapsibles();
    initializeExport();
    restoreState();
    updateAllFilters();
  });
  
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
  }
  
  function updateCategoryState(prefix) {
    const category = document.querySelector(`.filter-category[data-prefix="${prefix}"]`);
    const checkboxes = category.querySelectorAll('.code-checkbox');
    const checkedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    const hasFilter = checkedCount < checkboxes.length;
    
    category.classList.toggle('has-filter', hasFilter);
    
    const selectAllBtn = category.querySelector('.select-all-btn');
    selectAllBtn.textContent = checkedCount === checkboxes.length ? 'None' : 'All';
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
    
    // Hide rows with no active codes
    document.querySelectorAll('.coding-table tbody tr').forEach(row => {
      const tags = row.querySelectorAll('.code-tag');
      const hasActiveCode = Array.from(tags).some(tag => !tag.classList.contains('inactive'));
      row.classList.toggle('hidden', !hasActiveCode);
    });
    
    updateStats();
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
  
  function updateStats() {
    document.querySelectorAll('.interview-section').forEach(section => {
      const table = section.querySelector('.coding-table');
      if (!table) return;
      
      const total = table.querySelectorAll('tbody tr').length;
      const visible = table.querySelectorAll('tbody tr:not(.hidden)').length;
      const summary = section.querySelector('.stats-summary');
      if (summary) {
        summary.textContent = 'Showing ' + visible + ' of ' + total + ' coded lines';
      }
    });
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
    csv += '# Filter Parameters: ' + JSON.stringify(filterParams) + '\n';
    csv += '\n';
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
    const output = {
      exportDate: new Date().toISOString(),
      filterParameters: filterParams,
      recordCount: data.length,
      data: data
    };
    
    downloadFile(JSON.stringify(output, null, 2), `coding-export-${timestamp}.json`, 'application/json');
  }
  
  function exportExcel(data, filterParams) {
    const timestamp = getTimestamp();
    const wb = XLSX.utils.book_new();
    
    // Data sheet
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Coded Data');
    
    // Filter parameters sheet
    const filterData = [{
      'Export Date': new Date().toISOString(),
      'Filter Parameters': JSON.stringify(filterParams, null, 2),
      'Record Count': data.length
    }];
    const filterWs = XLSX.utils.json_to_sheet(filterData);
    XLSX.utils.book_append_sheet(wb, filterWs, 'Export Info');
    
    XLSX.writeFile(wb, `coding-export-${timestamp}.xlsx`);
  }
  
  function exportHTML(data, filterParams) {
    const timestamp = getTimestamp();
    let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Coding Export</title>';
    html += '<style>body{font-family:sans-serif;margin:2rem;}table{border-collapse:collapse;width:100%;margin-top:1rem;}';
    html += 'th,td{border:1px solid #ddd;padding:8px;text-align:left;}th{background:#f2f2f2;}';
    html += '.metadata{background:#f8f9fa;padding:1rem;border-radius:4px;margin-bottom:1rem;}';
    html += '.metadata p{margin:0.5rem 0;}</style></head><body>';
    html += '<h1>Qualitative Coding Export</h1>';
    html += '<div class="metadata">';
    html += '<p><strong>Export Date:</strong> ' + new Date().toLocaleString() + '</p>';
    html += '<p><strong>Record Count:</strong> ' + data.length + '</p>';
    html += '<p><strong>Filter Parameters:</strong></p>';
    html += '<pre>' + JSON.stringify(filterParams, null, 2) + '</pre>';
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
    
    doc.setFontSize(16);
    doc.text('Qualitative Coding Export', 14, 20);
    
    doc.setFontSize(10);
    doc.text('Export Date: ' + new Date().toLocaleString(), 14, 30);
    doc.text('Record Count: ' + data.length, 14, 36);
    doc.text('Filter Parameters:', 14, 42);
    
    const filterText = JSON.stringify(filterParams, null, 2);
    const filterLines = doc.splitTextToSize(filterText, 180);
    doc.setFontSize(8);
    doc.text(filterLines, 14, 48);
    
    const startY = 48 + (filterLines.length * 3) + 5;
    const tableData = data.map(row => [row.interview, row.speaker, row.text, row.codes]);
    
    doc.autoTable({
      startY: startY,
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
})();