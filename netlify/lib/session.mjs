// Shared session helpers — runs in both Netlify Functions (Node) and Edge Functions (Deno).
// Uses only Web Crypto so the same code works in both runtimes.
// No secrets live in this file: they come from environment variables set in the Netlify UI.

export const COOKIE_NAME = 'cf_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

const enc = new TextEncoder();

export function env(key) {
  try {
    const v = globalThis.Netlify?.env?.get(key);
    if (v) return v;
  } catch {}
  return globalThis.process?.env?.[key] || '';
}

export function isConfigured() {
  return !!env('APP_PASSWORD');
}

async function hmacKey() {
  const secret = env('SESSION_SECRET') || ('crewflow-session:' + env('APP_PASSWORD'));
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(payload) {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(payload)));
}

// Constant-time string comparison (compares SHA-256 digests so lengths never leak)
export async function safeEqual(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function checkPassword(pw) {
  if (!isConfigured() || typeof pw !== 'string' || !pw) return false;
  return safeEqual(pw, env('APP_PASSWORD'));
}

export async function createToken() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = 'v1.' + exp;
  return payload + '.' + (await sign(payload));
}

export async function verifyToken(token) {
  if (!isConfigured() || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(parts[2], await sign(parts[0] + '.' + parts[1]));
}

export function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

export async function isAuthed(req) {
  return verifyToken(readCookie(req));
}

export function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}
