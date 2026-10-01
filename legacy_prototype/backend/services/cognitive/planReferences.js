// services/cognitive/planReferences.js — fill a plan step's reference to an
// earlier step's result with the real value.
//
// The planner writes every step of a plan BEFORE any of them has run, so it
// cannot know the URL that step 1's search will return. When step 2 needs it,
// the only thing the model can write is a description of it:
//
//   "<URL of top headline from step 1>"        "{{step1.results[0].url}}"
//   "URL of the most relevant paper from step 1"                  "$1[0].url"
//
// CognitiveCore used to pass that string straight to the tool. FetchTool then
// prefixed "https://", both the direct fetch and Jina Reader rejected it, and
// the deep-read step of the scheduled briefings failed on 40 consecutive
// recorded runs from 2026-08-17 on — every one of those briefings was written
// from headlines alone, with nothing in the output saying so.
//
// Scope is deliberately narrow: only tools whose whole input IS a URL, only an
// input that visibly is a placeholder rather than a real address, and only URLs
// taken from results this same run already gathered. A reference that cannot be
// resolved is reported as unresolved and the step is SKIPPED, not guessed at and
// not sent to the tool — a skipped step costs nothing, and the reasoning pass
// after the plan sees every real result and can fetch properly from there.

/** Tools whose input is a single URL. Anything else is left exactly as planned. */
const URL_INPUT_TOOLS = new Set(['fetch', 'crawl']);

const HTTP_URL = /https?:\/\/[^\s"'<>{}|\\^`\]]+/i;

/** Keys that hold the address of the THING a result is about, best first. */
const PREFERRED_URL_KEYS = ['url', 'link', 'href', 'pdfUrl', 'sourceUrl', 'source'];

/** The URL a plan step's input carries, whatever shape the planner wrote it in. */
function urlIn(input) {
  if (input && typeof input === 'object') return urlIn(input.url || input.link || '');
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return urlIn(JSON.parse(s)); } catch (e) { /* fall through to a plain scan */ }
  }
  const m = s.match(HTTP_URL);
  return m ? m[0].replace(/[.,;:)]+$/, '') : null;
}

/**
 * Which earlier step the placeholder points at, if it names one.
 * Recognises "step 1", "step1.results", "steps 1-3" (takes the first), "$1".
 */
function referencedStep(input) {
  const s = typeof input === 'string' ? input : JSON.stringify(input || '');
  const m = s.match(/\bsteps?\s*(\d+)/i) || s.match(/\$(\d+)\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Every http(s) URL in a tool result, in document order, with the addresses of
 * the items themselves ahead of incidental ones (a feed's own homepage, an
 * author profile). Order matters: news and paper tools return results ranked,
 * so "the top article" is the first item's url.
 */
function urlsInResult(result) {
  const preferred = [];
  const incidental = [];
  const walk = (node, key) => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (/^https?:\/\//i.test(node)) (PREFERRED_URL_KEYS.includes(key) ? preferred : incidental).push(node);
      return;
    }
    if (Array.isArray(node)) { node.forEach(n => walk(n, key)); return; }
    if (typeof node === 'object') {
      // An error result has no addresses worth following.
      if (node.error && Object.keys(node).length <= 2) return;
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(result, null);
  return [...new Set([...preferred, ...incidental])];
}

/**
 * Resolve a plan step's input against the results gathered so far.
 *
 * @param {object} step            the plan step ({ step, tool, input })
 * @param {Array}  priorResults    [{ planStep, tool, input, result }] from THIS run
 * @returns {{ input: any, resolved: boolean, unresolved: boolean, note?: string }}
 *   `resolved`   — the input was a placeholder and now carries a real URL
 *   `unresolved` — it was a placeholder and no URL could honestly fill it; skip
 *   neither      — the input was already usable, or this tool is out of scope
 */
function resolveStepInput(step, priorResults) {
  const input = step.input;
  if (!URL_INPUT_TOOLS.has(step.tool)) return { input, resolved: false, unresolved: false };
  if (urlIn(input)) return { input, resolved: false, unresolved: false };

  // An empty input is not a placeholder, but it is not a URL either, and the
  // old `step.input || goal` default sent the entire goal to fetch as an address.
  const wanted = referencedStep(input);
  const alreadyUsed = new Set(priorResults
    .filter(r => URL_INPUT_TOOLS.has(r.tool))
    .map(r => urlIn(r.input))
    .filter(Boolean));

  // The named step first when the placeholder names one, then the most recent
  // results — "the top article" almost always means the search just before it.
  const candidates = [
    ...priorResults.filter(r => wanted != null && r.planStep === wanted),
    ...[...priorResults].reverse().filter(r => !(wanted != null && r.planStep === wanted))
  ].filter(r => !URL_INPUT_TOOLS.has(r.tool) || r.planStep === wanted);

  for (const r of candidates) {
    const url = urlsInResult(r.result).find(u => !alreadyUsed.has(u));
    if (url) {
      return {
        input: { url },
        resolved: true,
        unresolved: false,
        note: `plan referenced ${wanted != null ? `step ${wanted}` : 'an earlier result'} ("${String(typeof input === 'string' ? input : JSON.stringify(input)).slice(0, 80)}"); filled with ${url} from ${r.tool}`
      };
    }
  }

  return {
    input,
    resolved: false,
    unresolved: true,
    note: `plan step ${step.step} gave "${step.tool}" a description of a URL instead of a URL ("${String(typeof input === 'string' ? input : JSON.stringify(input)).slice(0, 80)}"), and no earlier result in this run held one to fill it with`
  };
}

module.exports = { resolveStepInput, urlIn, urlsInResult, referencedStep, URL_INPUT_TOOLS };
