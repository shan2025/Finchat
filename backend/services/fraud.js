// services/fraud.js — AI Fraud Detection via Qwen / fallback simulation
const axios = require('axios');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

async function detectFraud(message) {
  try {
    const result = await detectWithQwen(message);
    return { ...result, model: OLLAMA_MODEL };
  } catch {
    const result = detectSimulated(message);
    return { ...result, model: 'simulation' };
  }
}

async function detectWithQwen(message) {
  const prompt = `You are a fraud detection AI for an internal business chat system. Analyze this message strictly.

Message: "${message}"

Respond ONLY with a JSON object (no markdown, no explanation):
{"risk":"HIGH|MEDIUM|LOW","reason":"brief reason under 12 words","indicators":["flag1","flag2"]}

HIGH = scams, phishing, credential theft, financial manipulation, threats, harmful content
MEDIUM = suspicious language, unusual requests, borderline content
LOW = normal business communication`;

  const response = await axios.post(
    `${OLLAMA_URL}/api/generate`,
    { model: OLLAMA_MODEL, prompt, stream: false },
    { timeout: 15000 }
  );

  const raw = response.data.response.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

function detectSimulated(message) {
  const m = message.toLowerCase();

  const highPatterns = [
    { p: /send.*money|wire transfer|western union|urgent.*pay/i, r: 'Money transfer fraud pattern' },
    { p: /click.*link|verify.*account.*http|password.*reset.*urgent/i, r: 'Phishing link directive' },
    { p: /your password|credit card number|ssn|bank account.*number/i, r: 'Credential harvesting attempt' },
    { p: /prince|lottery|won.*prize|claim.*inheritance/i, r: 'Advance-fee fraud pattern' },
    { p: /act now|expires in|last chance|immediately transfer/i, r: 'Artificial urgency manipulation' },
  ];

  const medPatterns = [
    { p: /personal.*address|where.*do.*you.*live|phone number/i, r: 'Personal info extraction attempt' },
    { p: /guaranteed.*return|no risk investment|100% profit/i, r: 'Misleading financial claims' },
    { p: /don't tell anyone|keep.*secret|between us only/i, r: 'Secrecy/deception pattern' },
  ];

  for (const { p, r } of highPatterns) {
    if (p.test(m)) return { risk: 'HIGH', reason: r, indicators: ['Pattern matched', 'Policy violation'] };
  }
  for (const { p, r } of medPatterns) {
    if (p.test(m)) return { risk: 'MEDIUM', reason: r, indicators: ['Suspicious language', 'Flagged for review'] };
  }

  return { risk: 'LOW', reason: 'No fraud indicators detected', indicators: ['Message appears compliant'] };
}

// Token penalty per risk level
function getPenalty(risk) {
  return { HIGH: 20, MEDIUM: 10, LOW: 0 }[risk] || 0;
}

module.exports = { detectFraud, getPenalty };
