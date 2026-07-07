// services/aiChat.js — Qwen persona chat with hidden fraud detection
const axios = require('axios');
const { getPersona } = require('./personas');
const { getSystemSnapshot } = require('./systemState');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const FRAUD_TAG = '[FRAUD_DETECTED]';

// EXTREME fraud patterns — direct credential theft, wire fraud, impersonation
// Penalty: ALL tokens removed
const EXTREME_PATTERNS = [
    /send.*otp|share.*otp|give.*otp/i,
    /credit.*card|cvv|pin.*number/i,
    /your.*password|your.*ssn|your.*aadhaar/i,
    /wire.*transfer|western.*union|urgent.*pay/i,
    /send.*money.*urgent|transfer.*immediately/i,
    /bank.*account.*number|account.*details/i,
    /impersonat|pretend.*to.*be/i,
    /phishing|malware|ransom/i
];

// HIGH fraud patterns — suspicious but less severe
// Penalty: 20 tokens
const HIGH_PATTERNS = [
    /click.*link|verify.*http|password.*reset/i,
    /won.*lottery|claim.*prize|inheritance/i,
    /don'?t.*tell.*anyone|keep.*secret/i,
    /guaranteed.*return|no.*risk.*invest|100%.*profit/i
];

const FRAUD_PATTERNS = [...EXTREME_PATTERNS, ...HIGH_PATTERNS];

function matchesFraudPattern(message) {
    return FRAUD_PATTERNS.some(p => p.test(message));
}

/**
 * Classify fraud severity: 'EXTREME' or 'HIGH'
 * EXTREME = credential theft, wire fraud, impersonation → all tokens removed
 * HIGH = general suspicious activity → 20 token penalty
 */
function classifyFraudSeverity(message) {
    if (EXTREME_PATTERNS.some(p => p.test(message))) return 'EXTREME';
    if (HIGH_PATTERNS.some(p => p.test(message))) return 'HIGH';
    return 'HIGH'; // default if flagged by AI but no pattern match
}

/**
 * Send a message to Qwen as a specific persona.
 * Returns { response, fraudDetected, cleanResponse }
 *
 * @param {string} personaId - e.g. 'susheel', 'sona', 'vishnu'
 * @param {string} userMessage - the user's message
 * @param {Array}  history - previous messages [{role:'user'|'assistant', content:'...'}]
 */
async function chatWithPersona(personaId, userMessage, history = []) {
    const persona = getPersona(personaId);
    if (!persona) throw new Error(`Unknown persona: ${personaId}`);

    // Build conversation messages for Ollama chat API
    // For Plato: inject live system state so it's always up-to-date
    let systemContent = persona.systemPrompt;
    if (personaId === 'plato') {
        try {
            const snapshot = await getSystemSnapshot();
            systemContent = persona.systemPrompt + '\n\n' + snapshot;
        } catch (err) {
            console.error('Failed to get system snapshot for Plato:', err.message);
        }
    }

    const messages = [
        { role: 'system', content: systemContent },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: userMessage }
    ];

    let attempts = 0;
    const maxRetries = 3;

    while (attempts < maxRetries) {
        try {
            const response = await axios.post(
                `${OLLAMA_URL}/api/chat`,
                {
                    model: OLLAMA_MODEL,
                    messages,
                    stream: false,
                    options: {
                        temperature: 0.7,
                        top_p: 0.9,
                        num_predict: 150
                    }
                },
                { timeout: 300000 }
            );

            const rawResponse = response.data.message?.content || '';
            return parseResponse(rawResponse, userMessage);

        } catch (err) {
            attempts++;
            const status = err.response?.status;
            const code = err.code;
            console.error(`❌ Qwen chat error (attempt ${attempts}/${maxRetries}):`, {
                message: err.message,
                status: status || 'N/A',
                code: code || 'N/A',
                url: `${OLLAMA_URL}/api/chat`,
                model: OLLAMA_MODEL
            });

            if (status === 404) {
                console.warn(`⚠️ Model '${OLLAMA_MODEL}' not found! Please run: ollama pull ${OLLAMA_MODEL}`);
                // Don't retry 404s, fail immediately to simulation
                return simulateResponse(persona, userMessage);
            }

            if (attempts >= maxRetries) {
                // If all retries fail, fall back to simulation
                console.warn('⚠️ All AI retries failed. Falling back to simulation.');
                return simulateResponse(persona, userMessage);
            }

            // Wait before retrying (1s, 2s, 4s...)
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempts - 1)));
        }
    }
}

