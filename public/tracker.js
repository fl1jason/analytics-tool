/**
 * Analytics Tracker
 * Embed on your site: <script src="http://your-analytics-server/tracker.js" async></script>
 */
(function () {
  'use strict';

  // Derive the collect endpoint from this script's own URL
  var script = document.currentScript;
  var baseUrl = '';
  if (script && script.src) {
    try {
      var u = new URL(script.src);
      baseUrl = u.protocol + '//' + u.host;
    } catch (e) {}
  }
  var ENDPOINT = baseUrl + '/collect';

  // Detect search engine and extract terms from a referrer URL
  function parseReferrer(ref) {
    if (!ref) return { engine: null, terms: null };
    var engines = [
      { re: /google\.[^/]+\/(?:search|webhp).*[?&]q=([^&#]+)/i,     name: 'Google' },
      { re: /bing\.com\/search.*[?&]q=([^&#]+)/i,                    name: 'Bing' },
      { re: /yahoo\.com\/search.*[?&]p=([^&#]+)/i,                   name: 'Yahoo' },
      { re: /duckduckgo\.com\/.*[?&]q=([^&#]+)/i,                    name: 'DuckDuckGo' },
      { re: /yandex\.[^/]+\/search.*[?&]text=([^&#]+)/i,             name: 'Yandex' },
      { re: /baidu\.com\/s.*[?&]wd=([^&#]+)/i,                       name: 'Baidu' },
      { re: /ecosia\.org\/search.*[?&]q=([^&#]+)/i,                  name: 'Ecosia' },
      { re: /brave\.com\/search.*[?&]q=([^&#]+)/i,                   name: 'Brave' },
    ];
    for (var i = 0; i < engines.length; i++) {
      var m = ref.match(engines[i].re);
      if (m) {
        try {
          return {
            engine: engines[i].name,
            terms: decodeURIComponent(m[1].replace(/\+/g, ' ')),
          };
        } catch (e) {
          return { engine: engines[i].name, terms: m[1] };
        }
      }
    }
    return { engine: null, terms: null };
  }

  function getReferrerDomain(ref) {
    if (!ref) return null;
    try {
      return new URL(ref).hostname;
    } catch (e) {
      return null;
    }
  }

  function collect() {
    var ref = document.referrer || '';
    var search = parseReferrer(ref);

    var payload = {
      url: window.location.href,
      path: window.location.pathname + window.location.search,
      title: document.title,
      referrer: ref || null,
      referrer_domain: getReferrerDomain(ref),
      search_engine: search.engine,
      search_terms: search.terms,
      screen_width: screen.width,
      screen_height: screen.height,
      language: navigator.language || navigator.userLanguage || null,
      timezone: (Intl && Intl.DateTimeFormat)
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : null,
      user_agent: navigator.userAgent,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
    };

    var body = JSON.stringify(payload);

    // Prefer sendBeacon (non-blocking, survives page unload)
    if (navigator.sendBeacon) {
      try {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        return;
      } catch (e) {}
    }

    // Fallback to fetch
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        credentials: 'omit',
      }).catch(function () {});
    } catch (e) {}
  }

  // Fire after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', collect);
  } else {
    collect();
  }
})();
