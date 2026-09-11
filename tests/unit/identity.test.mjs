/**
 * Unit checks for the Google ID token decoder.
 *
 *     npm run test:unit
 *
 * This is the one part of sign-in the browser suite cannot cover: Google will
 * not issue a real token to an automated browser, so the e2e tests call
 * `signInWithGoogle` with an already-decoded profile. Everything that happens
 * *before* that — parsing the JWT and rejecting the ones that should not be
 * trusted — is checked here instead.
 *
 * On what these checks are worth: see the header of js/google-identity.js. This
 * validation catches a malformed, stale or misdirected token. It is not a
 * defence against someone who controls the browser, and nothing here should be
 * read as one.
 */

import { decodeIdToken } from '../../js/google-identity.js';

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
let failures = 0;

const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    console.log(`  FAIL ${label}: ${err.message}`);
    failures++;
  }
};

/** Builds a token with a real signature-shaped third segment we never verify. */
function token(claims) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${b64({ alg: 'RS256', kid: 'test' })}.${b64(claims)}.c2lnbmF0dXJl`;
}

const valid = (overrides = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '110000000000000000001',
  email: 'Mia.Alvarez@Gmail.com',
  email_verified: true,
  name: 'Mia Alvarez',
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});

const refuses = (label, claims, pattern) => check(label, () => {
  let message = 'NO ERROR';
  try { decodeIdToken(token(claims), CLIENT_ID); } catch (e) { message = e.message; }
  if (!pattern.test(message)) throw new Error(`message was: ${message}`);
});

/* ---------- the happy path ---------- */

check('a well-formed token yields a profile', () => {
  const profile = decodeIdToken(token(valid()), CLIENT_ID);
  if (profile.name !== 'Mia Alvarez') throw new Error(`name was ${profile.name}`);
  if (profile.sub !== '110000000000000000001') throw new Error('sub not carried');
});

check('the email is lowercased, because the roster is matched on it', () => {
  const profile = decodeIdToken(token(valid()), CLIENT_ID);
  if (profile.email !== 'mia.alvarez@gmail.com') throw new Error(`email was ${profile.email}`);
});

check('a non-ASCII name survives the decode', () => {
  // atob yields Latin-1. Without the UTF-8 re-decode this comes back mangled,
  // and a cadet's name is the last thing that should be corrupted.
  const profile = decodeIdToken(token(valid({ name: 'José Núñez-Ávila' })), CLIENT_ID);
  if (profile.name !== 'José Núñez-Ávila') throw new Error(`name was ${profile.name}`);
});

check('the bare issuer form is accepted', () => {
  decodeIdToken(token(valid({ iss: 'accounts.google.com' })), CLIENT_ID);
});

check('a Workspace domain is carried through when present', () => {
  const profile = decodeIdToken(token(valid({ hd: 'wilkes.edu' })), CLIENT_ID);
  if (profile.hd !== 'wilkes.edu') throw new Error(`hd was ${profile.hd}`);
  if (decodeIdToken(token(valid()), CLIENT_ID).hd !== null) throw new Error('hd invented');
});

check('the name falls back to the email when Google sends none', () => {
  const claims = valid();
  delete claims.name;
  if (decodeIdToken(token(claims), CLIENT_ID).name !== 'mia.alvarez@gmail.com') {
    throw new Error('no fallback name');
  }
});

/* ---------- the refusals ---------- */

refuses('an expired token is refused',
  valid({ exp: Math.floor(Date.now() / 1000) - 60 }), /expired/i);

refuses('a token for another application is refused',
  valid({ aud: 'someone-else.apps.googleusercontent.com' }), /different application/i);

refuses('a token from another issuer is refused',
  valid({ iss: 'https://accounts.example.com' }), /not issued by google/i);

refuses('an unverified email is refused',
  valid({ email_verified: false }), /not verified/i);

/*
 * Both of these are accepted today, and both are refused by the proxy.
 *
 * That asymmetry is the reason to pin them here rather than shrug: the server is
 * the boundary that holds, so neither is a way in — but a client that accepts a
 * token the server will reject sends somebody through sign-in only to fail at
 * their first read, with a message about the server rather than their account.
 */
refuses('email_verified as the string "false" is refused, not coerced',
  valid({ email_verified: 'false' }), /not verified/i);

refuses('a token with no expiry is refused rather than treated as fresh',
  // Number(undefined) is NaN, and every comparison with NaN is false — so an
  // omitted exp read as "not expired" rather than as missing.
  valid({ exp: undefined }), /expir/i);

check('a token with no email is refused', () => {
  const claims = valid();
  delete claims.email;
  let message = 'NO ERROR';
  try { decodeIdToken(token(claims), CLIENT_ID); } catch (e) { message = e.message; }
  if (!/did not return an email/i.test(message)) throw new Error(`message was: ${message}`);
});

check('a token that is not three segments is refused', () => {
  let message = 'NO ERROR';
  try { decodeIdToken('not.a-token', CLIENT_ID); } catch (e) { message = e.message; }
  if (!/not a valid token/i.test(message)) throw new Error(`message was: ${message}`);
});

check('a token whose payload is not JSON is refused', () => {
  let message = 'NO ERROR';
  try { decodeIdToken('aGVhZGVy.bm90LWpzb24.c2ln', CLIENT_ID); } catch (e) { message = e.message; }
  if (!/could not be read/i.test(message)) throw new Error(`message was: ${message}`);
});

check('an empty credential is refused rather than treated as anonymous', () => {
  let message = 'NO ERROR';
  try { decodeIdToken(null, CLIENT_ID); } catch (e) { message = e.message; }
  if (!/not a valid token/i.test(message)) throw new Error(`message was: ${message}`);
});

console.log(failures ? `\n${failures} identity check(s) failed.` : '\nAll identity checks passed.');
process.exit(failures ? 1 : 0);
