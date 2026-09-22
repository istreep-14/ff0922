/**
 * The only fetch wrapper: retry on 429/5xx and network stalls, and a pool
 * that stops when a worker throws so one auth failure does not keep asking.
 */
import { config } from './config.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** League keys and the account email are the credential. Errors get logged and written into the page. */
export function safeUrl(url) {
  return String(url).replace(/([?&](?:email|key)=)[^&]*/gi, '$1***');
}

function headerMap(h) {
  const out = {};
  for (const k of ['etag', 'last-modified', 'date', 'content-type']) {
    const v = h.get(k);
    if (v != null) out[k] = v;
  }
  return out;
}

export async function get(url, { retries = 3, asText = false, headers = {}, withHeaders = false, timeoutMs = config.timeoutMs } = {}) {
  const reqHeaders = { 'User-Agent': UA, Accept: '*/*', ...headers };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: reqHeaders,
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, retryable: true });
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status} for ${safeUrl(url)}${body ? ` — ${body.slice(0, 160)}` : ''}`), { status: res.status });
      }
      const raw = await res.text();
      const meta = withHeaders ? { headers: headerMap(res.headers), status: res.status } : null;
      if (asText) return withHeaders ? { body: raw, ...meta } : raw;
      if (!raw.trim()) return withHeaders ? { body: null, ...meta } : null;
      try {
        const parsed = JSON.parse(raw);
        return withHeaders ? { body: parsed, ...meta } : parsed;
      } catch {
        throw new Error(`Non-JSON response from ${url}: ${raw.slice(0, 120)}`);
      }
    } catch (err) {
      lastErr = err.name === 'TimeoutError'
        ? Object.assign(new Error(`Timed out after ${timeoutMs}ms: ${safeUrl(url)}`), { name: 'TimeoutError' })
        : err;
      const retryable = err.retryable || err.name === 'TypeError' || err.name === 'TimeoutError';
      if (!retryable || attempt === retries) break;
      await sleep(2 ** attempt * 500 + Math.random() * 250);
    }
  }
  throw lastErr;
}

export async function pool(items, worker, { concurrency = config.concurrency, delayMs = config.delayMs } = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  let aborted = false;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !aborted) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        aborted = true;
        throw err;
      }
      if (delayMs) await sleep(delayMs);
    }
  });
  await Promise.all(runners);
  return results;
}
