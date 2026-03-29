"use strict";

let currentResult = null;
let currentQuestion = "";
let savedQueries = [];
let emailPanelOpen = false;
let editingScheduleId = null;

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([loadStats(), loadSavedQueries(), loadEmailSchedules()]);
  document.getElementById("query-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) runQuery();
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const { stats, today } = await res.json();

    document.getElementById("hs-today").textContent = fmt(today.today);
    document.getElementById("hs-month").textContent = fmt(
      stats.total_pageviews,
    );
    document.getElementById("hs-unique").textContent = fmt(
      stats.unique_visitors,
    );

    document.getElementById("sc-today").textContent = fmt(today.today);
    document.getElementById("sc-today-u").textContent =
      `${fmt(today.unique_today)} unique`;
    document.getElementById("sc-month").textContent = fmt(
      stats.total_pageviews,
    );
    document.getElementById("sc-month-u").textContent =
      `${fmt(stats.unique_visitors)} unique visitors`;
    document.getElementById("sc-pages").textContent = fmt(stats.unique_pages);
    document.getElementById("sc-days").textContent = fmt(stats.active_days);

    if (stats.total_pageviews > 0) {
      document.getElementById("stats-row").style.display = "flex";
    }
  } catch (e) {
    console.error("Failed to load stats", e);
  }
}

// ── Saved Queries ─────────────────────────────────────────────────────────────

async function loadSavedQueries() {
  try {
    const res = await fetch("/api/saved-queries");
    savedQueries = await res.json();
    renderSavedQueries();
  } catch (e) {
    console.error("Failed to load saved queries", e);
  }
}

function renderSavedQueries() {
  const list = document.getElementById("saved-list");

  if (savedQueries.length === 0) {
    list.innerHTML =
      '<div class="sidebar-empty">No saved queries yet.<br>Run a query and save it for quick access.</div>';
    return;
  }

  list.innerHTML = savedQueries
    .map(
      (q) => `
    <div class="saved-query" data-id="${q.id}" onclick="runSavedQuery(${q.id})">
      <span class="saved-query-icon"><i class="fa-solid fa-bolt"></i></span>
      <div class="saved-query-body">
        <div class="saved-query-text" title="${esc(q.query)}">${esc(q.query)}</div>
        <div class="saved-query-meta">
          ${q.run_count} run${q.run_count !== 1 ? "s" : ""}
          ${q.last_run ? " · " + relTime(q.last_run) : ""}
        </div>
      </div>
      <button class="saved-query-delete" onclick="deleteSavedQuery(event, ${q.id})" title="Remove">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
  `,
    )
    .join("");
}

async function runSavedQuery(id) {
  const q = savedQueries.find((x) => x.id === id);
  if (!q) return;

  document
    .querySelectorAll(".saved-query")
    .forEach((el) => el.classList.remove("active"));
  document
    .querySelector(`.saved-query[data-id="${id}"]`)
    ?.classList.add("active");

  document.getElementById("query-input").value = q.query;
  await runQuery(q.id);
}

async function saveCurrentQuery() {
  if (!currentQuestion || !currentResult) return;

  try {
    const res = await fetch("/api/saved-queries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: currentQuestion,
        description: currentResult.title,
        sql_query: currentResult.sql,
      }),
    });
    const saved = await res.json();
    savedQueries.unshift(saved);
    renderSavedQueries();
    const saveBtn = document.getElementById("save-btn");
    saveBtn.innerHTML = '<i class="fa-solid fa-star"></i> Saved';
    saveBtn.disabled = true;
    toast("Query saved!");
  } catch (e) {
    toast("Failed to save query", true);
  }
}

async function deleteSavedQuery(event, id) {
  event.stopPropagation();
  await fetch(`/api/saved-queries/${id}`, { method: "DELETE" });
  savedQueries = savedQueries.filter((q) => q.id !== id);
  renderSavedQueries();
  toast("Query removed");
}

// ── Run Query ─────────────────────────────────────────────────────────────────

