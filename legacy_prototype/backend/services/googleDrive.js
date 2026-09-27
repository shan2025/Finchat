// services/googleDrive.js — find the user's Drive files by name, get their links.
//
// Backed by drive.metadata.readonly (see googleOAuth.js): names, types, links
// and modified times. Never contents — there is no call here that could read a
// file, and the scope would refuse one if there were.
//
// Used two ways:
//   • the mind map / board "add links" box — type "Duxbe POS spec", pick the file
//   • the `drive` agent tool — "attach the onboarding deck" becomes a search
const axios = require('axios');
const google = require('./googleOAuth');
const { classify } = require('./linkInfo');

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const FIELDS = 'id,name,mimeType,webViewLink,iconLink,modifiedTime,size,owners(displayName)';

class DriveError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const MIME_LABEL = {
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.google-apps.form': 'Google Form',
  'application/vnd.google-apps.folder': 'Drive folder',
  'application/pdf': 'PDF'
};

async function tokenFor(userId) {
  if (!google.isConfigured()) {
    throw new DriveError('not_configured', 'Google is not set up on this server, so Drive cannot be searched.');
  }
  if (!(await google.hasFeature(userId, 'drive'))) {
    throw new DriveError('not_connected', 'Google Drive is not connected. Connect it in Settings → Connected accounts.');
  }
  const token = await google.getAccessToken(userId);
  if (!token) {
    throw new DriveError('not_connected', 'The Google Drive connection has lapsed. Reconnect it in Settings → Connected accounts.');
  }
  return token;
}

/** Drive's query language wraps values in single quotes; \ and ' must be escaped. */
function quote(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Build the q= for a name search. Every word must appear in the name, in any
 * order — "POS spec duxbe" finds "Duxbe POS — Spec v2". Words shorter than two
 * characters are dropped; they match nearly everything.
 */
function nameQuery(text) {
  const words = String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2).slice(0, 6);
  const clauses = words.map(w => `name contains ${quote(w)}`);
  clauses.push('trashed = false');
  return clauses.join(' and ');
}

/** One Drive file in the shape the UI and the agent both use. */
function toLink(f) {
  const info = classify(f.webViewLink);
  return {
    fileId: f.id,
    title: f.name,
    url: f.webViewLink,
    provider: info ? info.provider : 'gdrive',
    kindLabel: MIME_LABEL[f.mimeType] || (info && info.label) || 'Drive file',
    mimeType: f.mimeType,
    iconLink: f.iconLink || null,
    modifiedTime: f.modifiedTime || null,
    owner: f.owners && f.owners[0] ? f.owners[0].displayName : null
  };
}

async function call(token, params) {
  try {
    const res = await axios.get(FILES_URL, {
      params: { supportsAllDrives: true, includeItemsFromAllDrives: true, ...params },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 12000
    });
    return res.data;
  } catch (err) {
    const status = err.response && err.response.status;
    const reason = err.response && err.response.data && err.response.data.error
      && err.response.data.error.message;
    if (status === 403 && /has not been used|is disabled/i.test(reason || '')) {
      throw new DriveError('api_disabled', 'The Google Drive API is not enabled on this server\'s Google Cloud project.');
    }
    if (status === 401 || status === 403) {
      throw new DriveError('not_connected', 'Google refused the Drive request — reconnect Drive in Settings.');
    }
    throw new DriveError('drive_error', `Google Drive did not answer: ${reason || err.message}`);
  }
}

/**
 * Files whose names match `text`, most recently modified first. Empty text
 * returns the most recently modified files — the "what was I just working on"
 * list.
 */
async function search(userId, text, { limit = 10 } = {}) {
  const token = await tokenFor(userId);
  const data = await call(token, {
    q: String(text || '').trim() ? nameQuery(text) : 'trashed = false',
    orderBy: 'modifiedTime desc',
    pageSize: Math.max(1, Math.min(25, Number(limit) || 10)),
    fields: `files(${FIELDS})`
  });
  await google.touch(userId);
  return (data.files || []).map(toLink);
}

/** One file by id — used to name a pasted Drive link. Null when it is not visible to this user. */
async function getFile(userId, fileId) {
  const token = await tokenFor(userId);
  try {
    const res = await axios.get(`${FILES_URL}/${encodeURIComponent(fileId)}`, {
      params: { supportsAllDrives: true, fields: FIELDS },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    return toLink(res.data);
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    throw new DriveError('drive_error', `Google Drive did not answer: ${err.message}`);
  }
}

/**
 * Resolve a list of names ("Duxbe POS spec", "Q3 budget") to files. Each name
 * gets its best match — an exact (case-insensitive) name first, otherwise the
 * most recent file containing every word — plus the runners-up, so a UI can
 * offer "did you mean" instead of guessing silently.
 */
async function resolveNames(userId, names, { alternatives = 4 } = {}) {
  const out = [];
  for (const name of names.slice(0, 15)) {
    const clean = String(name || '').trim();
    if (!clean) continue;
    const hits = await search(userId, clean, { limit: alternatives + 1 });
    const exact = hits.find(h => h.title.toLowerCase() === clean.toLowerCase());
    const best = exact || hits[0] || null;
    out.push({ name: clean, match: best, alternatives: hits.filter(h => h !== best).slice(0, alternatives) });
  }
  return out;
}

/** Is Drive usable for this user right now? Never throws. */
async function isConnected(userId) {
  try { return google.isConfigured() && await google.hasFeature(userId, 'drive'); } catch (e) { return false; }
}

module.exports = { search, getFile, resolveNames, isConnected, nameQuery, toLink, DriveError };
