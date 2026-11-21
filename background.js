'use strict';

// Shared helpers (t, sleep, credentials, URL checks, auth-failure handling,
// tag API helpers) come from common.js, which manifest.json loads before
// this file (after crypto.js).

const MENU_ID_SAVE           = 'merlin-save-link';
const MENU_ID_SAVE_TAGS      = 'merlin-save-with-tags';
const MENU_ID_SAVE_PAGE      = 'merlin-save-page';
const MENU_ID_SAVE_PAGE_TAGS = 'merlin-save-page-with-tags';
const MENU_ID_SAVE_MAIL      = 'merlin-save-mail';
const MENU_ID_SAVE_MAIL_TAGS = 'merlin-save-mail-with-tags';
const MENU_ID_MAIL_CONTENT      = 'merlin-save-mail-content';
const MENU_ID_MAIL_CONTENT_TAGS = 'merlin-save-mail-content-with-tags';

const COMMAND_SAVE_MAIL = 'save-mail';

// Tab types that show an email (3-pane mail tab, message tab/window). A
// right-click into the message body there has the "page" context, but there
// is no web page to save — those tabs get the "send email content" items.
const MAIL_VIEW_TAB_TYPES = new Set(['mail', 'messageDisplay']);

// Upper bound for one multi-selection save, so a mistaken "select all" in a
// big folder doesn't send thousands of emails.
const MAX_MAILS_PER_SAVE = 50;

// Upper bound for the page HTML sent along with a page save. Larger pages
// (e.g. with embedded data: images) are saved by URL only, and the server
// fetches them itself.
const MAX_HTML_BYTES = 10 * 1024 * 1024;

// Request timeouts. Saving gets more time because it may upload up to
// 10 MB of HTML.
const SAVE_TIMEOUT_MS = 60_000;
const TAGS_TIMEOUT_MS = 10_000;

const PENDING_SAVE_PREFIX = '_merlinPendingSave_';
const LOGIN_POLL_ALARM    = 'merlin-login-poll';

// Size of the "save with tags" window: tall enough for the tag tree and the
// buttons below Thunderbird's window title bar.
const SAVE_DIALOG_SIZE = { width: 460, height: 640 };

// ─── Migration: old storage layouts → encrypted storage.local ────────────────
//
// Earlier versions knew two other places for the credentials:
//   1. Plain-text fields directly in storage.local (nextcloudUrl/username/
//      appPassword).
//   2. A passphrase-encrypted copy in storage.sync (credEnc + encPassphrase).
// Both are replaced by the encrypted storage.local entry (see crypto.js).
// Existing installs are migrated once; leftovers are removed, including the
// old single-slot pending save, which held the app password in plain text.
async function migrateCredentialsToEncryptedLocal() {
  const { credEnc, nextcloudUrl, username, appPassword } = await browser.storage.local.get([
    'credEnc', 'nextcloudUrl', 'username', 'appPassword',
  ]);

  if (!credEnc && nextcloudUrl && username && appPassword) {
    await setCredentials({ nextcloudUrl, username, appPassword });
  }

  await browser.storage.local.remove([
    'nextcloudUrl', 'username', 'appPassword', 'encPassphrase', '_merlinPendingSave',
  ]);

  try { await browser.storage.sync.remove(['credEnc', 'encPassphrase']); } catch { /* storage.sync may be unavailable */ }
}

browser.runtime.onInstalled.addListener(migrateCredentialsToEncryptedLocal);
browser.runtime.onStartup.addListener(migrateCredentialsToEncryptedLocal);

// ─── Login Flow polling ───────────────────────────────────────────────────────
//
// Polling runs here rather than on the options page, so it survives the user
// switching away from the options tab. The result is written to
// storage.local, where the options page picks it up via storage.onChanged.
//
// Under Manifest V3 the background script is a non-persistent event page that
// Thunderbird may unload at any time. The full flow state therefore lives in
// storage.local (_merlinLoginFlow), and an alarm wakes the page every 30 s.
// If no poll is running in memory at that point, it resumes from the stored
// state; once the deadline has passed, the flow ends with a timeout message
// instead of hanging silently.

const LOGIN_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

let _lfTimer  = null;
let _lfActive = false;

