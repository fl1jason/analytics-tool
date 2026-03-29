require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const geoip = require('geoip-lite');
const { UAParser } = require('ua-parser-js');
const Anthropic = require('@anthropic-ai/sdk');

const {
  db,
  insertPageview,
  getStats,
  getStatsToday,
  getSavedQueries,
  insertSavedQuery,
  updateQueryRunCount,
  updateSavedQuery,
  deleteSavedQuery,
  SCHEMA_DESCRIPTION,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow cross-origin for the tracker endpoint (external sites need this)
app.use('/collect', cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// Dashboard API routes get same-origin CORS only
app.use('/api', cors({ origin: `http://localhost:${PORT}` }));

// ─── Tracker Endpoint ────────────────────────────────────────────────────────

app.post('/collect', (req, res) => {
  try {
    const data = req.body;

    // Get real IP (handle proxies)
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.headers['x-real-ip'] ||
      req.socket.remoteAddress ||
      '';

    // Clean loopback IPs for geoip
    const cleanIp = ip === '::1' || ip === '127.0.0.1' ? null : ip;

    // Geo lookup
    const geo = cleanIp ? geoip.lookup(cleanIp) : null;

    // Parse user agent (sent from client for accuracy)
    const ua = data.user_agent || req.headers['user-agent'] || '';
    const parser = new UAParser(ua);
    const browser = parser.getBrowser();
    const os = parser.getOS();
    const device = parser.getDevice();

    const deviceType =
      device.type === 'mobile' ? 'mobile' :
      device.type === 'tablet' ? 'tablet' :
      'desktop';

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
      $timestamp: data.timestamp || new Date().toISOString().replace('T', ' ').slice(0, 19),
    });

    res.sendStatus(204);
  } catch (err) {
    console.error('Error saving pageview:', err);
    res.sendStatus(500);
  }
});

// ─── Stats API ───────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const stats = getStats.get();
  const today = getStatsToday.get();

  const topPages = db.prepare(`
    SELECT path, title, COUNT(*) as views
    FROM pageviews
    WHERE timestamp >= datetime('now', '-7 days')
    GROUP BY path
    ORDER BY views DESC
    LIMIT 5
  `).all();

  const topReferrers = db.prepare(`
    SELECT referrer_domain, COUNT(*) as visits
    FROM pageviews
    WHERE referrer_domain IS NOT NULL AND referrer_domain != ''
      AND timestamp >= datetime('now', '-7 days')
    GROUP BY referrer_domain
    ORDER BY visits DESC
    LIMIT 5
  `).all();

  res.json({ stats, today, topPages, topReferrers });
});

// ─── Natural Language Query API ──────────────────────────────────────────────

app.post('/api/query', async (req, res) => {
  const { question, saved_query_id } = req.body;

  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }

  try {
    // Step 1: Ask Claude to generate SQL
    const sqlResponse = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: `You are an expert SQLite analyst. Given a database schema and a question,
generate a SQL query to answer it. Always respond with valid JSON only, no markdown.
The JSON must have: { "sql": "...", "title": "...", "description": "..." }
- sql: a safe read-only SELECT query (no INSERT/UPDATE/DELETE/DROP)
- title: short title for the result (e.g. "Top Landing Pages This Week")
- description: one sentence explaining what the query shows`,
      messages: [{
        role: 'user',
        content: `Database schema:\n${SCHEMA_DESCRIPTION}\n\nQuestion: ${question}`,
      }],
    });

    let sqlData;
    try {
      const rawText = sqlResponse.content[0].text.trim();
      // Strip markdown code blocks if present
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      sqlData = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'Failed to parse SQL from AI response' });
    }

    // Safety check — only allow SELECT statements
    const sqlUpper = sqlData.sql.trim().toUpperCase();
    if (!sqlUpper.startsWith('SELECT') && !sqlUpper.startsWith('WITH')) {
      return res.status(400).json({ error: 'Only SELECT queries are allowed' });
    }

    // Step 2: Execute the SQL
    let rows, columns;
    try {
      const stmt = db.prepare(sqlData.sql);
      rows = stmt.all();
      columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    } catch (sqlErr) {
      return res.status(400).json({ error: `SQL error: ${sqlErr.message}`, sql: sqlData.sql });
    }

    // Step 3: Ask Claude to interpret the results
    let answer = null;
    if (rows.length > 0) {
      const interpretResponse = await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `The user asked: "${question}"

Here are the query results (up to 20 rows shown):
${JSON.stringify(rows.slice(0, 20), null, 2)}

Write a concise, friendly 1-3 sentence answer directly addressing the question.
Include key numbers/names from the data. No markdown, plain text only.`,
        }],
      });
      answer = interpretResponse.content[0].text.trim();
    } else {
      answer = 'No data found for this query in the current dataset.';
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
    console.error('Query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Saved Queries API ───────────────────────────────────────────────────────

app.get('/api/saved-queries', (req, res) => {
  res.json(getSavedQueries.all());
});

app.post('/api/saved-queries', (req, res) => {
  const { query, description, sql_query } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  const result = insertSavedQuery.run({ $query: query, $description: description || null, $sql_query: sql_query || null });
  res.json({ id: Number(result.lastInsertRowid), query, description, sql_query, run_count: 0 });
});

app.put('/api/saved-queries/:id/run', (req, res) => {
  updateQueryRunCount.run({ $id: req.params.id });
  res.json({ ok: true });
});

app.delete('/api/saved-queries/:id', (req, res) => {
  deleteSavedQuery.run(req.params.id);
  res.json({ ok: true });
});

// ─── Serve Dashboard ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCountryName(code) {
  const names = {
    US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia',
    DE: 'Germany', FR: 'France', JP: 'Japan', IN: 'India', BR: 'Brazil',
    MX: 'Mexico', IT: 'Italy', ES: 'Spain', NL: 'Netherlands', SE: 'Sweden',
    NO: 'Norway', DK: 'Denmark', FI: 'Finland', PL: 'Poland', RU: 'Russia',
    CN: 'China', KR: 'South Korea', SG: 'Singapore', NZ: 'New Zealand',
    ZA: 'South Africa', IE: 'Ireland', CH: 'Switzerland', AT: 'Austria',
    BE: 'Belgium', PT: 'Portugal', AR: 'Argentina', CL: 'Chile',
  };
  return names[code] || code;
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✓ Analytics server running at http://localhost:${PORT}`);
  console.log(`✓ Dashboard:   http://localhost:${PORT}/`);
  console.log(`✓ Tracker URL: http://localhost:${PORT}/tracker.js\n`);
  console.log('Embed on your site with:');
  console.log(`  <script src="http://localhost:${PORT}/tracker.js" async></script>\n`);
});
