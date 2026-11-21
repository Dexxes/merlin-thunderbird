'use strict';

// Test helpers: a fake WebExtension `browser` API for the extension pages
// (injected into Chromium via Playwright) and pre-encrypted credentials in
// the format of crypto.js.

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function readMessages(lang) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', lang, 'messages.json'), 'utf8'));
}

// browser.i18n.getMessage with $NAME$ placeholders mapped onto $1/$2 subs.
function makeGetMessage(msgs) {
  return (key, subs) => {
    const m = msgs[key];
    if (!m) return '';
    let s = m.message;
    subs = subs == null ? [] : [].concat(subs);
    for (const [name, p] of Object.entries(m.placeholders || {})) {
      const i = Number(p.content.slice(1)) - 1;
      s = s.replace(new RegExp(`\\$${name}\\$`, 'gi'), subs[i] ?? '');
    }
    return s;
  };
}

// storage.local entries (encKeyRaw + credEnc) that crypto.js decrypts to `creds`.
async function encryptedCredentials(creds) {
  const raw = new Uint8Array(32).fill(7);
  const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12).fill(3);
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(creds)));
  const b64 = b => Buffer.from(b).toString('base64');
  return { encKeyRaw: b64(raw), credEnc: { v: 2, iv: b64(iv), ciphertext: b64(new Uint8Array(ct)) } };
}

// Init script for extension pages. Records sent messages in window.__sent and
// permission requests in window.__perm.
function pageInitScript(lang, store) {
  return `
    window.__sent = []; window.__perm = [];
    const __store = ${JSON.stringify(store)};
    const __listeners = [];
    const __getMessage = (${makeGetMessage.toString()})(${JSON.stringify(readMessages(lang))});
    window.browser = {
      i18n: { getUILanguage: () => '${lang}', getMessage: __getMessage },
      storage: {
        local: {
          get: async (keys) => {
            if (keys == null) return { ...__store };
            const out = {};
            for (const k of [].concat(keys)) if (k in __store) out[k] = __store[k];
            return out;
          },
          set: async (o) => {
            Object.assign(__store, o);
            const changes = {};
            for (const k in o) changes[k] = { newValue: o[k] };
            __listeners.forEach(l => l(changes, 'local'));
          },
          remove: async (keys) => { for (const k of [].concat(keys)) delete __store[k]; },
        },
        onChanged: { addListener: l => __listeners.push(l) },
      },
      runtime: { id: 'me', sendMessage: async (m) => { window.__sent.push(m); return { ok: true }; }, getURL: p => p },
      permissions: { request: async (o) => { window.__perm.push(o); return true; } },
      tabs: { create: async () => ({ id: 5 }) },
      notifications: { create: async () => {} },
    };
  `;
}

function fileUrl(page) {
  return `file://${path.join(ROOT, page)}`;
}

module.exports = { ROOT, readMessages, makeGetMessage, encryptedCredentials, pageInitScript, fileUrl };