async function startBackgroundLoginPoll({ pollEndpoint, pollToken, serverUrl, loginTabId, backendKind }) {
  _lfStopTimer();

  // The poll token (and the response carrying the app password) may only be
  // exchanged with the server the user entered.
  if (typeof pollToken !== 'string' || !pollToken
      || !sameOrigin(pollEndpoint, serverUrl) || !isAllowedServerUrl(pollEndpoint)) {
    await browser.storage.local.set({ _merlinLoginFlowResult: { error: t('options_loginInvalidResponse') } });
    return;
  }

  const flow = {
    active: true,
    loginTabId,
    pollEndpoint,
    pollToken,
    serverUrl,
    backendKind,
    deadline: Date.now() + LOGIN_FLOW_TIMEOUT_MS,
  };
  await browser.storage.local.set({ _merlinLoginFlow: flow });
  browser.alarms.create(LOGIN_POLL_ALARM, { periodInMinutes: 0.5 });

  _lfRun(flow, 2000);
}

function _lfStopTimer() {
  _lfActive = false;
  clearTimeout(_lfTimer);
  _lfTimer = null;
}

function _lfRun(flow, delayMs) {
  _lfActive = true;

  async function poll() {
    if (!_lfActive) return;

    if (Date.now() > flow.deadline) {
      await _lfFinish({ error: t('options_loginTimeout') });
      return;
    }

    try {
      const r = await fetch(flow.pollEndpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `token=${encodeURIComponent(flow.pollToken)}`,
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

      await _lfFinish({ creds, serverUrl: flow.serverUrl, backendKind: flow.backendKind });
    } catch {
      // Transient network error — keep retrying
      if (_lfActive) _lfTimer = setTimeout(poll, 2000);
    }
  }

  _lfTimer = setTimeout(poll, delayMs);
}

// Resumes a stored flow after Thunderbird unloaded the event page (alarm) or
// was restarted (onStartup).
async function resumeBackgroundLoginPoll() {
  if (_lfActive) return;
  const { _merlinLoginFlow: flow } = await browser.storage.local.get('_merlinLoginFlow');
  if (!flow?.active || !flow.pollEndpoint) {
    await browser.alarms.clear(LOGIN_POLL_ALARM);
    return;
  }
  if (Date.now() > (flow.deadline ?? 0)) {
    await _lfFinish({ error: t('options_loginTimeout') });
    return;
  }
  _lfRun(flow, 0);
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOGIN_POLL_ALARM) resumeBackgroundLoginPoll();
});
browser.runtime.onStartup.addListener(resumeBackgroundLoginPoll);

async function cancelBackgroundLoginPoll() {
  _lfStopTimer();
  await browser.alarms.clear(LOGIN_POLL_ALARM);
  await browser.storage.local.remove('_merlinLoginFlow');
  await browser.storage.local.set({ _merlinLoginFlowResult: { cancelled: true } });
}

async function _lfFinish({ creds, serverUrl, backendKind, error }) {
  _lfStopTimer();
  await browser.alarms.clear(LOGIN_POLL_ALARM);

  const { _merlinLoginFlow } = await browser.storage.local.get('_merlinLoginFlow');
  const loginTabId = _merlinLoginFlow?.loginTabId;
  await browser.storage.local.remove('_merlinLoginFlow');

  if (!error) {
    const valid = creds
      && typeof creds.loginName === 'string' && creds.loginName
      && typeof creds.appPassword === 'string' && creds.appPassword;
    if (!valid) error = t('options_loginInvalidResponse');
  }

  if (error) {
    await browser.storage.local.set({ _merlinLoginFlowResult: { error } });
    return;
  }

  // The poll response may only replace the server URL if it is same-origin
  // with the URL the user entered — otherwise a compromised server could
  // silently redirect future save traffic (including the newly issued app
  // password) to another origin.
  const finalServerUrl = serverBase(sameOrigin(creds.server, serverUrl) ? creds.server : serverUrl);
  await setCredentials({
    nextcloudUrl: finalServerUrl,
    username:     creds.loginName,
    appPassword:  creds.appPassword,
    backendKind,
  });
  await resetAuthFailures();

  // Close the login tab
  if (loginTabId != null) browser.tabs.remove(loginTabId).catch(() => {});

  // Notify the options page via storage (in case it is still open)
  await browser.storage.local.set({
    _merlinLoginFlowResult: {
      success:   true,
      serverUrl: finalServerUrl,
      loginName: creds.loginName,
    },
  });

  // Return to the settings: focuses an open options page or opens a new one.
  browser.runtime.openOptionsPage().catch(() => {});
}

