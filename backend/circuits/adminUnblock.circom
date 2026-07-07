// Admin Unblock ZKP Circuit — Groth16
// Proves: "I know a secret nonce such that Poseidon(adminId, userId, action, nonce, timestamp) == commitment"
// Private: nonce
// Public:  adminId, userId, action, timestamp, commitment

pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";

template AdminUnblock() {
    // Public inputs
    signal input adminId;
    signal input userId;
    signal input action;
    signal input timestamp;
    signal input commitment;

    // Private input (witness) — only the admin knows this
    signal input nonce;

    // Hash all inputs using Poseidon (ZKP-friendly hash)
    component hasher = Poseidon(5);
    hasher.inputs[0] <== adminId;
    hasher.inputs[1] <== userId;
    hasher.inputs[2] <== action;
    hasher.inputs[3] <== nonce;
    hasher.inputs[4] <== timestamp;

    // Constraint: the hash must equal the commitment
    commitment === hasher.out;
}

component main {public [adminId, userId, action, timestamp, commitment]} = AdminUnblock();
