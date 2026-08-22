'use strict';

const MENU_ID_SAVE           = 'merlin-save-link';
const MENU_ID_SAVE_TAGS      = 'merlin-save-with-tags';
const MENU_ID_SAVE_PAGE      = 'merlin-save-page';
const MENU_ID_SAVE_PAGE_TAGS = 'merlin-save-page-with-tags';
const MENU_ID_SAVE_MAIL      = 'merlin-save-mail';

// Thunderbird exposes a `messenger` global; Firefox does not.
const IS_THUNDERBIRD = typeof messenger !== 'undefined';

// ─── i18n shorthand ───────────────────────────────────────────────────────────
// Liest lokalisierte Strings aus _locales/<lang>/messages.json (generiert aus
// localization/strings/*.json via tools/i18n/export.py). `subs` ist optional
// und wird auf die $1/$2-Platzhalter der jeweiligen Message abgebildet.
const t = (key, subs) => browser.i18n.getMessage(key, subs);

// ─── Logo as base64 data URL ──────────────────────────────────────────────────
// Pages block moz-extension:// URLs via CSP, so we convert the icon once to
// an inline data URL and pass it as an argument into the injected function.

let _logoDataUrl = null;

async function getLogoDataUrl() {
  if (_logoDataUrl) return _logoDataUrl;
  try {
    const resp = await fetch(browser.runtime.getURL('icons/icon-128.png'));
    const blob = await resp.blob();
    _logoDataUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch {
    _logoDataUrl = ''; // no logo on error — flyout still works
  }
  return _logoDataUrl;
}

// ─── Credential storage helpers ───────────────────────────────────────────────
//
// Credentials liegen ausschließlich in storage.local, verschlüsselt (AES-GCM,
// siehe crypto.js) unter dem Key `credEnc`. Es gibt keinen Sync mehr: weder
// die alte Klartext-Variante noch die alte passphrasen-basierte
// storage.sync-Kopie werden noch verwendet (siehe SECURITY-AUDIT.md und
// migrateCredentialsToEncryptedLocal() unten für die Migration von
// Bestandsdaten).

async function getCredentials() {
  const { credEnc } = await browser.storage.local.get('credEnc');
  if (!credEnc) return {};
  try {
    return await merlinDecryptCredentials(credEnc);
  } catch {
    // Chiffretext kaputt/Schlüssel weg — wie "keine Credentials" behandeln.
    return {};
  }
}

async function setCredentials(fields) {
  const current = await getCredentials();
  const merged  = { ...current, ...fields };
  const credEnc = await merlinEncryptCredentials(merged);
  await browser.storage.local.set({ credEnc });
}

async function clearCredentials() {
  await browser.storage.local.remove(['credEnc', 'encKeyRaw']);
}

// ─── Login Flow polling ───────────────────────────────────────────────────────
//
// The polling runs here in the background script, not in the options page.
// That way it survives the user switching away from the options tab.  Results
// are written to browser.storage.local so the options page can react via
// storage.onChanged.

let _lfTimer  = null;
let _lfActive = false;

async function startBackgroundLoginPoll({ pollEndpoint, pollToken, serverUrl, loginTabId, backendKind }) {
  // Cancel any stale flow
  if (_lfActive) {
    _lfActive = false;
    clearTimeout(_lfTimer);
    _lfTimer = null;
  }

  _lfActive = true;
  await browser.storage.local.set({ _merlinLoginFlow: { active: true, loginTabId } });

  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute timeout

  async function poll() {
    if (!_lfActive) return;

    if (Date.now() > deadline) {
      await _lfFinish({ error: t('options_loginTimeout') });
      return;
    }

    try {
      const r = await fetch(pollEndpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `token=${encodeURIComponent(pollToken)}`,
        signal:  AbortSignal.timeout(5_000),
      });

      if (r.status === 404) {
        // Not yet authorised — check again in 2 s
        if (_lfActive) _lfTimer = setTimeout(poll, 2000);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const creds = await r.json();
      if (!_lfActive) return;

      await _lfFinish({ creds, serverUrl, backendKind });
    } catch {
      // Transient network error — keep retrying
      if (_lfActive) _lfTimer = setTimeout(poll, 2000);
    }
  }

  _lfTimer = setTimeout(poll, 2000);
}

async function cancelBackgroundLoginPoll() {
  if (!_lfActive) return;
  _lfActive = false;
  clearTimeout(_lfTimer);
  _lfTimer = null;
  await browser.storage.local.remove('_merlinLoginFlow');
  await browser.storage.local.set({ _merlinLoginFlowResult: { cancelled: true } });
}

async function _lfFinish({ creds, serverUrl, backendKind, error }) {
  _lfActive = false;
  clearTimeout(_lfTimer);
  _lfTimer = null;

  const { _merlinLoginFlow } = await browser.storage.local.get('_merlinLoginFlow');
  const loginTabId = _merlinLoginFlow?.loginTabId;
  await browser.storage.local.remove('_merlinLoginFlow');

  if (error) {
    await browser.storage.local.set({ _merlinLoginFlowResult: { error } });
    return;
  }

  // Save credentials — verschlüsselt in storage.local (siehe Kommentar oben
  // bei getCredentials/setCredentials).
  const finalServerUrl = (creds.server || serverUrl).replace(/\/$/, '');
  await setCredentials({
    nextcloudUrl: finalServerUrl,
    username:     creds.loginName,
    appPassword:  creds.appPassword,
    backendKind,
  });

  // Close the Nextcloud login tab
  if (loginTabId != null) browser.tabs.remove(loginTabId).catch(() => {});

  // Notify options page via storage
  await browser.storage.local.set({
    _merlinLoginFlowResult: {
      success:   true,
      serverUrl: finalServerUrl,
      loginName: creds.loginName,
    },
  });

  // Automatisch zurück zu den Einstellungen: fokussiert die Options-Seite,
  // falls der Nutzer währenddessen weggeklickt hat, oder öffnet sie neu.
  browser.runtime.openOptionsPage().catch(() => {});
}

// ─── Migration: alte Speicherformen → verschlüsseltes storage.local ──────────
//
// Frühere Versionen kannten zwei andere Ablagen, die beide abgelöst werden:
//   1. Klartext-Felder direkt in storage.local (nextcloudUrl/username/
//      appPassword) — die ursprüngliche "Arbeitskopie".
//   2. Eine passphrasen-verschlüsselte Kopie in storage.sync (credEnc +
//      encPassphrase), in der irrtümlichen Annahme, Mozilla verschlüssle
//      storage.sync für Thunderbird immer serverseitig Ende-zu-Ende — das
//      stimmt nur mit eingerichtetem Thunderbird Sync (Mozilla-Konto), siehe
//      SECURITY-AUDIT.md.
//
// Es gibt keinen Sync mehr und keine Passphrase mehr. Bestandsnutzer werden
// einmalig auf die neue, zufallsschlüssel-verschlüsselte storage.local-Ablage
// migriert; alle alten Klartext-/Sync-Reste werden danach entfernt.
async function migrateCredentialsToEncryptedLocal() {
  const { credEnc, nextcloudUrl, username, appPassword } = await browser.storage.local.get([
    'credEnc', 'nextcloudUrl', 'username', 'appPassword',
  ]);

  // Fall 1: alte Klartext-Felder in storage.local, noch kein credEnc.
  if (!credEnc && nextcloudUrl && username && appPassword) {
    await setCredentials({ nextcloudUrl, username, appPassword });
  }

  // Alte Klartext-Felder + Passphrase sind in jedem Fall Datenmüll.
  await browser.storage.local.remove(['nextcloudUrl', 'username', 'appPassword', 'encPassphrase']);

  // Fall 2: alte Sync-Kopie aufräumen — wird nicht mehr genutzt.
  try { await browser.storage.sync.remove(['credEnc', 'encPassphrase']); } catch { /* storage.sync evtl. nicht verfügbar */ }
}

browser.runtime.onInstalled.addListener(migrateCredentialsToEncryptedLocal);
browser.runtime.onStartup.addListener(migrateCredentialsToEncryptedLocal);

// ─── Message handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'merlin:startLoginPoll') {
    startBackgroundLoginPoll(msg);
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:cancelLoginPoll') {
    cancelBackgroundLoginPoll();
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:saveWithTags') {
    handleSaveWithTags(msg.tags ?? [], msg.windowId ?? null);
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:cancelSave') {
    browser.storage.local.remove('_merlinPendingSave').catch(() => {});
    return Promise.resolve({ ok: true });
  }
});