async function runQuery(savedId = null) {
  const input = document.getElementById("query-input");
  const question = input.value.trim();
  if (!question) return;

  currentQuestion = question;
  currentResult = null;

  setLoading(true);

  try {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, saved_query_id: savedId }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || "Unknown error");
      return;
    }

    currentResult = data;
    renderResult(data, question);

    const alreadySaved = savedQueries.some(
      (q) => q.query.toLowerCase() === question.toLowerCase(),
    );
    const saveBtn = document.getElementById("save-btn");
    saveBtn.style.display = alreadySaved ? "none" : "";
    saveBtn.innerHTML = '<i class="fa-regular fa-star"></i> Save';
    saveBtn.disabled = false;

    if (savedId) loadSavedQueries();
  } catch (e) {
    showError("Network error: " + e.message);
  } finally {
    setLoading(false);
  }
}

function renderResult(data, question) {
  const area = document.getElementById("results-area");
  const noData = !data.rows || data.rows.length === 0;

  const tableHtml = noData
    ? '<div class="no-data">No data found for this query.</div>'
    : `<div class="result-body">
        <table class="result-table">
          <thead>
            <tr>${data.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${data.rows
              .slice(0, 200)
              .map(
                (row) =>
                  `<tr>${data.columns.map((c) => `<td class="${isNumeric(row[c]) ? "num" : ""}">${esc(row[c] ?? "")}</td>`).join("")}</tr>`,
              )
              .join("")}
          </tbody>
        </table>
       </div>`;

  const cardId = "result-" + Date.now();
  const card = document.createElement("div");
  card.className = "result-card";
  card.innerHTML = `
    <div class="result-header">
      <div class="result-header-left">
        <div class="result-title">${esc(data.title || question)}</div>
        <div class="result-answer">${esc(data.answer || "")}</div>
      </div>
    </div>
    ${tableHtml}
    <div class="result-footer">
      <span class="result-count">${data.row_count} row${data.row_count !== 1 ? "s" : ""}</span>
      <button class="sql-toggle" onclick="toggleSql('${cardId}')">
        Show SQL <i class="fa-solid fa-chevron-down"></i>
      </button>
    </div>
    <pre class="sql-block" id="${cardId}">${esc(data.sql || "")}</pre>
  `;

  area.insertBefore(card, area.firstChild);
  document.getElementById("empty-state")?.remove();
}

function toggleSql(id) {
  const block = document.getElementById(id);
  const btn = block?.previousElementSibling?.querySelector(".sql-toggle");
  if (!block) return;
  block.classList.toggle("visible");
  if (btn)
    btn.innerHTML = block.classList.contains("visible")
      ? 'Hide SQL <i class="fa-solid fa-chevron-up"></i>'
      : 'Show SQL <i class="fa-solid fa-chevron-down"></i>';
}

function showError(msg) {
  const area = document.getElementById("results-area");
  const card = document.createElement("div");
  card.className = "result-card";
  card.style.borderColor = "rgba(248,113,113,0.4)";
  card.innerHTML = `
    <div class="result-header">
      <div class="result-header-left">
        <div class="result-title" style="color:var(--red)">
          <i class="fa-solid fa-triangle-exclamation"></i> Error
        </div>
        <div class="result-answer">${esc(msg)}</div>
      </div>
    </div>
  `;
  area.insertBefore(card, area.firstChild);
  document.getElementById("empty-state")?.remove();
}

// ── Email Schedules ───────────────────────────────────────────────────────────

async function loadEmailSchedules() {
  try {
    const res = await fetch("/api/email-schedules");
    const schedules = await res.json();
    renderEmailSchedules(schedules);
  } catch (e) {
    console.error("Failed to load email schedules", e);
  }
}

function renderEmailSchedules(schedules) {
  const list = document.getElementById("email-schedules-list");
  if (!schedules || schedules.length === 0) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = schedules
    .map(
      (s) => `
    <div class="schedule-item ${s.active ? "" : "schedule-inactive"}">
      <div class="schedule-item-info">
        <div class="schedule-email"><i class="fa-solid fa-envelope"></i> ${esc(s.email)}</div>
        <div class="schedule-meta">
          <i class="fa-regular fa-calendar"></i> Every ${DAYS[s.day_of_week]}
          ${s.last_sent ? " · Last sent " + relTime(s.last_sent) : ""}
        </div>
      </div>
      <div class="schedule-item-actions">
        <button class="icon-btn" onclick="sendNow(${s.id})" title="Send now">
          <i class="fa-solid fa-paper-plane"></i>
        </button>
        <button class="icon-btn" onclick="toggleSchedule(${s.id}, ${s.active})" title="${s.active ? "Pause" : "Resume"}">
          <i class="fa-solid fa-${s.active ? "pause" : "play"}"></i>
        </button>
        <button class="icon-btn icon-btn-danger" onclick="deleteSchedule(${s.id})" title="Delete">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
  `,
    )
    .join("");
}

