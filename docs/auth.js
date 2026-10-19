/* ============================================================
   Fairbank: Sign in with HubSpot
   ------------------------------------------------------------
   Loaded synchronously in <head> of every page. Hides the page until
   the rep has a session from the n8n sign-in flow
   (n8n-flows/auth-hubspot.json):

   1. "Sign in with HubSpot" sends the rep to HubSpot's own login and
      consent page, pinned to Fairbank's account (HUB_ID).
   2. HubSpot sends the browser to the n8n flow with a one-time code.
      n8n trades it for a token (with the app's client secret), asks
      HubSpot which account and user the token is for, refuses any
      account but Fairbank's, looks up the rep's HubSpot user record
      (e_user_id, branch, territory) and signs a session token (JWT).
   3. n8n sends the browser back here with the session token in the URL
      fragment (#fb_session=...). This file stores it and strips it from
      the address bar.

   Every fetch() to a PROTECTED webhook gets "Authorization: Bearer
   <session>". Those webhooks check the token's signature and expiry
   (n8n JWT auth), so a call without a valid session is refused by the
   server, not just hidden by this page. The session's claims become
   window.FB_USER (same shape the old password gate used).

   Setup: CLIENT_ID below is the HubSpot app's client id (public, safe
   here). The client secret lives only in n8n. See README.md.
   ============================================================ */

