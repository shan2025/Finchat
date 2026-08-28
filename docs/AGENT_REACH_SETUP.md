# Agent-Reach Worker — Setup Guide

Give FinChat agents access to **authed/social platforms** our in-process JS tools
can't reach: logged-in Reddit, Twitter/X, LinkedIn, Instagram, Facebook.

## Why a separate worker?

[Agent-Reach](https://github.com/Panniantong/Agent-Reach) is a Python CLI that
picks the best current backend per platform and keeps browser logins/cookies on
disk. Render's free Docker container is **ephemeral** — it can't hold a login
session (the same reason outbound SMTP is blocked there). So the CLI runs on a
**persistent machine you control** (your always-on PC or a VPS) and exposes a tiny
HTTP endpoint; FinChat's Node backend calls that endpoint. No Python runs inside
the FinChat process.

```
FinChat (Render, Node)  ──HTTPS──►  your machine
  AgentReachTool.js                  cloudflared tunnel
                                       └─► uvicorn app.py  ─shell─►  agent-reach CLI
                                                                       (holds logins)
```

When your machine is **off**, the tool returns `searchUnavailable: true` and agents
say the social lookup is unavailable — they never fabricate "no discussion found".

---

## Part A — On your machine (you do this; it needs your logins)

### 1. Install Agent-Reach

Requires Python 3.10+.

```bash
pip install agent-reach        # or follow the repo's README install
agent-reach install            # pulls per-platform backends (yt-dlp, gh, etc.)
agent-reach doctor             # shows which platform uses which backend
```

### 2. Log in to the platforms you want

Do this once per platform — it opens a browser and stores cookies under
`~/.agent-reach/` (local only, never uploaded, never in the repo):

```bash
agent-reach configure reddit
agent-reach configure twitter
agent-reach configure linkedin
# ...only the ones you actually need
```

Re-run `agent-reach doctor` to confirm each shows a live backend.

### 3. Run the worker HTTP service

From `agent-reach-worker/` in this repo:

```bash
pip install -r requirements.txt

# Generate a shared secret and KEEP IT — you'll paste it into FinChat's .env too
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Set env vars and start it (bind to localhost — the tunnel handles the outside):

```bash
# PowerShell
$env:REACH_SECRET = "<paste the secret>"
$env:REACH_PLATFORMS = "reddit,twitter,linkedin"   # only the ones you logged in
uvicorn app:app --host 127.0.0.1 --port 8791
```

Check it: open `http://127.0.0.1:8791/health` — you should see
`{"ok": true, "cli_present": true, "platforms": [...]}`.

### 4. Expose it with a tunnel (Cloudflare Tunnel — free, recommended)

Your PC is behind NAT, so Render can't reach `127.0.0.1`. `cloudflared` gives it a
public HTTPS URL:

```bash
# install cloudflared, then:
cloudflared tunnel --url http://127.0.0.1:8791
```

It prints a URL like `https://random-words.trycloudflare.com`. That's your
`AGENT_REACH_URL`. (The quick tunnel URL changes each restart; for a stable URL,
set up a **named** Cloudflare tunnel — see Cloudflare's docs.)

> Alternative: `ngrok http 8791` (free URL changes on restart). Avoid raw router
> port-forwarding — it exposes a port on your home IP.

---

## Part B — In FinChat (the code side, already scaffolded)

Add to `finchat/legacy_prototype/backend/.env`:

```
AGENT_REACH_URL=https://random-words.trycloudflare.com
AGENT_REACH_SECRET=<the same secret from step 3>
```

On Render, set those same two vars in the dashboard (there is no render.yaml —
see the deployment notes). Watch for whitespace when pasting.

### Scope the tool to the right agents

The tool is registered as `agent_reach` but agents only see it if it's in their
`agent_configs.tools`. Add it only where it makes sense, e.g.:

- **Aurelius** (sentiment/catalyst hunting) → Twitter + Reddit
- **rasha** (jobs) → LinkedIn

```sql
-- example: grant to one agent (adjust to your JSON shape for agent_configs.tools)
update agent_configs
set tools = tools || '["agent_reach"]'::jsonb
where agent_id = '<aurelius agent id>';
```

`search` and `wikipedia` are always available; everything else, including
`agent_reach`, is per-agent.

---

## Verify end to end

1. Worker `/health` returns `cli_present: true` and your platforms.
2. From FinChat's box: `curl` the tunnel `/health`.
3. In chat, ask an agent that has the tool: *"what's the sentiment on NVDA on
   Twitter?"* — it should call `agent_reach` with `platform: twitter`.
4. Turn your PC off and ask again → the agent should say the social lookup is
   currently unavailable (NOT that there's no discussion). That's the
   `searchUnavailable` fallback working.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `AGENT-REACH NOT CONFIGURED` | env vars unset in FinChat | set `AGENT_REACH_URL` / `AGENT_REACH_SECRET` |
| `WORKER UNREACHABLE` | PC off / tunnel down | start the worker + `cloudflared` |
| `BACKEND DOWN for <platform>` (424) | login expired on the worker | `agent-reach configure <platform>` again |
| `401 bad x-reach-secret` | secret mismatch | make the two secrets identical |
| `platform ... not enabled` | not in `REACH_PLATFORMS` | add it and restart uvicorn (after logging in) |

## Safety

- The worker only ever runs **read-only** lookups — it never passes Agent-Reach's
  `--system` (write) flag.
- Cookies/tokens stay on your machine under `~/.agent-reach/`; nothing is committed.
- All social results are `verified:false` — agents must cross-check facts against
  wikipedia/news/search before reporting them.
