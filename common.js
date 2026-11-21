'use strict';

// ─── Shared helpers ───────────────────────────────────────────────────────────
//
// Loaded after crypto.js and before background.js (manifest
// "background.scripts") and before the page scripts of options.html and
// save-dialog.html. Everything here is a plain global so the classic
// (non-module) scripts can use it.

// i18n shorthand: reads localized strings from _locales/<lang>/messages.json
// (generated from merlin-translations via export.py --platform webext).
// `subs` maps onto the $1/$2 placeholders of the message.
const t = (key, subs) => browser.i18n.getMessage(key, subs);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Server URL checks ────────────────────────────────────────────────────────

function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Credentials, URLs and page content must only travel encrypted. Plain
// http:// is accepted solely for loopback addresses (local development),
// where nothing leaves the machine.
function isAllowedServerUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

// ─── Server API helpers ───────────────────────────────────────────────────────

function serverBase(url) {
  return url.replace(/\/+$/, '');
}

function basicAuthHeader(username, appPassword) {
  return `Basic ${btoa(`${username}:${appPassword}`)}`;
}

// The tag list lives under a different prefix per backend: the Nextcloud app
// serves it below /index.php/apps/merlin/api, merlin-server below /api.
function tagsEndpoint(url, backendKind) {
  const prefix = backendKind === 'standalone' ? '/api' : '/index.php/apps/merlin/api';
  return `${serverBase(url)}${prefix}/tags`;
}

// The tag API may answer with a bare array or wrap it in { tags } / { data }.
function normalizeTagList(data) {
  if (Array.isArray(data)) return data;
  return data?.tags ?? data?.data ?? [];
}

function showNotification(title, message) {
  return browser.notifications.create({
    type:    'basic',
    iconUrl: browser.runtime.getURL('icons/icon-48.png'),
    title,
    message,
  });
}

// ─── Credential storage ───────────────────────────────────────────────────────
//
// Credentials live only in storage.local, encrypted with AES-GCM under the
// key `credEnc` (see crypto.js). Nothing is synced. A ciphertext that cannot
// be decrypted (key gone, data corrupted) counts as "no credentials".

async function getCredentials() {
  const { credEnc } = await browser.storage.local.get('credEnc');
  if (!credEnc) return {};
  try {
    return await merlinDecryptCredentials(credEnc);
  } catch {
    return {};
  }
}

async function setCredentials(fields) {
  const current = await getCredentials();
  const credEnc = await merlinEncryptCredentials({ ...current, ...fields });
  await browser.storage.local.set({ credEnc });
}

async function clearCredentials() {
  await browser.storage.local.remove(['credEnc', 'encKeyRaw', '_merlinAuthFailures']);
}

// ─── Auth failure handling ────────────────────────────────────────────────────
//
// A single HTTP 401 can have harmless causes (wrong backend type selected,
// a misconfigured reverse proxy, a short server hiccup). Clearing the
// credentials right away would force a new login for nothing, so they are
// only cleared after two consecutive 401s. Any successful request resets the
// counter.

const AUTH_FAILURE_LIMIT = 2;

// Returns true when the credentials were cleared.
async function recordAuthFailure() {
  const { _merlinAuthFailures = 0 } = await browser.storage.local.get('_merlinAuthFailures');
  const count = _merlinAuthFailures + 1;
  if (count < AUTH_FAILURE_LIMIT) {
    await browser.storage.local.set({ _merlinAuthFailures: count });
    return false;
  }
  await clearCredentials();
  await showNotification(t('notification_defaultTitle'), t('saveDialog_authFailed'));
  return true;
}

async function resetAuthFailures() {
  await browser.storage.local.remove('_merlinAuthFailures');
}
