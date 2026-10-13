import { sessionCookie } from '../lib/session.mjs';

export default async () => new Response(null, {
  status: 302,
  headers: { location: '/login', 'set-cookie': sessionCookie('', 0), 'cache-control': 'no-store' },
});

export const config = { path: '/api/logout' };
