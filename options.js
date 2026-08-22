'use strict';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// i18n-Kürzel: liest lokalisierte Strings aus _locales/<lang>/messages.json
// (generiert via tools/i18n/export.py). `subs` mappt auf die $1/$2-Platzhalter.
const t = (key, subs) => browser.i18n.getMessage(key, subs);

// ─── Nextcloud URL — HTTPS erzwungen ────────────────────────────────────────
//
// Das Eingabefeld zeigt nur noch den Host/Pfad an; "https://" steht als
// fixes Präfix davor (siehe options.html, .url-prefix) und ist dem Nutzer so
// sichtbar fest vorgegeben. Falls trotzdem ein Schema mitgetippt oder
// eingefügt wird (z. B. per Copy-Paste einer vollen URL), wird es hier
// abgeschnitten statt zu einem doppelten oder http-Schema zu führen.
function stripProtocol(value) {
  return (value || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function getFullNextcloudUrl() {
  const cleaned = stripProtocol($('nextcloudUrl').value);
  return cleaned ? `https://${cleaned}` : '';
}

function setNextcloudUrlInput(fullUrl) {
  $('nextcloudUrl').value = stripProtocol(fullUrl);
}

// ─── Runtime host permission for the user's Nextcloud server ─────────────────
//
// host_permissions ist nur noch optional (manifest.json) statt pauschal
// <all_urls>. Grund: ohne aktiv erteilte (statt nur deklarierte) Origin-
// Permission greift Thunderbirds Netzwerk-Stack die CORS-Prüfung für fetch()
// auch aus privilegierten Erweiterungsseiten (z. B. der Options-Seite) —
// "Access-Control-Allow-Origin fehlt" trotz Status 200. chrome.permissions
// .request (hier browser.permissions.request) schaltet das für die konkret
// angefragte Origin frei; das funktioniert hier, weil der Request innerhalb
// eines Button-Klicks (User-Geste) ausgelöst wird. Mirrors merlin-chrome.
function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

async function ensureHostPermission(url) {
  const origin = originPatternFor(url);
  if (!origin) return false;
  // Kein vorgeschalteter `await permissions.contains(...)`: Thunderbird/Firefox
  // verlangt, dass permissions.request() direkt aus der Klick-Handler-Kette
  // aufgerufen wird — ein Await davor lässt die User-Geste "verfallen"
  // ("permissions.request may only be called from a user input handler").
  // request() selbst löst ohne Prompt sofort auf, falls die Permission schon
  // erteilt ist, daher ist der separate contains()-Check unnötig.
  return browser.permissions.request({ origins: [origin] });
}

function showCloseButton() {
  const existing = $('closeTabBtn');
  if (existing) { existing.style.display = 'inline-flex'; return; }

  const btn = document.createElement('button');
  btn.id        = 'closeTabBtn';
  btn.className = 'btn btn-close-tab';
  btn.textContent = t('options_closeTab');
  btn.addEventListener('click', () => window.close());
  $('status').appendChild(btn);
}

function showStatus(message, type /* 'success' | 'error' | 'info' */, durationMs = 5000) {
  const wrap = $('status');
  const icon = $('statusIcon');
  const text = $('statusText');

  const icons = { success: '✓', error: '✕', info: '…' };

  icon.textContent = icons[type] ?? '•';
  text.textContent = message;
  wrap.className   = `status visible ${type}`;

  clearTimeout(showStatus._timer);
  if (durationMs > 0) {
    showStatus._timer = setTimeout(() => { wrap.className = 'status'; }, durationMs);
  }
}

// ─── Storage helpers ───────────────────────────────────────────────────────────
//
// Credentials liegen ausschließlich verschlüsselt in storage.local (AES-GCM,
// siehe crypto.js, Key `credEnc`). Kein Sync, keine Passphrase — siehe
// Kommentar in background.js für den Hintergrund (SECURITY-AUDIT.md).

async function getCredentials() {
  const { credEnc } = await browser.storage.local.get('credEnc');
  if (!credEnc) return {};
  try {
    return await merlinDecryptCredentials(credEnc);
  } catch {
    return {};
  }
}

async function clearCredentials() {
  await browser.storage.local.remove(['credEnc', 'encKeyRaw']);
}

// ─── Nextcloud Login Flow v2 ──────────────────────────────────────────────────
//
// The options page handles:
//   1. POST {nextcloudUrl}/index.php/login/v2  →  { login, poll: { token, endpoint } }
//   2. Open the `login` URL in a new tab
//   3. Hand off polling to the background script (so it survives tab switches /
//      popup close in Thunderbird)
//   4. React to the result written to storage by the background script
//
// The button doubles as a cancel button while a flow is in progress.

let _lfActive = false;  // UI-only guard (background tracks the real state)

function _lfReset() {
  _lfActive = false;
  $('loginFlowBtn').querySelector('span').textContent = t('options_loginButton');
}

function cancelLoginFlow() {
  if (!_lfActive) return;
  _lfReset();
  browser.runtime.sendMessage({ type: 'merlin:cancelLoginPoll' }).catch(() => {});
  showStatus(t('options_loginCancelled'), 'info');
}

function selectedBackendKind() {
  return document.querySelector('input[name="backendKind"]:checked')?.value || 'nextcloud';
}

async function startLoginFlow() {
  // Toggle: clicking the button again cancels an in-progress flow
  if (_lfActive) { cancelLoginFlow(); return; }

  const url = getFullNextcloudUrl();
  if (!url) {
    showStatus(t('options_enterUrlFirst'), 'error');
    $('nextcloudUrl').focus();
    return;
  }

  const backendKind = selectedBackendKind();

  _lfActive = true;
  $('loginFlowBtn').querySelector('span').textContent = t('options_cancelLogin');
  showStatus(t('options_connecting'), 'info', 0);

  // ── Step 0: request access to this specific server only ────────────────────
  if (!(await ensureHostPermission(url))) {
    _lfReset();
    showStatus(t('options_needsPermission'), 'error');
    return;
  }

  // ── Step 1: initiate ────────────────────────────────────────────────────────
  // merlin-server bildet Nextclouds Login-Flow-v2-JSON identisch nach (siehe
  // merlin-server/src/Controller/LoginFlowController.php) - nur die Start-URL
  // unterscheidet sich, Polling/Parsing bleibt unverändert.
  let loginUrl, pollToken, pollEndpoint;
  try {
    const loginFlowPath = backendKind === 'standalone' ? '/login/v2' : '/index.php/login/v2';
    const r = await fetch(`${url}${loginFlowPath}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    loginUrl     = d.login;
    pollToken    = d.poll.token;
    pollEndpoint = d.poll.endpoint;
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotReach', [e.message]), 'error');
    return;
  }
  if (!_lfActive) return;

  // ── Step 2: open login tab ───────────────────────────────────────────────────
  let loginTabId = null;
  try {
    const tab = await browser.tabs.create({ url: loginUrl });
    loginTabId = tab.id;
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotOpenLogin', [e.message]), 'error');
    return;
  }
  showStatus(t('options_completeLogin'), 'info', 0);

  // ── Step 3: hand polling off to the background script ─────────────────────
  try {
    await browser.runtime.sendMessage({
      type:         'merlin:startLoginPoll',
      pollEndpoint,
      pollToken,
      serverUrl:    url,
      loginTabId,
      backendKind,
    });
  } catch (e) {
    _lfReset();
    showStatus(t('options_cannotStartPolling', [e.message]), 'error');
  }
}

// ── Step 4: react to background result ────────────────────────────────────────

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes._merlinLoginFlowResult) return;

  const result = changes._merlinLoginFlowResult.newValue;
  if (!result) return;

  // Clean up immediately so stale results don't fire on next open
  browser.storage.local.remove('_merlinLoginFlowResult').catch(() => {});

  _lfReset();

  if (result.cancelled) {
    return;
  }

  if (result.error) {
    showStatus(result.error, 'error');
    return;
  }

  if (result.success) {
    setNextcloudUrlInput(result.serverUrl);
    showStatus(t('options_loggedInAs', [result.loginName]), 'success', 0);
    showCloseButton();
    updateLogoutButton(true);
    updateTestButton(true);
  }
});

// ─── Logout ────────────────────────────────────────────────────────────────────
//
// Entfernt die gespeicherten Zugangsdaten und setzt die UI in den
// "nicht verbunden"-Zustand zurück. Es gibt keine manuellen Login-Felder in
// Thunderbird — die URL bleibt im Feld stehen, nur die Credentials werden gelöscht.

function updateLogoutButton(connected) {
  const btn = $('logoutBtn');
  if (!btn) return;
  btn.disabled = !connected;
  btn.style.display = connected ? 'inline-flex' : 'none';
}

// "Test connection" ergibt ohne gespeicherte Credentials keinen Sinn (der Klick
// würde sofort mit "Please log in with Nextcloud first." fehlschlagen) — daher
// bleibt der Button gesperrt, bis ein Login-Versuch erfolgreich war.
function updateTestButton(connected) {
  const btn = $('testBtn');
  if (!btn) return;
  btn.disabled = !connected;
}

async function logout() {
  await clearCredentials();
  updateLogoutButton(false);
  updateTestButton(false);
  showStatus(t('options_disconnected'), 'info');
}

// ─── Load saved settings ──────────────────────────────────────────────────────

async function loadSettings() {
  const { nextcloudUrl, username, appPassword, backendKind } = await getCredentials();

  if (nextcloudUrl) setNextcloudUrlInput(nextcloudUrl);
  const radio = document.querySelector(`input[name="backendKind"][value="${backendKind === 'standalone' ? 'standalone' : 'nextcloud'}"]`);
  if (radio) radio.checked = true;
  const connected = Boolean(nextcloudUrl && username && appPassword);
  updateLogoutButton(connected);
  updateTestButton(connected);

  // Restore in-progress UI state if the background is still polling
  const { _merlinLoginFlow } = await browser.storage.local.get('_merlinLoginFlow');
  if (_merlinLoginFlow?.active) {
    _lfActive = true;
    $('loginFlowBtn').querySelector('span').textContent = t('options_cancelLogin');
    showStatus(t('options_completeLogin'), 'info', 0);
    return;
  }

  // Show welcome hint when no URL is stored yet
  if (!nextcloudUrl) {
    showStatus(t('options_welcome'), 'info', 0);
  }
}

// ─── Test connection ──────────────────────────────────────────────────────────

async function testConnection() {
  const url = getFullNextcloudUrl();

  // Read stored credentials — they come from the login flow, not manual fields
  const { username, appPassword, backendKind } = await getCredentials();

  if (!url || !username || !appPassword) {
    showStatus(t('options_loginFirst'), 'error');
    return;
  }

  const btn = $('testBtn');
  btn.disabled = true;
  btn.querySelector('span').textContent = t('options_testing');
  showStatus(t('options_connectingShort'), 'info', 0);

  try {
    // merlin-server hat keine Pocket-kompatible /api/v1/get - stattdessen
    // ein leichter, bereits authentifizierter GET-Call (gleiche Vereinfachung
    // wie iOS' MerlinAPI.testConnection()/Androids SettingsViewModel.testConnection()).
    const creds = btoa(`${username}:${appPassword}`);
    const resp = backendKind === 'standalone'
      ? await fetch(`${url}/api/articles/counts`, {
          method:  'GET',
          headers: { 'Authorization': `Basic ${creds}` },
          signal:  AbortSignal.timeout(10_000),
        })
      : await fetch(`${url}/index.php/apps/merlin/api/v1/get`, {
          method:  'POST',
          headers: {
            'Authorization': `Basic ${creds}`,
            'Content-Type':  'application/json',
          },
          body:   JSON.stringify({ state: 'all', count: 1 }),
          signal: AbortSignal.timeout(10_000),
        });

    if (resp.ok) {
      showStatus(t('options_testSuccess'), 'success');
    } else if (resp.status === 401) {
      showStatus(t('options_testAuthFailed'), 'error');
    } else if (resp.status === 404) {
      showStatus(t('options_testNotFound'), 'error');
    } else {
      showStatus(t('options_testServerError', [String(resp.status)]), 'error');
    }
  } catch (e) {
    if (e.name === 'TimeoutError') {
      showStatus(t('options_testTimeout'), 'error');
    } else {
      showStatus(t('options_testFailed', [e.message]), 'error');
    }
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = t('options_testButton');
  }
}

// ─── Wire everything up ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  $('loginFlowBtn').addEventListener('click', startLoginFlow);
  $('testBtn').addEventListener('click', testConnection);
  $('logoutBtn').addEventListener('click', logout);
});
