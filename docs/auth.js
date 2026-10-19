/* ============================================================
   Fairbank: temporary password gate
   ------------------------------------------------------------
   Loaded synchronously in <head> of every page. Hides the page until
   the rep enters the shared password and their Eclipse user id
   (e_user_id). The e_user_id is looked up in HubSpot through n8n
   (e-order-placement/user) to get the rep's name, default branch and
   territory, which pages read from window.FB_USER.

   This is a browser-only gate: it hides the pages, it does not protect
   the n8n webhooks. Microsoft login will replace this file later.

   Change the password: put the SHA-256 hex of the new password in
   PASSWORD_HASH (see README.md). Everyone is signed out on change.
   ============================================================ */

(function () {
  'use strict';

  var PASSWORD_HASH = '533099ac357e5586238f6be92e706eacb5dea6559fa61b979069c39c5efe8cee';
  var USER_URL = 'https://n8n.fairbankequipment.com/webhook/e-order-placement/user';

  var KEY_AUTH = 'fb_auth';
  var KEY_USER = 'fb_user';
  var KEY_LAST_ID = 'fb_e_user_id';

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* private mode */ } }

  function storedUser() {
    try { return JSON.parse(lsGet(KEY_USER) || 'null'); } catch (e) { return null; }
  }

  var user = lsGet(KEY_AUTH) === PASSWORD_HASH ? storedUser() : null;

  window.FB_USER = user;
  window.fbSignOut = function () {
    lsDel(KEY_AUTH);
    lsDel(KEY_USER);
    window.location.reload();
  };

  if (user) {
    document.addEventListener('DOMContentLoaded', addUserChip);
    return;
  }

  // ── Locked: hide everything but the gate ─────────────────────
  document.documentElement.classList.add('fb-locked');
  var style = document.createElement('style');
  style.textContent = [
    'html.fb-locked body > *:not(#fb-gate) { display: none !important; }',
    '#fb-gate { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center;',
    '  padding: 16px; background: linear-gradient(to bottom right, #091529, #003057); font-family: "Barlow", sans-serif; }',
    '#fb-gate form { width: 100%; max-width: 360px; background: #0e2245; border: 1px solid rgba(200,150,42,.25);',
    '  border-radius: 10px; padding: 28px 24px; box-shadow: 0 20px 60px rgba(0,0,0,.45); color: #fff; }',
    '#fb-gate h1 { margin: 0 0 4px; font-family: "Barlow Condensed", sans-serif; font-weight: 700; font-size: 28px;',
    '  letter-spacing: .04em; text-transform: uppercase; color: #c8962a; }',
    '#fb-gate p { margin: 0 0 20px; color: #8fa4c2; font-size: 14px; }',
    '#fb-gate label { display: block; margin: 0 0 6px; font-size: 12px; font-weight: 600; letter-spacing: .08em;',
    '  text-transform: uppercase; color: #8fa4c2; }',
    '#fb-gate input { box-sizing: border-box; width: 100%; margin: 0 0 16px; padding: 11px 12px; font: inherit; font-size: 16px;',
    '  color: #fff; background: #091529; border: 1px solid #2a4466; border-radius: 6px; }',
    '#fb-gate input:focus { outline: 2px solid #c8962a; outline-offset: 1px; border-color: transparent; }',
    '#fb-gate button { width: 100%; padding: 12px; font-family: "Barlow Condensed", sans-serif; font-weight: 700; font-size: 18px;',
    '  letter-spacing: .06em; text-transform: uppercase; color: #091529; background: #c8962a; border: 0; border-radius: 6px; cursor: pointer; }',
    '#fb-gate button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }',
    '#fb-gate button[disabled] { opacity: .6; cursor: wait; }',
    '#fb-gate .fb-gate-error { min-height: 20px; margin: 12px 0 0; color: #ff8a80; font-size: 14px; }',
  ].join('\n');
  document.head.appendChild(style);

  document.addEventListener('DOMContentLoaded', renderGate);

  function renderGate() {
    var wrap = document.createElement('div');
    wrap.id = 'fb-gate';
    wrap.innerHTML =
      '<form novalidate>' +
      '<h1>Fairbank Sales</h1>' +
      '<p>Sign in to continue.</p>' +
      '<label for="fb-gate-user">Eclipse user ID</label>' +
      '<input id="fb-gate-user" name="e_user_id" autocomplete="username" autocapitalize="characters" spellcheck="false" required>' +
      '<label for="fb-gate-pass">Password</label>' +
      '<input id="fb-gate-pass" name="password" type="password" autocomplete="current-password" required>' +
      '<button type="submit">Sign in</button>' +
      '<div class="fb-gate-error" role="alert"></div>' +
      '</form>';
    document.body.appendChild(wrap);

    var form = wrap.querySelector('form');
    var idEl = wrap.querySelector('#fb-gate-user');
    var passEl = wrap.querySelector('#fb-gate-pass');
    var btn = wrap.querySelector('button');
    var errEl = wrap.querySelector('.fb-gate-error');

    idEl.value = (lsGet(KEY_LAST_ID) || '').toUpperCase();
    (idEl.value ? passEl : idEl).focus();

    // Eclipse user IDs are uppercase: capitalise as the rep types or pastes.
    idEl.addEventListener('input', function () {
      var up = idEl.value.toUpperCase();
      if (up === idEl.value) return;
      var start = idEl.selectionStart, end = idEl.selectionEnd;
      idEl.value = up;
      idEl.setSelectionRange(start, end);
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var eUserId = idEl.value.trim().toUpperCase();
      var password = passEl.value;
      errEl.textContent = '';
      if (!eUserId) { errEl.textContent = 'Enter your Eclipse user ID.'; idEl.focus(); return; }
      if (!password) { errEl.textContent = 'Enter the password.'; passEl.focus(); return; }

      btn.disabled = true;
      btn.textContent = 'Signing in…';
      sha256(password)
        .then(function (hash) {
          if (hash !== PASSWORD_HASH) throw new Error('Incorrect password.');
          return fetch(USER_URL + '?e_user_id=' + encodeURIComponent(eUserId))
            .then(function (res) {
              return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok || data.error) {
                  throw new Error(data.error || ('User lookup failed (status ' + res.status + ').'));
                }
                return data;
              });
            })
            .then(function (data) {
              lsSet(KEY_LAST_ID, eUserId);
              lsSet(KEY_USER, JSON.stringify(data));
              lsSet(KEY_AUTH, hash);
              window.FB_USER = data;
              document.documentElement.classList.remove('fb-locked');
              wrap.remove();
              addUserChip();
              window.dispatchEvent(new CustomEvent('fb:auth', { detail: data }));
            });
        })
        .catch(function (err) {
          errEl.textContent = err.message || 'Sign in failed.';
          btn.disabled = false;
          btn.textContent = 'Sign in';
          passEl.select();
        });
    });
  }

  function sha256(text) {
    var bytes = new TextEncoder().encode(text);
    return window.crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }

  // Small "signed in as" chip with a sign-out link, top-right. It scrolls
  // with the page so it never covers the order page's sticky phone bar.
  function addUserChip() {
    var u = window.FB_USER;
    if (!u || document.getElementById('fb-user-chip')) return;
    var chip = document.createElement('div');
    chip.id = 'fb-user-chip';
    chip.style.cssText =
      'position:absolute;right:12px;top:12px;z-index:9000;display:flex;gap:10px;align-items:center;' +
      'padding:6px 12px;font:500 12px "Barlow",sans-serif;color:#8fa4c2;background:rgba(8,21,41,.9);' +
      'border:1px solid #2a4466;border-radius:999px;';
    var name = document.createElement('span');
    name.textContent = (u.name || u.e_user_id) + ' · ' + u.e_user_id;
    var out = document.createElement('button');
    out.type = 'button';
    out.textContent = 'Sign out';
    out.style.cssText = 'font:600 12px "Barlow",sans-serif;color:#c8962a;background:none;border:0;padding:0;cursor:pointer;';
    out.addEventListener('click', window.fbSignOut);
    chip.appendChild(name);
    chip.appendChild(out);
    document.body.appendChild(chip);
  }
})();
