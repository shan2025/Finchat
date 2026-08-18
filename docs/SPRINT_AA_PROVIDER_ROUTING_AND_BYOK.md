# Sprint AA — Provider Routing, Per-Agent Keys, Fallback Ladder & BYOK

**Status:** Budget fix + context efficiency SHIPPED 2026-08-18 · sequencing revised (see §11) · not yet deployed
**Written:** 2026-08-18

---

## 0. What shipped (2026-08-18)

**Phase 1 — complete.**

| Change | Where |
|---|---|
| Framework default budget 5,000 → **15,000** tokens, 60s → **120s** | `ExecutionManager.js:56` |
| Per-agent budgets in `runtime_settings.budget`, read **before** the execution row is created | `CognitiveCore.js`, migration `030` |
| Precedence: caller budget > agent budget > framework default | `CognitiveCore.js` |
| Honest user-facing message replacing "Budget exceeded. Here is my best response…" | `CognitiveCore.js` (`BUDGET_EXHAUSTED_MESSAGE`) |
| Trivial workloads (`community_name`, `extraction`, `gap-detection`) routed to a cheap provider **and** a cheap model | `inference.js` (`WORKLOAD_MODEL_HINTS`) |
| `prompt_tokens_used` / `completion_tokens_used` split on executions | migration `031`, `ExecutionRepository.js`, `ReasoningEngine.js` |

Per-agent budgets applied: plato/nova 25k, aurelius/rasha 20k, memory 12k, sentinel 8k.

**Phase 2 — partially shipped.** DeepSeek (funded, $2) and Mistral (free tier)
added and promoted; Cerebras still outstanding (needs a signup).

**Verified, not assumed.** The exact failing case from the screenshot — Rasha,
a "find for me then"-shaped question — was replayed through the full cognitive
loop twice:

```
completion_reason : natural          (was: budget_exceeded)
tokens_used       : 7,993 / 20,000   (was: 5,266 / 5,000)
iterations        : 2 / 5
provider          : deepseek         915ms  (was: gemini, 16-33s)
```

Full suite: **253 tests, 0 failures.**

The token split immediately earned its place: that run recorded
`prompt_tokens_used 6,860` against `completion_tokens_used 1,133` — **86% of the
budget was re-reading its own context**, not producing an answer. That number is
the case for §4.1.3's context cap, and nothing recorded it before today.

### 0.1 Context efficiency — shipped 2026-08-18

Done next on the strength of the 86% figure above, ahead of adding more providers.

**Measured first, before changing anything.** Per-block sizing of a real Rasha
context found the cost was not conversation history — it was the tool catalogue:

| block | size | note |
|---|---|---|
| tool catalogue | 6,977 chars ≈ **1,744 tok** | 18 tools with full parameter schemas, **re-sent every turn** |
| rules block | 2,202 chars ≈ 551 tok | re-sent every turn |
| tool results | ≤12,000 chars | already budgeted |
| conversation history | **unbounded** | not yet dominant, but uncapped |

On a first turn with no history, the system prompt was **99.7% of the entire
request** against a 10-token question.

**Two changes:**

1. **Compact the catalogue once tool results are in hand.** In that state the
   loop is already telling the model "you MUST use action respond now", so full
   parameter schemas have no reader. Names and one-line purposes stay, so the
   one legitimate exception — the goal needs a tool that has not run yet — is
   still reachable.
2. **Cap conversation history** at 8,000 chars (`HISTORY_CONTEXT_BUDGET_CHARS`),
   keeping the most recent turns and telling the model when older ones were
   dropped. Not yet the dominant cost; capped before it became one.

**Result, same replayed Rasha run:**

| | before | after | |
|---|---|---|---|
| prompt tokens | 6,860 | **5,532** | −19% |
| total tokens | 7,993 | **6,357** | −20% |
| synthesis turn prompt | 3,873 | **2,545** | −34% |
| completion_reason | natural | natural | quality held |

`context_chars_saved` recorded 5,313 chars ≈ 1,328 tokens — reconciling exactly
with the observed per-turn drop. Suite: **266 tests, 0 failures.**

### 0.2 Per-agent tool scoping — shipped 2026-08-18 (approved)

`tool_permissions` only governs `bash`/`file_edit`/`file_write`, so every agent
was shown all 18 research tools — Rasha, a careers agent, carried `forex`,
`commodities`, `crypto`, `stocks` and `watchlist` schemas on every turn.

