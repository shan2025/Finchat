# ADR-0003: IPFS with Blockchain Anchors

> ✅ **IMPLEMENTED.** Hash chain in `services/proof.js`, IPFS pinning via Pinata in
> `services/ipfs.js`, Solana anchoring in `services/solana.js` (devnet, not mainnet).
> Note this is an audit-evidence layer only — it is not on the authorization path.

- **Status**: Accepted — implemented (devnet)
- **Date**: 2026-07-03
- **Deciders**: Platform Architecture Team
- **Technical Domain**: Decentralized Storage & Audit Trail

## Context and Problem Statement
The FinChat platform requires a tamper-proof audit trail for conversations, system-agent decisions, and governance votes to ensure absolute compliance and post-incident forensic capacity.

Storing all chat messages and attachments directly on a public or private blockchain is cost-prohibitive, presents severe scalability bottlenecks, and directly violates data privacy regulations such as GDPR and DPDP (which mandate the "Right to be Forgotten" or data deletion). Conversely, storing these logs solely in a traditional central database (like PostgreSQL) does not provide cryptographic trust and tamper-evidence needed for decentralized governance. We need a hybrid approach.

## Decision Drivers
- **Data Privacy & Compliance**: Compliance with GDPR/DPDP, allowing deletion of sensitive information (PII) if required.
- **Cryptographic Trust**: Proof of data integrity and chronological order that cannot be tampered with, even by system administrators.
- **Cost & Scalability**: Storing massive amounts of messaging data and file attachments must be economically viable.
- **Auditability**: Auditors must be able to independently verify that a log has not been altered or deleted.

## Considered Options
1. **Pure On-Chain Storage**: Store all message content and attachments directly on the Solana blockchain.
2. **Pure Centralized Storage**: Store everything in PostgreSQL/S3. Use standard encryption and backup.
3. **IPFS + Blockchain Anchors (Hybrid)**: Store complete message logs and attachments in IPFS (InterPlanetary File System), encrypting sensitive fields. Calculate cryptographic hashes of these logs, chain them together (hash-chaining), and anchor only the root hashes (or periodic checkpoint hashes) onto the Solana blockchain.

## Decision Outcome
Chosen Option: **IPFS + Blockchain Anchors (Hybrid)**. The detailed, content-addressable storage is offloaded to IPFS (and pinned via services like Pinata), while a secure, immutable cryptographic hash of the data (the "anchor") is posted to the Solana blockchain. 

### Consequences
- **Positive**:
  - **GDPR/DPDP Compliance**: Message content stored on IPFS can be encrypted with a user-specific key. If a user requests deletion, deleting the decryption key renders the IPFS data permanently unreadable (cryptographic erasure), satisfying the Right to be Forgotten, while the hash anchor on-chain remains intact without violating privacy.
  - **Low On-Chain Cost**: Anchoring only periodic block hashes or roots (e.g., via Merkle trees) minimizes transaction fees and gas costs.
  - **Tamper Evidence**: If anyone alters a historical message in IPFS or PostgreSQL, the resulting file hash will change, causing a verification failure against the immutable blockchain anchor.
- **Negative**:
  - **Increased Latency**: Anchoring transactions on Solana introduces transaction execution latency (though block times are ~400ms).
  - **Pinning Management**: Requires active maintenance of an IPFS pinning service to guarantee data availability.
- **Risks**:
  - Dependent on Solana network availability and transaction fee stability.
  - Key management for encrypted IPFS payloads becomes critical; if a key is lost, the audit trail cannot be decrypted by auditors.
