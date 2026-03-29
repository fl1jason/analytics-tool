const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'analytics.db'));

// WAL mode for better read performance
db.exec(`PRAGMA journal_mode = WAL`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pageviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    country TEXT,
    country_code TEXT,
    city TEXT,
    region TEXT,
    browser TEXT,
    browser_version TEXT,
    os TEXT,
    device_type TEXT,
    screen_width INTEGER,
    screen_height INTEGER,
    language TEXT,
    timezone TEXT,
    url TEXT,
    path TEXT,
    title TEXT,
    referrer TEXT,
    referrer_domain TEXT,
    search_engine TEXT,
    search_terms TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS saved_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    description TEXT,
    sql_query TEXT,
    last_run DATETIME,
    run_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_pageviews_timestamp ON pageviews(timestamp);
  CREATE INDEX IF NOT EXISTS idx_pageviews_path ON pageviews(path);
  CREATE INDEX IF NOT EXISTS idx_pageviews_ip ON pageviews(ip);
`);

const insertPageview = db.prepare(`
  INSERT INTO pageviews (
    ip, country, country_code, city, region,
    browser, browser_version, os, device_type,
    screen_width, screen_height, language, timezone,
    url, path, title, referrer, referrer_domain,
    search_engine, search_terms, timestamp
  ) VALUES (
    $ip, $country, $country_code, $city, $region,
    $browser, $browser_version, $os, $device_type,
    $screen_width, $screen_height, $language, $timezone,
    $url, $path, $title, $referrer, $referrer_domain,
    $search_engine, $search_terms, $timestamp
  )
`);

const getStats = db.prepare(`
  SELECT
    COUNT(*) as total_pageviews,
    COUNT(DISTINCT ip) as unique_visitors,
    COUNT(DISTINCT path) as unique_pages,
    COUNT(DISTINCT DATE(timestamp)) as active_days
  FROM pageviews
  WHERE timestamp >= datetime('now', '-30 days')
`);

const getStatsToday = db.prepare(`
  SELECT COUNT(*) as today, COUNT(DISTINCT ip) as unique_today
  FROM pageviews
  WHERE DATE(timestamp) = DATE('now')
`);

const getSavedQueries = db.prepare(`
  SELECT * FROM saved_queries ORDER BY run_count DESC, created_at DESC
`);

const insertSavedQuery = db.prepare(`
  INSERT INTO saved_queries (query, description, sql_query)
  VALUES ($query, $description, $sql_query)
`);

const updateQueryRunCount = db.prepare(`
  UPDATE saved_queries SET run_count = run_count + 1, last_run = datetime('now')
  WHERE id = $id
`);

const deleteSavedQuery = db.prepare(`DELETE FROM saved_queries WHERE id = ?`);

const SCHEMA_DESCRIPTION = `
Database: SQLite
Table: pageviews
Columns:
  - id: INTEGER (primary key)
  - ip: TEXT (visitor IP address)
  - country: TEXT (country name, e.g. "United States")
  - country_code: TEXT (2-letter ISO code, e.g. "US")
  - city: TEXT (city name)
  - region: TEXT (state/province)
  - browser: TEXT (e.g. "Chrome", "Safari", "Firefox")
  - browser_version: TEXT
  - os: TEXT (e.g. "Windows", "macOS", "iOS", "Android")
  - device_type: TEXT ("desktop", "mobile", "tablet")
  - screen_width: INTEGER (pixels)
  - screen_height: INTEGER (pixels)
  - language: TEXT (e.g. "en-US")
  - timezone: TEXT (IANA timezone, e.g. "America/New_York")
  - url: TEXT (full URL)
  - path: TEXT (URL path, e.g. "/blog/post-1")
  - title: TEXT (page title)
  - referrer: TEXT (full referrer URL)
  - referrer_domain: TEXT (referrer hostname)
  - search_engine: TEXT (e.g. "Google", "Bing" — NULL if not from search)
  - search_terms: TEXT (decoded search query — NULL if not from search)
  - timestamp: DATETIME (UTC, "YYYY-MM-DD HH:MM:SS")

Useful SQLite date helpers:
  - Current time: datetime('now')
  - Today: DATE('now')
  - This week: datetime('now', '-7 days')
  - This month: datetime('now', '-30 days')
  - Hour: strftime('%H', timestamp)
  - Day of week: strftime('%w', timestamp) -- 0=Sunday
`;

module.exports = {
  db,
  insertPageview,
  getStats,
  getStatsToday,
  getSavedQueries,
  insertSavedQuery,
  updateQueryRunCount,
  deleteSavedQuery,
  SCHEMA_DESCRIPTION,
};