// ─── Save with tags (called from save-dialog) ─────────────────────────────────

async function handleSaveWithTags(tags, windowId) {
  // Close the dialog window
  if (windowId != null) browser.windows.remove(windowId).catch(() => {});

  const { _merlinPendingSave } = await browser.storage.local.get('_merlinPendingSave');
  await browser.storage.local.remove('_merlinPendingSave');

  if (!_merlinPendingSave) return;

  const { url, tabId, nextcloudUrl, username, appPassword, backendKind, isPage } = _merlinPendingSave;

  // HTML wird erst jetzt (statt schon beim Öffnen des Dialogs) eingefangen,
  // um es nicht zwischenzeitlich in storage.local ablegen zu müssen — bei
  // großen Seiten würde das an dessen Quota stoßen. Der Tab existiert zu
  // diesem Zeitpunkt noch, da der Save-Dialog nur ein separates Popup-Fenster
  // ist und den ursprünglichen Tab nicht schließt.
  let html = null;
  if (isPage && tabId != null) html = await captureTabHtml(tabId);

  await saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, tabId, tags, html });
}

// ─── HTML-Capture für Seiten-Speichern ────────────────────────────────────────
//
// Funktioniert nur in echten Content-Tabs (z. B. ein per "Link in neuem Tab
// öffnen" geöffneter Link oder ein RSS-Artikel-Tab) — in Mail-Tabs
// (Nachrichtenansicht/-liste/Compose) ist scripting.executeScript nicht
// verfügbar und schlägt fehl. Der try/catch degradiert dann sauber auf
// URL-only-Save, exakt das Muster, das Firefox/Chrome für privilegierte
// Seiten (about:*, PDF-Viewer) schon nutzen.
async function captureTabHtml(tabId) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func:   () => document.documentElement.outerHTML,
    });
    return results?.[0]?.result ?? null;
  } catch {
    return null;
  }
}

