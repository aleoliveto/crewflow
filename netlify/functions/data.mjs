// Persistent dataset storage in Netlify Blobs.
//
// Each dataset (trips / wfly / ulv / disc, plus shared settings) is stored as the gzip-compressed source text,
// split into chunks so every request stays well under the function payload limit.
// A single JSON manifest records which upload is current for each dataset.
//
//   GET    /api/data                               → manifest
//   GET    /api/data?kind=trips&chunk=0            → gzip chunk of the current upload
//   PUT    /api/data?kind=trips&upload=ID&chunk=0  → store one chunk (binary body)
//   POST   /api/data?kind=trips&upload=ID&commit=1 → make upload current (JSON meta body)
//   DELETE /api/data?kind=trips                    → remove dataset
import { getStore } from '@netlify/blobs';
import { isAuthed, json } from '../lib/session.mjs';

const KINDS = new Set(['trips', 'wfly', 'ulv', 'disc', 'settings']);
const MAX_CHUNKS = 200;
const MAX_CHUNK_BYTES = 4.5 * 1024 * 1024;
const UPLOAD_ID = /^[a-z0-9-]{8,48}$/;

const store = () => getStore({ name: 'crewflow', consistency: 'strong' });

async function readManifest(s) {
  const res = await s.getWithMetadata('manifest', { type: 'json' });
  return { manifest: res?.data || { version: 1, datasets: {} }, etag: res?.etag };
}

// Optimistic-concurrency update so two people saving at once can't clobber each other
async function updateManifest(s, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { manifest, etag } = await readManifest(s);
    const next = fn(structuredClone(manifest));
    const res = await s.setJSON('manifest', next, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (res.modified) return { prev: manifest, next };
  }
  throw new Error('manifest busy, try again');
}

async function purgeChunks(s, kind, keepUpload) {
  const { blobs } = await s.list({ prefix: kind + '/' });
  await Promise.all(blobs
    .filter(b => !keepUpload || !b.key.startsWith(`${kind}/${keepUpload}/`))
    .map(b => s.delete(b.key)));
}

export default async (req) => {
  if (!(await isAuthed(req))) return json({ error: 'unauthorised' }, 401);

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind');
  const s = store();

  try {
    if (req.method === 'GET' && !kind) {
      const { manifest } = await readManifest(s);
      return json(manifest);
    }

    if (!KINDS.has(kind)) return json({ error: 'unknown dataset' }, 400);

    // Mutations need a custom header — a cross-site form can't send one (CSRF guard)
    if (req.method !== 'GET' && req.headers.get('x-crewflow') !== '1') return json({ error: 'bad request' }, 400);

    if (req.method === 'GET') {
      const chunk = Number(url.searchParams.get('chunk'));
      const { manifest } = await readManifest(s);
      const ds = manifest.datasets[kind];
      if (!ds || !Number.isInteger(chunk) || chunk < 0 || chunk >= ds.chunks) return json({ error: 'not found' }, 404);
      const data = await s.get(`${kind}/${ds.uploadId}/${chunk}`, { type: 'arrayBuffer' });
      if (!data) return json({ error: 'chunk missing' }, 404);
      return new Response(data, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    }

    if (req.method === 'PUT') {
      const upload = url.searchParams.get('upload') || '';
      const chunk = Number(url.searchParams.get('chunk'));
      if (!UPLOAD_ID.test(upload) || !Number.isInteger(chunk) || chunk < 0 || chunk >= MAX_CHUNKS) return json({ error: 'bad chunk' }, 400);
      const body = await req.arrayBuffer();
      if (!body.byteLength || body.byteLength > MAX_CHUNK_BYTES) return json({ error: 'chunk size' }, 413);
      await s.set(`${kind}/${upload}/${chunk}`, body);
      return json({ ok: true });
    }

    if (req.method === 'POST' && url.searchParams.has('commit')) {
      const upload = url.searchParams.get('upload') || '';
      if (!UPLOAD_ID.test(upload)) return json({ error: 'bad upload id' }, 400);
      const meta = await req.json();
      const chunks = Number(meta.chunks);
      if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) return json({ error: 'bad chunk count' }, 400);
      // Confirm every chunk actually landed before switching over
      const { blobs } = await s.list({ prefix: `${kind}/${upload}/` });
      if (blobs.length !== chunks) return json({ error: `expected ${chunks} chunks, found ${blobs.length}` }, 409);

      const entry = {
        uploadId: upload,
        chunks,
        name: String(meta.name || '').slice(0, 200),
        records: Number(meta.records) || 0,
        bytes: Number(meta.bytes) || 0,
        uploadedAt: new Date().toISOString(),
      };
      const { next } = await updateManifest(s, m => { m.datasets[kind] = entry; m.updatedAt = entry.uploadedAt; return m; });
      await purgeChunks(s, kind, upload);
      return json(next);
    }

    if (req.method === 'DELETE') {
      const { next } = await updateManifest(s, m => { delete m.datasets[kind]; m.updatedAt = new Date().toISOString(); return m; });
      await purgeChunks(s, kind, null);
      return json(next);
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: e.message || 'storage error' }, 500);
  }
};

export const config = { path: '/api/data' };
