// scripts/benchmark_fraud.js — Systematic evaluation of fraud detection metrics
const { detectFraud } = require('../services/fraud');

const dataset = [
    // ── FRAUD SAMPLES (Label: 1) ────────────────────────────────
    { message: "URGENT: Your account has been compromised. Click http://bit.ly/secure-login to verify.", label: 1 },
    { message: "Hey, can you send me $500 via wire transfer? Need it for a project deposit immediately.", label: 1 },
    { message: "You have won the corporate lottery! Please reply with your SSN and bank details to claim.", label: 1 },
    { message: "This is HR. We need your password to update the payroll system. Please send it now.", label: 1 },
    { message: "I'm stuck at the airport, please transfer funds via Western Union for my ticket.", label: 1 },
    { message: "New internal policy: all staff must verify their credentials at http://finchat-hr.net/verify", label: 1 },
    { message: "Congratulations! You have been selected for a 100% guaranteed return investment. Reply YES.", label: 1 },
    { message: "We found a suspicious transaction in your wallet. Verify at http://identity-check.io", label: 1 },
    { message: "Urgent meeting room changed. Download the new agenda: http://file-host.com/agenda.exe", label: 1 },
    { message: "Hey, it's the CEO. I need you to buy 5 iTunes gift cards for a client and send codes.", label: 1 },

    // ── BENIGN SAMPLES (Label: 0) ────────────────────────────────
    { message: "Hey team, let's meet at 10 AM for the architectural review.", label: 0 },
    { message: "Can you review the pull request for the new authentication module?", label: 0 },
    { message: "The server deployment was successful. All services are healthy.", label: 0 },
    { message: "Does anyone want to go for lunch at the cafeteria today?", label: 0 },
    { message: "The quarterly report is attached to the email. Please check and provide feedback.", label: 0 },
    { message: "Happy Birthday to Sona! There's cake in the breakroom.", label: 0 },
    { message: "I'll be out of the office tomorrow for a doctor's appointment.", label: 0 },
    { message: "The database migration script is ready to run on staging.", label: 0 },
    { message: "Thanks for the swift response on the bug fix.", label: 0 },
    { message: "Can we schedule a call to discuss the new feature roadmap for Q3?", label: 0 }
];

async function runBenchmark() {
    console.log('📊 Starting FinChat Fraud Detection Benchmark...\n');
    console.log('Running 20 tests (10 Fraud, 10 Benign)...\n');

    let tp = 0, fp = 0, tn = 0, fn = 0;
    const start = Date.now();

    for (let i = 0; i < dataset.length; i++) {
        const { message, label } = dataset[i];
        process.stdout.write(`Test ${i + 1}/20... `);

        try {
            const result = await detectFraud(message);
            const isFraud = (result.risk === 'HIGH' || result.risk === 'MEDIUM');

            if (label === 1) { // Positive Case
                if (isFraud) {
                    tp++;
                    console.log('✅ Correct (TP)');
                } else {
                    fn++;
                    console.log('❌ Missed (FN)');
                }
            } else { // Negative Case
                if (isFraud) {
                    fp++;
                    console.log('❌ False Alarm (FP)');
                } else {
                    tn++;
                    console.log('✅ Correct (TN)');
                }
            }
        } catch (err) {
            console.log(`❌ Error: ${err.message}`);
        }
    }

    const duration = (Date.now() - start) / 1000;
    const accuracy = (tp + tn) / dataset.length;
    const precision = tp / (tp + fp) || 0;
    const recall = tp / (tp + fn) || 0;
    const f1 = 2 * (precision * recall) / (precision + recall) || 0;
    const fpr = fp / (fp + tn) || 0;

    console.log('\n================================================');
    console.log('🏁 Benchmark Results');
    console.log('================================================');
    console.log(`Model Path:     Qwen 2.5 3B (via Ollama)`);
    console.log(`Total Samples:  ${dataset.length}`);
    console.log(`Duration:       ${duration.toFixed(2)}s (${(duration / dataset.length).toFixed(2)}s/msg)`);
    console.log('------------------------------------------------');
    console.log(`Accuracy:       ${(accuracy * 100).toFixed(1)}%`);
    console.log(`Precision:      ${(precision * 100).toFixed(1)}%`);
    console.log(`Recall:         ${(recall * 100).toFixed(1)}%`);
    console.log(`F1-Score:       ${(f1 * 100).toFixed(1)}%`);
    console.log(`False Pos Rate: ${(fpr * 100).toFixed(1)}%`);
    console.log('================================================');
    console.log('\nPROPOSED IEEE DOCUMENTATION:');
    console.log(`"The AI fraud detection system using Qwen 2.5 3B achieves a Precision of ${(precision * 100).toFixed(1)}%, a Recall of ${(recall * 100).toFixed(1)}%, and a False Positive Rate of ${(fpr * 100).toFixed(1)}% on a balanced benchmark of internal chat scenarios."`);

    process.exit(0);
}

runBenchmark().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
