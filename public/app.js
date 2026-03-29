'use strict';

let currentResult = null;   // last query result for saving
let currentQuestion = '';
let savedQueries = [];

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([loadStats(), loadSavedQueries()]);
  document.getElementById('query-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) runQuery();
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const { stats, today } = await res.json();

    document.getElementById('hs-today').textContent = fmt(today.today);
    document.getElementById('hs-month').textContent = fmt(stats.total_pageviews);
    document.getElementById('hs-unique').textContent = fmt(stats.unique_visitors);

    document.getElementById('sc-today').textContent = fmt(today.today);
    document.getElementById('sc-today-u').textContent = `${fmt(today.unique_today)} unique`;
    document.getElementById('sc-month').textContent = fmt(stats.total_pageviews);
    document.getElementById('sc-month-u').textContent = `${fmt(stats.unique_visitors)} unique visitors`;
    document.getElementById('sc-pages').textContent = fmt(stats.unique_pages);
    document.getElementById('sc-days').textContent = fmt(stats.active_days);

    if (stats.total_pageviews > 0) {
      document.getElementById('stats-row').style.display = 'flex';
    }
  } catch (e) {
    console.error('Failed to load stats', e);
  }
}

// ── Saved Queries ─────────────────────────────────────────────────────────────

async function loadSavedQueries() {
  try {
    const res = await fetch('/api/saved-queries');
    savedQueries = await res.json();
    renderSavedQueries();
  } catch (e) {
    console.error('Failed to load saved queries', e);
  }
}

function renderSavedQueries() {
  const list = document.getElementById('saved-list');

  if (savedQueries.length === 0) {
    list.innerHTML = '<div class="sidebar-empty">No saved queries yet.<br>Run a query and save it for quick access.</div>';
    return;
  }

  list.innerHTML = savedQueries.map(q => `
    <div class="saved-query" data-id="${q.id}" onclick="runSavedQuery(${q.id})">
      <span class="saved-query-icon">⚡</span>
      <div class="saved-query-body">
        <div class="saved-query-text" title="${esc(q.query)}">${esc(q.query)}</div>
        <div class="saved-query-meta">
          ${q.run_count} run${q.run_count !== 1 ? 's' : ''}
          ${q.last_run ? ' · ' + relTime(q.last_run) : ''}
        </div>
      </div>
      <button class="saved-query-delete" onclick="deleteSavedQuery(event, ${q.id})" title="Remove">✕</button>
    </div>
  `).join('');
}

async function runSavedQuery(id) {
  const q = savedQueries.find(x => x.id === id);
  if (!q) return;

  // Highlight active
  document.querySelectorAll('.saved-query').forEach(el => el.classList.remove('active'));
  document.querySelector(`.saved-query[data-id="${id}"]`)?.classList.add('active');

  document.getElementById('query-input').value = q.query;
  await runQuery(q.id);
}

async function saveCurrentQuery() {
  if (!currentQuestion || !currentResult) return;

  try {
    const res = await fetch('/api/saved-queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: currentQuestion,
        description: currentResult.title,
        sql_query: currentResult.sql,
      }),
    });
    const saved = await res.json();
    savedQueries.unshift(saved);
    renderSavedQueries();
    document.getElementById('save-btn').textContent = '★ Saved';
    document.getElementById('save-btn').disabled = true;
    toast('Query saved!');
  } catch (e) {
    toast('Failed to save query', true);
  }
}

async function deleteSavedQuery(event, id) {
  event.stopPropagation();
  await fetch(`/api/saved-queries/${id}`, { method: 'DELETE' });
  savedQueries = savedQueries.filter(q => q.id !== id);
  renderSavedQueries();
  toast('Query removed');
}

// ── Run Query ─────────────────────────────────────────────────────────────────

