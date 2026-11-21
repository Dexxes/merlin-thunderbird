'use strict';

// Runs crypto.js, common.js and background.js in a Node VM with a fake
// Thunderbird WebExtension API and checks the save, mail and login flows.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, readMessages, makeGetMessage } = require('./helpers');

const getMessage = makeGetMessage(readMessages('en'));
const msg = (key, subs) => getMessage(key, subs);

function listener() {
  const fns = [];
  return { addListener: f => fns.push(f), fire: (...args) => Promise.all(fns.map(f => f(...args))) };
}

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

// Builds a fresh background context. `mails` maps message IDs to
// { header, full } as returned by messages.get / messages.getFull.
function loadBackground({ mails = {} } = {}) {
  const env = {
    store: {}, notes: [], fetches: [], windows: [], alarms: [], menuUpdates: {},
    fetchImpl: async () => new Response('{}', { status: 201 }),
    displayed: [], selected: [],
  };
  const ev = {
    clicked: listener(), shown: listener(), msg: listener(), installed: listener(),
    startup: listener(), alarm: listener(), removed: listener(), action: listener(), command: listener(),
  };
  env.ev = ev;
  const header = id => mails[id].header;

  const browser = {
    i18n: { getMessage },
    storage: {
      local: {
        get: async (k) => {
          if (k == null) return structuredClone(env.store);
          const o = {};
          for (const x of [].concat(k)) if (x in env.store) o[x] = structuredClone(env.store[x]);
          return o;
        },
        set: async (o) => { Object.assign(env.store, structuredClone(o)); },
        remove: async (k) => { for (const x of [].concat(k)) delete env.store[x]; },
      },
      sync: { remove: async () => {} },
    },
    runtime: {
      id: 'me', getURL: p => `moz-extension://x/${p}`,
      onMessage: ev.msg, onInstalled: ev.installed, onStartup: ev.startup,
      openOptionsPage: async () => { env.notes.push(['openOptions']); },
    },
    menus: {
      removeAll: async () => {}, create: () => {}, refresh: () => {},
      update: (id, props) => { env.menuUpdates[id] = props; },
      onClicked: ev.clicked, onShown: ev.shown,
    },
    notifications: { create: async (o) => { env.notes.push([o.title, o.message]); } },
    permissions: { contains: async () => true },
    scripting: { executeScript: async () => [{ result: '<html>page</html>' }] },
    windows: {
      create: async (o) => { env.windows.push(o); return { id: 77 }; },
      update: async () => {}, remove: async () => {},
      get: async () => ({ left: 0, top: 0, width: 1600, height: 1000 }),
      getLastFocused: async () => ({}), onRemoved: ev.removed,
    },
    tabs: { remove: async () => {}, query: async () => [{ id: 3, type: 'mail' }] },
    alarms: { create: (n) => env.alarms.push(n), clear: async () => {}, onAlarm: ev.alarm },
    messages: {
      get: async id => header(id),
      getFull: async id => mails[id].full,
      continueList: async () => ({ id: null, messages: [] }),
      abortList: async () => {},
    },
    messageDisplay: { getDisplayedMessages: async () => ({ id: null, messages: env.displayed }) },
    mailTabs: { getSelectedMessages: async () => ({ id: null, messages: env.selected }) },
    messageDisplayAction: { onClicked: ev.action },
    commands: { onCommand: ev.command },
  };

  const ctx = {
    browser, AbortSignal, Response, Blob, TextEncoder, TextDecoder, btoa, atob, URL,
    setTimeout, clearTimeout, console, structuredClone, crypto: globalThis.crypto,
    fetch: (u, o) => { env.fetches.push([u, o]); return env.fetchImpl(u, o); },
    screen: { availWidth: 1920, availHeight: 1080, availLeft: 0, availTop: 0 },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['crypto.js', 'common.js', 'background.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  env.run = code => vm.runInContext(code, ctx);
  env.login = (fields = {}) => env.run(`setCredentials(${JSON.stringify({
    nextcloudUrl: 'https://cloud.example.com', username: 'u', appPassword: 'p', backendKind: 'nextcloud', ...fields,
  })})`);
  env.lastBody = () => JSON.parse(env.fetches.at(-1)[1].body);
  env.lastNote = () => env.notes.at(-1);
  return env;
}

function plainMail(id, subject, text, author = 'Anna <anna@example.org>') {
  return {
    header: { id, subject, author },
    full: {
      headers: { 'message-id': [`<${id}@example.org>`] },
      contentType: 'multipart/alternative',
      parts: [{ contentType: 'text/plain; charset=utf-8', body: text }],
    },
  };
}

let env;
beforeEach(async () => {
  env = loadBackground({ mails: { 1: plainMail(1, 'Hello', 'Hi\n\nThere <b>'), 2: plainMail(2, 'Second', 'Two') } });
  await env.login();
});

test('credentials are stored encrypted', () => {
  assert.ok(env.store.credEnc);
  assert.ok(!JSON.stringify(env.store).includes('"p"'));
});

test('direct link save', async () => {
  await env.ev.clicked.fire({ menuItemId: 'merlin-save-link', linkUrl: 'https://ex.org/a' }, { id: 1, type: 'mail' });
  assert.equal(env.fetches.at(-1)[0], 'https://cloud.example.com/index.php/apps/merlin/api/v1/add');
  assert.deepEqual(env.lastBody(), { url: 'https://ex.org/a' });
  assert.deepEqual(env.lastNote(), [msg('notification_defaultTitle'), msg('flyout_urlSaved')]);
});

test('page save sends the HTML and reports unsupported sites', async () => {
  env.fetchImpl = async () => new Response(JSON.stringify({ error: 'unsupported_site', domain: 'x.com' }), { status: 422 });
  await env.ev.clicked.fire({ menuItemId: 'merlin-save-page' }, { id: 1, type: 'content', url: 'https://x.com/p' });
  assert.equal(env.lastBody().html, '<html>page</html>');
  assert.equal(env.lastNote()[1], msg('flyout_unsupportedSite', ['x.com']));
});

test('only the second 401 in a row clears the credentials', async () => {
  env.fetchImpl = async () => new Response('', { status: 401 });
  const click = () => env.ev.clicked.fire({ menuItemId: 'merlin-save-link', linkUrl: 'https://ex.org/a' }, { id: 1 });
  await click();
  assert.ok(env.store.credEnc);
  assert.equal(env.lastNote()[1], msg('flyout_authFailedRetry'));
  await click();
  assert.ok(!env.store.credEnc);
  assert.deepEqual(env.lastNote(), [msg('notification_defaultTitle'), msg('saveDialog_authFailed')]);
});

test('http:// server URLs are refused before any request', async () => {
  await env.login({ nextcloudUrl: 'http://cloud.example.com' });
  await env.ev.clicked.fire({ menuItemId: 'merlin-save-link', linkUrl: 'https://ex.org/a' }, { id: 1 });
  assert.equal(env.fetches.length, 0);
  assert.equal(env.notes.at(-2)[1], msg('flyout_httpBlocked'));
});

test('context menu: page items in content tabs, mail-content items in mail tabs', async () => {
  await env.ev.shown.fire({ contexts: ['page'] }, { id: 1, type: 'content' });
  assert.equal(env.menuUpdates['merlin-save-page'].visible, true);
  assert.equal(env.menuUpdates['merlin-save-mail-content'].visible, false);
  await env.ev.shown.fire({ contexts: ['page'] }, { id: 1, type: 'messageDisplay' });
  assert.equal(env.menuUpdates['merlin-save-page'].visible, false);
  assert.equal(env.menuUpdates['merlin-save-mail-content'].visible, true);
  await env.ev.shown.fire({ contexts: ['page'] }, { id: 1, type: 'messageCompose' });
  assert.equal(env.menuUpdates['merlin-save-page'].visible, false);
  assert.equal(env.menuUpdates['merlin-save-mail-content'].visible, false);
});

test('"send email content" saves the displayed email', async () => {
  env.displayed = [{ id: 1, subject: 'Hello', author: 'Anna <anna@example.org>' }];
  await env.ev.clicked.fire({ menuItemId: 'merlin-save-mail-content' }, { id: 3, type: 'mail' });
  const body = env.lastBody();
  assert.equal(body.url, 'mail://message/1%40example.org');
  assert.equal(body.title, 'Hello');
  assert.equal(body.author, 'Anna');
  assert.match(body.html, /<p>Hi<\/p>\n<p>There &lt;b&gt;<\/p>/);
  assert.equal(env.lastNote()[1], msg('flyout_mailSaved'));
});

test('several selected emails are saved as separate articles', async () => {
  const selectedMessages = { id: null, messages: [{ id: 1, subject: 'Hello' }, { id: 2, subject: 'Second' }] };
  await env.ev.clicked.fire({ menuItemId: 'merlin-save-mail', selectedMessages }, { id: 3, type: 'mail' });
  assert.equal(env.fetches.length, 2);
  assert.deepEqual(env.fetches.map(([, o]) => JSON.parse(o.body).title), ['Hello', 'Second']);
  assert.deepEqual(env.lastNote(), [msg('notification_defaultTitle'), msg('flyout_mailsSaved', ['2'])]);
});

test('a failing email in a batch is reported as a partial save', async () => {
  let n = 0;
  env.fetchImpl = async () => new Response('{}', { status: n++ === 0 ? 201 : 500 });
  const selectedMessages = { messages: [{ id: 1 }, { id: 2 }] };
  await env.ev.clicked.fire({ menuItemId: 'merlin-save-mail', selectedMessages }, { id: 3, type: 'mail' });
  assert.equal(env.lastNote()[1], msg('flyout_mailsSavedPartial', ['1', '2']));
});

test('email with tags opens the dialog and saves the emails with the chosen tags', async () => {
  const selectedMessages = { messages: [{ id: 1, subject: 'Hello' }, { id: 2, subject: 'Second' }] };
  await env.ev.clicked.fire({ menuItemId: 'merlin-save-mail-with-tags', selectedMessages }, { id: 3, type: 'mail', windowId: 4 });
  assert.equal(env.fetches.length, 0);
  const key = Object.keys(env.store).find(k => k.startsWith('_merlinPendingSave_'));
  assert.deepEqual(env.store[key], { kind: 'mail', url: msg('saveDialog_mailCount', ['2']), messageIds: [1, 2], windowId: 77 });
  assert.ok(!JSON.stringify(env.store[key]).includes('"p"'));

  await env.ev.msg.fire({ type: 'merlin:saveWithTags', saveId: key.split('_').pop(), tags: ['news'] }, { id: 'me' });
  await tick();
  assert.deepEqual(env.fetches.map(([, o]) => JSON.parse(o.body).tags), [['news'], ['news']]);
  assert.ok(!(key in env.store));
});

test('message header button and keyboard shortcut save the email', async () => {
  env.displayed = [{ id: 2, subject: 'Second' }];
  await env.ev.action.fire({ id: 5, type: 'messageDisplay' });
  assert.equal(env.lastBody().title, 'Second');

  env.selected = [{ id: 1, subject: 'Hello' }];
  await env.ev.command.fire('save-mail', { id: 3, type: 'mail' });
  assert.equal(env.lastBody().title, 'Hello');
});

test('nothing selected → clear message, no request', async () => {
  await env.ev.command.fire('save-mail', { id: 3, type: 'mail' });
  assert.equal(env.fetches.length, 0);
  assert.equal(env.lastNote()[1], msg('flyout_noMailSelected'));
});

test('page with tags: dialog is centered and the entry holds no credentials', async () => {
  await env.login({ nextcloudUrl: 'https://srv.example.com', backendKind: 'standalone' });
  env.fetchImpl = async (u, o) => {
    if (u.endsWith('/api/tags') && o.method === 'GET') return new Response(JSON.stringify([{ id: 1, name: 'News' }]));
    if (u.endsWith('/api/tags')) return new Response('', { status: 500 });
    return new Response('{}', { status: 201 });
  };
  await env.ev.clicked.fire({ menuItemId: 'merlin-save-page-with-tags' }, { id: 4, type: 'content', url: 'https://ex.org/p', windowId: 3 });
  const win = env.windows.at(-1);
  assert.deepEqual([win.width, win.height, win.left, win.top], [460, 640, 730, 220]);
  const key = Object.keys(env.store).find(k => k.startsWith('_merlinPendingSave_'));
  assert.deepEqual(env.store[key], { url: 'https://ex.org/p', tabId: 4, isPage: true, windowId: 77 });

  await env.ev.msg.fire({ type: 'merlin:saveWithTags', saveId: key.split('_').pop(), tags: ['news', 'Neu'] }, { id: 'me' });
  await tick();
  assert.equal(env.fetches.at(-1)[0], 'https://srv.example.com/api/articles');
  assert.deepEqual(env.lastBody(), { url: 'https://ex.org/p', tagIds: [1], html: '<html>page</html>' });
  assert.equal(env.lastNote()[1], msg('flyout_urlSavedTagsFailed', ['Neu']));
});

test('messages from other senders are ignored', async () => {
  await env.ev.msg.fire({ type: 'merlin:startLoginPoll', pollEndpoint: 'https://evil.example/p', pollToken: 't', serverUrl: 'https://evil.example' }, { id: 'other' });
  assert.ok(!('_merlinLoginFlow' in env.store));
  assert.ok(!('_merlinLoginFlowResult' in env.store));
});

test('login flow rejects a poll endpoint on another origin', async () => {
  await env.run(`startBackgroundLoginPoll({ pollEndpoint: 'https://evil.example/poll', pollToken: 't', serverUrl: 'https://cloud.example.com' })`);
  assert.equal(env.store._merlinLoginFlowResult.error, msg('options_loginInvalidResponse'));
});

test('login flow keeps the entered origin and stores the new credentials', async () => {
  env.fetchImpl = async () => new Response(JSON.stringify({ server: 'https://evil.example', loginName: 'anna', appPassword: 'secret' }));
  await env.run(`startBackgroundLoginPoll({ pollEndpoint: 'https://cloud.example.com/login/v2/poll', pollToken: 't', serverUrl: 'https://cloud.example.com', backendKind: 'nextcloud' })`);
  assert.ok(env.alarms.includes('merlin-login-poll'));
  await tick(2300);
  assert.deepEqual(env.store._merlinLoginFlowResult, { success: true, serverUrl: 'https://cloud.example.com', loginName: 'anna' });
  const creds = await env.run('getCredentials()');
  assert.equal(creds.nextcloudUrl, 'https://cloud.example.com');
  assert.equal(creds.appPassword, 'secret');
});

test('an expired stored login flow ends with a timeout after the page was unloaded', async () => {
  env.store._merlinLoginFlow = { active: true, pollEndpoint: 'https://cloud.example.com/p', pollToken: 't', serverUrl: 'https://cloud.example.com', deadline: Date.now() - 1 };
  await env.ev.alarm.fire({ name: 'merlin-login-poll' });
  await tick();
  assert.equal(env.store._merlinLoginFlowResult.error, msg('options_loginTimeout'));
  assert.ok(!('_merlinLoginFlow' in env.store));
});

test('migration removes the legacy plain-text pending save', async () => {
  env.store._merlinPendingSave = { appPassword: 'x' };
  await env.ev.installed.fire({});
  assert.ok(!('_merlinPendingSave' in env.store));
});
