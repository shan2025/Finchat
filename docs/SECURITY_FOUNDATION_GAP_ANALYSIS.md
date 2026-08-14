# FinChat — Agent Security Foundation: Gap Analysis

**Date:** 2026-08-13
**Method:** the 30-item P0/P1/P2 list was checked line by line against the code in
`finchat/legacy_prototype/backend`. Every "already built" claim below cites a file and
line. Nothing here is inferred from the sprint docs — those over-claim.

---

## Executive summary

The pasted roadmap was written without access to the codebase, and it is wrong in two
directions at once:

1. **It asks you to build things you already have.** The execution boundary, tool
   permissions, rate limits, the human-approval gate, the task state machine and
   structured tool audit logging are all implemented and wired.
2. **It under-prioritises the one thing that is genuinely dangerous today.** `BashTool`
   executes arbitrary shell commands on the host with no sandbox. The roadmap files
   sandboxing under P2 / Phase 2. It is the single highest-severity item you have and
   belongs at the top of P0.

Net effect: the real remaining work is roughly a third of that list, and the ordering
should change.

---

## Already built — do not rebuild

| Roadmap item | Status | Evidence |
|---|---|---|
| **#1** Agents must not execute tools directly | **Built** | `CognitiveCore.js:4` imports only `executeTool`; the sole tool call sites are `CognitiveCore.js:329` and `:407`. Agents never touch a tool implementation. |
| **#2** Tool permissions first-class | **Built** | `ToolManager.checkPermission(agentId, toolName)` at `ToolManager.js:61`, backed by migration `1720000000005_tools-and-permissions.js`. |
| **#6** Authoritative task state | **Built** | `StateMachine.js` exports `STATES`, `IllegalTransitionError`, `stateMachineEvents`. Illegal transitions throw rather than being accepted from the model. |
| **#7** One execution boundary | **Built** | `executeTool()` at `ToolManager.js:131` is the only path: permission → rate limit → approval gate → cache → `impl.execute()` → result log. |
| **#12** Scoped human approval (not approve-everything) | **Built** | `requires_approval` manifest flag + `ApprovalRequiredError` (`ToolManager.js:34-41, 142-143`); the Core parks the execution in `WAITING(human_approval)` and notifies. |
| **#22** Audit ≠ `console.log` | **Built** | `logToolCall()` `:211` and `logToolResult()` `:239` write structured rows (call id, execution id, agent id, tool, input, status, output, error, cached, duration) to Postgres. |
| **#25** Execution budgets | **Partly built** | `ExecutionManager` exposes `checkBudget` / `incrementUsage`; migration `…007_agent-token-budgets.js`. Token budget only — see gaps. |
| **#8** Execution trace | **Partly built** | `CognitiveCore.logPhase(executionId, phase, stepNumber, content, startedAt)` + `execution_logs.phase` gives a replayable per-step record. Missing: memory reads/writes and agent-to-agent messages are not in the same trace. |
| **#21** Postgres vs Redis split | **Mostly correct** | Durable state (executions, tool calls, permissions, memories) is in Postgres; Redis holds cache + BullMQ queues. Verify no security decision is Redis-only before calling this done. |

---

## Real gaps, in the order I would fix them

### P0-1 — `BashTool` runs unsandboxed on the host  🔴 **highest severity**

`tools/BashTool.js:2` uses `child_process.exec` directly. The only control is a 30s
timeout and a 10MB buffer (`:30`). There is no command allowlist, no working-directory
restriction, no network policy, no user separation, no filesystem confinement.

Paired with `FileWriteTool`, `FileEditTool` and `FileReadTool` — all of which also
operate on the real filesystem — any agent granted these tools has, in effect, host
shell access. A prompt injection landing in `CrawlTool` or `FetchTool` output that
persuades the model to emit a `bash` action is a full host compromise, and your
permission layer will happily allow it if the agent's row permits `bash`.