**The per-agent lists already existed and had simply never been read.**
`agent_configs.tools` has held curated sets all along — aurelius:
stocks/crypto/commodities/news/watchlist/fetch/search, rasha:
jobs/resume/apply_draft/fetch/search, nova: paper/crawl/news/fetch/search.
`listTools()` never consulted them. So this wired up existing data rather than
inventing a mapping.

Three rules make it safe:

- **`search` and `wikipedia` survive any scoping.** The RULES block *orders* the
  model to verify named things with them; scoping either away would command a
  tool the same prompt never showed.
- **Plato is never scoped.** Its own row lists only `["search"]`, but it is the
  fallback for every goal no specialist matched.
- **Empty means "unconfigured", not "no tools".** The two are indistinguishable
  in the data, and guessing toward "none" would silently strip an agent of every
  capability (memory and sentinel both have `[]`).

### 0.3 Cumulative result

Same replayed Rasha run throughout:

| | original | after §0.1 | after §0.2 | total |
|---|---|---|---|---|
| **total tokens** | 7,993 | 6,357 | **5,047** | **−37%** |
| **prompt tokens** | 6,860 | 5,532 | **3,923** | **−43%** |
| completion tokens | 1,133 | 825 | 1,124 | held |
| context re-read | 86% | 87% | **78%** | |
| turn 1 prompt | 2,987 | 2,987 | **1,695** | −43% |
| turn 2 prompt | 3,873 | 2,545 | **2,228** | −42% |
| completion_reason | natural | natural | natural | |

§0.4 then trades ~150 of those tokens back for a 78% cache hit rate — final
figures at the end of that section.

Suite: **271 tests, 0 failures.**

Worth noting: at 5,047 tokens this run would now very nearly fit the *original*
5,000 ceiling that failed. The budget fix stopped the bleeding; the context work
removed most of the reason it was bleeding.

### 0.4 Prefix caching — shipped 2026-08-18, and it reversed part of §0.1

**The per-turn compaction in §0.1 turned out to be measurably wrong. This is the
correction.**

DeepSeek caches an identical prompt prefix automatically. Verified by experiment
before changing anything: resending the same 1,933-token prefix returned
`prompt_cache_hit_tokens: 1920` — **99%**, billed at a fraction of the miss price.

`ContextBuilder` already ordered stable content first (persona + schema +
catalogue in message 1; memories, tool results, history, goal after). But §0.1
rendered the catalogue *full* on turn 1 and *compact* once results arrived —
changing message 1 mid-run and destroying the prefix precisely when it would
have paid:

| turn 2 | tokens | billed as |
|---|---|---|
| per-turn compaction (§0.1) | 2,228 | all cache-miss |
| stable full catalogue | 2,581 | 1,664 cached |

Saving 366 tokens forfeited a cache hit on the 1,664 before it. **The catalogue
rendering is now a run-level policy, fixed for every turn**, and per-agent
scoping (§0.2) is what makes "always full" cheap: nova 533 tok, rasha 575,
aurelius 701. Full also keeps the parameter schemas, so tool selection carries
no added risk at all.

`TOOL_CATALOGUE_COMPACT=1` renders compact on every turn instead — still stable,
still cacheable. That trade is only right if a provider *without* prefix caching
becomes primary.

**Measured on the same replayed run:**

```
turn 1   1,664 / 1,695 prompt tokens from cache   (98%)
turn 2   1,664 / 2,581 prompt tokens from cache   (64%)
         3,328 / 4,276 overall                     (78%)
```

Turn 1 hits because the prefix is stable **across runs too** — every
conversation with the same agent shares it.

`inference_metrics.cached_tokens` (migration 033) records this per call. It is
the only way to *see* the invariant: anything perturbing the first system
message — a timestamp, a reordered directive, a per-turn rendering — silently
drops the hit rate to zero while every other metric looks healthy. **A run whose
`cached_tokens` is 0 after the first turn has a prefix bug.**

### 0.5 Two KPIs, two different things

`context_chars_saved` now usually reads **0**, and that is correct rather than
broken. It measures *compaction and history trimming*; with the catalogue stable
and a short conversation, neither fires. Scoping's saving shows up as a smaller
prompt, not a larger `charsSaved`.

| question | column |
|---|---|
| Is the prompt small? | `executions.prompt_tokens_used` |
| Did trimming fire? | `executions.context_chars_saved` |
| Is caching working? | `inference_metrics.cached_tokens` |
| Did the run fit its ceiling? | `executions.completion_reason` |

