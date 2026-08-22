'use strict';

// ─── Merlin Credential Encryption ────────────────────────────────────────────
//
// Schutzziel: Das Nextcloud-App-Passwort liegt in storage.local nicht im
// Klartext, sondern als AES-GCM-Chiffretext. Es gibt keine Passphrase-Eingabe
// durch den Nutzer — der AES-Schlüssel wird zufällig erzeugt und liegt
// ebenfalls (raw) in storage.local. Das schützt nicht gegen einen Angreifer
// mit vollem Zugriff auf das Thunderbird-Profilverzeichnis (Schlüssel und
// Chiffretext liegen dort nebeneinander), verhindert aber, dass das
// App-Passwort als Klartext-String im Profil auftaucht, z. B. bei
// versehentlichem Export, Backup-Inspektion oder Sync-Mechanismen.
//
// Es gibt KEINEN Sync mehr: storage.sync wird von dieser Erweiterung nicht
// mehr verwendet. Credentials bleiben ausschließlich lokal auf dem Gerät
// (storage.local), unabhängig davon, ob Thunderbird Sync aktiv ist.
//
// Identisch zur Implementierung in merlin-chrome/crypto.js.

function _merlinToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function _merlinFromBase64(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Der Schlüssel wird beim ersten Gebrauch zufällig erzeugt und danach aus
// storage.local wiederverwendet — kein PBKDF2 nötig, da er nicht aus einer
// (potenziell schwachen) Nutzereingabe abgeleitet wird, sondern selbst schon
// volle 256 Bit Entropie hat.
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

// credsObj: { nextcloudUrl, username, appPassword }
async function merlinEncryptCredentials(credsObj) {
  const key = await merlinGetOrCreateKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const plaintext  = new TextEncoder().encode(JSON.stringify(credsObj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  // iv ist nicht geheim (Standard bei AES-GCM) — darf mit dem Chiffretext liegen.
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
