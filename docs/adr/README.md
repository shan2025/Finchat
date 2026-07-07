# Architecture Decision Records (ADRs)

This directory contains the Architecture Decision Records (ADRs) for the FinChat Platform. Each ADR documents a key technical decision, its context, the options considered, the final decision, and the consequences.

## Index of ADRs

| ID | Title | Date | Status |
|----|-------|------|--------|
| [ADR-0001](0001-use-fastapi-for-backend-services.md) | FastAPI instead of Django or Node.js/Express | 2026-07-03 | Accepted |
| [ADR-0002](0002-use-postgresql-for-relational-data.md) | PostgreSQL instead of MongoDB | 2026-07-03 | Accepted |
| [ADR-0003](0003-use-ipfs-and-blockchain-anchoring.md) | IPFS + Blockchain Anchors instead of On-Chain Storage | 2026-07-03 | Accepted |

## Creating a New ADR

To create a new ADR, copy the template below and save it as `docs/adr/XXXX-title-in-kebab-case.md`, where `XXXX` is the next sequential number.

```markdown
# ADR-XXXX: [Short Title of the Decision]

- **Status**: [Proposed | Accepted | Rejected | Deprecated | Superseded]
- **Date**: YYYY-MM-DD
- **Deciders**: [Name or Role]
- **Technical Domain**: [Backend | Database | Security | Blockchain | AI Orchestration]

## Context and Problem Statement
[What is the context? What problem are we trying to solve? Include constraints and requirements.]

## Decision Drivers
- [Driver 1]
- [Driver 2]

## Considered Options
1. [Option 1]
2. [Option 2]

## Decision Outcome
Chosen Option: [Option X], because [justification].

### Consequences
- **Positive**: [What becomes easier or better?]
- **Negative**: [What becomes harder? What compromises were made?]
- **Risks**: [Are there any operational risks or dependencies introduced?]
```