Caching lowers **cost**; it does not lower `tokens_used`, because cached tokens
still count. Compaction and scoping lower `tokens_used`, which is what protects
the budget ceiling and the Groq/Gemini free tiers — neither of which caches
automatically. Both matter, for different reasons.

**Still not done:** the rules block (551 tok/turn) is emphatic anti-hallucination
prose. It is repetitive and could be tightened, but every clause was added
against a specific failure, so it is not worth trimming for tokens alone.

---
**Owner question this answers:** *"Why do I keep getting 'Budget exceeded', why is it slow, and how do I give each agent its own key/model with a fallback that never leaves the user without an answer — for free?"*

Every number in the Diagnosis section is a real query against the live Supabase
(`oktchjdmajlylvdeeikl`), 14-day window, run 2026-08-18. Nothing here is estimated.

---

## 1. Diagnosis — what is actually happening

### 1.1 "Budget exceeded" is NOT a quota problem

This is the most important correction to make up front. There are two *different*
failures that both feel like "the AI is out of credit", and they need opposite fixes:

| Symptom in chat | Real cause | Where it comes from |
|---|---|---|
| "Budget exceeded. Here is my best response given the constraints." | The **local per-run token ceiling** was hit. Providers were fine. | `CognitiveCore.js:364` and `:408` |
| "I am currently experiencing temporary high traffic or network delays…" | Every provider in the chain refused. This is the real quota/outage failure. | `inference.js:624` |

The Rasha screenshot is the **first** one. No provider quota was involved.

### 1.2 The exact mechanism

`ExecutionManager.createExecution()` (`ExecutionManager.js:47-57`) defaults every run to:

```
maxIterations: 8   maxToolCalls: 5   maxTokens: 5000   maxRuntimeSeconds: 60
```

`aiChat.js` only overrides that budget when the message contains a magic word
(`ultrathink` / `megathink` / `think hard`, `aiChat.js:90-100`). An ordinary
message like *"find for me then"* therefore runs on **5,000 tokens**.

Now measure what one turn actually costs. From `inference_metrics`, chat calls on
the current primary model:

| provider / model | calls | avg prompt | avg completion | **avg per turn** | avg latency |
|---|---|---|---|---|---|
| groq · `openai/gpt-oss-120b` | 397 | 1,947 | 667 | **2,614** | 6.2 s |
| groq · `openai/gpt-oss-20b` | 138 | 1,364 | 568 | 1,932 | 4.2 s |
| gemini · `gemini-3.5-flash` | 13 | 2,642 | 323 | 2,965 | **16.0 s** |
| gemini · `gemini-flash-latest` | 8 | 1,408 | 123 | 1,531 | **32.6 s** |

`ReasoningEngine` charges `total_tokens` — **prompt included** — to the budget
(`ReasoningEngine.js:201`, `CognitiveCore.js:344`). The prompt is re-sent in full on
every turn, so the same context is charged again each iteration.

**2,614 × 2 turns = 5,228 > 5,000.** The run dies on turn two, before any tool
result can be turned into prose. That is the whole bug.

### 1.3 The data confirms it exactly

Per-agent, 14 days:

| agent | reason | runs | avg tokens used | ceiling |
|---|---|---|---|---|
| **rasha** | budget_exceeded | 2 | **5,266** | **5,000** |
| **rasha** | natural | 2 | 6,705 | 5,000 |
| **aurelius** | budget_exceeded | 5 | 11,620 | **5,000** |
| **aurelius** | natural | 12 | 5,835 | 5,000 |
| plato | budget_exceeded | 27 | 15,997 | 15,926 |
| nova | budget_exceeded | 9 | 18,885 | 15,000 |

Rasha overran by **266 tokens** — one tenth of one turn. Aurelius's *successful*
runs average 5,835 against a 5,000 ceiling; they only survive because
`CognitiveCore` reserves a final funded turn to write something. Rasha and Aurelius
are running on the untouched framework default while Plato and Nova got theirs
raised by the briefing/mission callers. **Nobody ever set a chat budget for the
specialist agents.**

Chat totals, 14 days: 66 natural, 35 error, **26 budget_exceeded**. So roughly one
chat in four dies on a ceiling that is one turn too small.

### 1.4 The second failure: the provider bench is only two deep

`.env` has `GROQ_API_KEY` and `GEMINI_API_KEY` set. **`DEEPSEEK_API_KEY` is empty.**
The third provider in `PROVIDERS` (`inference.js:94-101`) is skipped silently
by `_usableKey()`. So "falls back across three providers" is actually two.

