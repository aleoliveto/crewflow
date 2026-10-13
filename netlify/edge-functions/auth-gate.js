// Password gate: every request except the login page and login API must carry a valid session cookie.
import { isAuthed, isConfigured } from '../lib/session.mjs';

export default async (req, context) => {
  const url = new URL(req.url);
  const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/functions/');

  if (!isConfigured()) {
    const msg = 'CrewFlow is not configured: set the APP_PASSWORD environment variable in Netlify.';
    return new Response(msg, { status: 503, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
  }

  if (await isAuthed(req)) {
    const res = await context.next();
    // Never let shared caches keep authenticated pages
    if (!isApi) res.headers.set('cache-control', 'private, no-store');
    return res;
  }

  if (isApi) {
    return new Response(JSON.stringify({ error: 'unauthorised' }), {
      status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  const next = url.pathname === '/' ? '' : '?next=' + encodeURIComponent(url.pathname + url.search);
  return new Response(null, { status: 302, headers: { location: '/login' + next, 'cache-control': 'no-store' } });
};

export const config = {
  path: '/*',
  excludedPath: ['/login', '/login.html', '/api/login', '/api/logout'],
};