function toggleEmailPanel() {
  emailPanelOpen = !emailPanelOpen;
  document
    .getElementById("email-panel")
    .classList.toggle("open", emailPanelOpen);
  document.getElementById("email-chevron").className = emailPanelOpen
    ? "fa-solid fa-chevron-up"
    : "fa-solid fa-chevron-down";
}

function showAddSchedule() {
  document.getElementById("email-form").style.display = "flex";
  document.getElementById("add-schedule-btn").style.display = "none";
  document.getElementById("schedule-email").focus();
  editingScheduleId = null;
}

function cancelAddSchedule() {
  document.getElementById("email-form").style.display = "none";
  document.getElementById("add-schedule-btn").style.display = "";
  document.getElementById("schedule-email").value = "";
  editingScheduleId = null;
}

async function saveSchedule() {
  const email = document.getElementById("schedule-email").value.trim();
  const day_of_week = parseInt(
    document.getElementById("schedule-day").value,
    10,
  );

  if (!email) {
    toast("Please enter an email address", true);
    return;
  }

  try {
    const res = await fetch("/api/email-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, day_of_week }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    cancelAddSchedule();
    await loadEmailSchedules();
    toast(`Report scheduled for every ${DAYS[day_of_week]}`);
  } catch (e) {
    toast("Failed to save: " + e.message, true);
  }
}

async function sendReportNow() {
  const emailInput = document.getElementById("send-now-email");
  const btn = document.getElementById("send-now-btn");
  const email = emailInput.value.trim();
  if (!email) {
    toast("Please enter an email address", true);
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';
  try {
    const res = await fetch("/api/send-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    emailInput.value = "";
    toast(`Report sent to ${email}!`);
  } catch (e) {
    toast("Failed to send: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Now';
  }
}

async function sendNow(id) {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  try {
    const res = await fetch(`/api/email-schedules/${id}/send-now`, {
      method: "POST",
    });
    if (!res.ok) throw new Error((await res.json()).error);
    toast("Summary email sent!");
    await loadEmailSchedules();
  } catch (e) {
    toast("Failed to send: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
  }
}

async function toggleSchedule(id, currentlyActive) {
  const schedules = await (await fetch("/api/email-schedules")).json();
  const s = schedules.find((x) => x.id === id);
  if (!s) return;
  await fetch(`/api/email-schedules/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: s.email,
      day_of_week: s.day_of_week,
      active: currentlyActive ? 0 : 1,
    }),
  });
  await loadEmailSchedules();
  toast(currentlyActive ? "Report paused" : "Report resumed");
}

async function deleteSchedule(id) {
  await fetch(`/api/email-schedules/${id}`, { method: "DELETE" });
  await loadEmailSchedules();
  toast("Schedule removed");
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

function useQuery(el) {
  document.getElementById("query-input").value = el.textContent;
  document.getElementById("query-input").focus();
}

function setLoading(on) {
  const btn = document.getElementById("run-btn");
  const icon = document.getElementById("run-btn-icon");
  btn.disabled = on;
  if (on) {
    icon.innerHTML =
      '<span class="spinner" style="display:inline-block;vertical-align:middle"></span>';
    const area = document.getElementById("results-area");
    const loader = document.createElement("div");
    loader.id = "loader-card";
    loader.className = "result-card";
    loader.innerHTML =
      '<div class="loading-bar"><div class="spinner"></div> Analysing website traffic...</div>';
    area.insertBefore(loader, area.firstChild);
    document.getElementById("empty-state")?.remove();
  } else {
    icon.innerHTML = '<i class="fa-solid fa-play"></i>';
    document.getElementById("loader-card")?.remove();
  }
}

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.borderColor = isError ? "rgba(248,113,113,0.4)" : "var(--border)";
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(n) {
  if (n === null || n === undefined) return "0";
  return Number(n).toLocaleString();
}

function isNumeric(val) {
  return val !== null && val !== "" && !isNaN(val);
}

function relTime(dateStr) {
  const diff = Date.now() - new Date(dateStr + "Z").getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