Of 140 `error` executions, **106** are literally
`AI Inference unavailable across providers` — both providers spent or throttled at
the same moment. There is no third net.

### 1.5 Why answers are slow

Chat routes **Gemini first** (`inference.js:127`). That decision was correct at the
time — it was made to stop scheduled research from draining the Groq day. But
measured latency says Gemini is the slowest thing on the bench for chat:
**16.0 s** and **32.6 s** average versus Groq's **6.2 s**. Multiply by 2–3
reasoning turns per answer and that is a 30–90 second wait. The user's instinct
("it takes a lot of time") is measurably right, and it is a *routing* consequence,
not a context-size one.

Secondary waste worth naming: `community_name` — a task that emits a **4-token
label** — made 177 calls to the 120B reasoning model at **24.4 s each**, burning
~140 reasoning tokens per label. The same job on `llama-3.3-70b` took 2.9 s and 4
tokens. Trivial tasks are being routed to the most expensive model on the bench.

### 1.6 The daily briefing is one agent, not many

Confirmed. `briefing.js:216` forces `targetAgentId: 'plato'`, and
`PlatoOrchestrator.route()` selects exactly **one** agent per run
(`PlatoOrchestrator.js:44-78`). There is no fan-out. Plato researches *and* writes
the whole thing. No specialist contributes.

### 1.7 The per-agent briefings you want already exist — and are switched off

`agent_missions` today:

| agent | title | cadence | enabled | failures |
|---|---|---|---|---|
| aurelius | Crypto brief (6h) | 6h | **false** | 0 |
| rasha | Daily job hunt | daily | **false** | 0 |
| nova | Daily research digest | daily | true | 0 |
| nova | Daily Research & Markets Digest | daily | false | 3 |
| plato | Monitor the stock market | daily | **false** | 3 |

The crypto brief and the job-hunt brief are already defined. Worse: even flipping
`enabled` would not fire them, because **missions have no scheduler**. pg_cron only
calls `trigger_daily_briefing()`; `cron-job.org` (which drove `/api/cron/tick`) is
disabled. The tech briefing you receive is the Plato pg_cron briefing plus Nova's
digest — the only two things with a live trigger.

### 1.8 BYOK is a parameter with no caller

`runInference({ byokKey })` exists (`inference.js:538`, `:553`) and applies only to
Groq. Nothing in the codebase ever passes it. There is no key column on `users`, no
storage table, and no UI. It is a stub.

---

## 2. What is already built (do not rebuild)

Credit where due — a lot of the architecture you're asking for is in place:

- ✅ **Per-workload provider routing** — `WORKLOAD_ROUTES` (`inference.js:126-133`).
  Chat and briefing/mission already draw on separate pools. *This is the thing you
  asked for yesterday; it shipped.* What is missing is that the pools are only two
  providers deep and the chat order is latency-hostile.
- ✅ **Cross-provider fallback with 429/413/5xx handling, backoff, payload trimming,
  dead-model retirement** (`_runProviderChain`).
- ✅ **Impatient workloads** — chat skips rate-limit backoff (`inference.js:143`).
- ✅ **Per-agent model pinning** — `agent_configs.runtime_settings.model` (Aurelius
  pins `gpt-oss-120b`).
- ✅ **Per-mission token budgets** — `agent_missions.max_tokens_per_run`.
- ✅ **Full inference telemetry** — `inference_metrics` is what made this diagnosis
  possible.

The gaps are: **budget ceilings, bench depth, per-agent keys, a formal fallback
ladder, a mission scheduler, and BYOK.**

---

## 3. The free provider bench

Everything below is a genuinely free tier. Limits verified 2026-08-18; treat them
as "check the console before relying on it", since providers change these often.

