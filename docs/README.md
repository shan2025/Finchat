# FinChat Platform Engineering Documentation

Welcome to the FinChat Platform Engineering Repository. This directory serves as the single source of truth for the system architecture, design specifications, and architectural decision records (ADRs) of the FinChat Platform.

## Documentation Index

> **Read the "current" documents first.** The SAD and ADR-0001 describe an intended
> architecture that was never built; they are kept as history, not as description.

### 0. [CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md) — **what actually runs**
Descriptive record of the system as deployed: Node/Express, PostgreSQL + pgvector on
Supabase, Redis/BullMQ, static HTML frontend, Render hosting. Start here.

### 0b. [SECURITY_FOUNDATION_GAP_ANALYSIS.md](SECURITY_FOUNDATION_GAP_ANALYSIS.md)
Agent-security posture checked line by line against the code: what is already enforced
(execution boundary, tool permissions, approval gate, state machine) and the real
remaining gaps, in priority order.

### 1. [System Architecture Document (SAD)](system_architecture_document.md) — ⚠ TARGET, NOT BUILT
Intended future blueprint. Describes FastAPI, React, Qdrant and Kubernetes, none of which
are in use. Its "Approvals" table is generated boilerplate and records no real sign-off.

### 2. [Architecture Decision Records (ADRs)](adr/README.md)
A historical record of significant architectural decisions. Each now carries an
implementation status banner.

- **[ADR-0001: FastAPI Framework Selection](adr/0001-use-fastapi-for-backend-services.md)** — ⚠ **never implemented**; the backend is Node/Express.
- **[ADR-0002: PostgreSQL Database Selection](adr/0002-use-postgresql-for-relational-data.md)** — ✅ implemented (with pgvector, not a separate vector DB).
- **[ADR-0003: IPFS with Blockchain Anchors](adr/0003-use-ipfs-and-blockchain-anchoring.md)** — ✅ implemented on Solana devnet; audit-evidence layer only.

---

## Roadmap Tracker

```text
┌──────────────────────────────────────────────┐
│  1. System Architecture Document (SAD)       │ ◄ CURRENT STEP
├──────────────────────────────────────────────┤
│  2. Technical Architecture Document (TAD)    │
├──────────────────────────────────────────────┤
│  3. Database Design Document (DDD)           │
├──────────────────────────────────────────────┤
│  4. API Design Specification                 │
├──────────────────────────────────────────────┤
│  5. Memory Architecture Specification        │
├──────────────────────────────────────────────┤
│  6. Blockchain Architecture                  │
├──────────────────────────────────────────────┤
│  7. Infrastructure Architecture              │
├──────────────────────────────────────────────┤
│  8. Security Architecture                    │
├──────────────────────────────────────────────┤
│  9. DevOps Architecture                      │
├──────────────────────────────────────────────┤
│ 10. Sprint Planning                          │
└──────────────────────────────────────────────┘
```
