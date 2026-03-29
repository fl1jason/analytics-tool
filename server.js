require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const geoip = require("geoip-lite");
const { UAParser } = require("ua-parser-js");
const Anthropic = require("@anthropic-ai/sdk");
const sgMail = require("@sendgrid/mail");
const cron = require("node-cron");

const {
  db,
  insertPageview,
  getStats,
  getStatsToday,
  getSavedQueries,
  insertSavedQuery,
  updateQueryRunCount,
  deleteSavedQuery,
  getEmailSchedules,
  getActiveSchedulesForDay,
  insertEmailSchedule,
  updateEmailSchedule,
  markScheduleSent,
  deleteEmailSchedule,
  SCHEMA_DESCRIPTION,
} = require("./db");

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Allowed origins for the tracker collect endpoint
const ALLOWED_TRACKER_ORIGINS = [
  "https://fl1digital.com",
  "https://www.fl1digital.com",
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // sendBeacon and same-origin requests may omit Origin
  return ALLOWED_TRACKER_ORIGINS.some((o) =>
    o instanceof RegExp ? o.test(origin) : o === origin,
  );
}

const collectCorsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin not allowed: ${origin}`));
    }
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: true,
};

// Explicit preflight handler — required for non-simple requests (JSON content-type)
app.options("/collect", cors(collectCorsOptions));

// Apply CORS headers to actual POST requests
app.use("/collect", cors(collectCorsOptions));

// Dashboard API routes get same-origin CORS only
app.use("/api", cors({ origin: `http://localhost:${PORT}` }));

// ─── Tracker Endpoint ────────────────────────────────────────────────────────

app.post("/collect", (req, res) => {
  try {
    const data = req.body;

    // Get real IP (handle proxies)
    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.headers["x-real-ip"] ||
      req.socket.remoteAddress ||
      "";

    // Clean loopback IPs for geoip
    const cleanIp = ip === "::1" || ip === "127.0.0.1" ? null : ip;

    // Geo lookup
    const geo = cleanIp ? geoip.lookup(cleanIp) : null;

    // Parse user agent (sent from client for accuracy)
    const ua = data.user_agent || req.headers["user-agent"] || "";
    const parser = new UAParser(ua);
    const browser = parser.getBrowser();
    const os = parser.getOS();
    const device = parser.getDevice();

    const deviceType =
      device.type === "mobile"
        ? "mobile"
        : device.type === "tablet"
          ? "tablet"
          : "desktop";

    insertPageview.run({
      $ip: cleanIp || ip,
      $country: geo?.country ? getCountryName(geo.country) : null,
      $country_code: geo?.country || null,
      $city: geo?.city || null,
      $region: geo?.region || null,
      $browser: browser.name || null,
      $browser_version: browser.version || null,
      $os: os.name || null,
      $device_type: deviceType,
      $screen_width: data.screen_width || null,
      $screen_height: data.screen_height || null,
      $language: data.language || null,
      $timezone: data.timezone || null,
      $url: data.url || null,
      $path: data.path || null,
      $title: data.title || null,
      $referrer: data.referrer || null,
      $referrer_domain: data.referrer_domain || null,
      $search_engine: data.search_engine || null,
      $search_terms: data.search_terms || null,
      $timestamp:
        data.timestamp ||
        new Date().toISOString().replace("T", " ").slice(0, 19),
    });

    res.sendStatus(204);
  } catch (err) {
    console.error("Error saving pageview:", err);
    res.sendStatus(500);
  }
});

// ─── Stats API ───────────────────────────────────────────────────────────────

app.get("/api/stats", (req, res) => {
  const stats = getStats.get();
  const today = getStatsToday.get();

  const topPages = db
    .prepare(
      `
    SELECT path, title, COUNT(*) as views
    FROM pageviews
    WHERE timestamp >= datetime('now', '-7 days')
    GROUP BY path
    ORDER BY views DESC
    LIMIT 5
  `,
    )
    .all();

  const topReferrers = db
    .prepare(
      `
    SELECT referrer_domain, COUNT(*) as visits
    FROM pageviews
    WHERE referrer_domain IS NOT NULL AND referrer_domain != ''
      AND timestamp >= datetime('now', '-7 days')
    GROUP BY referrer_domain
    ORDER BY visits DESC
    LIMIT 5
  `,
    )
    .all();

  res.json({ stats, today, topPages, topReferrers });
});