| # | Provider | Free allowance | Speed | Notes / role |
|---|---|---|---|---|
| 1 | **Groq** *(have)* | 200k tokens **per model per day** | fastest (6 s) | Best chat latency on the bench. Reasoning model bills reasoning tokens. |
| 2 | **Gemini** *(have)* | ~6 req/min free tier | slow (16–33 s) | Large context. Good for briefings, poor for chat. |
| 3 | **Cerebras** *(new)* | **1M tokens/day**, 30 req/min | very fast | Biggest free daily budget on the market. **Context capped at 8,192 on free tier** — fine for chat (avg prompt 1,947), too small for a 15-source briefing. |
| 4 | **Mistral** *(new)* | ~1B tokens/month, ~1 req/sec | medium | Genuinely different model family — real redundancy when both Groq and Gemini have a bad day. Needs phone verification. |
| 5 | **OpenRouter** *(new)* | 50 req/day free (1,000/day after a one-time $10) | varies | Last-resort emergency net only. 50/day is too thin to route to. |
| 6 | **Ollama local** *(have)* | unlimited, free | slow (27 s) | `qwen2.5:3b`. Works in local dev. **Dead on Render** — `OLLAMA_URL` points at localhost, which on a cloud host is the app's own container. Needs a tunnel + an awake desktop to be real in production. |

**Recommended additions: Cerebras first, then Mistral.** Cerebras alone adds 1M
free tokens/day — five times the entire current Groq allowance — and is fast enough
to lead the chat route. DeepSeek's empty key slot should either be filled or the
provider removed so the logs stop implying a net that isn't there.

---

## 4. Phase 1 — Stop the bleeding (budget)

**Goal:** no more "Budget exceeded" in ordinary chat. Highest value, smallest change.
Ship this first, on its own.

**1.1 — Give every agent a real chat budget.**
Extend `agent_configs.runtime_settings` with a `budget` object and read it in
`PlatoOrchestrator.route()` before calling into `CognitiveCore`:

```jsonc
"runtime_settings": {
  "model": "openai/gpt-oss-120b",
  "budget": { "maxTokens": 15000, "maxIterations": 6, "maxToolCalls": 6,
              "maxRuntimeSeconds": 120 }
}
```

Precedence: `caller-supplied budget` > `agent runtime_settings.budget` >
`framework default`. Callers that already set a budget (briefing 40k, missions)
keep winning, so nothing regresses.

**1.2 — Raise the framework default from 5,000 to 15,000 tokens.**
`ExecutionManager.js:56`. 5,000 was sized for a single turn of a model that no
longer exists; the current primary costs 2,614/turn and the loop needs 3–4 turns
to research and then write. 15,000 ≈ 5 honest turns. Note `LOOP_SAFETY_NET = 8`
in `CognitiveCore.js:230` already caps iterations independently, so this cannot
run away.

**1.3 — Stop charging the same prompt on every turn.**
The structural fix behind 1.2. The prompt is re-sent in full each iteration, so a
3-turn run pays for its context three times. Two sub-fixes:

- Track `prompt_tokens` and `completion_tokens` separately on the execution row
  (migration 030), so telemetry can finally distinguish "did real work" from
  "re-read its own context".
- Cap context growth in `ContextBuilder` for the chat workload. This also directly
  reduces latency — smaller prompt, faster answer.

Keep `tokens_used` as **total** tokens: that is what providers actually meter, and
it is the number that must stay honest for quota accounting.

**1.4 — Make the message truthful.**
`'Budget exceeded. Here is my best response given the constraints.'` is shown when
the model produced *nothing*, which makes it a lie — there is no response after
that sentence. Replace with something that says what happened and what to do:
> *"I ran out of my per-answer budget before I could finish this one. Ask me again
> and I'll pick up where I left off, or say 'think hard' to give me a bigger budget."*

**1.5 — Route trivial tasks to trivial models.**
`community_name`, `extraction`, and similar label-sized jobs should pin
`gpt-oss-20b` (or Cerebras). Saves 24 s and ~300 reasoning tokens per call across
177+ calls.

**Acceptance:** re-run the §1.3 query after a week. Chat `budget_exceeded` should
be < 5% of chat runs (currently ~21%).

---

## 5. Phase 2 — Widen the bench

**2.1** Register Cerebras (OpenAI-compatible `style: 'openai'` — slots straight into
`PROVIDERS` with no new call path) and Mistral (also OpenAI-compatible).

**2.2** Add a `maxContextChars` field per provider so the router **skips** a
provider whose context window cannot hold the payload rather than discovering it
via a 413. Cerebras's 8,192-token free cap makes this necessary, not optional.

**2.3** Re-order the routes with the measured latency in hand:

```
chat      → cerebras, groq, gemini, mistral        # fast first; both are quick
briefing  → groq, gemini, mistral, cerebras        # big context first
mission   → groq, cerebras, gemini, mistral
trivial   → cerebras, groq                          # new workload class
```

Chat leading with Gemini was a deliberate anti-starvation fix; adding Cerebras
means chat can lead with something *fast* and still not touch Groq's research
allowance. That is strictly better than the current trade.

