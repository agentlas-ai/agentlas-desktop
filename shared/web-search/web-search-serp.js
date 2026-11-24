(function agentlasSerpExtract(query, max) {
  // Agentlas web search: reads one search results page that is open in a real browser engine (desktop: the bundled Agentlas
  // browser, phone: the app's own WebView). One source: the phone app's copy of this file, kept byte for byte equal.
  // Callers append `(<query JSON>, <max>)` and read back the returned object.
  // Returns { engine, blocked, relevant, results: [{ url, title, snippet }] }. It never clicks, types or solves anything.
  var host = location.hostname;
  var engine = /(^|\.)google\./.test(host) ? 'google'
    : /(^|\.)bing\.com$/.test(host) ? 'bing'
    : /(^|\.)duckduckgo\.com$/.test(host) ? 'duckduckgo'
    : 'other';
  var text = String((document.body && document.body.innerText) || '').slice(0, 4000);
  var blocked = false;
  if (engine === 'google') {
    blocked = location.pathname.indexOf('/sorry') === 0 || host === 'consent.google.com'
      || !!document.querySelector('form#captcha-form, #recaptcha') || /unusual traffic|비정상적인 트래픽/i.test(text);
  } else if (engine === 'bing') {
    blocked = !!document.querySelector('#b_captcha, .captcha') || /verify you are a human|사람인지 확인/i.test(text);
  } else if (engine === 'duckduckgo') {
    blocked = !!document.querySelector('.anomaly-modal__title, #challenge-form, .anomaly-modal')
      || /bots use DuckDuckGo too|unusual activity/i.test(text);
  }
  var clean = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
  var unwrap = function (href) {
    var u;
    try { u = new URL(href, location.href); } catch (e) { return null; }
    var inner = null;
    if (/(^|\.)google\./.test(u.hostname) && u.pathname === '/url') inner = u.searchParams.get('q') || u.searchParams.get('url');
    else if (/(^|\.)duckduckgo\.com$/.test(u.hostname) && u.pathname.indexOf('/l/') === 0) inner = u.searchParams.get('uddg');
    else if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.indexOf('/ck/a') === 0) {
      var p = u.searchParams.get('u');
      if (p && p.indexOf('a1') === 0) {
        try {
          var b = p.slice(2).replace(/-/g, '+').replace(/_/g, '/');
          while (b.length % 4) b += '=';
          inner = decodeURIComponent(escape(atob(b)));
        } catch (e) { return null; }
      }
    }
    if (inner !== null) { try { u = new URL(inner); } catch (e) { return null; } }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    // The search site's own pages (ads, its other verticals, its redirectors) are not results.
    if (/(^|\.)(duckduckgo\.com|bing\.com|google\.[a-z.]+|gstatic\.com|googleadservices\.com|doubleclick\.net)$/.test(u.hostname)) return null;
    u.hash = '';
    return u.href;
  };
  var results = [];
  var seen = {};
  var limit = typeof max === 'number' && max > 0 ? Math.floor(max) : 10;
  var push = function (anchor, titleEl, box, snippetSelector) {
    if (!anchor || results.length >= limit) return;
    var url = unwrap(anchor.getAttribute('href') || '');
    if (!url || url.length > 2000 || seen[url]) return;
    var title = clean(titleEl ? titleEl.innerText : anchor.innerText);
    if (!title) return;
    var snippet = '';
    if (box) {
      var s = snippetSelector ? box.querySelector(snippetSelector) : null;
      snippet = clean(s ? s.innerText : '');
      if (!snippet) snippet = clean(box.innerText).replace(title, '').trim();
    }
    seen[url] = true;
    results.push({ url: url, title: title.slice(0, 300), snippet: snippet.slice(0, 500) });
  };
  var i, list;
  if (engine === 'duckduckgo') {
    list = document.querySelectorAll('article[data-testid="result"], .result:not(.result--ad)');
    for (i = 0; i < list.length; i++) {
      push(list[i].querySelector('a[data-testid="result-title-a"], a.result__a'), null, list[i], '[data-result="snippet"], .result__snippet');
    }
  } else if (engine === 'bing') {
    list = document.querySelectorAll('li.b_algo');
    for (i = 0; i < list.length; i++) {
      push(list[i].querySelector('h2 a'), list[i].querySelector('h2'), list[i], '.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, .b_algoSlug, p');
    }
  } else if (engine === 'google') {
    list = document.querySelectorAll('a h3, a div[role="heading"]');
    for (i = 0; i < list.length; i++) {
      var a = list[i].closest('a');
      var box = a && (a.closest('div[data-hveid]') || a.closest('div.g, div.MjjYud'));
      push(a, list[i], box, '[data-sncf], .VwiC3b, .lEBKkf');
    }
  }
  if (results.length === 0 && !blocked) {
    list = document.querySelectorAll('a h2, a h3, h2 a, h3 a');
    for (i = 0; i < list.length; i++) {
      var anchor = list[i].tagName === 'A' ? list[i] : list[i].closest('a');
      push(anchor, list[i], anchor && anchor.parentElement, null);
    }
  }
  // A search site that does not block an automated reader may still answer it with pages that have nothing to do with the
  // question (measured: Bing gave Chinese forum pages for a Korean question). Such a page is not a result page.
  var terms = String(query || '').toLowerCase().split(/[\s.,;:!?'"()\[\]{}<>\/\\|`~@#$%^&*+=_-]+/).filter(function (t) { return t.length >= 2; });
  var relevant = true;
  if (terms.length > 0 && results.length > 0) {
    var hits = 0;
    for (i = 0; i < results.length; i++) {
      var hay = (results[i].title + ' ' + results[i].snippet + ' ' + results[i].url).toLowerCase();
      for (var t = 0; t < terms.length; t++) { if (hay.indexOf(terms[t]) >= 0) { hits++; break; } }
    }
    relevant = hits / results.length >= 0.3;
  }
  return { engine: engine, blocked: blocked, relevant: relevant, results: results };
})
