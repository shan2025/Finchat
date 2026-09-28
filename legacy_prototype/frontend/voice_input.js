// voice_input.js — talk to FinChat's AI panels (board and mind map "Ask AI").
//
// window.FcVoice.create({token, onText, onState, onError}) → {toggle, cancel, state}
//   Records with MediaRecorder, sends the audio to POST /api/voice/transcribe
//   (Groq Whisper, server side — works in every browser and in the desktop
//   app, and understands Malayalam, Hindi, Arabic… without being told).
// window.FcVoice.speak(text) / stop()
//   Reads a reply aloud with the browser's own speech synthesis. The panels
//   only speak when you SPOKE the question, so typing stays silent.
(function () {
  'use strict';
  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

  function create({ token, api = location.origin, maxSeconds = 120, onText, onState, onError }) {
    let rec = null, stream = null, chunks = [], timer = null, started = 0, cancelled = false, state = 'idle';
    const set = (s, extra) => { state = s; if (onState) onState(s, extra || {}); };
    const fail = (msg) => { set('idle'); if (onError) onError(msg); };
    const release = () => { clearInterval(timer); if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; };

    async function start() {
      if (!supported()) return fail('Voice needs a browser with microphone support');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        return fail(e && e.name === 'NotAllowedError'
          ? 'Microphone access was blocked — allow it for this site to use voice'
          : 'No microphone was found');
      }
      const mimeType = TYPES.find(t => MediaRecorder.isTypeSupported(t));
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];
      cancelled = false;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = upload;
      rec.start(250);
      started = Date.now();
      set('recording', { seconds: 0 });
      timer = setInterval(() => {
        const seconds = (Date.now() - started) / 1000;
        set('recording', { seconds });
        if (seconds >= maxSeconds) stop();
      }, 250);
    }

    function stop() {
      if (rec && rec.state === 'recording') rec.stop();
      release();
    }

    async function upload() {
      if (cancelled) { cancelled = false; return set('idle'); }
      const type = (rec && rec.mimeType) || 'audio/webm';
      const blob = new Blob(chunks, { type });
      if (blob.size < 1500) return fail('Nothing was recorded — hold the button a moment longer');
      set('transcribing');
      const fd = new FormData();
      fd.append('audio', blob, 'voice.' + (/ogg/.test(type) ? 'ogg' : /mp4/.test(type) ? 'm4a' : 'webm'));
      try {
        const r = await fetch(api + '/api/voice/transcribe', { method: 'POST', body: fd, headers: { Authorization: 'Bearer ' + token } });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.error || 'HTTP ' + r.status);
        set('idle');
        if (!b.text) return fail('No speech was heard — try again, a little closer to the mic');
        if (onText) onText(b.text);
      } catch (e) {
        fail(e.message);
      }
    }

    return {
      toggle() { if (state === 'recording') stop(); else if (state === 'idle') start(); },
      cancel() { if (state === 'recording') { cancelled = true; stop(); } },
      get state() { return state; }
    };
  }

  function speak(text) {
    if (!('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 1200));
    u.rate = 1.03;
    window.speechSynthesis.speak(u);
  }
  function stop() { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }

  window.FcVoice = { supported, create, speak, stop };
})();