// ─── Message handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  // Only accept messages from this add-on's own pages (options page, save
  // dialog) — keeps a future content script or another add-on from calling
  // startBackgroundLoginPoll() with its own endpoint/server values.
  if (sender.id !== browser.runtime.id) return;

  if (msg.type === 'merlin:startLoginPoll') {
    startBackgroundLoginPoll(msg);
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:cancelLoginPoll') {
    cancelBackgroundLoginPoll();
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:saveWithTags') {
    handleSaveWithTags(msg.saveId, msg.tags ?? []);
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'merlin:cancelSave') {
    takePendingSave(msg.saveId).then(p => {
      if (p?.windowId != null) browser.windows.remove(p.windowId).catch(() => {});
    });
    return Promise.resolve({ ok: true });
  }
});

// ─── Pending saves (tag dialog) ───────────────────────────────────────────────
//
// Each open tag dialog gets its own entry (its own ID instead of one global
// slot), so several open dialogs don't overwrite each other. The entry holds
// no credentials — they are read fresh via getCredentials() when saving, so
// the app password never sits unencrypted in storage.local. Closing the
// dialog with the window's close button cleans up the entry via
// windows.onRemoved; leftovers from the previous session are removed on
// startup.

function pendingSaveKey(saveId) {
  return `${PENDING_SAVE_PREFIX}${saveId}`;
}

async function takePendingSave(saveId) {
  if (typeof saveId !== 'string' || !saveId) return null;
  const key = pendingSaveKey(saveId);
  const { [key]: pending } = await browser.storage.local.get(key);
  await browser.storage.local.remove(key);
  return pending ?? null;
}

async function removePendingSaves(filter) {
  const all = await browser.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(PENDING_SAVE_PREFIX) && filter(all[k]));
  if (keys.length) await browser.storage.local.remove(keys);
}

browser.windows.onRemoved.addListener((windowId) => {
  removePendingSaves(p => p?.windowId === windowId).catch(() => {});
});
browser.runtime.onStartup.addListener(() => {
  removePendingSaves(() => true).catch(() => {});
});

// ─── Save with tags (called from the save dialog) ─────────────────────────────

async function handleSaveWithTags(saveId, tags) {
  // Take the entry first, then close the window — otherwise windows.onRemoved
  // could clean it up before we read it.
  const pending = await takePendingSave(saveId);
  if (!pending) return;
  if (pending.windowId != null) browser.windows.remove(pending.windowId).catch(() => {});

  const creds = await getCredentials();
  if (!creds.nextcloudUrl || !creds.username || !creds.appPassword) {
    await notify('error', t('notification_configureCredentials'));
    return;
  }

  // Emails: the entry only holds message IDs; the content is read now.
  if (pending.kind === 'mail') {
    const headers = [];
    for (const id of pending.messageIds ?? []) {
      try { headers.push(await browser.messages.get(id)); } catch { /* message gone */ }
    }
    await saveMails(creds, headers, tags);
    return;
  }

  // The HTML is only captured now, so it never has to sit in storage.local.
  // The tab still exists: the save dialog is a separate popup window.
  const { url, tabId, isPage } = pending;
  let html = null;
  if (isPage && tabId != null) html = await captureTabHtml(tabId);

  await saveToMerlin({ ...creds, url, tags, html });
}

// ─── HTML capture for page saves ──────────────────────────────────────────────
//
// Only works in real content tabs (e.g. a link opened in a new tab, or an RSS
// article tab). In mail tabs (message view/list, compose)
// scripting.executeScript is unavailable and throws; the catch then falls
// back to a URL-only save.
async function captureTabHtml(tabId) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      // Runs in the page. Pages over the limit return null and are saved by
      // URL only. The UTF-16 length is never larger than the UTF-8 byte
      // size, hence the cheap pre-check.
      func: (maxBytes) => {
        const html = document.documentElement.outerHTML;
        if (html.length > maxBytes) return null;
        return new Blob([html]).size > maxBytes ? null : html;
      },
      args: [MAX_HTML_BYTES],
    });
    return results?.[0]?.result ?? null;
  } catch {
    return null;
  }
}