/**
 * Parse Qwen's response, detect and strip [FRAUD_DETECTED] tag.
 * Includes false-positive suppression: if Qwen flags fraud but the
 * user message doesn't match any known fraud pattern, suppress the flag.
 */
function parseResponse(rawResponse, userMessage = '') {
    let fraudDetected = rawResponse.includes(FRAUD_TAG);
    // Hard filter for the persistent boilerplate
    const BOILERPLATE_REGEX = /\[IF YOU NEED ANY BANKING HELP OR HAVE ANY QUESTIONS, FEEL FREE TO ASK!\]/gi;
    let cleanResponse = rawResponse
        .replace(FRAUD_TAG, '')
        .replace(BOILERPLATE_REGEX, '')
        .trim();

    // Safety Net: If the user message matches a known high-risk pattern,
    // force fraudDetected = true even if the AI forgot the tag.
    if (!fraudDetected && matchesFraudPattern(userMessage)) {
        console.log(`🛡️ Fraud safety net triggered: "${userMessage.substring(0, 60)}"`);
        fraudDetected = true;
    }

    // False-positive suppression: double-check against known patterns
    // If AI flagged it but it DOES NOT match any pattern, suppress it
    if (fraudDetected && !matchesFraudPattern(userMessage)) {
        console.log(`⚠️ Fraud flag suppressed (false positive): "${userMessage.substring(0, 60)}"`);
        fraudDetected = false;
    }

    return {
        response: rawResponse,
        fraudDetected,
        cleanResponse
    };
}

/**
 * Fallback simulation when Ollama is unavailable
 */
function simulateResponse(persona, userMessage) {
    const msg = userMessage.toLowerCase();

    // Check for fraud patterns
    const fraudPatterns = [
        /send.*otp|share.*otp|give.*otp/i,
        /bank.*account.*number|account.*details/i,
        /credit.*card|cvv|pin.*number/i,
        /click.*link|verify.*http|password.*reset/i,
        /wire.*transfer|western.*union|urgent.*pay/i,
        /won.*lottery|claim.*prize|inheritance/i,
        /send.*money.*urgent|transfer.*immediately/i,
        /don'?t.*tell.*anyone|keep.*secret/i,
        /guaranteed.*return|no.*risk.*invest|100%.*profit/i,
        /your.*password|your.*ssn|your.*aadhaar/i
    ];

    const isFraud = fraudPatterns.some(p => p.test(msg));

    const normalResponses = [
        `Hey! That's interesting. Tell me more about it! 😊`,
        `Hmm, I see what you mean. What do you think about it?`,
        `That's a good point! I was actually thinking about something similar.`,
        `Oh nice! How's everything going on your end?`,
        `Ha, that's cool! Anything else on your mind?`
    ];

    const cleanResponse = isFraud
        ? `Hmm, I'm not sure about that. That sounds a bit unusual to me. Maybe you should check with the compliance team? 🤔`
        : normalResponses[Math.floor(Math.random() * normalResponses.length)];

    return {
        response: isFraud ? cleanResponse + '\n' + FRAUD_TAG : cleanResponse,
        fraudDetected: isFraud,
        cleanResponse
    };
}

module.exports = { chatWithPersona, FRAUD_TAG, classifyFraudSeverity };
