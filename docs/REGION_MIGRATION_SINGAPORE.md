# Region migration runbook — Oregon/Tokyo → Singapore

## Why

Measured against production on 2026-08-15:

```
static asset (no DB)      333 ms   ← client → Oregon
/health (2 DB queries)    549 ms
                          ──────
DB portion                216 ms for ~2 queries
per-query round trip      108 ms   ← Oregon ⇄ Tokyo, on every query
```

The Render web service runs in **Oregon (US West)**; the Supabase project
(`oktchjdmajlylvdeeikl`) is in **Tokyo (ap-northeast-1)**. Every database query
crosses the Pacific twice. This is distance, not query cost — a `SELECT 1`
measures the same as a real query, and no amount of indexing or query tuning
changes it.

It multiplies: a request issuing five queries spends ~540ms waiting on the
network before any work happens. The N+1 batching done in `89aab2b` reduced how
many times the toll is paid, but not the toll.

## Target

Both services in **Singapore**:

| | Now | After |
|---|---|---|
| App ⇄ DB | ~108ms/query | ~5ms/query |
| You (India) ⇄ app | ~333ms | ~60ms |

Render offers Singapore on the free tier; Supabase offers `ap-southeast-1`.

Rejected alternatives:
- **Supabase → US West** fixes app⇄DB but leaves the app 333ms from you, and
  makes *local* development worse (~250ms/query from India vs 126ms today).
- **Render → Singapore only** leaves ~70ms/query against Tokyo.

## Hard constraints

- **Render cannot change a service's region.** You must create a new service.
- **Supabase cannot change a project's region.** You must create a new project
  and migrate the data.
- Supabase **egress quota is per-organisation**. Create the new project in an
  org with headroom, or the migration lands somewhere already throttled.
- The current URL `finchat-6.onrender.com` belongs to the existing service. A
  new service gets a new subdomain unless you delete the old one first and
  reclaim the name, or attach a custom domain.

## Order of operations

Do the database first. It can be validated while the old app still runs, so
there is no window where the app is pointing at nothing.

### 1. New Supabase project

1. Create project in **`ap-southeast-1` (Singapore)**, in an org with egress
   headroom. Record the new project ref.
2. Note the new connection string. Use the **session pooler on 5432**, matching
   the current setup, and URL-encode the password (this bit us before).

### 2. Move the data

The last migration hit a dollar-quoting problem; this filter is the one that
worked. Run from a machine with `pg_dump` 17.x:

```bash
pg_dump \
  --dbname="$OLD_TOKYO_URL" \
  --no-owner --no-privileges --no-publications --no-subscriptions \
  --schema=public \
  --file=finchat_public.sql
```

```bash
psql --dbname="$NEW_SINGAPORE_URL" --single-transaction --file=finchat_public.sql
```

Notes:
- `--schema=public` only. Do **not** dump `auth`, `storage` or `extensions` —
  Supabase manages those and restoring them over a fresh project breaks it.
- If `pgvector` is used by RAG, enable it on the new project *before* the
  restore: `CREATE EXTENSION IF NOT EXISTS vector;`
- `--single-transaction` means a partial failure rolls back cleanly instead of
  leaving a half-populated database.

### 3. Verify the data before cutting over

```sql
-- run against BOTH, compare
SELECT 'users' t, COUNT(*) FROM users
UNION ALL SELECT 'messages', COUNT(*) FROM messages
UNION ALL SELECT 'entities', COUNT(*) FROM entities
UNION ALL SELECT 'ai_conversations', COUNT(*) FROM ai_conversations
UNION ALL SELECT 'neural_map_nodes', COUNT(*) FROM neural_map_nodes
ORDER BY 1;
```

Baseline at time of writing: 27 users, 372 messages, 538 entities (353 with a
`user_id`, 185 legacy NULL — see the knowledge-graph notes; those NULLs are
intentional and must survive the move).

Also confirm RLS came across — all 55 tables had it enabled:

```sql
SELECT COUNT(*) FROM pg_tables
WHERE schemaname='public' AND rowsecurity = true;
```

And check migration state matches: `SELECT * FROM pgmigrations ORDER BY id DESC LIMIT 5;`

### 4. New Render service in Singapore

1. New Web Service → same GitHub repo `shan2025/Finchat`, branch `main`,
   **Region: Singapore**, Runtime: Docker, Free.
2. Copy every environment variable from the old service. There is no
   `render.yaml`, so **config is dashboard-only and nothing is reproduced
   automatically** — this is the step most likely to be missed. At minimum:
   `DATABASE_URL` (→ new Singapore URL), `JWT_SECRET` (must be identical or
   every existing session is invalidated), `GROQ_API_KEY`, `CRON_SECRET`,
   SMTP settings, Telegram token, VAPID keys, Redis/Upstash URL,
   `ALLOWED_ORIGINS` / `FRONTEND_URL` (→ the new hostname).
3. Deploy and watch the build. The Dockerfile builds the Tailwind stylesheets;
   confirm `/finchat_tw.css` returns 200 at ~43KB, or the app serves unstyled.

### 5. Verify the new service

```bash
curl -s https://<new-host>/health
curl -sI https://<new-host>/finchat_tw.css | grep -i 'HTTP/\|cache-control'
```

`/health` must report `status: ok` with non-zero `users`, which proves it is
actually talking to the new database. "Live" in the Render dashboard does not
mean the app is healthy — it has crash-looped while showing Live before.

Then re-run the latency measurement. Success looks like the DB portion
dropping from ~216ms to under ~20ms:

```bash
# static (no DB) vs /health (2 queries) — the delta is the DB round trip
curl -o /dev/null -s -w 'static %{time_total}\n' https://<new-host>/finchat_tw.css
curl -o /dev/null -s -w 'health %{time_total}\n' https://<new-host>/health
```

### 6. Cut over

- Update `ALLOWED_ORIGINS` / `FRONTEND_URL` to the new hostname.
- Repoint the external cron that drives `/api/cron/tick` and
  `/api/cron/briefing` (with `CRON_SECRET`) at the new host, or scheduled
  notifications silently stop.
- Update the Telegram bot polling target if it is host-bound.
- Keep the old service **suspended, not deleted**, for a few days.

### 7. Rollback

Nothing is destroyed until step 8, so rollback is: point `DATABASE_URL` back at
Tokyo and resume the old Oregon service. Both remain intact throughout.

### 8. Cleanup (only once confident)

- Delete the old Render service.
- Pause, then later delete, the Tokyo Supabase project.
- Drop `entities_backup_028` if still present.

## After the move

Re-measure before doing further query optimisation. At ~5ms per round trip the
remaining N+1 patterns I judged "not worth batching" (the IPFS and
file-extraction loops in `messages.js` and `mindMaps.js`) stay not worth
batching — those are bound by network calls to other services, not the
database.

The process-memory caching added alongside this (`services/microCache.js`)
stays useful regardless: it removes the round trip entirely rather than
shortening it.