// ─── Save an email as an article ──────────────────────────────────────────────
//
// Uses browser.messages.* (messagesRead permission) instead of
// scripting.executeScript, so unlike the page capture above it also works
// directly in the message list. Subject and sender are sent as title/author
// so they override the server-side extractor (see ExtensionController::add()
// in merlin-nextcloud and ArticleController::create() in merlin-server) — for
// a plain-text mail the extraction from the wrapped HTML would not find a
// usable title or author otherwise.

async function buildMailPayload(header) {
  if (!header) return null;

  let full;
  try {
    full = await browser.messages.getFull(header.id, { decodeContent: true });
  } catch {
    return null;
  }

  // Prefer the HTML part (e.g. HTML newsletters), otherwise wrap the plain
  // text in minimal HTML.
  const htmlPart  = findPartByType(full, 'text/html');
  const plainPart = htmlPart ? null : findPartByType(full, 'text/plain');
  const html = htmlPart
    ? htmlPart.body
    : wrapPlainTextAsHtml(header.subject, plainPart?.body ?? '');

  // The Message-ID header gives a stable pseudo URL that is unique per
  // message (emails have no real URL, but the field is required). Falls back
  // to Thunderbird's internal numeric ID if the header is missing.
  const rawMessageId   = full.headers?.['message-id']?.[0] ?? String(header.id);
  const cleanMessageId = rawMessageId.replace(/^<|>$/g, '');
  const url = `mail://message/${encodeURIComponent(cleanMessageId)}`;

  return {
    kind: 'mail',
    url,
    html,
    title:  header.subject || null,
    author: formatMailAuthor(header.author),
  };
}

// Depth-first search through the MIME tree of messages.getFull() for the
// first part with a matching content type (case-insensitive prefix match
// because of parameters like "; charset=...").
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

  // <title> is only a fallback — normally the server overrides it with the
  // subject sent separately.
  return `<html><head><title>${escape(subject || '')}</title></head><body>${paragraphs}</body></html>`;
}

// header.author is "Name <email@address>" (or just the bare address). Strip
// the angle brackets for a cleaner author string, but only if a name is left.
function formatMailAuthor(author) {
  if (!author) return null;
  const stripped = author.replace(/\s*<[^>]*>\s*$/, '').trim();
  return stripped || author;
}

// ─── Which emails a click refers to ───────────────────────────────────────────

// Message lists can be paged (MessageList with an `id` for continueList);
// older APIs return plain arrays. Collects up to MAX_MAILS_PER_SAVE headers.
async function collectMessages(list) {
  if (!list) return [];
  if (Array.isArray(list)) return list.slice(0, MAX_MAILS_PER_SAVE);
  const headers = [...(list.messages ?? [])];
  let listId = list.id;
  while (listId && headers.length < MAX_MAILS_PER_SAVE) {
    const next = await browser.messages.continueList(listId);
    headers.push(...(next.messages ?? []));
    listId = next.id;
  }
  if (listId) {
    try { await browser.messages.abortList(listId); } catch { /* older Thunderbird */ }
  }
  return headers.slice(0, MAX_MAILS_PER_SAVE);
}

// The email(s) shown in a message pane, message tab or message window.
async function displayedMessages(tab) {
  if (tab?.id == null) return [];
  try {
    return await collectMessages(await browser.messageDisplay.getDisplayedMessages(tab.id));
  } catch {
    return [];
  }
}

// The emails selected in the message list of a 3-pane mail tab.
async function selectedMessages(tab) {
  if (tab?.id == null) return [];
  try {
    return await collectMessages(await browser.mailTabs.getSelectedMessages(tab.id));
  } catch {
    return [];
  }
}

// For the toolbar button and the keyboard shortcut: in a mail tab the
// selected emails, in a message tab/window the displayed one.
async function messagesForTab(tab) {
  if (tab?.type === 'mail') {
    const selected = await selectedMessages(tab);
    if (selected.length) return selected;
  }
  return displayedMessages(tab);
}

// ─── Context menu setup ───────────────────────────────────────────────────────
//
// Thunderbird's primary API is browser.menus; browser.contextMenus is only a
// partial alias there and does NOT fire reliably in the message display pane.