**Fix order:** (a) immediately revoke `bash` / file-write tools from every agent except
an explicit admin one; (b) mark them `requires_approval`; (c) then containerise.
(a) and (b) are configuration changes you can make today.

### P0-2 — Tool output is not marked untrusted (roadmap #16, #17)

Tool results are returned from `executeTool()` and concatenated into the next prompt by
`ContextBuilder` with no provenance envelope. `CrawlTool`, `FetchTool`, `RedditTool`,
`QuoraTool` and `PaperTool` all return third-party text. There is no structural
boundary between SYSTEM / USER / TOOL / WEB / MEMORY content.

This is the classic indirect-injection surface, and it is wide open.

### P0-3 — No risk tiers, only a boolean (roadmap #11)

`requires_approval` is binary. There is no LOW / MEDIUM / HIGH / CRITICAL classification,
so you cannot express "auto-allow reads, policy-check writes, human-approve external
sends". Everything is either free or blocking. Add a `risk_level` column to the tool
registry and drive the gate from it.

### P0-4 — Memory has no access control or provenance (roadmap #4, #13, #14, #15)

`MemoryService` / `MemoryEngine` expose store/retrieve across agents. Memories carry no
owner, classification, trust score or source authority, so "the user claimed X" and "the
IAM system asserts X" are indistinguishable at retrieval time. Combined with the
`dream()` consolidation loop, a poisoned memory becomes persistent, trusted context.

### P0-5 — Agent-to-agent messages are unauthorised (roadmap #5)

`DebateOrchestrator.js:133` and `PlatoOrchestrator.js:92` call `agent.execute({...})`
directly. There is no sender/receiver authorisation, no delegation scope, no data
classification on the message. An agent's request to another agent is trusted purely
because it originated inside the process.

### P1-6 — Budgets are token-only (roadmap #25)

`checkBudget` covers tokens. There is no wall-clock budget, tool-call-count budget,
network budget or cost budget, so a looping agent burns time and API quota without
tripping anything. Related: no `max_depth` / `max_children` on delegation (#26).

### P1-7 — No kill switch (roadmap #27)

There is `sweepStaleExecutions` on boot, but no operator action to stop a running
execution, revoke a tool mid-flight, or disable an agent without a restart.

### P1-8 — Trace is incomplete (roadmap #8)

Extend `logPhase` to cover memory reads/writes and inter-agent messages so
"show me everything that happened in execution N" is genuinely complete.

---

## Items I would drop or defer

- **#20 "rewrite the Express architecture"** — the layering the roadmap asks for
  (API → task → agent runtime → execution → tools) is already how the code is arranged.
  Routes are thin; agent behaviour lives in `services/cognitive` and `services/agents`.
  This is a non-issue.
- **#29 "blockchain should not be the first security layer"** — agreed, and it already
  isn't. The proof chain / IPFS / Solana anchoring is an audit-evidence layer sitting
  beside the app, not an authorization path. No change needed.
- **#3 agent identity** — `agent_id` already threads through `executeTool`, tool logs and
  budgets. What is missing is not identity but *scoping* (task-scoped, time-limited
  grants), which is really part of P0-3.

---

## Corrected sequence

```
P0  1. Revoke + gate bash/file tools, then sandbox them
    2. Tool-output provenance envelope (untrusted-content boundary)
    3. Risk tiers on the tool registry, gate driven by risk
    4. Memory ACL + provenance
    5. Agent-to-agent authorisation

P1  6. Full execution budgets (time, calls, cost, depth)
    7. Kill switch (stop execution / revoke tool / disable agent)
    8. Complete the execution trace

P2  9. Policy engine as a separate deterministic component
   10. Security monitor / anomaly detection
   11. Tamper-evident audit (this is where your existing proof chain earns its place)
```

The framing in the pasted note is right — never make the LLM the security boundary — and
FinChat mostly already honours it. The exception is `BashTool`, where the model's output
reaches `child_process.exec` with only a permission row in between. Close that first.
