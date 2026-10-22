/* ============================================================
   Fairbank: Outlook Sync
   All IDs match the fom-* prefixes used in index.html.
   Wrapped in an IIFE so nothing leaks onto window.
   ============================================================ */

(function () {

  // ── Config ──────────────────────────────────────────────────
  var WEBHOOK_URL = 'https://n8n.fairbankequipment.com/webhook/outlook-dash';

  // Order here is the order settings are sent back in the POST body.
  var SETTING_KEYS = {
    users_to_sync:      'users',
    emails_to_exclude:  'emails',
    domains_to_exclude: 'domains',
    domains_to_include: 'domains',
  };

  var EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var DOMAIN_RE = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

  // Users to sync must belong to one of these mailbox domains
  var USER_DOMAINS  = ['@fairbankequipment.com', '@bigwsales.com'];
  var USER_EMAIL_RE = /^[^\s@]+@(fairbankequipment\.com|bigwsales\.com)$/;
  var USER_ID_RE    = /^[A-Z]{6}$/;

  var ICON_X =
    '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
      '<path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';


  // ── Shared utility ───────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function fetchRequest(name) {
    var url = new URL(WEBHOOK_URL);
    url.searchParams.set('request', name);
    return fetch(url.toString()).then(function (res) {
      if (!res.ok) throw new Error('Server returned ' + res.status);
      return res.json();
    });
  }

  function showStateError(boxId, msg) {
    var box = $(boxId);
    box.querySelector('.state-msg').textContent = msg;
    box.classList.toggle('show', !!msg);
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('fom-toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }


  // ── Page header ──────────────────────────────────────────────
  // Same #333 bar as order placement (initHeader() in its app.js): the
  // Fairbank mark left, a user menu right (the rep's name with a caret;
  // it opens their email, Eclipse user id and Sign out). It replaces
  // auth.js's sign-in chip (hidden in styles.css). Sticky; on phones it
  // slides away while scrolling down and comes back on any scroll up.
  function initHeader(user) {
    var name = user.name || user.e_user_id || '';
    var header = document.createElement('header');
    header.className = 'fom-header';
    header.innerHTML =
      '<div class="fom-header__logo">' +
        '<img src="fairbank-mark.png" alt="Fairbank" width="32" height="24">' +
      '</div>' +
      '<div class="fom-umenu">' +
        '<button type="button" class="fom-umenu__btn" aria-haspopup="true" aria-expanded="false">' +
          // Phones show the first name only (CSS swaps the two spans).
          '<span class="fom-umenu__name fom-umenu__name--full">' + escHtml(name) + '</span>' +
          '<span class="fom-umenu__name fom-umenu__name--first">' + escHtml(name.split(/\s+/)[0]) + '</span>' +
          '<svg class="fom-umenu__caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M0 0h10L5 6z" fill="currentColor"/></svg>' +
        '</button>' +
        '<div class="fom-umenu__panel" hidden>' +
          (user.email ? '<div class="fom-umenu__row"><span class="fom-umenu__lbl">Email</span>' + escHtml(user.email) + '</div>' : '') +
          '<div class="fom-umenu__row"><span class="fom-umenu__lbl">Eclipse ID</span>' + escHtml(user.e_user_id || '') + '</div>' +
          '<button type="button" class="fom-umenu__out">Sign out</button>' +
        '</div>' +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);
    header.querySelector('.fom-umenu__out').addEventListener('click', function () {
      if (window.fbSignOut) window.fbSignOut();
    });

    // User menu: the name button toggles it; a click outside or Escape
    // closes it (Escape puts focus back on the button).
    var menuBtn = header.querySelector('.fom-umenu__btn');
    var menu = header.querySelector('.fom-umenu__panel');
    function setMenu(open) {
      menu.hidden = !open;
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    menuBtn.addEventListener('click', function () { setMenu(menu.hidden); });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !header.querySelector('.fom-umenu').contains(e.target)) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) { setMenu(false); menuBtn.focus(); }
    });

    // Phones only (the class does nothing on desktop, see styles.css):
    // hide on a scroll down past the header, show again on a scroll up.
    // Moves under 4px are ignored so a resting finger does not flicker it.
    var lastY = window.scrollY;
    window.addEventListener('scroll', function () {
      var y = window.scrollY;
      if (y <= header.offsetHeight) header.classList.remove('fom-header--hidden');
      else if (y - lastY > 4) header.classList.add('fom-header--hidden');
      else if (lastY - y > 4) header.classList.remove('fom-header--hidden');
      else return;
      lastY = y;
    }, { passive: true });
  }


  // ── Tabs ─────────────────────────────────────────────────────
  var navBtns = document.querySelectorAll('.fairbank-outlook-module .fom-nav-btn');

  function setTab(name) {
    navBtns.forEach(function (btn) {
      var on = btn.dataset.tab === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.fairbank-outlook-module .fom-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'fom-panel-' + name);
    });
    $('fom-savebar').classList.toggle('show', name === 'settings' && isDirty());
    try { history.replaceState(null, '', '#' + name); } catch (_) {}
  }

  navBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setTab(btn.dataset.tab);
      window.scrollTo(0, 0);
    });
  });


  // ── Dashboard: raw JSON highlighting ──────────────────────────
  function highlightJson(json) {
    return escHtml(json).replace(
      /(&quot;(?:\\.|[^\\&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      function (match, str, colon, bool) {
        if (str)  return colon ? '<span class="tok-key">' + str + '</span>' + colon : '<span class="tok-str">' + str + '</span>';
        if (bool) return '<span class="tok-bool">' + match + '</span>';
        if (match === 'null') return '<span class="tok-null">null</span>';
        return '<span class="tok-num">' + match + '</span>';
      }
    );
  }

  // ── Dashboard chart (emails sent / received per user) ────────
  var infoUsers = [];       // normalised rows from users_json
  var chartSort = 'sent';   // sent desc, then received desc, then e_user_id asc
  var chartView = 'chart';

  var CHART_SORTS = {
    total:    function (a, b) { return (b.sent + b.received) - (a.sent + a.received) || a.id.localeCompare(b.id); },
    sent:     function (a, b) { return b.sent - a.sent || b.received - a.received || a.id.localeCompare(b.id); },
    received: function (a, b) { return b.received - a.received || b.sent - a.sent || a.id.localeCompare(b.id); },
    id:       function (a, b) { return a.id.localeCompare(b.id); },
  };

  function parseInfoUsers(data) {
    var rows = data && Array.isArray(data.users_json) ? data.users_json : null;
    if (!rows) throw new Error('Response did not include users_json.');
    return rows.map(function (u) {
      return {
        id:       String(u.e_user_id || '?'),
        email:    String(u.email_address || ''),
        owner:    u.hs_owner_id ? String(u.hs_owner_id) : '',
        sent:     Number(u.emails_sent) || 0,
        received: Number(u.emails_received) || 0,
      };
    });
  }

  // Integer tick step of 1, 2 or 5 x 10^n giving about four intervals
  function niceTicks(max) {
    if (max <= 0) return [0, 1, 2, 3, 4, 5];
    var raw  = max / 4;
    var mag  = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 5, 10].map(function (m) { return m * mag; })
      .filter(function (v) { return v >= raw && v >= 1; })[0] || 1;
    var top = Math.ceil(max / step) * step;
    var ticks = [];
    for (var t = 0; t <= top; t += step) ticks.push(t);
    return ticks;
  }

  function fmtNum(n) { return Number(n).toLocaleString(); }

  function renderTiles() {
    var sent = 0, received = 0, active = 0;
    infoUsers.forEach(function (u) {
      sent += u.sent;
      received += u.received;
      if (u.sent + u.received > 0) active++;
    });
    $('fom-info-tiles').innerHTML =
      '<div class="fom-tile"><div class="fom-tile-label"><span class="fom-swatch fom-swatch-sent"></span>Emails Sent</div>' +
        '<div class="fom-tile-value">' + fmtNum(sent) + '</div></div>' +
      '<div class="fom-tile"><div class="fom-tile-label"><span class="fom-swatch fom-swatch-recv"></span>Emails Received</div>' +
        '<div class="fom-tile-value">' + fmtNum(received) + '</div></div>' +
      '<div class="fom-tile"><div class="fom-tile-label">Active Users</div>' +
        '<div class="fom-tile-value">' + active + '<span class="fom-tile-of"> of ' + infoUsers.length + '</span></div></div>';
  }

  function sortedUsers() {
    return infoUsers.slice().sort(CHART_SORTS[chartSort] || CHART_SORTS.sent);
  }

  function renderChart() {
    var chart = $('fom-chart');
    var users = sortedUsers();
    if (!users.length) {
      chart.innerHTML = '<div class="fom-empty">No user activity to show.</div>';
      return;
    }

    var max   = users.reduce(function (m, u) { return Math.max(m, u.sent, u.received); }, 0);
    var ticks = niceTicks(max);
    var top   = ticks[ticks.length - 1];
    var pct   = function (v) { return (v / top * 100).toFixed(3) + '%'; };

    var grid = ticks.map(function (t) {
      return '<span class="fom-gridline' + (t === 0 ? ' is-zero' : '') + '" style="left:' + pct(t) + '"></span>';
    }).join('');
    var axis = ticks.map(function (t) {
      return '<span class="fom-tick" style="left:' + pct(t) + '">' + fmtNum(t) + '</span>';
    }).join('');

    var rows = users.map(function (u) {
      var idle = u.sent + u.received === 0;
      return '<div class="fom-bar-row' + (idle ? ' is-idle' : '') + '" tabindex="0" data-id="' + escHtml(u.id) + '"' +
          ' aria-label="' + escHtml(u.id + ': ' + u.sent + ' sent, ' + u.received + ' received') + '">' +
        '<span class="fom-bar-label">' + escHtml(u.id) + '</span>' +
        '<span class="fom-bar-plot">' +
          '<span class="fom-bar fom-bar-sent" style="width:' + pct(u.sent) + '"></span>' +
          '<span class="fom-bar fom-bar-recv" style="width:' + pct(u.received) + '"></span>' +
        '</span>' +
      '</div>';
    }).join('');

    chart.innerHTML =
      '<div class="fom-chart-body">' +
        '<div class="fom-chart-grid" aria-hidden="true">' + grid + '</div>' +
        '<div class="fom-bar-rows">' + rows + '</div>' +
      '</div>' +
      '<div class="fom-chart-axis" aria-hidden="true"><span></span><span class="fom-axis-ticks">' + axis + '</span></div>' +
      '<div class="fom-axis-title">Emails</div>';
  }

  function renderChartTable() {
    var body = sortedUsers().map(function (u) {
      return '<tr>' +
        '<td><span class="fom-user-id">' + escHtml(u.id) + '</span></td>' +
        '<td>' + (u.email ? escHtml(u.email) : '<span class="fom-muted">No email</span>') + '</td>' +
        '<td class="num">' + fmtNum(u.sent) + '</td>' +
        '<td class="num">' + fmtNum(u.received) + '</td>' +
        '<td class="num">' + fmtNum(u.sent + u.received) + '</td>' +
        '<td>' + (u.owner ? escHtml(u.owner) : '<span class="fom-muted">Not set</span>') + '</td>' +
      '</tr>';
    }).join('');
    $('fom-chart-table').innerHTML =
      '<table><thead><tr>' +
        '<th>Eclipse User ID</th><th>Email</th><th class="num">Sent</th><th class="num">Received</th><th class="num">Total</th><th>HubSpot Owner</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function renderDashboard() {
    renderTiles();
    renderChart();
    renderChartTable();
  }

  function setChartView(view) {
    chartView = view;
    $('fom-chart-card').classList.toggle('show-table', view === 'table');
    document.querySelectorAll('#fom-chart-card .fom-segmented button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    hideTip();
  }

  // ── Chart tooltip ──
  var tipEl = $('fom-chart-tip');

  function tipHtml(u) {
    return '<div class="fom-tip-head">' +
        '<span class="fom-user-id">' + escHtml(u.id) + '</span>' +
        '<span class="fom-tip-email">' + escHtml(u.email || 'No email') + '</span>' +
      '</div>' +
      '<div class="fom-tip-rows">' +
        '<div class="fom-tip-row"><span><span class="fom-swatch fom-swatch-sent"></span>Sent</span><strong>' + fmtNum(u.sent) + '</strong></div>' +
        '<div class="fom-tip-row"><span><span class="fom-swatch fom-swatch-recv"></span>Received</span><strong>' + fmtNum(u.received) + '</strong></div>' +
        '<div class="fom-tip-row fom-tip-total"><span>Total</span><strong>' + fmtNum(u.sent + u.received) + '</strong></div>' +
      '</div>' +
      '<div class="fom-tip-foot"><span>HubSpot Owner ID</span>' +
        (u.owner ? '<span class="fom-tip-owner">' + escHtml(u.owner) + '</span>' : '<span class="fom-muted">Not set</span>') +
      '</div>';
  }

  // x / y are relative to the chart wrap; flips to stay inside it
  function showTip(u, x, y) {
    var wrap = $('fom-chart-wrap');
    tipEl.innerHTML = tipHtml(u);
    tipEl.classList.add('show');
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var left = x + 16, topPos = y + 16;
    if (left + w > wrap.clientWidth - 8) left = Math.max(8, x - w - 16);
    if (topPos + h > wrap.clientHeight - 8) topPos = Math.max(8, y - h - 16);
    tipEl.style.left = left + 'px';
    tipEl.style.top  = topPos + 'px';
  }

  function hideTip() {
    tipEl.classList.remove('show');
    document.querySelectorAll('#fom-chart .fom-bar-row.hover').forEach(function (r) { r.classList.remove('hover'); });
  }

  function userById(id) {
    for (var i = 0; i < infoUsers.length; i++) if (infoUsers[i].id === id) return infoUsers[i];
    return null;
  }

  function highlightRow(row) {
    document.querySelectorAll('#fom-chart .fom-bar-row.hover').forEach(function (r) {
      if (r !== row) r.classList.remove('hover');
    });
    row.classList.add('hover');
  }

  $('fom-chart').addEventListener('mousemove', function (e) {
    var row = e.target.closest('.fom-bar-row');
    var u   = row && userById(row.dataset.id);
    if (!u) { hideTip(); return; }
    var r = $('fom-chart-wrap').getBoundingClientRect();
    highlightRow(row);
    showTip(u, e.clientX - r.left, e.clientY - r.top);
  });

  $('fom-chart').addEventListener('mouseleave', hideTip);

  // Keyboard: focusing a row shows its card beside the label
  $('fom-chart').addEventListener('focusin', function (e) {
    var row = e.target.closest('.fom-bar-row');
    var u   = row && userById(row.dataset.id);
    if (!u) return;
    var wr = $('fom-chart-wrap').getBoundingClientRect();
    var rr = row.getBoundingClientRect();
    highlightRow(row);
    showTip(u, rr.left - wr.left + 80, rr.top - wr.top);
  });

  $('fom-chart').addEventListener('focusout', hideTip);

  $('fom-chart-sort').addEventListener('change', function () {
    chartSort = this.value;
    hideTip();
    if (infoUsers.length) { renderChart(); renderChartTable(); }
  });

  document.querySelectorAll('#fom-chart-card .fom-segmented button').forEach(function (b) {
    b.addEventListener('click', function () { setChartView(b.dataset.view); });
  });

  $('fom-raw-toggle').addEventListener('click', function () {
    var open = !$('fom-raw-card').classList.contains('expanded');
    $('fom-raw-card').classList.toggle('expanded', open);
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  function loadInfo() {
    var btn  = $('fom-info-refresh');
    var code = $('fom-info-code');
    btn.disabled = true;
    btn.classList.add('spinning');
    showStateError('fom-info-error', '');
    hideTip();

    fetchRequest('info')
      .then(function (data) {
        code.innerHTML = highlightJson(JSON.stringify(data, null, 2));
        infoUsers = parseInfoUsers(data);
        renderDashboard();
        $('fom-info-meta').textContent = infoUsers.length + ' users · Updated ' + new Date().toLocaleTimeString();
      })
      .catch(function (err) {
        $('fom-chart').innerHTML = '';
        showStateError('fom-info-error', 'Could not load dashboard data: ' + err.message);
      })
      .finally(function () {
        btn.disabled = false;
        btn.classList.remove('spinning');
      });
  }

  $('fom-info-refresh').addEventListener('click', loadInfo);


  // ── Settings state ───────────────────────────────────────────
  var saved = null;   // last state confirmed by the server
  var draft = null;   // working copy the user is editing

  function emptySettings() {
    var s = {};
    Object.keys(SETTING_KEYS).forEach(function (id) {
      s[id] = {};
      s[id][SETTING_KEYS[id]] = [];
    });
    return s;
  }

  // GET returns { results: [{ setting_id, data }] }; normalise to the POST shape.
  function parseSettings(resp) {
    var s = emptySettings();
    var rows = resp && Array.isArray(resp.results) ? resp.results : [];
    rows.forEach(function (row) {
      var listKey = SETTING_KEYS[row.setting_id];
      if (!listKey) return;
      var list = row.data && Array.isArray(row.data[listKey]) ? row.data[listKey] : [];
      s[row.setting_id][listKey] = list;
    });
    return s;
  }

  function isDirty() {
    return !!saved && JSON.stringify(saved) !== JSON.stringify(draft);
  }

  function syncDirtyUi() {
    var dirty = isDirty();
    $('fom-dirty-dot').classList.toggle('show', dirty);
    $('fom-savebar').classList.toggle('show', dirty && $('fom-panel-settings').classList.contains('active'));
    if (dirty) setSaveMsg('You have unsaved changes', false);
  }

  function setSaveMsg(msg, isError) {
    var el = $('fom-savebar-msg');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  function savedHas(settingId, matchFn) {
    var list = saved[settingId][SETTING_KEYS[settingId]];
    return list.some(matchFn);
  }


  // ── Settings rendering ───────────────────────────────────────
  var usersExpanded = false;   // always starts collapsed

  function setUsersExpanded(on) {
    usersExpanded = on;
    $('fom-users-card').classList.toggle('expanded', on);
    $('fom-users-toggle').setAttribute('aria-expanded', on ? 'true' : 'false');
    $('fom-users-expand').textContent = on ? 'Hide users' : 'Show users';
  }

  function userMatches(u, q) {
    if (!q) return true;
    return [u.email, u.e_user_id, u.hs_owner_id].some(function (v) {
      return String(v || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  // Summary pills: total, per-domain counts, and unsaved adds / removals
  function renderUsersRollup(users) {
    var byDomain = {};
    users.forEach(function (u) {
      var d = u.email.slice(u.email.indexOf('@'));
      byDomain[d] = (byDomain[d] || 0) + 1;
    });

    var draftEmails = users.map(function (u) { return u.email; });
    var savedEmails = saved.users_to_sync.users.map(function (u) { return u.email; });
    var added   = draftEmails.filter(function (e) { return savedEmails.indexOf(e) === -1; }).length;
    var removed = savedEmails.filter(function (e) { return draftEmails.indexOf(e) === -1; }).length;

    var html = '<span class="fom-stat"><strong>' + users.length + '</strong> ' + (users.length === 1 ? 'user' : 'users') + '</span>';
    Object.keys(byDomain)
      .sort(function (a, b) { return byDomain[b] - byDomain[a]; })
      .forEach(function (d) {
        html += '<span class="fom-stat"><strong>' + byDomain[d] + '</strong> ' + escHtml(d) + '</span>';
      });
    if (added)   html += '<span class="fom-stat fom-stat-add"><strong>+' + added + '</strong> unsaved</span>';
    if (removed) html += '<span class="fom-stat fom-stat-remove"><strong>&minus;' + removed + '</strong> unsaved</span>';
    $('fom-users-rollup').innerHTML = html;
  }

  function renderUsers() {
    var users = draft.users_to_sync.users;
    var rows  = $('fom-users-rows');
    var q     = $('fom-users-search').value.trim().toLowerCase();
    $('fom-users-count').textContent = users.length;
    renderUsersRollup(users);
    rows.innerHTML = '';

    var shown = 0;
    users.forEach(function (u, i) {
      if (!userMatches(u, q)) return;
      shown++;
      var isNew = !savedHas('users_to_sync', function (s) { return s.email === u.email; });
      var row = document.createElement('div');
      row.className = 'fom-user-row fom-users-grid' + (isNew ? ' is-new' : '');
      row.innerHTML =
        '<span class="fom-user-email" title="' + escHtml(u.email) + '">' + escHtml(u.email) + '</span>' +
        '<span class="fom-user-id">' + escHtml(u.e_user_id || '—') + '</span>' +
        '<span class="fom-owner-id">' + escHtml(u.hs_owner_id || '—') + '</span>' +
        '<button class="fom-remove-btn" title="Remove user" aria-label="Remove ' + escHtml(u.email) + '">' + ICON_X + '</button>';
      row.querySelector('.fom-remove-btn').addEventListener('click', function () {
        draft.users_to_sync.users.splice(i, 1);
        renderUsers();
        syncDirtyUi();
      });
      rows.appendChild(row);
    });

    $('fom-users-filter-count').textContent = q ? 'Showing ' + shown + ' of ' + users.length : '';
    if (!users.length) {
      rows.innerHTML = '<div class="fom-empty">No users are being synced.</div>';
    } else if (!shown) {
      rows.innerHTML = '<div class="fom-empty">No users match &quot;' + escHtml(q) + '&quot;.</div>';
    }
  }

  $('fom-users-toggle').addEventListener('click', function () { setUsersExpanded(!usersExpanded); });
  $('fom-users-expand').addEventListener('click', function () { setUsersExpanded(!usersExpanded); });
  $('fom-users-search').addEventListener('input', renderUsers);
  setUsersExpanded(false);

  function renderChips(settingId, chipsId, countId, emptyMsg) {
    var listKey = SETTING_KEYS[settingId];
    var list    = draft[settingId][listKey];
    var wrap    = $(chipsId);
    $(countId).textContent = list.length;
    wrap.innerHTML = '';

    if (!list.length) {
      wrap.innerHTML = '<div class="fom-empty">' + escHtml(emptyMsg) + '</div>';
      return;
    }

    list.forEach(function (val, i) {
      var isNew = !savedHas(settingId, function (s) { return s === val; });
      var chip = document.createElement('span');
      chip.className = 'fom-chip' + (isNew ? ' is-new' : '');
      chip.innerHTML =
        '<span>' + escHtml(val) + '</span>' +
        '<button class="fom-remove-btn" title="Remove" aria-label="Remove ' + escHtml(val) + '">' + ICON_X + '</button>';
      chip.querySelector('.fom-remove-btn').addEventListener('click', function () {
        draft[settingId][listKey].splice(i, 1);
        renderChips(settingId, chipsId, countId, emptyMsg);
        syncDirtyUi();
      });
      wrap.appendChild(chip);
    });
  }

  function renderEmails()  { renderChips('emails_to_exclude',  'fom-emails-chips',  'fom-emails-count',  'No emails are excluded.'); }
  function renderDomains() { renderChips('domains_to_exclude', 'fom-domains-chips', 'fom-domains-count', 'No domains are excluded.'); }
  function renderIncludeDomains() { renderChips('domains_to_include', 'fom-include-domains-chips', 'fom-include-domains-count', 'No domains are included.'); }

  function renderSettings() {
    renderUsers();
    renderEmails();
    renderDomains();
    renderIncludeDomains();
    syncDirtyUi();
  }


  // ── Add forms ────────────────────────────────────────────────
  function formError(id, msg, inputEl) {
    var el = $(id);
    el.textContent = msg || '';
    el.classList.toggle('show', !!msg);
    el.classList.remove('note');
    if (inputEl) {
      inputEl.classList.add('invalid');
      inputEl.focus();
    }
  }

  function formNote(id, msg) {
    var el = $(id);
    el.textContent = msg;
    el.classList.add('show', 'note');
  }

  function clearFormError(form, errId) {
    form.querySelectorAll('input').forEach(function (i) { i.classList.remove('invalid'); });
    formError(errId, '');
  }

  // Users
  var usersForm = $('fom-users-form');
  usersForm.addEventListener('input', function () { clearFormError(usersForm, 'fom-users-form-error'); });

  // Force Eclipse user ID to capital letters as the user types
  usersForm.elements.e_user_id.addEventListener('input', function () {
    var pos = this.selectionStart;
    var cleaned = this.value.toUpperCase().replace(/[^A-Z]/g, '');
    if (cleaned !== this.value) {
      var removed = this.value.length - cleaned.length;
      this.value = cleaned;
      this.setSelectionRange(Math.max(0, pos - removed), Math.max(0, pos - removed));
    }
  });
  usersForm.addEventListener('submit', function (e) {
    e.preventDefault();
    clearFormError(usersForm, 'fom-users-form-error');
    var f = usersForm.elements;
    var user = {
      email:       f.email.value.trim().toLowerCase(),
      e_user_id:   f.e_user_id.value.trim().toUpperCase(),
      hs_owner_id: f.hs_owner_id.value.trim(),
    };

    if (!USER_EMAIL_RE.test(user.email)) return formError('fom-users-form-error', 'Email must end with ' + USER_DOMAINS.join(' or ') + '.', f.email);
    if (!USER_ID_RE.test(user.e_user_id)) return formError('fom-users-form-error', 'Eclipse user ID must be exactly 6 capital letters.', f.e_user_id);
    if (user.hs_owner_id && !/^\d+$/.test(user.hs_owner_id)) return formError('fom-users-form-error', 'HubSpot owner ID should be numeric.', f.hs_owner_id);

    var exists = draft.users_to_sync.users.some(function (u) { return u.email.toLowerCase() === user.email; });
    if (exists) return formError('fom-users-form-error', user.email + ' is already in the list.', f.email);

    draft.users_to_sync.users.push(user);
    usersForm.reset();
    f.email.focus();
    $('fom-users-search').value = '';
    setUsersExpanded(true);
    renderUsers();
    syncDirtyUi();
    var rowsEl = $('fom-users-rows');
    rowsEl.scrollTop = rowsEl.scrollHeight;   // new user is appended last
  });

  // Emails / domains share one handler. Accepts a comma-separated list,
  // ignores all whitespace, and rejects semicolons outright.
  var SEMICOLON_MSG = 'Semicolons are not allowed. Separate entries with commas.';

  function bindListForm(formId, errId, settingId, normalise, validate, render) {
    var form = $(formId);
    var input = form.elements.value;

    form.addEventListener('input', function () {
      clearFormError(form, errId);
      if (input.value.indexOf(';') !== -1) formError(errId, SEMICOLON_MSG, input);
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearFormError(form, errId);

      var raw = input.value.replace(/\s+/g, '');
      if (raw.indexOf(';') !== -1) return formError(errId, SEMICOLON_MSG, input);

      var values = raw.split(',').filter(Boolean).map(normalise);
      if (!values.length) return formError(errId, validate(''), input);

      var invalid = values.filter(function (v) { return validate(v); });
      if (invalid.length) {
        var msg = invalid.length === 1 && values.length === 1
          ? validate(invalid[0])
          : 'Not valid: ' + invalid.join(', ') + '. Nothing was added.';
        return formError(errId, msg, input);
      }

      var list    = draft[settingId][SETTING_KEYS[settingId]];
      var skipped = [];
      values.forEach(function (v) {
        if (list.indexOf(v) === -1) list.push(v);
        else if (skipped.indexOf(v) === -1) skipped.push(v);
      });

      if (skipped.length === values.length) {
        return formError(errId, skipped.join(', ') + (skipped.length === 1 ? ' is' : ' are') + ' already in the list.', input);
      }

      form.reset();
      input.focus();
      render();
      syncDirtyUi();
      if (skipped.length) formNote(errId, 'Skipped (already in the list): ' + skipped.join(', '));
    });
  }

  bindListForm('fom-emails-form', 'fom-emails-form-error', 'emails_to_exclude',
    function (v) { return v.toLowerCase(); },
    function (v) { return EMAIL_RE.test(v) ? '' : 'Enter a valid email address.'; },
    renderEmails
  );

  function normaliseDomain(v) {
    v = v.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (v.indexOf('@') > 0) v = v.slice(v.indexOf('@'));   // pasted a full address
    return v && v.charAt(0) !== '@' ? '@' + v : v;
  }

  // A domain can't be both included and excluded
  function validateDomain(otherId, otherLabel) {
    return function (v) {
      if (!DOMAIN_RE.test(v)) return 'Enter a valid domain, e.g. example.com';
      if (draft[otherId].domains.indexOf(v) !== -1) return v + ' is already in ' + otherLabel + '.';
      return '';
    };
  }

  bindListForm('fom-domains-form', 'fom-domains-form-error', 'domains_to_exclude',
    normaliseDomain, validateDomain('domains_to_include', 'Domains to Include'), renderDomains
  );

  bindListForm('fom-include-domains-form', 'fom-include-domains-form-error', 'domains_to_include',
    normaliseDomain, validateDomain('domains_to_exclude', 'Domains to Exclude'), renderIncludeDomains
  );


  // ── Load / save / cancel ─────────────────────────────────────
  function loadSettings() {
    var btn = $('fom-settings-refresh');
    if (isDirty() && !window.confirm('Discard unsaved changes and reload settings?')) return;

    btn.disabled = true;
    btn.classList.add('spinning');
    showStateError('fom-settings-error', '');
    if (!saved) $('fom-settings-loading').classList.add('show');

    fetchRequest('settings')
      .then(function (resp) {
        saved = parseSettings(resp);
        draft = clone(saved);
        $('fom-settings-body').classList.add('show');
        renderSettings();
      })
      .catch(function (err) {
        showStateError('fom-settings-error', 'Could not load settings: ' + err.message);
      })
      .finally(function () {
        btn.disabled = false;
        btn.classList.remove('spinning');
        $('fom-settings-loading').classList.remove('show');
      });
  }

  function setSaving(on) {
    $('fom-save-btn').disabled          = on;
    $('fom-cancel-btn').disabled        = on;
    $('fom-save-spinner').style.display = on ? 'block' : 'none';
    $('fom-save-label').textContent     = on ? 'Saving…' : 'Save';
  }

  $('fom-save-btn').addEventListener('click', function () {
    var body = { settings: clone(draft) };
    setSaving(true);

    fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error('Server returned ' + res.status + (t ? ': ' + t : ''));
          });
        }
        saved = clone(draft);
        renderSettings();
        toast('Settings saved');
      })
      .catch(function (err) {
        setSaveMsg('Save failed. ' + err.message, true);
      })
      .finally(function () { setSaving(false); });
  });

  $('fom-cancel-btn').addEventListener('click', function () {
    draft = clone(saved);
    ['fom-users-form', 'fom-emails-form', 'fom-domains-form', 'fom-include-domains-form'].forEach(function (id) {
      $(id).reset();
      clearFormError($(id), id + '-error');
    });
    renderSettings();
  });

  $('fom-settings-refresh').addEventListener('click', loadSettings);

  window.addEventListener('beforeunload', function (e) {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });


  // ── Boot ─────────────────────────────────────────────────────
  // auth.js sets FB_USER once the rep is signed in (the page stays
  // hidden behind its sign-in gate until then).
  if (window.FB_USER) initHeader(window.FB_USER);
  setTab(location.hash === '#dashboard' ? 'dashboard' : 'settings');
  loadInfo();
  loadSettings();

})();