**2.4** Either populate `DEEPSEEK_API_KEY` or drop the provider from the array.

**2.5** Make the local model real in production, or admit it isn't. Recommended:
keep Ollama as the local-dev net, and set `OLLAMA_URL` to a tunnel **only** if the
desktop is reliably awake. Do not present it as a production fallback otherwise —
that's the trap the current code comments already call out.

---

## 6. Phase 3 — Quota Manager (revised 2026-08-18)

> **Revised after review.** The original draft made "one free API key per agent"
> the architectural assumption — `GROQ_API_KEY_AURELIUS`, `CEREBRAS_API_KEY_RASHA`
> — and used multiple free keys to multiply quota. That bakes a provider-terms
> question (§12.2) into the core design, and it would have to be unpicked when
> BYOK arrives. Build the isolation abstraction instead; per-agent credentials
> then become one way to populate it rather than the thing it is made of.

**3.1 — A credential pool per provider, behind a Quota Manager.**

```
Agent → Workload → Execution Policy → Quota Manager → Provider Router → Model
```

The Quota Manager owns *which credential from which pool* serves a given call,
and the accounting of what each pool has left. The Provider Router keeps what it
does today: order, fallback, retry, trimming.

This gets the same workload isolation without assuming multiple free keys exist,
and BYOK (§9) becomes a pool with one entry rather than a special case threaded
through the router — which is what `inference.js`'s current Groq-only `byokKey`
special case already demonstrates the cost of.

**3.2 — Resolution order** stays as designed, but as a pool query:
`user BYOK key` → `agent-specific credential` → `system credential` → `skip provider`.

### 3.3 — Shipped 2026-08-18 (`b8e47d4`), `services/QuotaManager.js`

- **Credential pools** — `resolveCredentials(provider, {agentId, userKey})`, read from
  `<PROVIDER>_API_KEY_<AGENT>` then `<PROVIDER>_API_KEY`. Empty pool = skip provider.
  Replaced the single hard-coded `(cfg.name === 'groq' && byokKey)` line that was
  the whole of BYOK. `PROVIDERS[].apiKey` and `_usableKey` deleted from
  `inference.js` — credentials no longer live there.
- **Spent-allowance markers** — the router *already* distinguished a per-minute
  throttle from a spent daily allowance, then discarded the verdict, so every
  later call re-probed the dead model until UTC midnight. Now remembered per
  model per credential, capped at the UTC reset, expiring on read.
- **`usageToday()`** — reporting from existing metrics. Deliberately *not* on the
  inference path: a pre-flight quota check means a database read before every
  call, and the router already learns of exhaustion from the provider itself.

**Two findings worth keeping.** Retired-model and spent-allowance exhaustion need
*opposite* handling — all-retired falls back to the configured list (our own
inference from a 400, may be wrong), all-spent skips the provider (the provider
told us directly). The first version reused one fallback for both and re-offered
every exhausted model. And `database` must be required *lazily* inside
`usageToday()`; a top-level require opens a Postgres pool as an import side
effect and hangs the test runner on a handle nobody asked for.

**Not built:** the Execution Policy layer is still notional — budgets come from
`agent_configs` plus callers, which is a proto-policy rather than one. Markers
live in process memory, so Render's spin-down loses them; the cost is one wasted
round-trip per cold start, against a database read on every call.

**3.2 — Per-agent route override** in `runtime_settings`:

```jsonc
"runtime_settings": {
  "providers": ["cerebras", "groq", "gemini"],   // this agent's order
  "model": "openai/gpt-oss-120b",
  "keyslot": "AURELIUS"                          // suffix for the env lookup
}
```

`_providersFor()` gains an `agentId` argument; agent order wins over workload order
when present, and any provider missing from the list is still appended as a last
resort (the existing safety behaviour — a typo must never disable a working key).

**3.3 — Why this genuinely helps.** Groq's allowance is per model **per key** per
day. Two keys = two independent 200k days. Aurelius's crypto research can burn its
own key without touching the key that answers your chat.

**3.4 — Fix the tool-permission mismatch while here.** `listTools()` takes no
`agentId`, so every agent is told it has bash/file_write/file_edit though only
Plato may use them. Agents plan steps they cannot execute, then burn budget failing
them. This is a direct contributor to wasted iterations.

---

## 7. Phase 4 — The fallback ladder (the decision table)

This is the "what happens in every failure case" table you asked for. Each row is
what the router does **next**; it never gives up until the last row.

