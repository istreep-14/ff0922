/**
 * Credentials and paths. The email is the only MyPlaybook credential.
 * A parent-repo `.env` is read so an existing checkout keeps working, and a
 * `slim/.env` overrides it. The process environment still wins over both.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');
export const DIST = join(ROOT, 'dist');
export const SNAPSHOT = join(DATA, 'snapshot.json');
export const HTML = join(DIST, 'index.html');

/**
 * Trailing comments and whitespace are stripped. A key with a stray space
 * reads as a different key, and `FP_WEEK=3 # pinned` must not become NaN.
 */
export function parseEnv(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const quoted = /^(["']).*\1$/.test(v);
    if (!quoted) v = v.replace(/\s+#.*$/, '').trim();
    out.set(m[1], quoted ? v.slice(1, -1) : v);
  }
  return out;
}

function applyEnvFile(path, preexisting) {
  if (!existsSync(path)) return;
  for (const [k, v] of parseEnv(readFileSync(path, 'utf8'))) {
    if (!preexisting.has(k)) process.env[k] = v;
  }
}

const preexisting = new Set(Object.keys(process.env));
applyEnvFile(join(ROOT, '..', '.env'), preexisting);
applyEnvFile(join(ROOT, '.env'), preexisting);

export const config = {
  email: process.env.FP_EMAIL || '',
  extraKeys: (process.env.FP_EXTRA_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean),
  concurrency: Number(process.env.FP_CONCURRENCY || 3),
  delayMs: Number(process.env.FP_DELAY_MS || 250),
  timeoutMs: Number(process.env.FP_TIMEOUT_MS || 30_000),
  season: process.env.FP_SEASON || null,
  week: process.env.FP_WEEK || null,
};