// ─── E-Mail als Artikel speichern ──────────────────────────────────────────────
//
// Nutzt browser.messages.* (messagesRead-Permission) statt scripting.executeScript —
// funktioniert deshalb, anders als das Seiten-HTML-Capture oben, auch direkt in der
// Nachrichtenliste/-ansicht. Betreff/Absender werden als title/author mitgeschickt,
// damit sie den servertigen Extractor überstimmen (siehe ExtensionController::add()
// in merlin-nextcloud bzw. ArticleController::create() in merlin-server) — bei einer
// reinen Textmail liefert die Extraktion aus dem gewrappten HTML sonst keinen
// brauchbaren Titel/Autor.

async function buildMailPayload(info) {
  const header = info.selectedMessages?.messages?.[0];
  if (!header) return null;

  let full;
  try {
    full = await browser.messages.getFull(header.id, { decodeContent: true });
  } catch {
    return null;
  }

  // HTML-Teil bevorzugen (z. B. HTML-Newsletter), sonst Klartext in minimales
  // HTML wrappen (der eigentliche "reine Textmail"-Fall).
  const htmlPart  = findPartByType(full, 'text/html');
  const plainPart = htmlPart ? null : findPartByType(full, 'text/plain');
  const html = htmlPart
    ? htmlPart.body
    : wrapPlainTextAsHtml(header.subject, plainPart?.body ?? '');

  // Message-ID-Header für eine stabile, pro Nachricht eindeutige Pseudo-URL
  // (E-Mails haben keine echte URL, das Feld ist aber Pflicht). Fallback auf
  // Thunderbirds interne numerische ID, falls der Header fehlt (selten, z. B.
  // bei kaputt erzeugten Mails).
  const rawMessageId  = full.headers?.['message-id']?.[0] ?? String(header.id);
  const cleanMessageId = rawMessageId.replace(/^<|>$/g, '');
  const url = `mail://message/${encodeURIComponent(cleanMessageId)}`;

  return {
    url,
    html,
    title:  header.subject || null,
    author: formatMailAuthor(header.author),
  };
}

