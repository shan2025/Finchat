// services/transcribe.js — speech to text for the voice buttons (board and
// mind map "Ask AI", and anywhere else that wants dictation).
//
// Groq's hosted Whisper, on the system Groq key. Server-side rather than the
// browser's SpeechRecognition on purpose: that API is missing in Firefox and in
// the desktop app's embedded browser, and in Chrome it ships audio to Google
// anyway. Whisper also detects the language itself, so Malayalam, Hindi and
// Arabic come back as written text, not as a guess in English.
const MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_BYTES = 10 * 1024 * 1024;   // ~10 minutes of Opus; the UI stops at 2

class TranscribeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** @returns {Promise<string>} the words, trimmed; '' when nothing was said */
async function transcribe({ buffer, mimetype, originalname }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new TranscribeError(503, 'Voice input is not set up on this server');
  if (!buffer || !buffer.length) throw new TranscribeError(400, 'No audio received');
  if (buffer.length > MAX_BYTES) throw new TranscribeError(413, 'That recording is too long — keep it under two minutes');
  const type = String(mimetype || 'audio/webm').split(';')[0];
  if (!type.startsWith('audio/') && type !== 'video/webm') throw new TranscribeError(400, 'That is not an audio recording');

  const form = new FormData();
  // Whisper infers the format from the file name, so the extension must match.
  const ext = /ogg/.test(type) ? 'ogg' : /mp4|m4a|aac/.test(type) ? 'm4a' : /mpeg|mp3/.test(type) ? 'mp3' : /wav/.test(type) ? 'wav' : 'webm';
  form.append('file', new Blob([buffer], { type }), (originalname && /\.\w+$/.test(originalname)) ? originalname : `voice.${ext}`);
  form.append('model', MODEL);
  form.append('response_format', 'json');
  form.append('temperature', '0');

  let res;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(45000) });
  } catch (e) {
    throw new TranscribeError(503, 'Could not reach the speech service — try again');
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 429) throw new TranscribeError(503, 'Voice is busy right now — try again in a minute, or type it');
  if (!res.ok) {
    console.warn(`⚠️ Whisper ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    throw new TranscribeError(502, 'Could not turn that recording into text — try again');
  }
  return String(body.text || '').trim();
}

module.exports = { transcribe, TranscribeError, MODEL };
