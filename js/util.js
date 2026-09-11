/**
 * Small DOM / formatting helpers. No framework — this file is the framework.
 */

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Creates an element. `attrs` keys map to attributes, except:
 *   class/className, dataset, style (object), on* (event listeners), html (innerHTML).
 * `children` accepts nodes, strings, arrays, null/false (skipped).
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Safe stand-ins for node.append() / node.replaceChildren().
 *
 * Views are full of `condition && el(...)` children. The native methods
 * stringify a `false` or `undefined` child, which paints the literal text
 * "false" onto the page; these skip it. Always prefer these in view code.
 */
export function mount(parent, ...children) {
  return append(parent, children);
}

export function remount(parent, ...children) {
  clear(parent);
  return append(parent, children);
}

/** Inline SVG icon from the sprite below. */
export function icon(name, { size = null, cls = '' } = {}) {
  const path = ICONS[name] ?? ICONS.dot;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (size) { svg.style.width = size; svg.style.height = size; }
  if (cls) svg.setAttribute('class', cls);
  svg.innerHTML = path;
  return svg;
}

/** 24x24 stroke icons, feather-ish. */
const ICONS = {
  dot: '<circle cx="12" cy="12" r="3"/>',
  student: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/>',
  cadre: '<path d="M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6l-8-4Z"/><path d="m9 12 2 2 4-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 11 4 4 0 0 0 7 19h10.5Z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  device: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  edit: '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
  inbox: '<path d="M21 12h-6l-2 3h-2l-2-3H3"/><path d="M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2-7Z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v3"/><path d="M12 9v9"/><path d="M17 5v13"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>',
  clipboard: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>',
  filter: '<path d="M3 4h18l-7 8v7l-4 2v-9L3 4Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M3 11h18"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
};

/* ------------------------------------------------------------------ *
 * Ids, dates, text
 * ------------------------------------------------------------------ */

/** Sortable-ish unique id: prefix_<base36 time>_<random>. */
export function makeId(prefix = 'id') {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}${rand}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function fmtDate(iso, opts = { dateStyle: 'medium' }) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, opts).format(d);
}

export function fmtDateTime(iso) {
  return fmtDate(iso, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "in 3 days" / "2 hours ago". */
export function fmtRelative(iso) {
  if (!iso) return '';
  const diffMs = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return '';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units = [
    ['year', 31536e6], ['month', 2592e6], ['week', 6048e5],
    ['day', 864e5], ['hour', 36e5], ['minute', 6e4],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms) return rtf.format(Math.round(diffMs / ms), unit);
  }
  return 'just now';
}

/** Date-only ISO (yyyy-mm-dd) for <input type="date">. */
export function toDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
}