function setupContextMenu() {
  browser.menus.removeAll().then(() => {
    browser.menus.create({
      id:       MENU_ID_SAVE,
      title:    t('contextMenu_saveLink'),
      contexts: ['link'],
    });
    browser.menus.create({
      id:       MENU_ID_SAVE_TAGS,
      title:    t('contextMenu_saveLinkWithTags'),
      contexts: ['link'],
    });
    // Page items are for content tabs (opened links, RSS articles). In tabs
    // that show an email, onShown swaps them for the email-content items.
    browser.menus.create({
      id:       MENU_ID_SAVE_PAGE,
      title:    t('contextMenu_savePage'),
      contexts: ['page', 'selection', 'image'],
    });
    browser.menus.create({
      id:       MENU_ID_SAVE_PAGE_TAGS,
      title:    t('contextMenu_savePageWithTags'),
      contexts: ['page', 'selection', 'image'],
    });
    browser.menus.create({
      id:       MENU_ID_MAIL_CONTENT,
      title:    t('contextMenu_saveMailContent'),
      contexts: ['page', 'selection', 'image'],
      visible:  false,
    });
    browser.menus.create({
      id:       MENU_ID_MAIL_CONTENT_TAGS,
      title:    t('contextMenu_saveMailContentWithTags'),
      contexts: ['page', 'selection', 'image'],
      visible:  false,
    });
    // Right-click on messages in the message list (thread pane).
    browser.menus.create({
      id:       MENU_ID_SAVE_MAIL,
      title:    t('contextMenu_saveMail'),
      contexts: ['message_list'],
    });
    browser.menus.create({
      id:       MENU_ID_SAVE_MAIL_TAGS,
      title:    t('contextMenu_saveMailWithTags'),
      contexts: ['message_list'],
    });
  });
}

browser.runtime.onInstalled.addListener(setupContextMenu);
browser.runtime.onStartup.addListener(setupContextMenu);

// Shows the page items only in content tabs and the email-content items only
// where an email is displayed. In the compose window neither makes sense.
browser.menus.onShown.addListener((info, tab) => {
  const isPageMenu = ['page', 'selection', 'image'].some(c => info.contexts.includes(c));
  if (!isPageMenu) return;
  const inMail    = MAIL_VIEW_TAB_TYPES.has(tab?.type);
  const inCompose = tab?.type === 'messageCompose';
  const pageVisible = !inMail && !inCompose;
  for (const id of [MENU_ID_SAVE_PAGE, MENU_ID_SAVE_PAGE_TAGS]) {
    browser.menus.update(id, { visible: pageVisible });
  }
  for (const id of [MENU_ID_MAIL_CONTENT, MENU_ID_MAIL_CONTENT_TAGS]) {
    browser.menus.update(id, { visible: inMail });
  }
  browser.menus.refresh();
});

// ─── Common checks before any save ────────────────────────────────────────────

// Returns the credentials when a save can go ahead, otherwise tells the user
// what is missing (and opens the settings) and returns null.
async function readyCredentials() {
  const creds = await getCredentials();
  const { nextcloudUrl, username, appPassword } = creds;

  // No credentials yet → show notification + open settings
  if (!nextcloudUrl || !username || !appPassword) {
    await notify('error', t('notification_configureCredentials'));
    await sleep(700);
    browser.runtime.openOptionsPage();
    return null;
  }

  // Older installs may still have an http:// URL stored.
  if (!isAllowedServerUrl(nextcloudUrl)) {
    await notify('error', t('flyout_httpBlocked'));
    browser.runtime.openOptionsPage();
    return null;
  }

  // The host permission is optional and limited to the configured server's
  // origin; it is granted on login in the options page. It can NOT be
  // requested here: an await has already run, and Thunderbird requires an
  // uninterrupted user gesture for permissions.request(). So only check it
  // and point the user to the settings if it is missing.
  const origin = originPatternFor(nextcloudUrl);
  if (origin && !(await browser.permissions.contains({ origins: [origin] }))) {
    await notify('error', t('notification_needsPermission'));
    browser.runtime.openOptionsPage();
    return null;
  }

  return creds;
}

// ─── Context menu click ───────────────────────────────────────────────────────