(function () {
  'use strict';

  var CLIENT_ID = 'REPLACE_WITH_HUBSPOT_CLIENT_ID';
  var HUB_ID = '43793456';
  var SCOPES = 'oauth';
  var N8N = 'https://n8n.fairbankequipment.com/webhook/';
  var REDIRECT_URI = N8N + 'e-order-placement/auth/hubspot';
  // Webhook path prefixes that need the session token. Add a prefix
  // only once that webhook uses the same JWT credential in n8n.
  var PROTECTED = ['e-order-placement/'];

  var KEY_SESSION = 'fb_session';
  var KEY_NONCE = 'fb_nonce';

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function ssDel(k) { try { window.sessionStorage.removeItem(k); } catch (e) { /* private mode */ } }

  // Old password-gate keys.
  lsDel('fb_auth');
  lsDel('fb_user');
  lsDel('fb_e_user_id');

  function b64urlDecode(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = window.atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function b64urlEncode(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return window.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Reads the claims. The signature is checked by n8n on every call;
  // this only decides whether to show the page.
  function claimsOf(token) {
    try {
      var c = JSON.parse(b64urlDecode(String(token).split('.')[1]));
      if (!c || String(c.hub_id) !== HUB_ID || !c.e_user_id) return null;
      if (!(Number(c.exp) * 1000 > Date.now() + 30000)) return null;
      return c;
    } catch (e) { return null; }
  }

  function userOf(c) {
    return {
      e_user_id: c.e_user_id,
      name: c.name || '',
      email: c.email || '',
      default_branch: c.default_branch || '',
      territory: c.territory || '',
      hs_user_id: c.hs_user_id || '',
      hs_owner_id: c.hs_owner_id || '',
    };
  }

  // ── Coming back from n8n: #fb_session=...&fb_nonce=... or #fb_auth_error=...
  var gateMessage = '';
  (function readReturn() {
    var h = window.location.hash;
    if (h.indexOf('fb_session=') < 0 && h.indexOf('fb_auth_error=') < 0) return;
    var p = new URLSearchParams(h.slice(1));
    var expected = ssGet(KEY_NONCE);
    ssDel(KEY_NONCE);
    if (p.get('fb_auth_error')) {
      gateMessage = p.get('fb_auth_error');
    } else if (!expected || p.get('fb_nonce') !== expected) {
      // Not a sign-in this tab started: ignore the token.
      gateMessage = 'Sign-in could not be confirmed. Try again.';
    } else if (!claimsOf(p.get('fb_session'))) {
      gateMessage = 'Sign-in returned an unusable session. Try again.';
    } else {
      lsSet(KEY_SESSION, p.get('fb_session'));
    }
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) { window.location.hash = ''; }
  })();

  var token = lsGet(KEY_SESSION);
  var claims = token ? claimsOf(token) : null;
  if (!claims) { lsDel(KEY_SESSION); token = null; }
  var user = claims ? userOf(claims) : null;

  window.FB_USER = user;
  window.fbSignOut = function () {
    lsDel(KEY_SESSION);
    window.location.reload();
  };

  // ── Session token on every protected webhook call ────────────
  function isProtected(url) {
    if (url.indexOf(N8N) !== 0) return false;
    var rest = url.slice(N8N.length);
    if (rest.indexOf(REDIRECT_URI.slice(N8N.length)) === 0) return false;
    return PROTECTED.some(function (p) { return rest.indexOf(p) === 0; });
  }

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!isProtected(url)) return nativeFetch(input, init);
    if (!token || !claimsOf(token)) {
      endSession('Your session ended. Sign in again.');
      return Promise.reject(new Error('Signed out. Sign in again.'));
    }
    init = Object.assign({}, init);
    var headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', 'Bearer ' + token);
    init.headers = headers;
    return nativeFetch(input, init).then(function (res) {
      // n8n refuses a bad or expired token before the flow runs.
      if (res.status === 401 || res.status === 403) endSession('Your session ended. Sign in again.');
      return res;
    });
  };

  // Lock the page again (no reload, so the message shows).
  function endSession(message) {
    lsDel(KEY_SESSION);
    token = null;
    window.FB_USER = null;
    gateMessage = message;
    lock();
    if (document.body) renderGate();
  }

  if (user) {
    // Lock as soon as the session expires, even if the rep is idle.
    var left = Number(claims.exp) * 1000 - Date.now() - 30000;
    window.setTimeout(function () { endSession('Your session ended. Sign in again.'); },
      Math.min(Math.max(left, 0), 2147483647));
    document.addEventListener('DOMContentLoaded', addUserChip);
    return;
  }

  // ── Locked: hide everything but the gate ─────────────────────
  lock();
  document.addEventListener('DOMContentLoaded', renderGate);

  function lock() {
    document.documentElement.classList.add('fb-locked');
    if (document.getElementById('fb-gate-style')) return;
    var style = document.createElement('style');
    style.id = 'fb-gate-style';
    style.textContent = [
      'html.fb-locked body > *:not(#fb-gate) { display: none !important; }',
      '#fb-gate { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center;',
      '  padding: 16px; background: linear-gradient(to bottom right, #091529, #003057); font-family: "Barlow", sans-serif; }',
      '#fb-gate .fb-gate-box { width: 100%; max-width: 360px; background: #0e2245; border: 1px solid rgba(200,150,42,.25);',
      '  border-radius: 10px; padding: 28px 24px; box-shadow: 0 20px 60px rgba(0,0,0,.45); color: #fff; box-sizing: border-box; }',
      '#fb-gate h1 { margin: 0 0 4px; font-family: "Barlow Condensed", sans-serif; font-weight: 700; font-size: 28px;',
      '  letter-spacing: .04em; text-transform: uppercase; color: #c8962a; }',
      '#fb-gate p { margin: 0 0 20px; color: #8fa4c2; font-size: 14px; }',
      '#fb-gate button { width: 100%; padding: 12px; font-family: "Barlow Condensed", sans-serif; font-weight: 700; font-size: 18px;',
      '  letter-spacing: .06em; text-transform: uppercase; color: #091529; background: #c8962a; border: 0; border-radius: 6px; cursor: pointer; }',
      '#fb-gate button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }',
      '#fb-gate button[disabled] { opacity: .6; cursor: wait; }',
      '#fb-gate .fb-gate-error { min-height: 20px; margin: 12px 0 0; color: #ff8a80; font-size: 14px; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  function renderGate() {
    if (document.getElementById('fb-gate')) {
      document.querySelector('#fb-gate .fb-gate-error').textContent = gateMessage;
      return;
    }
    var chip = document.getElementById('fb-user-chip');
    if (chip) chip.remove();
    var wrap = document.createElement('div');
    wrap.id = 'fb-gate';
    wrap.innerHTML =
      '<div class="fb-gate-box">' +
      '<h1>Fairbank Sales</h1>' +
      '<p>Sign in with your Fairbank HubSpot account.</p>' +
      '<button type="button">Sign in with HubSpot</button>' +
      '<div class="fb-gate-error" role="alert"></div>' +
      '</div>';
    document.body.appendChild(wrap);

    var btn = wrap.querySelector('button');
    var errEl = wrap.querySelector('.fb-gate-error');
    errEl.textContent = gateMessage;
    btn.focus();

    btn.addEventListener('click', function () {
      if (CLIENT_ID.indexOf('REPLACE_') === 0) {
        errEl.textContent = 'HubSpot sign-in is not set up yet (no client id in auth.js).';
        return;
      }
      var nonce = Array.prototype.map.call(window.crypto.getRandomValues(new Uint8Array(16)), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
      ssSet(KEY_NONCE, nonce);
      var back = window.location.href.split('#')[0];
      var url = 'https://app.hubspot.com/oauth/' + HUB_ID + '/authorize' +
        '?client_id=' + encodeURIComponent(CLIENT_ID) +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(SCOPES) +
        '&state=' + encodeURIComponent(b64urlEncode(JSON.stringify({ r: back, n: nonce })));
      btn.disabled = true;
      btn.textContent = 'Opening HubSpot…';
      window.location.assign(url);
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
    // Name only; the Eclipse user id is shown only when there is no name.
    name.textContent = u.name || u.e_user_id;
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
