'use strict';
/** Минимальный HTTP-хелпер на встроенном fetch (Node 18+). Таймаут и ошибки -> throw. */

async function httpGet(url, { timeoutMs = 15000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; affcheck-mvp/0.1; +local)',
        'Accept': 'application/json, text/html, */*',
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function httpGetJson(url, opts) {
  const text = await httpGet(url, opts);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON from ${url}: ${e.message}`);
  }
}

module.exports = { httpGet, httpGetJson };