// Tiefensuche über die MIME-Baumstruktur von messages.getFull() nach dem ersten
// Part mit passendem Content-Type (case-insensitive, Prefix-Match wegen
// Parametern wie "; charset=...").
function findPartByType(part, contentType) {
  if (!part) return null;
  if (part.contentType?.toLowerCase().startsWith(contentType) && part.body) return part;
  for (const sub of part.parts ?? []) {
    const found = findPartByType(sub, contentType);
    if (found) return found;
  }
  return null;
}

function wrapPlainTextAsHtml(subject, text) {
  const escape = s => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const paragraphs = escape(text)
    .split(/\n\s*\n/)
    .map(block => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  // <title> ist ein Fallback, falls der title-Override aus irgendeinem Grund
  // nicht greift — im Normalfall überschreibt der Server ihn ohnehin mit dem
  // separat mitgeschickten Betreff.
  return `<html><head><title>${escape(subject || '')}</title></head><body>${paragraphs}</body></html>`;
}

// Thunderbirds header.author kommt als "Name <email@adresse>" (oder nur die
// blanke Adresse ohne Namen) — die spitzen Klammern für einen saubereren
// Autoren-String entfernen, aber nur wenn davor noch ein Name übrig bleibt.
function formatMailAuthor(author) {
  if (!author) return null;
  const stripped = author.replace(/\s*<[^>]*>\s*$/, '').trim();
  return stripped || author;
}

// ─── Context menu setup ───────────────────────────────────────────────────────
//
// Thunderbird's primary API is browser.menus; browser.contextMenus is only a
// partial alias there and does NOT fire reliably in the message display pane.
// Firefox supports both names. We prefer browser.menus when available.

const menus = browser.menus ?? browser.contextMenus;

function setupContextMenu() {
  menus.removeAll().then(() => {
    menus.create({
      id:       MENU_ID_SAVE,
      title:    t('contextMenu_saveLink'),
      contexts: ['link'],
    });
    menus.create({
      id:       MENU_ID_SAVE_TAGS,
      title:    t('contextMenu_saveLinkWithTags'),
      contexts: ['link'],
    });
    // Feuert nur in echten Content-Tabs (siehe captureTabHtml-Kommentar) —
    // in Mail-Tabs erscheint der Eintrag entweder gar nicht oder degradiert
    // beim Klick sauber auf URL-only-Save.
    menus.create({
      id:       MENU_ID_SAVE_PAGE,
      title:    t('contextMenu_savePage'),
      contexts: ['page', 'selection', 'image'],
    });
    menus.create({
      id:       MENU_ID_SAVE_PAGE_TAGS,
      title:    t('contextMenu_savePageWithTags'),
      contexts: ['page', 'selection', 'image'],
    });
    // Feuert beim Rechtsklick auf eine Nachricht in der Nachrichtenliste
    // (Thread Pane) — nutzt browser.messages.*, nicht scripting.executeScript,
    // funktioniert daher unabhängig von der Mail-Tab-Einschränkung oben.
    menus.create({
      id:       MENU_ID_SAVE_MAIL,
      title:    t('contextMenu_saveMail'),
      contexts: ['message_list'],
    });
  });
}

browser.runtime.onInstalled.addListener(setupContextMenu);
browser.runtime.onStartup.addListener(setupContextMenu);

// ─── Context menu click ───────────────────────────────────────────────────────

menus.onClicked.addListener(async (info, tab) => {
  const { menuItemId } = info;
  const isLink    = menuItemId === MENU_ID_SAVE || menuItemId === MENU_ID_SAVE_TAGS;
  const isPage    = menuItemId === MENU_ID_SAVE_PAGE || menuItemId === MENU_ID_SAVE_PAGE_TAGS;
  const isMail    = menuItemId === MENU_ID_SAVE_MAIL;
  const withTags  = menuItemId === MENU_ID_SAVE_TAGS || menuItemId === MENU_ID_SAVE_PAGE_TAGS;
  if (!isLink && !isPage && !isMail) return;

  // Mail-Save hat keine Tags-Variante — url/html/title/author kommen komplett
  // aus buildMailPayload(), nicht aus dem Tab (es gibt für message_list auch
  // keinen sinnvollen Content-Tab).
  let mailPayload = null;
  if (isMail) {
    mailPayload = await buildMailPayload(info);
    if (!mailPayload) return;
  }

  const url   = isMail ? mailPayload.url : (isLink ? info.linkUrl : tab?.url);
  const tabId = tab?.id;
  if (!url) return;

  const { nextcloudUrl, username, appPassword, backendKind } = await getCredentials();

  // No credentials yet → show notification + open settings
  if (!nextcloudUrl || !username || !appPassword) {
    await fallbackNotify('error', t('notification_configureCredentials'));
    await sleep(700);
    browser.runtime.openOptionsPage();
    return;
  }

  // host_permissions ist seit dem CORS-Fix nur noch optional und auf die
  // konkrete Nextcloud-Origin beschränkt (statt <all_urls>) — wird normalerweise
  // schon beim Login in den Optionen erteilt (dort passiert das synchron-direkt
  // im Klick-Handler, siehe ensureHostPermission() in options.js). Hier können
  // wir die Permission NICHT per request() nachfordern: bis hier hin ist schon
  // ein await (getCredentials) gelaufen, und Thunderbird/Firefox verlangt für
  // permissions.request() eine ununterbrochene User-Geste direkt aus dem
  // Event-Handler — sonst "permissions.request may only be called from a user
  // input handler". Daher nur passiv prüfen (contains, kein await davor nötig)
  // und bei fehlender Berechtigung auf die Einstellungen verweisen, wo der
  // saubere Re-Grant passiert.
  const origin = originPatternFor(nextcloudUrl);
  if (origin && !(await browser.permissions.contains({ origins: [origin] }))) {
    await fallbackNotify('error', t('notification_needsPermission'));
    browser.runtime.openOptionsPage();
    return;
  }

  // ── Direct save (no dialog) ─────────────────────────────────────────────────
  if (!withTags) {
    // HTML-Capture funktioniert nur in echten Content-Tabs, siehe
    // captureTabHtml-Kommentar — schlägt sie fehl, bleibt html null und der
    // Server macht wie bisher seinen eigenen Fetch. Für Mail-Save kommt html
    // schon fertig aus buildMailPayload().
    const html = isMail ? mailPayload.html : (isPage ? await captureTabHtml(tabId) : null);
    await saveToMerlin({
      nextcloudUrl, username, appPassword, backendKind, url, tabId, tags: [], html,
      title:  isMail ? mailPayload.title : null,
      author: isMail ? mailPayload.author : null,
    });
    return;
  }

  // ── Save with tags — open dialog ────────────────────────────────────────────
  await browser.storage.local.set({
    _merlinPendingSave: { url, tabId, nextcloudUrl, username, appPassword, backendKind, isPage },
  });

  try {
    await browser.windows.create({
      url:     browser.runtime.getURL('save-dialog.html'),
      type:    'popup',
      width:   460,
      height:  420,
    });
  } catch {
    // Fallback: save directly if window creation fails
    await browser.storage.local.remove('_merlinPendingSave');
    const html = isPage ? await captureTabHtml(tabId) : null;
    await saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, tabId, tags: [], html });
  }
});

