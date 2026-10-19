# Paul Monitoring Dashboard

Password-protected crew analytics for Netlify, with two sections:

- **Tripping overlaps.** Network and map views of crew tripped A→B **and** B→A on the same day, top crossings, and which department (route-code prefix) booked the overlapping moves.
- **WFLY.** Every Willing-to-Fly instance (CP/FO) with same-day context at that base: same-rank pilots tripped in/out, discretion (FDP extensions) used and unpaid leave (ULV) granted.

One filter row drives everything: a date-range calendar with presets, bases, rank, department / activity, plus "More filters".

Uploaded files are saved to a private, shared workspace (Netlify Blobs), so they load automatically for anyone signed in, on any device.

## Data files

Load via **Data → Upload files** or drag onto the window — the type is detected automatically and several can be loaded at once. Uploads **add up**: every file is kept and the files of a type are merged by date. Where files overlap, the most recently uploaded file is used for those dates (no double counting), and a file fully covered by a newer upload is dropped automatically. Individual files can be removed from the Data panel.

| Report | Recognised by |
| --- | --- |
| All tripping (UTF-16/tab or UTF-8/comma) | `OpsDate`, `Crew ID`, `Rank`, `Crew Base`, `Trip Base` columns |
| WFLY / crewBid details (`$`) | `Day of $ Date`, `Base`, `Rank`, `crewBid`, `Activity` columns |
| ULV | Crew Schedule Statistics, *GROUND DUTIES:ULV* export |
| Discretion | *Discretion Report (Detailed Format)* export |

The estimated cost per WFLY (CP / FO) is entered once in the WFLY sidebar and saved to the workspace — it is never stored in this repository.

> **Never commit data files.** The repo is public; `.gitignore` blocks `*.csv`, `*.xlsx` and audit exports as a safety net.

## Deploy on Netlify

1. Create a new site from this repository (settings come from `netlify.toml`; no build command needed).
2. In **Site configuration → Environment variables** add:
   - `APP_PASSWORD` — the shared password (required; the site returns 503 until it is set).
   - `SESSION_SECRET` — optional long random string for signing session cookies. If omitted, a key derived from `APP_PASSWORD` is used, so changing the password signs everyone out.
3. Deploy. Netlify Blobs needs no extra setup.

No secrets or API keys live in the code — everything sensitive is an environment variable or workspace data.

## How it works

```
public/index.html                     the app (static)
public/login.html                     sign-in page
netlify/edge-functions/auth-gate.js   blocks every request without a valid session cookie
netlify/functions/login.mjs           POST /api/login → HttpOnly, Secure, SameSite=Strict cookie (12 h)
netlify/functions/logout.mjs          GET  /api/logout
netlify/functions/data.mjs            /api/data → datasets in the "crewflow" Blobs store
netlify/lib/session.mjs               HMAC-signed session tokens (Web Crypto; shared by edge + functions)
```

Datasets are gzip-compressed in the browser and uploaded in ≤3 MB chunks; a manifest records the current upload per dataset and old chunks are purged on replace. Writes need the session cookie plus a custom header (CSRF guard). Failed logins are slowed down.

## Local development

```bash
npm install
cp .env.example .env    # set APP_PASSWORD
npx netlify dev
```

Opening `public/index.html` directly also works in "local only" mode (nothing is saved).

Map outlines: `public/basemap.json`, derived from [Natural Earth](https://www.naturalearthdata.com/) (public domain) via `world-atlas`.