export function fromDateInput(value, endOfDay = false) {
  if (!value) return null;
  const d = new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function pluralize(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Rounds to `places` and drops trailing zeros. */
export function round(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

export function mean(nums) {
  const valid = nums.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

export function median(nums) {
  const valid = nums.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

/** Population standard deviation. */
export function stdev(nums) {
  const valid = nums.filter(Number.isFinite);
  if (valid.length < 2) return null;
  const m = mean(valid);
  return Math.sqrt(mean(valid.map((n) => (n - m) ** 2)));
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}


/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

export function download(filename, content, mime = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** RFC 4180-ish CSV. `columns` is [{key, label, get?}]. */
/**
 * A value that a spreadsheet would run rather than read.
 *
 * Excel and Sheets treat a cell beginning `=`, `+`, `-` or `@` as a formula, and
 * CSV quoting does not prevent it — the quotes are consumed on import and the
 * formula runs. In Sheets it can reach the network (`IMPORTXML`, `HYPERLINK`).
 *
 * That matters here more than in most exports, because the least controlled text
 * in this app is a cadet's free-text answer, and the person who opens the file is
 * the cadre member the feedback is about.
 *
 * Numbers are exempt, including numeric strings: a scale answer of -3 is a
 * number, and prefixing it would turn every numeric column into text.
 */
const NUMERIC = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const looksExecutable = (s) => /^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s);

export function toCsv(rows, columns) {
  const escape = (v) => {
    if (v == null) return '';
    const raw = String(v);
    // A leading apostrophe is the conventional defusing: spreadsheets read the
    // rest as literal text and do not show the mark.
    const s = looksExecutable(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escape(c.label ?? c.key)).join(',');
  const body = rows.map((row) =>
    columns.map((c) => escape(c.get ? c.get(row) : row[c.key])).join(','));
  return [header, ...body].join('\r\n');
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Opens a native file picker and resolves with the chosen File (or null). */
export function pickFile(accept = '.json') {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/* ------------------------------------------------------------------ *
 * Feedback / overlays
 * ------------------------------------------------------------------ */

const TOAST_ICONS = { ok: 'checkCircle', danger: 'alert', warn: 'alert', info: 'info' };

export function toast(message, tone = 'info', ms = 4000) {
  const host = $('#toasts') || document.body.appendChild(el('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const node = el('div', { class: `toast toast--${tone}` }, icon(TOAST_ICONS[tone] || 'info'), el('div', {}, message));
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 200ms';
    setTimeout(() => node.remove(), 220);
  }, ms);
  return node;
}

/**
 * Promise-based modal. `body` is a node or string; `actions` is
 * [{label, value, variant, autofocus}]. Resolves with the chosen value, or null
 * if dismissed.
 */
export function modal({ title, body, actions = [{ label: 'OK', value: true, variant: 'primary' }], size = null }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'modal' });
    if (size) dialog.style.maxWidth = size;
    const foot = el('div', { class: 'modal__foot' });

    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    };

    for (const action of actions) {
      const btn = el('button', {
        type: 'button',
        class: `btn btn--${action.variant || 'default'}`,
        onclick: () => done(action.value),
      }, action.label);
      if (action.autofocus) setTimeout(() => btn.focus(), 30);
      foot.append(btn);
    }

    dialog.append(el('div', { class: 'modal__panel' },
      title && el('div', { class: 'modal__head' }, el('h2', { class: 'modal__title' }, title)),
      el('div', { class: 'modal__body' }, typeof body === 'string' ? el('p', {}, body) : body),
      actions.length ? foot : null));

    dialog.addEventListener('close', () => { done(null); dialog.remove(); });
    dialog.addEventListener('cancel', () => done(null));
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function confirmDialog(title, message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return modal({
    title,
    body: message,
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary', autofocus: true },
    ],
  }).then(Boolean);
}

/** Common UI fragments used across views. */
export function emptyState({ iconName = 'inbox', title, message, action = null }) {
  return el('div', { class: 'empty' },
    icon(iconName, { cls: 'empty__icon' }),
    el('div', { class: 'empty__title' }, title),
    message && el('div', {}, message),
    action && el('div', { style: { marginTop: 'var(--sp-4)' } }, action));
}

export function notice(tone, title, ...body) {
  const iconName = { warn: 'alert', danger: 'alert', ok: 'checkCircle', info: 'info' }[tone] || 'info';
  return el('div', { class: `notice notice--${tone}` },
    icon(iconName),
    el('div', {}, title && el('strong', { class: 'notice__title' }, title), ...body));
}

export function badge(label, tone = 'neutral', iconName = null) {
  return el('span', { class: `badge badge--${tone}` }, iconName && icon(iconName), label);
}

export function spinner(label = 'Loading…') {
  return el('div', { class: 'loading' }, el('div', { class: 'spinner' }), el('span', {}, label));
}

/** Labelled field wrapper. `control` is the input/select/textarea node. */
export function field(label, control, { hint = null, required = false, id = null } = {}) {
  const controlId = id || control.id || makeId('f');
  control.id = controlId;
  if (required) control.required = true;
  return el('div', { class: 'field' },
    el('label', { class: 'field__label', for: controlId },
      label, required && el('span', { class: 'field__req', 'aria-hidden': 'true' }, '*')),
    control,
    hint && el('div', { class: 'field__hint' }, hint));
}

/** <select> built from [{value,label}] or plain strings. */
export function select(options, { value = '', name = null, onchange = null, cls = 'select' } = {}) {
  const node = el('select', { class: cls, name, onchange });
  for (const opt of options) {
    const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
    node.append(el('option', { value: o.value, selected: o.value === value }, o.label));
  }
  node.value = value;
  return node;
}