browser.menus.onClicked.addListener(async (info, tab) => {
  const { menuItemId } = info;
  const isLink    = menuItemId === MENU_ID_SAVE || menuItemId === MENU_ID_SAVE_TAGS;
  const isPage    = menuItemId === MENU_ID_SAVE_PAGE || menuItemId === MENU_ID_SAVE_PAGE_TAGS;
  const isList    = menuItemId === MENU_ID_SAVE_MAIL || menuItemId === MENU_ID_SAVE_MAIL_TAGS;
  const isContent = menuItemId === MENU_ID_MAIL_CONTENT || menuItemId === MENU_ID_MAIL_CONTENT_TAGS;
  const withTags  = [MENU_ID_SAVE_TAGS, MENU_ID_SAVE_PAGE_TAGS, MENU_ID_SAVE_MAIL_TAGS, MENU_ID_MAIL_CONTENT_TAGS]
    .includes(menuItemId);
  if (!isLink && !isPage && !isList && !isContent) return;

  // ── Emails ──────────────────────────────────────────────────────────────────
  if (isList || isContent) {
    const headers = isList
      ? await collectMessages(info.selectedMessages)
      : await displayedMessages(tab);
    await startMailSave(headers, withTags, tab);
    return;
  }

  // ── Links and pages ─────────────────────────────────────────────────────────
  const url   = isLink ? info.linkUrl : tab?.url;
  const tabId = tab?.id;
  if (!url) return;

  const creds = await readyCredentials();
  if (!creds) return;

  if (!withTags) {
    // For page saves, send the rendered HTML so the server can skip its own
    // fetch (paywalled and JS-rendered pages). Link saves are fetched by the
    // server directly.
    const html = isPage ? await captureTabHtml(tabId) : null;
    await saveToMerlin({ ...creds, url, tags: [], html });
    return;
  }

  await openSaveDialog({ url, tabId, isPage }, tab?.windowId, async () => {
    const html = isPage ? await captureTabHtml(tabId) : null;
    await saveToMerlin({ ...creds, url, html, tags: [] });
  });
});

// ─── Toolbar button in the message header and keyboard shortcut ───────────────

browser.messageDisplayAction.onClicked.addListener(async (tab) => {
  await startMailSave(await displayedMessages(tab), false, tab);
});

browser.commands.onCommand.addListener(async (command, tab) => {
  if (command !== COMMAND_SAVE_MAIL) return;
  if (!tab) {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  }
  await startMailSave(await messagesForTab(tab), false, tab);
});

// ─── Saving emails ────────────────────────────────────────────────────────────

async function startMailSave(headers, withTags, tab) {
  if (!headers.length) {
    await notify('error', t('flyout_noMailSelected'));
    return;
  }

  const creds = await readyCredentials();
  if (!creds) return;

  if (!withTags) {
    await saveMails(creds, headers, []);
    return;
  }

  // The dialog shows the subject (one email) or the number of emails; the
  // entry only holds message IDs, the content is read when saving.
  const label = headers.length === 1
    ? (headers[0].subject || formatMailAuthor(headers[0].author) || '')
    : t('saveDialog_mailCount', [String(headers.length)]);
  const pending = { kind: 'mail', url: label, messageIds: headers.map(h => h.id) };
  await openSaveDialog(pending, tab?.windowId, () => saveMails(creds, headers, []));
}

// Saves each email as its own article. One email gets the usual detailed
// notification; several get one summary at the end. A fatal error (login
// rejected, server unreachable) stops the batch.
async function saveMails(creds, headers, tags) {
  if (!headers.length) {
    await notify('error', t('flyout_noMailSelected'));
    return;
  }

  if (headers.length === 1) {
    const payload = await buildMailPayload(headers[0]);
    if (!payload) { await notify('error', t('flyout_mailReadFailed')); return; }
    await saveToMerlin({ ...creds, ...payload, tags });
    return;
  }

  let saved = 0;
  let lastError = null;
  for (const header of headers) {
    const payload = await buildMailPayload(header);
    if (!payload) { lastError = { message: t('flyout_mailReadFailed') }; continue; }
    const result = await postArticle({ ...creds, ...payload, tags });
    if (result.ok) {
      saved++;
      continue;
    }
    lastError = result;
    if (result.fatal) break;
  }

  if (saved === headers.length) {
    await notify('success', t('flyout_mailsSaved', [String(saved)]));
  } else if (saved > 0) {
    await notify('error', t('flyout_mailsSavedPartial', [String(saved), String(headers.length)]));
  } else if (lastError && !lastError.silent) {
    await notify('error', lastError.message);
  }
}