// ─── API call ─────────────────────────────────────────────────────────────────

// merlin-server hat keine Pocket-kompatible Extension-API (/api/v1/add), die
// Tag-Namen serverseitig auflöst - Tag-IDs müssen hier vorab per /api/tags
// aufgelöst (bzw. bei Bedarf neu angelegt) werden.
async function resolveTagIdsStandalone(nextcloudUrl, creds, tagNames) {
  if (!tagNames || tagNames.length === 0) return [];

  const base = nextcloudUrl.replace(/\/$/, '');
  const headers = { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' };

  let existing = [];
  try {
    const resp = await fetch(`${base}/api/tags`, { method: 'GET', headers });
    if (resp.ok) existing = await resp.json();
  } catch { /* fällt unten auf "alle neu anlegen" zurück */ }

  const ids = [];
  for (const name of tagNames) {
    const match = existing.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (match) {
      ids.push(match.id);
      continue;
    }
    try {
      const resp = await fetch(`${base}/api/tags`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name }),
      });
      if (resp.ok) {
        const created = await resp.json();
        ids.push(created.id);
        existing.push(created);
      }
    } catch { /* einzelnes Tag konnte nicht angelegt werden - überspringen */ }
  }
  return ids;
}

async function saveToMerlin({ nextcloudUrl, username, appPassword, backendKind, url, tabId, tags = [], html = null, title = null, author = null }) {
  const creds = btoa(`${username}:${appPassword}`);

  let apiUrl, body;
  if (backendKind === 'standalone') {
    // merlin-server hat keine Pocket-kompatible Extension-API (/api/v1/add) -
    // stattdessen wird der native Endpunkt genutzt, den auch die Leseliste
    // (library.php) zum Hinzufügen nutzt. /api/articles akzeptiert html
    // genau wie /index.php/apps/merlin/api/v1/add unten (extractFromHtml()-
    // Pipeline ist ein 1:1-Port aus Nextcloud).
    apiUrl = `${nextcloudUrl.replace(/\/$/, '')}/api/articles`;
    const tagIds = await resolveTagIdsStandalone(nextcloudUrl, creds, tags);
    body = tagIds.length > 0 ? { url, tagIds } : { url };
    if (html) body.html = html;
    if (title) body.title = title;
    if (author) body.author = author;
  } else {
    apiUrl = `${nextcloudUrl.replace(/\/$/, '')}/index.php/apps/merlin/api/v1/add`;
    body = { url };
    if (tags && tags.length > 0) body.tags = tags;
    if (html) body.html = html;
    if (title) body.title = title;
    if (author) body.author = author;
  }

  let response;
  try {
    response = await fetch(apiUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    await injectFlyout(tabId, t('flyout_connectionFailed', [networkError.message]), 'error');
    return;
  }

  if (response.status === 401) {
    // Zugangsdaten sind ungültig geworden (z. B. App-Passwort widerrufen) —
    // löschen, damit der Nutzer gezwungen ist, sich erneut über den Login Flow zu verbinden.
    await clearCredentials();
    await notifyAuthFailed();
    await injectFlyout(tabId, t('flyout_authFailed'), 'error');
    return;
  }
  if (!response.ok) {
    await injectFlyout(tabId, t('flyout_serverError', [String(response.status)]), 'error');
    return;
  }

  // ── Immediately notify the user that the article was added ────────────────
  // We confirm success as soon as the server returns 2xx — no need to wait
  // for the full JSON body to be parsed.
  const message = tags && tags.length > 0
    ? t('flyout_articleAddedWithTags', [tags.join(', ')])
    : t('flyout_articleAdded');
  await injectFlyout(tabId, message, 'success');

  // Parse response in the background for potential future use (e.g. logging)
  try { await response.json(); } catch { /* ignore */ }
}

// ─── Flyout / notification ────────────────────────────────────────────────────
//
// In Thunderbird, active tabs are mail tabs (message display, compose, folder
// list) — browser.scripting.executeScript is not supported there.
// We therefore skip the scripting path entirely and always use the native
// desktop-notification API, which works reliably in Thunderbird.
//
// In Firefox, we still try to inject an in-page flyout toast and fall back to
// a notification only when scripting is blocked (privileged pages, PDFs, …).

async function injectFlyout(tabId, message, state) {
  if (IS_THUNDERBIRD || tabId == null) {
    await fallbackNotify(state, message);
    return;
  }

  const logoUrl = await getLogoDataUrl();

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      func:   renderFlyout,
      args:   [message, state, logoUrl],
    });
  } catch {
    // Scripting blocked (privileged page, pdf viewer, etc.)
    await fallbackNotify(state, message);
  }
}