async function runQuery(savedId = null) {
  const input = document.getElementById('query-input');
  const question = input.value.trim();
  if (!question) return;

  currentQuestion = question;
  currentResult = null;

  setLoading(true);
  clearEmptyState();

  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, saved_query_id: savedId }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Unknown error');
      return;
    }

    currentResult = data;
    renderResult(data, question);

    // Show save button (if not already saved)
    const alreadySaved = savedQueries.some(q => q.query.toLowerCase() === question.toLowerCase());
    const saveBtn = document.getElementById('save-btn');
    saveBtn.style.display = alreadySaved ? 'none' : '';
    saveBtn.textContent = '☆ Save';
    saveBtn.disabled = false;

    // Reload saved queries to update run counts
    if (savedId) loadSavedQueries();

  } catch (e) {
    showError('Network error: ' + e.message);
  } finally {
    setLoading(false);
  }
}

function renderResult(data, question) {
  const area = document.getElementById('results-area');

  const noData = !data.rows || data.rows.length === 0;

  const tableHtml = noData
    ? '<div class="no-data">No data found for this query.</div>'
    : `<div class="result-body">
        <table class="result-table">
          <thead>
            <tr>${data.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${data.rows.slice(0, 200).map(row =>
              `<tr>${data.columns.map(c => `<td class="${isNumeric(row[c]) ? 'num' : ''}">${esc(row[c] ?? '')}</td>`).join('')}</tr>`
            ).join('')}
          </tbody>
        </table>
       </div>`;

  const cardId = 'result-' + Date.now();

  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `
    <div class="result-header">
      <div class="result-header-left">
        <div class="result-title">${esc(data.title || question)}</div>
        <div class="result-answer">${esc(data.answer || '')}</div>
      </div>
    </div>
    ${tableHtml}
    <div class="result-footer">
      <span class="result-count">${data.row_count} row${data.row_count !== 1 ? 's' : ''}</span>
      <button class="sql-toggle" onclick="toggleSql('${cardId}')">Show SQL ▾</button>
    </div>
    <pre class="sql-block" id="${cardId}">${esc(data.sql || '')}</pre>
  `;

  // Prepend so newest is on top
  area.insertBefore(card, area.firstChild);

  // Remove old empty state if present
  document.getElementById('empty-state')?.remove();
}

function toggleSql(id) {
  const block = document.getElementById(id);
  const btn = block?.previousElementSibling?.querySelector('.sql-toggle');
  if (!block) return;
  block.classList.toggle('visible');
  if (btn) btn.textContent = block.classList.contains('visible') ? 'Hide SQL ▴' : 'Show SQL ▾';
}

function showError(msg) {
  const area = document.getElementById('results-area');
  const card = document.createElement('div');
  card.className = 'result-card';
  card.style.borderColor = 'rgba(248,113,113,0.4)';
  card.innerHTML = `
    <div class="result-header">
      <div class="result-header-left">
        <div class="result-title" style="color:var(--red)">⚠ Error</div>
        <div class="result-answer">${esc(msg)}</div>
      </div>
    </div>
  `;
  area.insertBefore(card, area.firstChild);
  document.getElementById('empty-state')?.remove();
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

function useQuery(el) {
  document.getElementById('query-input').value = el.textContent;
  document.getElementById('query-input').focus();
}

function setLoading(on) {
  const btn = document.getElementById('run-btn');
  const icon = document.getElementById('run-btn-icon');
  btn.disabled = on;
  if (on) {
    icon.innerHTML = '<span class="spinner" style="display:inline-block;vertical-align:middle"></span>';

    // Show a loading card
    const area = document.getElementById('results-area');
    const loader = document.createElement('div');
    loader.id = 'loader-card';
    loader.className = 'result-card';
    loader.innerHTML = '<div class="loading-bar"><div class="spinner"></div> Asking Claude...</div>';
    area.insertBefore(loader, area.firstChild);
    document.getElementById('empty-state')?.remove();
  } else {
    icon.innerHTML = '▶';
    document.getElementById('loader-card')?.remove();
  }
}

function clearEmptyState() {
  // Keep results, just remove the placeholder
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = isError ? 'rgba(248,113,113,0.4)' : 'var(--border)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n) {
  if (n === null || n === undefined) return '0';
  return Number(n).toLocaleString();
}

function isNumeric(val) {
  return val !== null && val !== '' && !isNaN(val);
}

function relTime(dateStr) {
  const diff = Date.now() - new Date(dateStr + 'Z').getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