// ─── Save dialog ──────────────────────────────────────────────────────────────

// Opens the "save with tags" window for `pending` (stored under its own ID).
// If the window cannot be opened, `fallback` saves without tags.
async function openSaveDialog(pending, windowId, fallback) {
  const saveId = crypto.randomUUID();
  const key    = pendingSaveKey(saveId);
  await browser.storage.local.set({ [key]: { ...pending, windowId: null } });

  try {
    const pos = await centeredPosition(SAVE_DIALOG_SIZE, windowId);
    const win = await browser.windows.create({
      url:  browser.runtime.getURL(`save-dialog.html?id=${encodeURIComponent(saveId)}`),
      type: 'popup',
      ...SAVE_DIALOG_SIZE,
      ...pos,
    });
    // left/top are not always honoured on create; set them again.
    if (pos && win?.id != null) {
      await browser.windows.update(win.id, pos).catch(() => {});
    }
    // Record the window ID so windows.onRemoved can clean up the entry. If
    // the dialog has already saved in the meantime, the entry is gone and is
    // not recreated.
    const { [key]: stored } = await browser.storage.local.get(key);
    if (stored) await browser.storage.local.set({ [key]: { ...stored, windowId: win.id } });
  } catch {
    await browser.storage.local.remove(key);
    await fallback();
  }
}

// ─── Dialog position ──────────────────────────────────────────────────────────

// Centers a window of `size` on the screen the Thunderbird window is on. The
// background page's `screen` describes the screen Thunderbird runs on; if the
// Thunderbird window lies on another monitor, center over that window instead
// (on a maximized window that is the middle of that screen too).
async function centeredPosition(size, windowId) {
  const center = (area) => ({
    left: Math.round(area.left + Math.max(0, (area.width  - size.width)  / 2)),
    top:  Math.round(area.top  + Math.max(0, (area.height - size.height) / 2)),
  });

  let mainWin = null;
  try {
    mainWin = windowId != null
      ? await browser.windows.get(windowId)
      : await browser.windows.getLastFocused();
  } catch { /* ignore */ }

  const scr = globalThis.screen;
  const screenArea = scr && scr.availWidth > 0 ? {
    left:   scr.availLeft ?? 0,
    top:    scr.availTop  ?? 0,
    width:  scr.availWidth,
    height: scr.availHeight,
  } : null;

  if (mainWin?.width > 0 && mainWin?.height > 0) {
    const cx = mainWin.left + mainWin.width  / 2;
    const cy = mainWin.top  + mainWin.height / 2;
    const onScreen = screenArea
      && cx >= screenArea.left && cx < screenArea.left + screenArea.width
      && cy >= screenArea.top  && cy < screenArea.top  + screenArea.height;
    if (!onScreen) return center(mainWin);
  }
  return screenArea ? center(screenArea) : null;
}

// ─── API call ─────────────────────────────────────────────────────────────────

// merlin-server has no Pocket-style extension API (/api/v1/add) that resolves
// tag names on the server, so tag IDs are resolved (or created) here via
// /api/tags first. Also returns the names that could not be applied, so the
// notification can report them honestly.
async function resolveTagIdsStandalone(nextcloudUrl, authHeader, tagNames) {
  if (!tagNames || tagNames.length === 0) return { ids: [], failed: [] };

  const endpoint = tagsEndpoint(nextcloudUrl, 'standalone');
  const headers  = { 'Authorization': authHeader, 'Content-Type': 'application/json' };

  // Without the existing tag list every tag would be created again as a
  // duplicate — rather apply none and report that.
  let existing;
  try {
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!resp.ok) return { ids: [], failed: [...tagNames] };
    existing = normalizeTagList(await resp.json());
  } catch {
    return { ids: [], failed: [...tagNames] };
  }

  const ids = [];
  const failed = [];
  for (const name of tagNames) {
    const match = existing.find(tag => String(tag.name).toLowerCase() === name.toLowerCase());
    if (match) {
      ids.push(match.id);
      continue;
    }
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body:   JSON.stringify({ name }),
        signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
      });
      if (!resp.ok) { failed.push(name); continue; }
      const created = await resp.json();
      ids.push(created.id);
      existing.push(created);
    } catch {
      failed.push(name);
    }
  }
  return { ids, failed };
}

