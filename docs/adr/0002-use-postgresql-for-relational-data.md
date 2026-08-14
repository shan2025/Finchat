# ADR-0002: PostgreSQL Database Selection

> ✅ **IMPLEMENTED.** PostgreSQL is live on Supabase, with pgvector serving the vector
> workload (this ADR's companion choice of a separate vector DB was not taken —
> see [CURRENT_ARCHITECTURE.md](../CURRENT_ARCHITECTURE.md)).

- **Status**: Accepted — implemented
- **Date**: 2026-07-03
- **Deciders**: Platform Architecture Team
- **Technical Domain**: Relational Database & Audit Trail

## Context and Problem Statement
The FinChat platform handles sensitive financial messaging, token transactions, audit trails, and agent configurations. We require a database system that guarantees absolute data integrity, supports complex relationships (users, sessions, messages, wallets, agent runs), and enforces strict governance policies.

While the prototype uses SQLite for local simplicity, we must select a production-grade database. The primary contenders are a NoSQL document database (MongoDB) and a relational database (PostgreSQL).

## Decision Drivers
- **Data Integrity and Consistency**: Strict compliance with ACID transactions, especially for token management and budget allocation.
- **Relational Complexity**: Interconnected entities (e.g., Users, Roles, Budgets, Conversations, Messages, Cryptographic Proofs) need clean relationships and foreign key integrity.
- **Audit & Governance Compliance**: Relational databases excel at maintaining rigid history tables and audit trails that are tamper-evident.
- **Extensibility**: Support for vector indexes (for memory search) and JSON/Document formats (for dynamic agent configurations).

## Considered Options
1. **MongoDB (NoSQL Document)**: Highly scalable, schema-less, and easy to store dynamic message objects. Lacks robust relational validation and is less suited for transactional token ledgers.
2. **PostgreSQL (RDBMS)**: The industry-standard open-source relational database. High reliability, advanced JSONB support, transactional integrity, and strong extension support (like `pgvector`).

## Decision Outcome
Chosen Option: **PostgreSQL**, because of its enterprise-grade transactional consistency (ACID), strong relational enforcement, and robust auditing support, coupled with the versatility of storing dynamic payloads using JSONB and performing vector searches using the `pgvector` extension.

### Consequences
- **Positive**:
  - **ACID Guarantees**: Prevents race conditions during token transactions, budget deductions, and audit logging.
  - **Relational Integrity**: Foreign keys ensure that orphaned data (e.g., messages without a conversation or budgets without a user) is impossible.
  - **Hybrid Data Models**: PostgreSQL's `JSONB` columns allow us to store semi-structured, dynamic agent state or metadata while keeping the core relational schemas intact.
  - **pgvector Integration**: Enables semantic memory searches directly inside the relational database, avoiding the complexity of sync pipelines to separate vector databases if we choose to consolidate.
- **Negative**:
  - **Schema Migrations**: Schema alterations require carefully planned migrations (e.g., using Alembic) as the platform scales.
  - **Write Scaling**: Harder to scale horizontally for raw write performance compared to NoSQL, but mitigated by connection pooling (PgBouncer), read replicas, and caching (Redis).
- **Risks**:
  - Requires database maintenance (vacuuming, indexing) to ensure consistent performance under high write load.
