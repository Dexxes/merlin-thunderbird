'use strict';

// Static checks that catch packaging mistakes without running Thunderbird:
// icon sizes, missing translations, files missing from the .xpi build.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, readMessages } = require('./helpers');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const sourceFiles = fs.readdirSync(ROOT).filter(f => /\.(js|html)$/.test(f));

function pngSize(file) {
  const buf = fs.readFileSync(path.join(ROOT, file));
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('every manifest icon has the pixel size it is declared with', () => {
  const declared = [
    ...Object.entries(manifest.icons),
    ...Object.entries(manifest.message_display_action?.default_icon ?? {}),
  ];
  for (const [size, file] of declared) {
    assert.deepEqual(pngSize(file), [Number(size), Number(size)], file);
  }
});

test('de and en have the same message names', () => {
  assert.deepEqual(Object.keys(readMessages('de')).sort(), Object.keys(readMessages('en')).sort());
});

test('every message used in code, HTML and manifest exists', () => {
  const used = new Set();
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) used.add(m[1]);
  for (const f of sourceFiles) {
    const src = read(f);
    for (const m of src.matchAll(/\bt\('(\w+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/backendText\('(\w+)', '(\w+)'\)/g)) { used.add(m[1]); used.add(m[2]); }
    for (const m of src.matchAll(/data-i18n(?:-placeholder|-title)?="(\w+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 50, `only ${used.size} keys found — is the pattern still right?`);
  for (const lang of ['de', 'en']) {
    const msgs = readMessages(lang);
    const missing = [...used].filter(k => !msgs[k]);
    assert.deepEqual(missing, [], `missing in ${lang}`);
  }
});

test('the .xpi build includes every script the add-on loads', () => {
  const build = read('tools/build-xpi.ps1');
  const loaded = new Set(manifest.background.scripts);
  for (const f of sourceFiles.filter(f => f.endsWith('.html'))) {
    loaded.add(f);
    for (const m of read(f).matchAll(/<script src="([^"]+)"/g)) loaded.add(m[1]);
  }
  for (const f of loaded) {
    assert.ok(build.includes(`'${f}'`), `${f} missing from tools/build-xpi.ps1`);
  }
});