// Sends one article to the server. Returns { ok, message } — `message` is
// the text to show the user; `fatal` marks errors that will repeat for every
// further article (stop a batch), `silent` that the user was already told.
// `kind` only picks the wording of the success message: 'mail' → "Email
// saved", anything else → "URL saved".
async function postArticle({ nextcloudUrl, username, appPassword, backendKind, url, tags = [], html = null, title = null, author = null, kind = 'url' }) {
  if (!isAllowedServerUrl(nextcloudUrl)) {
    return { ok: false, fatal: true, message: t('flyout_httpBlocked') };
  }

  const authHeader = basicAuthHeader(username, appPassword);
  let failedTags = [];

  let apiUrl, body;
  if (backendKind === 'standalone') {
    // merlin-server uses its native /api/articles endpoint, which accepts
    // html, title and author exactly like the Nextcloud app's /api/v1/add.
    apiUrl = `${serverBase(nextcloudUrl)}/api/articles`;
    const { ids: tagIds, failed } = await resolveTagIdsStandalone(nextcloudUrl, authHeader, tags);
    failedTags = failed;
    body = tagIds.length > 0 ? { url, tagIds } : { url };
  } else {
    apiUrl = `${serverBase(nextcloudUrl)}/index.php/apps/merlin/api/v1/add`;
    body = { url };
    if (tags && tags.length > 0) body.tags = tags;
  }
  if (html) body.html = html;
  if (title) body.title = title;
  if (author) body.author = author;

  let response;
  try {
    response = await fetch(apiUrl, {
      method:  'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch (networkError) {
    const message = networkError?.name === 'TimeoutError'
      ? t('flyout_timeout')
      : t('flyout_connectionFailed', [networkError.message]);
    return { ok: false, fatal: true, message };
  }

  if (response.status === 401) {
    // Credentials are only cleared on the second 401 in a row (see
    // recordAuthFailure in common.js), which then also shows its own
    // "please log in again" notification.
    const cleared = await recordAuthFailure();
    return { ok: false, fatal: true, silent: cleared, message: t('flyout_authFailedRetry') };
  }
  if (!response.ok) {
    // The Nextcloud backend rejects known unscrapable domains (see
    // content-filters/$unsupported.xml there) synchronously. merlin-server
    // may not know this error shape (yet) — then the generic branch applies.
    let payload = null;
    try { payload = await response.clone().json(); } catch { /* no JSON body */ }
    if (payload && payload.error === 'unsupported_site' && payload.domain) {
      return { ok: false, message: t('flyout_unsupportedSite', [payload.domain]) };
    }
    return { ok: false, message: t('flyout_serverError', [String(response.status)]) };
  }

  await resetAuthFailures();

  // Confirm as soon as the server returns 2xx — content extraction runs
  // asynchronously on the server; no need to wait for it here.
  const isMail = kind === 'mail';
  if (failedTags.length > 0) {
    const key = isMail ? 'flyout_mailSavedTagsFailed' : 'flyout_urlSavedTagsFailed';
    return { ok: true, message: t(key, [failedTags.join(', ')]) };
  }
  if (tags && tags.length > 0) {
    const key = isMail ? 'flyout_mailSavedWithTags' : 'flyout_urlSavedWithTags';
    return { ok: true, message: t(key, [tags.join(', ')]) };
  }
  return { ok: true, message: t(isMail ? 'flyout_mailSaved' : 'flyout_urlSaved') };
}

// Sends one article and reports the result as a notification.
async function saveToMerlin(article) {
  const result = await postArticle(article);
  if (result.silent) return;
  await notify(result.ok ? 'success' : 'error', result.message);
}

// ─── Notifications ────────────────────────────────────────────────────────────
//
// Thunderbird's active tabs are mostly mail tabs (message view, compose,
// folder list), where browser.scripting cannot inject an in-page toast. The
// add-on therefore always reports results as a desktop notification: "Merlin"
// as the title, the actual result as the text. Success and error are told
// apart by the text itself, so the title doesn't repeat it.

function notify(state, message) {
  return showNotification(t('notification_defaultTitle'), message);
}