| # | Failure signal | Interpretation | Action |
|---|---|---|---|
| 1 | HTTP 429, `retry-after` ≤ 120 s, background workload | per-minute throttle | Back off 5/15/30 s, retry **same model** *(built)* |
| 2 | HTTP 429, interactive chat | someone is waiting | **Do not wait.** Next provider immediately *(built)* |
| 3 | HTTP 429, `retry-after` > 120 s | **daily allowance spent** | Skip this model; mark provider spent-until-midnight; next provider *(partly built — add the sticky marker)* |
| 4 | HTTP 413 | payload too large | Trim to 12k, then 4k chars/msg, retry *(built)* |
| 5 | Payload > provider's `maxContextChars` | known too big | **Skip provider before calling** *(new — Phase 2.2)* |
| 6 | HTTP 400/404 + `model_not_found`/`decommissioned` | model retired | Blacklist for process, next model *(built)* |
| 7 | HTTP 5xx | provider wobble | Retry same model 2/6/15 s *(built)* |
| 8 | All models on provider exhausted | provider is out | Next provider in the agent/workload order *(built)* |
| 9 | All providers exhausted, **background** work | genuine outage | Enqueue for retry at next cron tick; do **not** deliver a failure as a report *(built for missions/briefing)* |
| 10 | All providers exhausted, **interactive** chat | genuine outage | Try local Ollama, then answer from RAG/knowledge-graph context **without** a fresh LLM call, labelled as such *(new)* |
| 11 | Local budget ceiling hit mid-run | our own limit, not theirs | Force the synthesis pass with what was gathered; only fail if literally nothing was collected *(built — `CognitiveCore.js:449-461`)* |

Row 10 is the answer to *"there's always a way to get an answer to the user."* Row 3
needs a sticky per-key/per-model "spent until UTC midnight" marker so the same
doomed round-trip isn't paid on every subsequent request of the day.

---

## 8. Phase 5 — Per-agent daily briefings

**5.1 — Restore a mission scheduler.** Missions are dead in the water without one.
Add a second pg_cron job hitting `/api/cron/tick` with `CRON_SECRET`, alongside the
existing `trigger_daily_briefing()`. This is the single blocker on everything in
this phase.

**5.2 — Assign domains by expertise** (matching what you described):

| agent | brief | cadence |
|---|---|---|
| **Aurelius** | Crypto + stocks: what moved, what to watch, entry/exit context | daily (already defined, needs enabling) |
| **Nova** | Tech + research + AI industry | daily *(already live — this is the one that works)* |
| **Rasha** | Jobs + hiring market + opportunities | daily (already defined, needs enabling) |
| **Plato** | Cross-domain synthesis: reads the three above, writes one executive summary | daily, **after** the others |

**5.3 — Stagger the schedule** so four research runs don't collide inside one
Groq minute — e.g. Aurelius 06:00, Nova 06:20, Rasha 06:40, Plato 07:00 IST. Plato's
run then costs almost nothing: it's summarising three finished texts, not
researching from scratch. That is a large net *saving* versus today's single
40k-token Plato mega-run.

**5.4 — Compliance note, and I want to be plain about it.** "Which stocks to invest
in, which cryptocurrency to buy" is personalised investment advice. Build the brief
to report *what happened and why it matters* — moves, catalysts, analyst
positioning, risk factors — and have Aurelius's system prompt refuse
buy/sell recommendations with a standing disclaimer. This is a prompt-level
decision, it costs you nothing in usefulness, and it keeps the product shippable to
other users. I'm flagging it, not blocking it — the brief itself gets built either
way.

---

## 9. Phase 6 — BYOK for new users

The multi-tenant story: FinChat is the harness (tools, memory, graphs, mind maps,
briefings, notification channels); the user brings the fuel.

**6.1 — Storage.** Migration 030, new table:

```sql
CREATE TABLE user_provider_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  provider      text NOT NULL,          -- groq | gemini | cerebras | mistral | openrouter | ollama
  key_ciphertext bytea NOT NULL,        -- AES-256-GCM, key from env MASTER_KEY
  key_last4     text NOT NULL,          -- for display only
  label         text,
  is_active     boolean DEFAULT true,
  last_ok_at    timestamptz,
  last_error    text,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (user_id, provider, label)
);
```

RLS on, matching the other 55 tables. **Encrypted at rest, never logged, never
returned to the client** — the API returns `••••last4` and nothing else.

