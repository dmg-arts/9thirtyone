/**
 * Every name a module uses is one it can actually reach.
 *
 *     npm run test:unit
 *
 * This exists because of a real bug: `js/views/settings.js` called
 * `connectionStatus()` and `checkProxy()` without importing either. Both were
 * added by an edit whose import line silently failed to match, and neither the
 * unit suite nor the browser suite caught it — the browser suite never visited
 * Settings, and `node --check` only parses, it does not resolve.
 *
 * The result shipped, and the first anyone knew was a user seeing
 * "connectionStatus is not defined" on a page that had been broken for three
 * releases.
 *
 * So: for every module, collect the bare identifiers it *calls*, and check each
 * one is imported, declared locally, or a known global. Cheap, static, and it
 * catches the whole class rather than the one instance.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.js')) out.push(path);
  }
  return out;
}

/** Globals the browser provides, plus the handful of built-ins in use. */
const GLOBALS = new Set([
  'console', 'window', 'document', 'navigator', 'location', 'history', 'fetch',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'matchMedia', 'IntersectionObserver', 'alert', 'confirm', 'prompt', 'atob', 'btoa',
  'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'structuredClone',
  'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date',
  'Map', 'Set', 'WeakMap', 'RegExp', 'Error', 'TypeError', 'Symbol', 'Proxy', 'Reflect',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'escape', 'unescape', 'URL', 'URLSearchParams', 'Blob', 'File',
  'FileReader', 'FormData', 'Response', 'Request', 'Headers', 'AbortController', 'Event',
  'CustomEvent', 'TextEncoder', 'TextDecoder', 'Uint8Array', 'Int32Array', 'Float64Array',
  'DOMParser', 'XMLSerializer', 'Intl', 'performance', 'caches', 'self', 'globalThis',
  'super', 'require', 'import', 'typeof', 'void', 'delete', 'in', 'instanceof', 'new',
  'return', 'if', 'for', 'while', 'switch', 'catch', 'function', 'class', 'await', 'yield',
  'this', 'true', 'false', 'null', 'undefined', 'var', 'let', 'const', 'else', 'do', 'try',
  'async', 'static', 'get', 'set',
]);

for (const path of walk('js')) {
  const source = readFileSync(path, 'utf8');

  const known = new Set(GLOBALS);
  // Imported bindings, including default and namespace forms.
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const name of m[1].split(',')) {
      const bound = name.trim().split(/\s+as\s+/).pop().trim();
      if (bound) known.add(bound);
    }
  }
  for (const m of source.matchAll(/import\s+([A-Za-z0-9_$]+)\s*,?\s*(?:\{|from)/g)) known.add(m[1]);
  for (const m of source.matchAll(/import\s*\*\s*as\s+([A-Za-z0-9_$]+)/g)) known.add(m[1]);

  // Anything declared in the file, at any depth.
  for (const m of source.matchAll(/(?:function\s*\*?|class)\s+([A-Za-z0-9_$]+)/g)) known.add(m[1]);
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) known.add(m[1]);
  // Destructured bindings, parameters and catch clauses.
  for (const m of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const bound = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z0-9_$]+$/.test(bound)) known.add(bound);
    }
  }
  for (const m of source.matchAll(/(?:function\s*\*?\s*[A-Za-z0-9_$]*|catch)\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const bound = part.split(/[=:]/)[0].replace(/[{}[\].]/g, '').trim();
      if (/^[A-Za-z0-9_$]+$/.test(bound)) known.add(bound);
    }
  }
  // Arrow parameters, both `x =>` and `(a, b) =>`.
  for (const m of source.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const bound = part.split(/[=:]/)[0].replace(/[{}[\].]/g, '').trim();
      if (/^[A-Za-z0-9_$]+$/.test(bound)) known.add(bound);
    }
  }
  for (const m of source.matchAll(/([A-Za-z0-9_$]+)\s*=>/g)) known.add(m[1]);
  // Method shorthand — `saveForm(form) {` in an object or class body. It is a
  // definition, but it is spelled exactly like a call.
  for (const m of source.matchAll(/^[ \t]*(?:static\s+)?(?:async\s+|get\s+|set\s+)?\*?\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/gm)) {
    known.add(m[1]);
  }

  // Regex literals contain things that look like calls — `\b(?:a|b)` reads as a
  // call to `b`. Strip them, along with strings and comments, before scanning.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\/(?![*/])(?:\\.|\[(?:\\.|[^\]])*\]|[^\/\n\\])+\/[gimsuy]*/g, ' 0 ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' "" ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' "" ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' "" ');

  // Bare calls: `name(` not preceded by a dot, and not a keyword.
  const called = new Set();
  for (const m of code.matchAll(/(^|[^.\w$])([a-zA-Z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    called.add(m[2]);
  }

  const missing = [...called].filter((name) => !known.has(name)).sort();
  check(`${path} reaches every name it calls`, () => {
    if (missing.length) throw new Error(`cannot reach: ${missing.join(', ')}`);
  });
}

console.log(failures ? `\n${failures} module(s) call something unreachable.` : '\nEvery module reaches what it calls.');
process.exit(failures ? 1 : 0);
