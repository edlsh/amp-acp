// Zero-dependency logger with level/namespace filtering for ACP adapter
// stdout is reserved for ACP protocol stream; all logs go to stderr or file
import { createWriteStream } from 'fs';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

function parseNamespaces(str) {
  const include = [];
  const exclude = [];

  if (!str || str === '*') {
    return { include: ['*'], exclude: [] };
  }

  for (const part of str
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (part.startsWith('-')) {
      exclude.push(part.slice(1));
    } else {
      include.push(part);
    }
  }

  return { include: include.length ? include : ['*'], exclude };
}

function matchPattern(ns, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1);
    return ns === prefix.slice(0, -1) || ns.startsWith(prefix);
  }
  return ns === pattern;
}

function matchNamespace(ns, patterns) {
  for (const excl of patterns.exclude) {
    if (matchPattern(ns, excl)) return false;
  }
  for (const incl of patterns.include) {
    if (matchPattern(ns, incl)) return true;
  }
  return false;
}

function formatContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined) continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${val}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function formatText(ts, level, ns, msg, ctx) {
  return `${ts} [${level}] [${ns}] ${msg}${formatContext(ctx)}`;
}

// Determine effective log level
function resolveLevel() {
  const envLevel = process.env.AMP_ACP_LOG_LEVEL?.toLowerCase();
  if (envLevel && LEVELS[envLevel] !== undefined) {
    return LEVELS[envLevel];
  }
  // If DEBUG is set, default to debug level
  if (process.env.DEBUG) {
    return LEVELS.debug;
  }
  return LEVELS.info;
}

// Resolve namespace filter from env vars
function resolveNamespaces() {
  const explicit = process.env.AMP_ACP_LOG_NAMESPACES;
  if (explicit) return parseNamespaces(explicit);

  // Backward compat: DEBUG env var for namespace filtering
  const debug = process.env.DEBUG;
  if (debug) return parseNamespaces(debug);

  return parseNamespaces('*');
}

// Module-level config (evaluated once at import)
const config = {
  stream: process.env.AMP_ACP_LOG ? createWriteStream(process.env.AMP_ACP_LOG, { flags: 'a' }) : process.stderr,
  level: resolveLevel(),
  format: process.env.AMP_ACP_LOG_FORMAT || 'text',
  namespaces: resolveNamespaces(),
};

function log(level, ns, msg, ctx = {}) {
  if (LEVELS[level] > config.level) return;
  if (!matchNamespace(ns, config.namespaces)) return;

  const ts = new Date().toISOString();
  const output =
    config.format === 'json' ? JSON.stringify({ ts, level, ns, msg, ...ctx }) : formatText(ts, level, ns, msg, ctx);

  config.stream.write(output + '\n');
}

export function createLogger(namespace) {
  return {
    error: (msg, ctx) => log('error', namespace, msg, ctx),
    warn: (msg, ctx) => log('warn', namespace, msg, ctx),
    info: (msg, ctx) => log('info', namespace, msg, ctx),
    debug: (msg, ctx) => log('debug', namespace, msg, ctx),
    trace: (msg, ctx) => log('trace', namespace, msg, ctx),
  };
}

// Root logger for global error handlers
export const rootLog = createLogger('acp:root');
