'use strict';

// ─── Merlin Credential Encryption ────────────────────────────────────────────
//
// Goal: the app password is not stored in storage.local as plain text but as
// AES-GCM ciphertext. There is no passphrase — the AES key is generated
// randomly and also lives (raw) in storage.local. This does NOT protect
// against an attacker with full access to the Thunderbird profile directory
// (key and ciphertext sit side by side there); it only keeps the app password
// from showing up as a readable string in the profile.
//
// Nothing is synced: credentials stay in storage.local on this device,
// whether or not Thunderbird Sync is set up.

function _merlinToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function _merlinFromBase64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// The key is generated randomly on first use and then reused from
// storage.local. No PBKDF2 needed: it is not derived from a (possibly weak)
// user input but has the full 256 bits of entropy itself.
async function merlinGetOrCreateKey() {
  const { encKeyRaw } = await browser.storage.local.get('encKeyRaw');

  let rawKey;
  if (encKeyRaw) {
    rawKey = _merlinFromBase64(encKeyRaw);
  } else {
    rawKey = crypto.getRandomValues(new Uint8Array(32));
    await browser.storage.local.set({ encKeyRaw: _merlinToBase64(rawKey) });
  }

  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// credsObj: { nextcloudUrl, username, appPassword, backendKind }
async function merlinEncryptCredentials(credsObj) {
  const key = await merlinGetOrCreateKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const plaintext  = new TextEncoder().encode(JSON.stringify(credsObj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  // The IV is not secret (standard for AES-GCM) and may sit next to the ciphertext.
  return {
    v:          2,
    iv:         _merlinToBase64(iv),
    ciphertext: _merlinToBase64(ciphertext),
  };
}

async function merlinDecryptCredentials(encBlob) {
  const key = await merlinGetOrCreateKey();
  const iv  = _merlinFromBase64(encBlob.iv);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    _merlinFromBase64(encBlob.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
