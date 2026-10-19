// Persistent dataset storage in Netlify Blobs.
//
// Each dataset type (trips / wfly / ulv / disc) holds a list of uploaded files, so new uploads
// add to the data instead of replacing it. Every file is stored as gzip-compressed source text,
// split into chunks so each request stays well under the function payload limit. A single JSON
// manifest records the files for each type; 'settings' keeps exactly one file.
//
//   GET    /api/data                                 → manifest
//   GET    /api/data?kind=trips&upload=ID&chunk=0    → gzip chunk of one file
//   PUT    /api/data?kind=trips&upload=ID&chunk=0    → store one chunk (binary body)
//   POST   /api/data?kind=trips&upload=ID&commit=1   → add the file to the manifest (JSON meta body)
//   DELETE /api/data?kind=trips&upload=ID            → remove one file
//   DELETE /api/data?kind=trips                      → remove every file of that type
import { getStore } from '@netlify/blobs';
import { isAuthed, json } from '../lib/session.mjs';

const KINDS = new Set(['trips', 'wfly', 'ulv', 'disc', 'settings']);
const SINGLE = new Set(['settings']);           // these replace instead of accumulating
const MAX_FILES = 100;
const MAX_CHUNKS = 200;
const MAX_CHUNK_BYTES = 4.5 * 1024 * 1024;
const UPLOAD_ID = /^[a-z0-9-]{8,48}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const store = () => getStore({ name: 'crewflow', consistency: 'strong' });

// Older manifests stored one file per type directly on the dataset entry
function normalise(manifest) {
  const m = manifest || { version: 2, datasets: {} };
  m.datasets = m.datasets || {};
  for (const [k, ds] of Object.entries(m.datasets)) {
    if (ds && !Array.isArray(ds.files)) m.datasets[k] = { files: ds.uploadId ? [ds] : [] };
  }
  m.version = 2;
  return m;
}

async function readManifest(s) {
  const res = await s.getWithMetadata('manifest', { type: 'json' });
  return { manifest: normalise(res?.data), etag: res?.etag };
}

// Optimistic-concurrency update so two people saving at once can't clobber each other
async function updateManifest(s, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { manifest, etag } = await readManifest(s);
    const next = fn(structuredClone(manifest));
    const res = await s.setJSON('manifest', next, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (res.modified) return next;
  }
  throw new Error('manifest busy, try again');
}

// Delete chunks under kind/ that no manifest file refers to (replaced, removed or abandoned uploads)
async function purgeOrphans(s, kind, manifest, keep = null) {
  const live = new Set((manifest.datasets[kind]?.files || []).map(f => f.uploadId));
  if (keep) live.add(keep);
  const { blobs } = await s.list({ prefix: kind + '/' });
  await Promise.all(blobs.filter(b => !live.has(b.key.split('/')[1])).map(b => s.delete(b.key)));
}

export default async (req) => {
  if (!(await isAuthed(req))) return json({ error: 'unauthorised' }, 401);

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind');
  const upload = url.searchParams.get('upload') || '';
  const s = store();

  try {
    if (req.method === 'GET' && !kind) return json((await readManifest(s)).manifest);

    if (!KINDS.has(kind)) return json({ error: 'unknown dataset' }, 400);
    if (upload && !UPLOAD_ID.test(upload)) return json({ error: 'bad upload id' }, 400);

    // Mutations need a custom header — a cross-site form can't send one (CSRF guard)
    if (req.method !== 'GET' && req.headers.get('x-crewflow') !== '1') return json({ error: 'bad request' }, 400);

    if (req.method === 'GET') {
      const chunk = Number(url.searchParams.get('chunk'));
      const { manifest } = await readManifest(s);
      const files = manifest.datasets[kind]?.files || [];
      const f = upload ? files.find(x => x.uploadId === upload) : files[0];
      if (!f || !Number.isInteger(chunk) || chunk < 0 || chunk >= f.chunks) return json({ error: 'not found' }, 404);
      const data = await s.get(`${kind}/${f.uploadId}/${chunk}`, { type: 'arrayBuffer' });
      if (!data) return json({ error: 'chunk missing' }, 404);
      return new Response(data, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    }

    if (req.method === 'PUT') {
      const chunk = Number(url.searchParams.get('chunk'));
      if (!upload || !Number.isInteger(chunk) || chunk < 0 || chunk >= MAX_CHUNKS) return json({ error: 'bad chunk' }, 400);
      const body = await req.arrayBuffer();
      if (!body.byteLength || body.byteLength > MAX_CHUNK_BYTES) return json({ error: 'chunk size' }, 413);
      await s.set(`${kind}/${upload}/${chunk}`, body);
      return json({ ok: true });
    }

    if (req.method === 'POST' && url.searchParams.has('commit')) {
      if (!upload) return json({ error: 'bad upload id' }, 400);
      const meta = await req.json();
      const chunks = Number(meta.chunks);
      if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) return json({ error: 'bad chunk count' }, 400);
      // Confirm every chunk actually landed before adding the file
      const { blobs } = await s.list({ prefix: `${kind}/${upload}/` });
      if (blobs.length !== chunks) return json({ error: `expected ${chunks} chunks, found ${blobs.length}` }, 409);

      const entry = {
        uploadId: upload,
        chunks,
        name: String(meta.name || '').slice(0, 200),
        records: Number(meta.records) || 0,
        bytes: Number(meta.bytes) || 0,
        from: DAY.test(meta.from) ? meta.from : null,
        to: DAY.test(meta.to) ? meta.to : null,
        uploadedAt: new Date().toISOString(),
      };
      // Files the client found fully covered by this upload are dropped in the same write
      const supersedes = new Set(Array.isArray(meta.supersedes) ? meta.supersedes.filter(x => UPLOAD_ID.test(x)) : []);
      const next = await updateManifest(s, m => {
        const ds = m.datasets[kind] || { files: [] };
        let files = SINGLE.has(kind) ? [] : ds.files.filter(f => !supersedes.has(f.uploadId));
        files = files.filter(f => f.uploadId !== upload).concat(entry);
        if (files.length > MAX_FILES) throw new Error(`too many files for ${kind} (max ${MAX_FILES}) — remove some old ones first`);
        m.datasets[kind] = { files };
        m.updatedAt = entry.uploadedAt;
        return m;
      });
      await purgeOrphans(s, kind, next, upload);
      return json(next);
    }

    if (req.method === 'DELETE') {
      const next = await updateManifest(s, m => {
        if (upload) {
          const files = (m.datasets[kind]?.files || []).filter(f => f.uploadId !== upload);
          if (files.length) m.datasets[kind] = { files }; else delete m.datasets[kind];
        } else delete m.datasets[kind];
        m.updatedAt = new Date().toISOString();
        return m;
      });
      await purgeOrphans(s, kind, next);
      return json(next);
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: e.message || 'storage error' }, 500);
  }
};

export const config = { path: '/api/data' };