**6.2 — Resolution order** (extends `resolveKey` from 3.1):

```
user's own key for this provider
  → agent-specific system key
  → shared system key
  → skip provider
```

A user with their own Groq key never touches your allowance. A user without one
falls through to the shared pool, subject to a per-user daily cap so one new
signup cannot drain the day for everyone.

**6.3 — Settings UI.** `finchat_settings.html` already exists and already hosts the
Telegram / WhatsApp / email connection flows — this is the same pattern, a new
"AI Providers" card:
- paste key → **validate with a 1-token live call** → store encrypted → show
  green/red status and `last_ok_at`
- per-provider enable/disable
- an honest "you are using the shared pool — N requests left today" line when no
  key is connected

**6.4 — Extend BYOK beyond Groq.** `inference.js:553` hard-codes BYOK to Groq
(`cfg.name === 'groq' && byokKey`). Generalise to a per-provider lookup. That one
line is the whole current limitation.

---

## 10. Phase 7 — Chat-command reconfiguration

You want users to retune agents by talking to them. Concrete shape:

- `/config <agent>` — show current model, providers, budget, tools, brief topics
- `/brief <agent> <topics…>` — rewrite that agent's mission goal
- `/budget <agent> <small|normal|deep>` — map to preset budget objects
- `/provider <agent> <order…>` — set the provider order
- `/key` — deep-link to the settings card (**never** accept a key typed into chat;
  it lands in the message table in plaintext and in the model's context)

Implement as an intent parsed **before** the message reaches the cognitive loop, so
it costs zero tokens, and write through to `agent_configs.runtime_settings` /
`agent_missions` scoped **per user** (today `agent_configs` is global — see the
existing note that the knowledge graph is not per-user either; the same
multi-tenancy gap applies here and must be closed before this phase ships publicly).

---

## 11. Sequencing

Revised 2026-08-18. The governing principle: **make each run cheaper before
buying more capacity.** Adding providers first would have expanded the compute
available to a system spending 86% of it re-reading its own prompt.

| # | Phase | Status |
|---|---|---|
| 1 | Budget fix | ✅ **done** |
| 2 | ContextBuilder efficiency | ✅ **done** (−20%) |
| 3 | Per-agent tool scoping | ✅ **done** (−37% cumulative) |
| 4 | Provider isolation + Quota Manager (§6) | ✅ **done** (`b8e47d4`) |
| 5 | Cerebras | next — needs a signup |
| 6 | Formal fallback ladder (§7 rows 3, 5, 10) | |
| 7 | Mission scheduler (§8.5.1) | single blocker on all per-agent briefings |
| 8 | Per-agent execution policies | |
| 9 | BYOK (§9) | the multi-tenant unlock |
| 10 | Per-user agent configuration | multi-tenancy gap, must precede a public §10 |
| 11 | Agent briefings + Plato synthesis (§8) | |
| 12 | Chat commands (§10) | |

Both repair phases are done. Everything remaining is capability, not repair.

### 11.1 Where this is heading

The through-line is that an agent should not know where its intelligence comes
from. It says *"I need to perform this task"*; FinChat decides model, provider,
credential, budget, tools, latency target and fallback:

```
                      Plato
                        │
                 Task / Workload
                        │
                Execution Policy
                        │
              ┌─────────┴─────────┐
         Agent Config        Quota Manager
              └─────────┬─────────┘
                        │
                 Provider Router
                        │
        ┌───────────────┼───────────────┐
    DeepSeek          Groq           Gemini
        └───────────────┼───────────────┘
                 Fallback Ladder
                        │
                 Local / RAG fallback
```

Phases 1 and 2 built the budget and context layers of this. Phase 4 builds the
quota layer, and the ladder in §7 is the bottom edge of it.

---

## 12. Open decisions for you

1. **Cerebras + Mistral signup** — both free, both need an account created by you.
   Nothing in Phase 2 can be tested without the keys.
2. **Per-agent Groq keys** — Groq's terms on multiple free keys per person are worth
   a read before we lean on 3.3 as the main allowance multiplier. BYOK (Phase 6) is
   the cleaner long-term answer to the same problem.
3. **Cost ceiling** — everything above is free tier. Confirm you want to stay strictly
   free even at the cost of the 8k context cap on the cheapest bench, or whether a
   one-time $10 on OpenRouter (50 → 1,000 req/day, permanent) is acceptable.
4. **Aurelius's advice posture** — confirm the §5.4 framing before that brief goes
   live.
