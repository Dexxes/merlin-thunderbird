'use strict';

// Loads save-dialog.html and options.html in headless Chromium with a fake
// WebExtension API (see helpers.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { encryptedCredentials, pageInitScript, fileUrl, readMessages, makeGetMessage } = require('./helpers');

const de = makeGetMessage(readMessages('de'));
const en = makeGetMessage(readMessages('en'));

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function openPage(file, lang, store) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e));
  await page.addInitScript(pageInitScript(lang, store));
  page.assertNoErrors = () => assert.deepEqual(errors, []);
  return page;
}

const TAGS = [
  { id: 1, name: 'Technik', parentId: null }, { id: 2, name: 'Linux', parentId: 1 },
  { id: 3, name: 'Kernel', parentId: 2 }, { id: 4, name: 'News', parentId: null },
  { id: 5, name: 'Österreich', parentId: 4 },
];

test('save dialog: tag tree, filter while typing, selection rules', async () => {
  const creds = await encryptedCredentials({ nextcloudUrl: 'https://cloud.example.com', username: 'u', appPassword: 'p', backendKind: 'nextcloud' });
  const page = await openPage('save-dialog.html', 'de', {
    ...creds, _merlinPendingSave_abc: { url: 'https://example.org/article', tabId: 1, isPage: false, windowId: 9 },
  });
  let auth = null;
  await page.route('https://cloud.example.com/**', r => {
    auth = r.request().headers().authorization;
    r.fulfill({ json: TAGS });
  });
  await page.goto(fileUrl('save-dialog.html') + '?id=abc');
  await page.waitForSelector('.tag-row');

  assert.equal(auth, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(await page.textContent('#urlDisplay'), 'https://example.org/article');
  const visible = () => page.$$eval('.tag-row:not([hidden]) .tag-name', els => els.map(e => e.textContent));
  const selected = () => page.$$eval('.tag-row.selected .tag-name', els => els.map(e => e.textContent));
  assert.deepEqual(await visible(), ['News', 'Österreich', 'Technik', 'Linux', 'Kernel']);

  // Only the text after the last comma filters; parents stay as dimmed context.
  await page.fill('#tagsInput', 'neu, kern');
  assert.deepEqual(await visible(), ['Technik', 'Linux', 'Kernel']);
  assert.equal(await page.$$eval('.tag-row.context-only:not([hidden])', e => e.length), 2);
  await page.fill('#tagsInput', 'oster');
  assert.deepEqual(await visible(), ['News', 'Österreich']);
  await page.fill('#tagsInput', 'zzz');
  assert.equal(await page.textContent('.tags-no-match'), de('saveDialog_noMatchingTags'));
  assert.equal(await page.isVisible('.tags-no-match'), true);

  // Picking a filtered tag replaces the typed fragment and selects its parents.
  await page.fill('#tagsInput', 'neu, kern');
  await page.click('.tag-row:has-text("Kernel")');
  assert.equal(await page.inputValue('#tagsInput'), 'neu, ');
  assert.deepEqual(await selected(), ['Technik', 'Linux', 'Kernel']);

  // Deselecting a tag also deselects its sub-tags.
  await page.click('.tag-row:has-text("Linux")');
  assert.deepEqual(await selected(), ['Technik']);

  await page.click('.tag-row:has-text("Kernel")');
  await page.focus('#tagsInput');
  await page.keyboard.press('Enter');
  const sent = await page.evaluate(() => window.__sent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'merlin:saveWithTags');
  assert.equal(sent[0].saveId, 'abc');
  assert.deepEqual([...sent[0].tags].sort(), ['Kernel', 'Linux', 'Technik', 'neu']);
  page.assertNoErrors();
  await page.close();
});

test('options: URL field prefilled with https://, http refused, login flow starts', async () => {
  const page = await openPage('options.html', 'de', {});
  let loginUrl = null;
  await page.route('**/login/v2', r => {
    loginUrl = r.request().url();
    r.fulfill({ json: { login: 'https://cloud.example.com/login/v2/flow/x', poll: { token: 'tok', endpoint: 'https://cloud.example.com/login/v2/poll' } } });
  });
  await page.goto(fileUrl('options.html'));
  await page.waitForFunction(() => document.getElementById('nextcloudUrl').value === 'https://');
  assert.equal(await page.textContent('#statusText'), de('options_welcome'));

  await page.click('#nextcloudUrl');
  await page.waitForTimeout(50);
  assert.equal(await page.$eval('#nextcloudUrl', e => e.selectionStart), 'https://'.length);
  await page.keyboard.insertText('https://cloud.example.com/');
  assert.equal(await page.inputValue('#nextcloudUrl'), 'https://cloud.example.com/');

  await page.fill('#nextcloudUrl', 'http://cloud.example.com');
  await page.click('#loginFlowBtn');
  assert.equal(await page.textContent('#statusText'), de('options_httpBlocked'));

  await page.fill('#nextcloudUrl', 'cloud.example.com/');
  await page.click('#loginFlowBtn');
  await page.waitForFunction(() => window.__sent.length > 0);
  assert.equal(loginUrl, 'https://cloud.example.com/index.php/login/v2');
  const sent = await page.evaluate(() => window.__sent[0]);
  assert.equal(sent.type, 'merlin:startLoginPoll');
  assert.equal(sent.serverUrl, 'https://cloud.example.com');
  assert.deepEqual(await page.evaluate(() => window.__perm[0]), { origins: ['https://cloud.example.com/*'] });
  page.assertNoErrors();
  await page.close();
});

test('options: standalone wording and localized labels', async () => {
  const page = await openPage('options.html', 'en', {});
  await page.goto(fileUrl('options.html'));
  await page.waitForFunction(() => document.getElementById('nextcloudUrl').value === 'https://');
  await page.check('#backendKindStandalone');
  assert.equal((await page.textContent('#loginFlowBtn span')).trim(), en('options_loginButtonStandalone'));
  assert.equal(await page.textContent('#statusText'), en('options_welcomeStandalone'));
  assert.equal(await page.textContent('[data-i18n="options_backendStandalone"]'), en('options_backendStandalone'));
  assert.equal(await page.textContent('.source-link'), en('options_sourceCodeLink'));
  page.assertNoErrors();
  await page.close();
});

test('options: login response with a poll endpoint on another origin is rejected', async () => {
  const page = await openPage('options.html', 'en', {});
  await page.route('**/login/v2', r => r.fulfill({ json: { login: 'https://evil.example/x', poll: { token: 't', endpoint: 'https://evil.example/poll' } } }));
  await page.goto(fileUrl('options.html'));
  await page.waitForFunction(() => document.getElementById('nextcloudUrl').value === 'https://');
  await page.fill('#nextcloudUrl', 'https://cloud.example.com');
  await page.click('#loginFlowBtn');
  await page.waitForFunction(t => document.getElementById('statusText').textContent === t, en('options_loginInvalidResponse'));
  assert.equal(await page.evaluate(() => window.__sent.length), 0);
  await page.close();
});

test('options: connection test only uses the stored URL', async () => {
  const creds = await encryptedCredentials({ nextcloudUrl: 'https://cloud.example.com', username: 'u', appPassword: 'p', backendKind: 'nextcloud' });
  const page = await openPage('options.html', 'en', creds);
  const requests = [];
  await page.route(/^https:\/\//, r => { requests.push(r.request().url()); r.fulfill({ json: {} }); });
  await page.goto(fileUrl('options.html'));
  await page.waitForFunction(() => document.getElementById('nextcloudUrl').value === 'https://cloud.example.com');

  await page.click('#testBtn');
  await page.waitForFunction(t => document.getElementById('statusText').textContent === t, en('options_testSuccess'));
  assert.deepEqual(requests, ['https://cloud.example.com/index.php/apps/merlin/api/v1/get']);

  // Another URL typed in: the app password must not go there.
  await page.fill('#nextcloudUrl', 'https://other.example.com');
  await page.click('#testBtn');
  assert.equal(await page.textContent('#statusText'), en('options_urlChangedLoginAgain'));
  assert.equal(requests.length, 1);
  page.assertNoErrors();
  await page.close();
});
