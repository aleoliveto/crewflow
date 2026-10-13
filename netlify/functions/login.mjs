import { checkPassword, createToken, sessionCookie, json, isConfigured } from '../lib/session.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!isConfigured()) return json({ error: 'APP_PASSWORD is not set on this site' }, 503);

  let password = '';
  try { ({ password } = await req.json()); } catch {}

  if (!(await checkPassword(password))) {
    await sleep(800 + Math.random() * 400); // slow down guessing
    return json({ error: 'Incorrect password' }, 401);
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await createToken()) });
};

export const config = { path: '/api/login' };