// This function runs INSIDE the page context — must be fully self-contained.
function renderFlyout(message, state, logoUrl) {
  const ID      = '__merlin_ext_flyout__';
  const STYLE_ID = '__merlin_ext_styles__';

  // Inject keyframe animation once
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      @keyframes __merlin_spin { to { transform: rotate(360deg); } }
      @keyframes __merlin_in   { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
    `;
    document.head.appendChild(s);
  }

  let flyout = document.getElementById(ID);
  if (!flyout) {
    flyout = document.createElement('div');
    flyout.id = ID;
    Object.assign(flyout.style, {
      position:      'fixed',
      bottom:        '24px',
      right:         '24px',
      zIndex:        '2147483647',
      display:       'flex',
      alignItems:    'center',
      gap:           '11px',
      background:    '#fff',
      border:        '1px solid #e0e4ea',
      borderRadius:  '13px',
      boxShadow:     '0 6px 24px rgba(0,0,0,0.13)',
      padding:       '13px 16px',
      minWidth:      '230px',
      maxWidth:      '340px',
      fontFamily:    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      fontSize:      '13px',
      lineHeight:    '1.4',
      animation:     '__merlin_in 0.2s ease both',
      transition:    'opacity 0.25s ease, transform 0.25s ease',
    });
    document.body.appendChild(flyout);
  }

  // Clear auto-hide timer if updating
  clearTimeout(flyout.__hideTimer);

  // Build flyout content via DOM API (avoids unsafe innerHTML with dynamic values)
  flyout.replaceChildren();

  // Left column: logo + state badge
  const logoWrap = document.createElement('div');
  Object.assign(logoWrap.style, { flexShrink:'0', position:'relative', width:'50px', height:'50px' });

  const img = document.createElement('img');
  img.src = logoUrl;
  img.alt = 'Merlin';
  Object.assign(img.style, { width:'50px', height:'50px', borderRadius:'10px', display:'block' });
  logoWrap.appendChild(img);

  const badgeWrap = document.createElement('div');
  Object.assign(badgeWrap.style, {
    position:'absolute', bottom:'-4px', right:'-4px', background:'#fff',
    borderRadius:'50%', width:'20px', height:'20px',
    display:'flex', alignItems:'center', justifyContent:'center',
    boxShadow:'0 1px 4px rgba(0,0,0,0.18)',
  });

  const badgeEl = document.createElement('div');
  if (state === 'success') {
    badgeEl.textContent = '✓';
    Object.assign(badgeEl.style, { color:'#256029', fontSize:'12px', fontWeight:'700', lineHeight:'1' });
  } else if (state === 'error') {
    badgeEl.textContent = '✕';
    Object.assign(badgeEl.style, { color:'#9b1c1c', fontSize:'12px', fontWeight:'700', lineHeight:'1' });
  } else {
    Object.assign(badgeEl.style, {
      width:'12px', height:'12px',
      border:'2px solid #0082c9', borderTopColor:'transparent',
      borderRadius:'50%', animation:'__merlin_spin 0.75s linear infinite',
    });
  }
  badgeWrap.appendChild(badgeEl);
  logoWrap.appendChild(badgeWrap);
  flyout.appendChild(logoWrap);

  // Right column: label + message
  const textCol = document.createElement('div');
  Object.assign(textCol.style, { flex:'1', minWidth:'0' });

  const label = document.createElement('div');
  label.textContent = 'Merlin';
  Object.assign(label.style, {
    fontWeight:'700', color:'#0082c9', fontSize:'12px',
    letterSpacing:'.03em', textTransform:'uppercase', marginBottom:'2px',
  });
  textCol.appendChild(label);

  const msgEl = document.createElement('div');
  msgEl.textContent = message;
  Object.assign(msgEl.style, { color:'#444', overflow:'hidden', textOverflow:'ellipsis' });
  textCol.appendChild(msgEl);

  flyout.appendChild(textCol);

  // Auto-dismiss after 3.5 s for finished states
  if (state !== 'loading') {
    flyout.__hideTimer = setTimeout(() => {
      flyout.style.opacity   = '0';
      flyout.style.transform = 'translateY(10px)';
      setTimeout(() => flyout.remove(), 280);
    }, 3500);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function notifyAuthFailed() {
  return browser.notifications.create({
    type:    'basic',
    iconUrl: browser.runtime.getURL('icons/icon-48.png'),
    title:   t('notification_authFailedTitle'),
    message: t('notification_authFailedMessage'),
  });
}

function fallbackNotify(state, message) {
  const titles = {
    success: t('notification_savedTitle'),
    error:   t('notification_errorTitle'),
    loading: t('notification_loadingTitle'),
  };
  return browser.notifications.create({
    type:    'basic',
    iconUrl: browser.runtime.getURL('icons/icon-48.png'),
    title:   titles[state] ?? t('notification_defaultTitle'),
    message,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// host_permissions ist nur noch optional (manifest.json) und auf die jeweils
// konfigurierte Nextcloud-Origin beschränkt — diese Helper-Funktion baut das
// Match-Pattern dafür. Duplikat von options.js: separate Skript-Kontexte ohne
// gemeinsames Modul-System, daher keine sinnvolle gemeinsame Datei dafür.
function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}
