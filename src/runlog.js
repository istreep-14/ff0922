import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA } from './config.js';

/**
 * The permanent run log: every line a sync prints, kept.
 *
 * A sync used to narrate to whichever terminal ran it and nowhere else. Run
 * from the dashboard's Sync page the server threw the narration away
 * (`log: () => {}`), so a failed step showed up as one word in a table with
 * nothing behind it, and a run from the CLI left nothing the page could show.
 * One append-only file fixes both: the CLI and the server write the same
 * lines, the server serves them while a run is going, and the build inlines
 * the tail so even the static page has the history.
 *
 * JSON lines, one entry per printed line: { t, seq, level, src, msg }.
 */

export const RUNLOG = join(DATA, 'runlog.jsonl');
/** Lines kept on disk. Trimmed on write, not on read, so a read is never a write. */
export const KEEP = 3000;
const TRIM_AT_BYTES = 1_500_000;

let seq = 0;

/** A line's level, from how the pipeline and the sync modules word it. */
export function levelOf(msg) {
  const s = String(msg);
  if (/\bFAIL\b|\bError\b|failed —|✗|\b[1-9]\d* failed\b/.test(s)) return 'error';
  if (/\bwarn\b|\bSTALE\b|refusing|skipping/i.test(s)) return 'warn';
  if (/^\s*(done|ok)\b|\b\d+ run,/.test(s)) return 'ok';
  return 'info';
}

export function append(entries, { file = RUNLOG } = {}) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter((e) => e && String(e.msg ?? '').trim());
  if (!list.length) return [];
  const now = Date.now();
  const rows = list.map((e) => ({
    t: e.t || new Date(now).toISOString(),
    seq: `${now.toString(36)}-${(seq++).toString(36)}`,
    level: e.level || levelOf(e.msg),
    src: e.src || 'sync',
    msg: String(e.msg).replace(/\s+$/, ''),
  }));
  mkdirSync(dirname(file), { recursive: true });
  // A run killed mid-write leaves a line with no newline; appending straight
  // onto it would fuse the next entry into the same unparseable line.
  appendFileSync(file, (endsTorn(file) ? '\n' : '') + rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    if (statSync(file).size > TRIM_AT_BYTES) trim({ file });
  } catch { /* a failed trim leaves a long file, not a broken one */ }
  return rows;
}

function endsTorn(file) {
  try {
    const size = statSync(file).size;
    if (!size) return false;
    const fd = openSync(file, 'r');
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    closeSync(fd);
    return b[0] !== 0x0a;
  } catch { return false; }
}

function trim({ file = RUNLOG, keep = KEEP } = {}) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length > keep) writeFileSync(file, lines.slice(-keep).join('\n') + '\n');
}

/** The last `limit` entries, optionally only those after `after` (a `seq` the caller already has). */
export function tail({ limit = 400, after = null, file = RUNLOG } = {}) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn last line from a killed run */ }
  }
  let out = rows;
  if (after) {
    const i = rows.findIndex((r) => r.seq === after);
    out = i >= 0 ? rows.slice(i + 1) : rows;
  }
  return out.slice(-limit);
}

/**
 * A `log` function for the sync modules that prints AND keeps.
 *
 * `echo` is the terminal (console.log for the CLI, nothing for the server);
 * every line goes to the file either way (unless `file` is null — the tests),
 * tagged with the step it came from.
 */
export function logger({ src = 'sync', echo = console.log, file = RUNLOG } = {}) {
  const fn = (...parts) => {
    const msg = parts.map(String).join(' ');
    if (echo) echo(msg);
    if (!file) return;
    for (const line of msg.split('\n')) {
      if (line.trim()) append({ msg: line, src: fn.src }, { file });
    }
  };
  fn.src = src;
  fn.as = (name) => logger({ src: name, echo, file });
  return fn;
}