// ─── Natural Language Query API ──────────────────────────────────────────────

app.post("/api/query", async (req, res) => {
  const { question, saved_query_id } = req.body;

  if (!question || !question.trim()) {
    return res.status(400).json({ error: "Question is required" });
  }

  try {
    // Step 1: Ask Claude to generate SQL
    const sqlResponse = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      system: `You are an expert SQLite analyst. Given a database schema and a question,
generate a SQL query to answer it. Always respond with valid JSON only, no markdown.
The JSON must have: { "sql": "...", "title": "...", "description": "..." }
- sql: a safe read-only SELECT query (no INSERT/UPDATE/DELETE/DROP)
- title: short title for the result (e.g. "Top Landing Pages This Week")
- description: one sentence explaining what the query shows`,
      messages: [
        {
          role: "user",
          content: `Database schema:\n${SCHEMA_DESCRIPTION}\n\nQuestion: ${question}`,
        },
      ],
    });

    let sqlData;
    try {
      const rawText = sqlResponse.content[0].text.trim();
      // Strip markdown code blocks if present
      const cleaned = rawText
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      sqlData = JSON.parse(cleaned);
    } catch {
      return res
        .status(500)
        .json({ error: "Failed to parse SQL from AI response" });
    }

    // Safety check — only allow SELECT statements
    const sqlUpper = sqlData.sql.trim().toUpperCase();
    if (!sqlUpper.startsWith("SELECT") && !sqlUpper.startsWith("WITH")) {
      return res.status(400).json({ error: "Only SELECT queries are allowed" });
    }

    // Step 2: Execute the SQL
    let rows, columns;
    try {
      const stmt = db.prepare(sqlData.sql);
      rows = stmt.all();
      columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    } catch (sqlErr) {
      return res
        .status(400)
        .json({ error: `SQL error: ${sqlErr.message}`, sql: sqlData.sql });
    }

    // Step 3: Ask Claude to interpret the results
    let answer = null;
    if (rows.length > 0) {
      const interpretResponse = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: `The user asked: "${question}"

Here are the query results (up to 20 rows shown):
${JSON.stringify(rows.slice(0, 20), null, 2)}

Write a concise, friendly 1-3 sentence answer directly addressing the question.
Include key numbers/names from the data. No markdown, plain text only.`,
          },
        ],
      });
      answer = interpretResponse.content[0].text.trim();
    } else {
      answer = "No data found for this query in the current dataset.";
    }

    // Update run count if this is a re-run of a saved query
    if (saved_query_id) {
      updateQueryRunCount.run({ $id: saved_query_id });
    }

    res.json({
      title: sqlData.title,
      description: sqlData.description,
      sql: sqlData.sql,
      columns,
      rows,
      answer,
      row_count: rows.length,
    });
  } catch (err) {
    console.error("Query error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Saved Queries API ───────────────────────────────────────────────────────

app.get("/api/saved-queries", (req, res) => {
  res.json(getSavedQueries.all());
});

app.post("/api/saved-queries", (req, res) => {
  const { query, description, sql_query } = req.body;
  if (!query) return res.status(400).json({ error: "query is required" });
  const result = insertSavedQuery.run({
    $query: query,
    $description: description || null,
    $sql_query: sql_query || null,
  });
  res.json({
    id: Number(result.lastInsertRowid),
    query,
    description,
    sql_query,
    run_count: 0,
  });
});

app.put("/api/saved-queries/:id/run", (req, res) => {
  updateQueryRunCount.run({ $id: req.params.id });
  res.json({ ok: true });
});

app.delete("/api/saved-queries/:id", (req, res) => {
  deleteSavedQuery.run(req.params.id);
  res.json({ ok: true });
});

// ─── Email Schedule API ───────────────────────────────────────────────────────

app.get("/api/email-schedules", (req, res) => {
  res.json(getEmailSchedules.all());
});

app.post("/api/email-schedules", (req, res) => {
  const { email, day_of_week } = req.body;
  if (!email || day_of_week === undefined) {
    return res
      .status(400)
      .json({ error: "email and day_of_week are required" });
  }
  const result = insertEmailSchedule.run({
    $email: email,
    $day_of_week: day_of_week,
  });
  res.json({
    id: Number(result.lastInsertRowid),
    email,
    day_of_week,
    active: 1,
  });
});

app.put("/api/email-schedules/:id", (req, res) => {
  const { email, day_of_week, active } = req.body;
  updateEmailSchedule.run({
    $id: req.params.id,
    $email: email,
    $day_of_week: day_of_week,
    $active: active !== undefined ? active : 1,
  });
  res.json({ ok: true });
});

app.delete("/api/email-schedules/:id", (req, res) => {
  deleteEmailSchedule.run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/email-schedules/:id/send-now", async (req, res) => {
  const schedules = getEmailSchedules.all();
  const schedule = schedules.find((s) => s.id === Number(req.params.id));
  if (!schedule) return res.status(404).json({ error: "Schedule not found" });

  try {
    await sendWeeklySummary(schedule.email);
    markScheduleSent.run({ $id: schedule.id });
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to send test email:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/send-now", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    await sendWeeklySummary(email);
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to send report:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Email Summary Generation ─────────────────────────────────────────────────

async function sendWeeklySummary(email) {
  if (!process.env.SENDGRID_API_KEY)
    throw new Error("SENDGRID_API_KEY not configured");
  if (!process.env.SENDGRID_FROM_EMAIL)
    throw new Error("SENDGRID_FROM_EMAIL not configured");

  const weekStats = db
    .prepare(
      `
    SELECT COUNT(*) as total_visits, COUNT(DISTINCT ip) as unique_visitors,
           COUNT(DISTINCT path) as unique_pages
    FROM pageviews WHERE timestamp >= datetime('now', '-7 days')
  `,
    )
    .get();

  const topPages = db
    .prepare(
      `
    SELECT path, title, COUNT(*) as views FROM pageviews
    WHERE timestamp >= datetime('now', '-7 days')
    GROUP BY path ORDER BY views DESC LIMIT 5
  `,
    )
    .all();

  const topReferrers = db
    .prepare(
      `
    SELECT referrer_domain, COUNT(*) as visits FROM pageviews
    WHERE referrer_domain IS NOT NULL AND referrer_domain != ''
      AND timestamp >= datetime('now', '-7 days')
    GROUP BY referrer_domain ORDER BY visits DESC LIMIT 5
  `,
    )
    .all();

  const topSearchTerms = db
    .prepare(
      `
    SELECT search_terms, search_engine, COUNT(*) as count FROM pageviews
    WHERE search_terms IS NOT NULL AND timestamp >= datetime('now', '-7 days')
    GROUP BY search_terms ORDER BY count DESC LIMIT 5
  `,
    )
    .all();

  const topCountries = db
    .prepare(
      `
    SELECT country, COUNT(*) as visits FROM pageviews
    WHERE country IS NOT NULL AND timestamp >= datetime('now', '-7 days')
    GROUP BY country ORDER BY visits DESC LIMIT 5
  `,
    )
    .all();

  // Generate AI insights
  const insightsRes = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `Write 2-3 concise, friendly insights for a weekly analytics report email.
Stats for the past 7 days: total visits=${weekStats.total_visits}, unique visitors=${weekStats.unique_visitors}.
Top pages: ${JSON.stringify(topPages.slice(0, 3))}.
Top referrers: ${JSON.stringify(topReferrers.slice(0, 3))}.
Top search terms: ${JSON.stringify(topSearchTerms.slice(0, 3))}.
Plain text only, no markdown, no bullet points. 2-3 sentences.`,
      },
    ],
  });
  const insights = insightsRes.content[0].text.trim();

  const dateRange = `${new Date(Date.now() - 7 * 86400000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
  const subject = `Weekly Analytics Summary · ${dateRange}`;

  const html = buildSummaryEmail({
    weekStats,
    topPages,
    topReferrers,
    topSearchTerms,
    topCountries,
    insights,
    dateRange,
  });

  await sgMail.send({
    to: email,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: "FL1 Analytics",
    },
    subject,
    html,
  });
}

function buildSummaryEmail({
  weekStats,
  topPages,
  topReferrers,
  topSearchTerms,
  topCountries,
  insights,
  dateRange,
}) {
  const row = (label, value) => `
    <tr>
      <td style="padding:8px 16px;border-bottom:1px solid #2e3148;color:#8b8fa8;font-size:13px;">${label}</td>
      <td style="padding:8px 16px;border-bottom:1px solid #2e3148;color:#e2e4f0;font-size:13px;font-weight:600;text-align:right;">${value}</td>
    </tr>`;

  const tableRows = (items, cols) =>
    items.length === 0
      ? `<tr><td colspan="${cols}" style="padding:12px 16px;color:#8b8fa8;font-size:13px;">No data this week</td></tr>`
      : items
          .map(
            (item, i) => `
    <tr>
      ${Object.values(item)
        .map(
          (v, j) =>
            `<td style="padding:8px 16px;border-bottom:${i < items.length - 1 ? "1px solid #2e3148" : "none"};color:${j === 0 ? "#e2e4f0" : "#8b8fa8"};font-size:13px;${j > 0 ? "text-align:right;" : ""}">${v ?? "—"}</td>`,
        )
        .join("")}
    </tr>`,
          )
          .join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#1a1d27;border:1px solid #2e3148;border-radius:8px 8px 0 0;padding:24px 32px;">
          <div style="font-size:20px;font-weight:700;color:#e2e4f0;">Analytics Summary</div>
          <div style="font-size:13px;color:#8b8fa8;margin-top:4px;">${dateRange}</div>
        </td></tr>

        <!-- Key Stats -->
        <tr><td style="background:#1a1d27;border-left:1px solid #2e3148;border-right:1px solid #2e3148;padding:0 32px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
            <tr>
              <td style="text-align:center;padding:16px;background:#222536;border-radius:6px;width:33%;">
                <div style="font-size:28px;font-weight:700;color:#e2e4f0;">${Number(weekStats.total_visits).toLocaleString()}</div>
                <div style="font-size:11px;color:#8b8fa8;text-transform:uppercase;letter-spacing:0.6px;margin-top:4px;">Total Visits</div>
              </td>
              <td width="12"></td>
              <td style="text-align:center;padding:16px;background:#222536;border-radius:6px;width:33%;">
                <div style="font-size:28px;font-weight:700;color:#6366f1;">${Number(weekStats.unique_visitors).toLocaleString()}</div>
                <div style="font-size:11px;color:#8b8fa8;text-transform:uppercase;letter-spacing:0.6px;margin-top:4px;">Unique Visitors</div>
              </td>
              <td width="12"></td>
              <td style="text-align:center;padding:16px;background:#222536;border-radius:6px;width:33%;">
                <div style="font-size:28px;font-weight:700;color:#34d399;">${Number(weekStats.unique_pages).toLocaleString()}</div>
                <div style="font-size:11px;color:#8b8fa8;text-transform:uppercase;letter-spacing:0.6px;margin-top:4px;">Pages Tracked</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Insights -->
        <tr><td style="background:#1a1d27;border-left:1px solid #2e3148;border-right:1px solid #2e3148;padding:0 32px 24px;">
          <div style="background:#222536;border-left:3px solid #6366f1;border-radius:0 6px 6px 0;padding:14px 16px;">
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:#6366f1;margin-bottom:6px;">AI Insights</div>
            <div style="font-size:13px;color:#e2e4f0;line-height:1.6;">${insights}</div>
          </div>
        </td></tr>

        <!-- Top Pages -->
        <tr><td style="background:#1a1d27;border-left:1px solid #2e3148;border-right:1px solid #2e3148;padding:0 32px 24px;">
          <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:#8b8fa8;margin-bottom:8px;">Top Pages</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#222536;border-radius:6px;overflow:hidden;">
            ${
              topPages.length === 0
                ? `<tr><td style="padding:12px 16px;color:#8b8fa8;font-size:13px;">No data this week</td></tr>`
                : topPages
                    .map(
                      (p, i) => `<tr>
                <td style="padding:8px 16px;border-bottom:${i < topPages.length - 1 ? "1px solid #2e3148" : "none"};color:#e2e4f0;font-size:13px;">${p.path}</td>
                <td style="padding:8px 16px;border-bottom:${i < topPages.length - 1 ? "1px solid #2e3148" : "none"};color:#8b8fa8;font-size:13px;text-align:right;">${Number(p.views).toLocaleString()} views</td>
              </tr>`,
                    )
                    .join("")
            }
          </table>
        </td></tr>

        <!-- Top Referrers -->
        ${
          topReferrers.length > 0
            ? `<tr><td style="background:#1a1d27;border-left:1px solid #2e3148;border-right:1px solid #2e3148;padding:0 32px 24px;">
          <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:#8b8fa8;margin-bottom:8px;">Top Referrers</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#222536;border-radius:6px;overflow:hidden;">
            ${topReferrers
              .map(
                (r, i) => `<tr>
              <td style="padding:8px 16px;border-bottom:${i < topReferrers.length - 1 ? "1px solid #2e3148" : "none"};color:#e2e4f0;font-size:13px;">${r.referrer_domain}</td>
              <td style="padding:8px 16px;border-bottom:${i < topReferrers.length - 1 ? "1px solid #2e3148" : "none"};color:#8b8fa8;font-size:13px;text-align:right;">${Number(r.visits).toLocaleString()} visits</td>
            </tr>`,
              )
              .join("")}
          </table>
        </td></tr>`
            : ""
        }

        <!-- Search Terms -->
        ${
          topSearchTerms.length > 0
            ? `<tr><td style="background:#1a1d27;border-left:1px solid #2e3148;border-right:1px solid #2e3148;padding:0 32px 24px;">
          <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:#8b8fa8;margin-bottom:8px;">Search Terms</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#222536;border-radius:6px;overflow:hidden;">
            ${topSearchTerms
              .map(
                (s, i) => `<tr>
              <td style="padding:8px 16px;border-bottom:${i < topSearchTerms.length - 1 ? "1px solid #2e3148" : "none"};color:#e2e4f0;font-size:13px;">${s.search_terms}</td>
              <td style="padding:8px 16px;border-bottom:${i < topSearchTerms.length - 1 ? "1px solid #2e3148" : "none"};color:#8b8fa8;font-size:13px;text-align:right;">${s.search_engine} · ${Number(s.count).toLocaleString()}×</td>
            </tr>`,
              )
              .join("")}
          </table>
        </td></tr>`
            : ""
        }

        <!-- Footer -->
        <tr><td style="background:#1a1d27;border:1px solid #2e3148;border-top:none;border-radius:0 0 8px 8px;padding:20px 32px;text-align:center;">
          <div style="font-size:12px;color:#8b8fa8;">Sent by FL1 Analytics · <a href="#" style="color:#6366f1;text-decoration:none;">Manage preferences</a></div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Daily Cron Job ───────────────────────────────────────────────────────────

// Runs every day at 08:00 UTC — checks which schedules are due today and sends
cron.schedule("0 8 * * *", async () => {
  const dayOfWeek = new Date().getDay(); // 0=Sun … 6=Sat
  const due = getActiveSchedulesForDay.all({ $day: dayOfWeek });

  for (const schedule of due) {
    console.log(`Sending weekly summary to ${schedule.email}…`);
    try {
      await sendWeeklySummary(schedule.email);
      markScheduleSent.run({ $id: schedule.id });
      console.log(`Sent to ${schedule.email}`);
    } catch (err) {
      console.error(`Failed to send to ${schedule.email}:`, err.message);
    }
  }
});

// ─── Serve Dashboard ─────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCountryName(code) {
  const names = {
    US: "United States",
    GB: "United Kingdom",
    CA: "Canada",
    AU: "Australia",
    DE: "Germany",
    FR: "France",
    JP: "Japan",
    IN: "India",
    BR: "Brazil",
    MX: "Mexico",
    IT: "Italy",
    ES: "Spain",
    NL: "Netherlands",
    SE: "Sweden",
    NO: "Norway",
    DK: "Denmark",
    FI: "Finland",
    PL: "Poland",
    RU: "Russia",
    CN: "China",
    KR: "South Korea",
    SG: "Singapore",
    NZ: "New Zealand",
    ZA: "South Africa",
    IE: "Ireland",
    CH: "Switzerland",
    AT: "Austria",
    BE: "Belgium",
    PT: "Portugal",
    AR: "Argentina",
    CL: "Chile",
  };
  return names[code] || code;
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✓ Analytics server running at http://localhost:${PORT}`);
  console.log(`✓ Dashboard:   http://localhost:${PORT}/`);
  console.log(`✓ Tracker URL: http://localhost:${PORT}/tracker.js\n`);
  console.log("Embed on your site with:");
  console.log(
    `  <script src="http://localhost:${PORT}/tracker.js" async></script>\n`,
  );
});
