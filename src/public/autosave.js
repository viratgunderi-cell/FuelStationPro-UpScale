/**
 * FuelBunk Pro — Modal AutoSave v2
 *
 * FIX BUG-09: The original AutoSave class expected static form IDs via enable(formId),
 * but every form in this app is rendered dynamically inside a modal via innerHTML.
 * No code ever called enable(), making the entire feature dead.
 *
 * This rewrite patches openModal() and closeModal() directly so autosave works
 * automatically on every modal — zero changes needed in admin.js or employee.js.
 *
 * Strategy:
 *   - openModal patches: after modal body is injected, scan inputs and attach listeners.
 *     If a draft exists for this modal title, show a non-blocking restore banner.
 *   - Input changes: debounce-save the entire modal-body input state to localStorage
 *     under a key derived from the modal title.
 *   - Drafts are cleared only when caller calls autoSave.clearDraft(title) after a
 *     successful DB write. Plain dismiss keeps the draft for next open.
 *
 * Storage key format: fb_autosave_<slugified-title>
 * Draft TTL: 2 hours — stale drafts are silently discarded.
 */

(function () {
  'use strict';

  const DRAFT_TTL_MS   = 2 * 60 * 60 * 1000; // 2 hours
  const DEBOUNCE_MS    = 1200;                 // save 1.2s after last keystroke
  const STORAGE_PREFIX = 'fb_autosave_';

  // Titles of modals that must NOT be auto-saved (passwords, PINs, destructive actions)
  const SKIP_TITLES = [
    'change', 'password', 'pin', 'reset', 'delete', 'remove', 'lock', 'unlock',
    'confirm', 'logout', 'session', 'gst settings',
  ];

  let _debounceTimer = null;
  let _activeTitle   = null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _slug(title) {
    return (title || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
  }

  function _storageKey(title) { return STORAGE_PREFIX + _slug(title); }

  function _shouldSkip(title) {
    const t = (title || '').toLowerCase();
    return SKIP_TITLES.some(function(w) { return t.includes(w); });
  }

  function _readDraft(title) {
    try {
      var raw = localStorage.getItem(_storageKey(title));
      if (!raw) return null;
      var draft = JSON.parse(raw);
      if (!draft || !draft.savedAt) return null;
      if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
        localStorage.removeItem(_storageKey(title));
        return null;
      }
      return draft;
    } catch(e) { return null; }
  }

  function _writeDraft(title, data) {
    try {
      localStorage.setItem(_storageKey(title), JSON.stringify(
        { data: data, savedAt: Date.now(), title: title }
      ));
    } catch(e) { console.warn('[AutoSave] Write failed:', e.message); }
  }

  // ── Collect / apply form state ────────────────────────────────────────────

  function _collectData(container) {
    var data = {};
    container.querySelectorAll('input, select, textarea').forEach(function(el) {
      var k = el.id || el.name;
      if (!k) return;
      if (el.type === 'password' || el.type === 'hidden' || el.type === 'submit') return;
      if (el.type === 'checkbox') { data[k] = el.checked; }
      else if (el.type === 'radio') { if (el.checked) data[k] = el.value; }
      else { data[k] = el.value; }
    });
    return data;
  }

  function _applyData(container, data) {
    Object.keys(data).forEach(function(k) {
      var v = data[k];
      var el = container.querySelector('#' + k) ||
               container.querySelector('[name="' + k + '"]');
      if (!el) return;
      if (el.type === 'checkbox') { el.checked = !!v; }
      else if (el.type === 'radio') { el.checked = el.value === v; }
      else {
        // Only restore if field has no user-set value (don't clobber pre-filled edit forms)
        if (!el.value || el.value === el.defaultValue) {
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
  }

  // ── Restore banner (non-blocking — no confirm() dialog) ───────────────────

  function _showRestoreBanner(modalBody, draft, title) {
    if (modalBody.querySelector('.fb-draft-banner')) return;
    var ageMin = Math.round((Date.now() - draft.savedAt) / 60000);
    var ageStr = ageMin < 2 ? 'just now' : ageMin + ' min ago';
    var banner = document.createElement('div');
    banner.className = 'fb-draft-banner';
    banner.style.cssText = [
      'background:rgba(212,148,15,0.10)',
      'border:1px solid rgba(212,148,15,0.30)',
      'border-radius:8px',
      'padding:10px 14px',
      'margin-bottom:14px',
      'font-size:12px',
      'color:var(--accent-light,#f0b429)',
      'display:flex',
      'align-items:center',
      'gap:10px',
    ].join(';');
    banner.innerHTML =
      '<span style="flex:1">📝 Unsaved draft from <strong>' + ageStr + '</strong> — restore?</span>' +
      '<button id="fb-draft-restore" style="background:var(--accent,#d4940f);color:#000;border:none;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer">Restore</button>' +
      '<button id="fb-draft-discard" style="background:transparent;border:none;color:var(--text-3,#6b7080);cursor:pointer;font-size:14px;padding:2px 6px" title="Discard draft">✕</button>';
    modalBody.insertBefore(banner, modalBody.firstChild);
    banner.querySelector('#fb-draft-restore').onclick = function() {
      _applyData(modalBody, draft.data);
      banner.remove();
    };
    banner.querySelector('#fb-draft-discard').onclick = function() {
      localStorage.removeItem(_storageKey(title));
      banner.remove();
    };
  }

  // ── Attach listeners to all inputs in a container ─────────────────────────

  function _attachListeners(modalBody, title) {
    var save = function() {
      clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(function() {
        var data = _collectData(modalBody);
        if (Object.keys(data).length > 0) _writeDraft(title, data);
      }, DEBOUNCE_MS);
    };

    modalBody.querySelectorAll('input, select, textarea').forEach(function(el) {
      if (el.type === 'password' || el.type === 'hidden') return;
      el.addEventListener('input',  save, { passive: true });
      el.addEventListener('change', save, { passive: true });
    });

    // Watch for inputs added after initial render (dynamic nozzle rows, etc.)
    var obs = new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        m.addedNodes.forEach(function(node) {
          if (node.nodeType !== 1) return;
          var els = node.matches('input,select,textarea') ? [node]
                  : Array.from(node.querySelectorAll('input,select,textarea'));
          els.forEach(function(el) {
            if (el.type === 'password' || el.type === 'hidden') return;
            el.addEventListener('input',  save, { passive: true });
            el.addEventListener('change', save, { passive: true });
          });
        });
      });
    });
    obs.observe(modalBody, { childList: true, subtree: true });
    modalBody._autoSaveObs = obs;
  }

  // ── Wait for openModal / closeModal to be defined, then patch ────────────
  // autosave.js loads after all other scripts, so they should already exist.
  // Use a small retry loop just in case of timing edge cases.

  function _patchWhenReady(attempts) {
    attempts = attempts || 0;
    if (typeof window.openModal !== 'function' || typeof window.closeModal !== 'function') {
      if (attempts < 20) setTimeout(function() { _patchWhenReady(attempts + 1); }, 100);
      else console.warn('[AutoSave] openModal/closeModal not found — autosave disabled');
      return;
    }

    var _origOpen  = window.openModal;
    var _origClose = window.closeModal;

    window.openModal = function(title, bodyHtml, footerHtml, width) {
      _activeTitle = title;
      _origOpen.apply(this, arguments);
      if (_shouldSkip(title)) return;
      var overlay   = document.getElementById('modal-overlay');
      var modalBody = overlay && overlay.querySelector('.modal-body');
      if (!modalBody) return;
      var draft = _readDraft(title);
      if (draft && Object.keys(draft.data || {}).length > 0) {
        _showRestoreBanner(modalBody, draft, title);
      }
      _attachListeners(modalBody, title);
    };

    window.closeModal = function() {
      clearTimeout(_debounceTimer);
      var overlay = document.getElementById('modal-overlay');
      if (overlay) {
        var body = overlay.querySelector('.modal-body');
        if (body && body._autoSaveObs) body._autoSaveObs.disconnect();
      }
      _activeTitle = null;
      _origClose.apply(this, arguments);
    };

    // Also patch appLogout to clear all drafts on sign-out
    if (typeof window.appLogout === 'function') {
      var _origLogout = window.appLogout;
      window.appLogout = async function() {
        window.autoSave.clearAll();
        return _origLogout.apply(this, arguments);
      };
    }

    console.log('[AutoSave] v2 ready — patched openModal/closeModal');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  window.autoSave = {
    /** Call after a successful DB write to discard the draft for that modal. */
    clearDraft: function(title) {
      try { localStorage.removeItem(_storageKey(title || _activeTitle || '')); } catch(e) {}
    },
    /** Debug: list all active drafts. */
    listDrafts: function() {
      var out = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          try {
            var d = JSON.parse(localStorage.getItem(k) || '{}');
            out.push({ title: d.title, savedAt: new Date(d.savedAt).toLocaleString() });
          } catch(e) {}
        }
      }
      return out;
    },
    /** Clear every draft (e.g. on logout). */
    clearAll: function() {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
      }
      keys.forEach(function(k) { localStorage.removeItem(k); });
      console.log('[AutoSave] Cleared', keys.length, 'draft(s)');
    },
  };

  // Kick off patching
  _patchWhenReady();

})();
