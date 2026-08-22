'use strict';

const $ = id => document.getElementById(id);

// i18n-Kürzel: liest lokalisierte Strings aus _locales/<lang>/messages.json
// (generiert via tools/i18n/export.py). `subs` mappt auf die $1/$2-Platzhalter.
const t = (key, subs) => browser.i18n.getMessage(key, subs);

// Tags selected via chips (independent from the text input)
const selectedChipTags = new Set();

document.addEventListener('DOMContentLoaded', async () => {

  // ─── Load pending save data ──────────────────────────────────────────────────
  let pendingSave = null;
  try {
    const result = await browser.storage.local.get('_merlinPendingSave');
    pendingSave = result._merlinPendingSave ?? null;
  } catch { /* ignore */ }

  const url = pendingSave?.url ?? '';
  $('urlDisplay').textContent = url;
  $('urlDisplay').title       = url;

  // ─── Auto-focus tag input ────────────────────────────────────────────────────
  $('tagsInput').focus();

  // ─── Load existing tags from API ────────────────────────────────────────────
  loadExistingTags(pendingSave);

  // ─── Save ────────────────────────────────────────────────────────────────────
  async function doSave() {
    // Collect tags from both the text input and chip selections, deduplicated
    const inputTags = $('tagsInput').value
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const tags = [...new Set([...selectedChipTags, ...inputTags])];

    let windowId = null;
    try {
      const win = await browser.windows.getCurrent();
      windowId  = win.id;
    } catch { /* window API not available */ }

    try {
      await browser.runtime.sendMessage({ type: 'merlin:saveWithTags', tags, windowId });
    } catch { /* background will handle errors */ }

    window.close();
  }

  // ─── Cancel ──────────────────────────────────────────────────────────────────
  function doCancel() {
    browser.runtime.sendMessage({ type: 'merlin:cancelSave' }).catch(() => {});
    window.close();
  }

  // ─── Event listeners ─────────────────────────────────────────────────────────
  $('saveBtn').addEventListener('click', doSave);
  $('cancelBtn').addEventListener('click', doCancel);

  $('tagsInput').addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { doCancel(); }
  });
});

// ─── Fetch & render existing tags ─────────────────────────────────────────────

async function loadExistingTags(pendingSave) {
  const spinner   = $('tagsSpinner');
  const chipsWrap = $('tagChips');

  if (!pendingSave?.nextcloudUrl || !pendingSave?.username || !pendingSave?.appPassword) {
    spinner.style.display = 'none';
    chipsWrap.innerHTML   = `<span class="tags-empty">${t('saveDialog_noCredentials')}</span>`;
    return;
  }

  const { nextcloudUrl, username, appPassword, backendKind } = pendingSave;
  const apiPrefix = backendKind === 'standalone' ? '/api' : '/index.php/apps/merlin/api';
  const apiUrl = `${nextcloudUrl.replace(/\/$/, '')}${apiPrefix}/tags`;
  const creds  = btoa(`${username}:${appPassword}`);

  try {
    const resp = await fetch(apiUrl, {
      method:  'GET',
      headers: { 'Authorization': `Basic ${creds}` },
      signal:  AbortSignal.timeout(8_000),
    });

    spinner.style.display = 'none';

    if (resp.status === 401) {
      // Zugangsdaten ungültig — löschen und Re-Login erzwingen, wie auch beim Speichern selbst.
      await browser.storage.local.remove(['credEnc', 'encKeyRaw']);
      await notifyAuthFailed();
      chipsWrap.innerHTML = `<span class="tags-error">${t('saveDialog_authFailed')}</span>`;
      return;
    }

    if (!resp.ok) {
      chipsWrap.innerHTML = `<span class="tags-error">${t('saveDialog_tagsLoadError', [String(resp.status)])}</span>`;
      return;
    }

    const data = await resp.json();

    // API may return { tags: [...] } or directly an array
    const tags = Array.isArray(data) ? data : (data.tags ?? data.data ?? []);

    if (!tags.length) {
      chipsWrap.innerHTML = `<span class="tags-empty">${t('saveDialog_noTags')}</span>`;
      return;
    }

    renderChips(tags, chipsWrap);

  } catch (err) {
    spinner.style.display = 'none';
    if (err.name === 'TimeoutError') {
      chipsWrap.innerHTML = `<span class="tags-error">${t('saveDialog_tagsTimeout')}</span>`;
    } else {
      // Silently hide the section on network errors — don't block the user
      $('tagsSection').style.display = 'none';
    }
  }
}

// ─── Notification helper ───────────────────────────────────────────────────────

function notifyAuthFailed() {
  return browser.notifications.create({
    type:    'basic',
    iconUrl: browser.runtime.getURL('icons/icon-48.png'),
    title:   t('notification_authFailedTitle'),
    message: t('notification_authFailedMessage'),
  });
}

// ─── Render clickable tag chips ───────────────────────────────────────────────

function renderChips(tags, container) {
  container.innerHTML = '';

  tags.forEach(tag => {
    const name = tag.name ?? tag;   // support both objects and plain strings
    if (!name) return;

    const chip = document.createElement('button');
    chip.type        = 'button';
    chip.textContent = name;
    chip.className   = 'tag-chip';
    if (selectedChipTags.has(name)) chip.classList.add('selected');

    chip.addEventListener('click', () => {
      if (selectedChipTags.has(name)) {
        selectedChipTags.delete(name);
        chip.classList.remove('selected');
      } else {
        selectedChipTags.add(name);
        chip.classList.add('selected');
      }
    });

    container.appendChild(chip);
  });
}
