# FinChat Platform Engineering Documentation

Welcome to the FinChat Platform Engineering Repository. This directory serves as the single source of truth for the system architecture, design specifications, and architectural decision records (ADRs) of the FinChat Platform.

## Documentation Index

### 1. [System Architecture Document (SAD)](system_architecture_document.md)
The master engineering blueprint of the FinChat Platform. It defines the overall layered architecture, service decomposition, data flows, deployment topology, trust boundaries, and scalability/resiliency strategies.

### 2. [Architecture Decision Records (ADRs)](adr/README.md)
A historical record of all significant architectural decisions made during the design and engineering of the FinChat Platform.

- **[ADR-0001: FastAPI Framework Selection](adr/0001-use-fastapi-for-backend-services.md)** — Explains the choice of FastAPI over Django/Express for production backend services.
- **[ADR-0002: PostgreSQL Database Selection](adr/0002-use-postgresql-for-relational-data.md)** — Explains why PostgreSQL is used instead of MongoDB for relational data and audit compliance.
- **[ADR-0003: IPFS with Blockchain Anchors](adr/0003-use-ipfs-and-blockchain-anchoring.md)** — Explains the hybrid storage approach using IPFS and Solana anchors for privacy, scale, and GDPR compliance.

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
