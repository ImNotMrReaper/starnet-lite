'use strict';
/* Lite answers on the home network / Tailscale and attaches StarNet's token itself, so it must make sure a request
   really comes from a Lite page and not from some other website the device happens to have open (CSRF):
     - every page gets a random per-device secret in a cookie (SameSite=Strict) and in the page itself;
     - every change (POST) must echo that secret, and must not come from another site's Origin.
   Pages also refuse to be framed (clickjacking) and only load their own scripts. */
const crypto = require('crypto');

const COOKIE = 'lite_csrf';

const PAGE_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store'
};

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Returns the device's secret, minting one (and the Set-Cookie header for it) when the device has none yet.
function csrfFor(req) {
  const have = parseCookies(req)[COOKIE];
  if (have && /^[a-f0-9]{48}$/.test(have)) return { token: have, setCookie: null };
  const token = crypto.randomBytes(24).toString('hex');
  return { token, setCookie: `${COOKIE}=${token}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly` };
}

function sameSite(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return !origin;   // no Origin (old browsers, plain form posts) is checked by the secret alone
  try { return new URL(origin).host === String(req.headers.host || ''); } catch (_) { return false; }
}

function checkCsrf(req, supplied) {
  const want = parseCookies(req)[COOKIE];
  if (!want || !supplied || !sameSite(req)) return false;
  const a = Buffer.from(String(want)), b = Buffer.from(String(supplied));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 65536) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch (_) { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

module.exports = { PAGE_HEADERS, COOKIE, parseCookies, csrfFor, checkCsrf, sameSite, readBody, readJson };
