// ===========================================================================
// Fairbank Sales Outreach, app.js
// ===========================================================================
//
//   1. List: the customers a rep should call (HubSpot customers, object
//      0-2), with their status, phone numbers, the Eclipse customer id and
//      the state. A box filters the list on the page.
//   2. Side card: a customer's buttons (Audio Note, Record Call, Status,
//      Task, Place an order), a free-text note box and properties (phone
//      numbers, insights, create date, street, city, state). ?customer=58856 opens it.
//
// Nothing is saved to HubSpot yet: the note box and the recording and task
// dialogs work in the browser only and say so. A status (Status button)
// shows in the list and on the card until the page is reloaded.
//
// Backend (n8n; nothing is written to HubSpot):
//   sales-outreach/customers         the call list (a fixed list of customer ids)
//   sales-outreach/transcribe (POST) a recording → AssemblyAI; answers a transcript id
//   sales-outreach/transcript?id=    that transcript, polled until done, with
//                                    lines labelled Speaker 1, Speaker 2, ...
//
// The rep comes from window.FB_USER, set by ../auth.js, which also adds the
// session token to the call.
// ===========================================================================

(function () {
  "use strict";

  var API = "https://n8n.fairbankequipment.com/webhook/sales-outreach/customers";
  var TRANSCRIBE_API = "https://n8n.fairbankequipment.com/webhook/sales-outreach/transcribe";
  var TRANSCRIPT_API = "https://n8n.fairbankequipment.com/webhook/sales-outreach/transcript";
  var ORDER_PAGE = "../order-placement/";

  // HubSpot's state property holds the 2-letter code; the list shows the
  // name, like HubSpot does.
  var STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
    CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
    KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
    MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
    NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
    NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
    OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
    TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
    WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  };

  // Call statuses (Status button). Kept on the page only, until a reload
  // (2026-10-29, on request: "should not save, but it should update the
  // site itself (temporarily)"). tone picks the pill colour (styles.css).
  var STATUSES = [
    { key: "called", label: "Called", tone: "ok" },
    { key: "voicemail", label: "Left voicemail", tone: "info" },
    { key: "no-answer", label: "No answer", tone: "warn" },
    { key: "call-back", label: "Call back later", tone: "info" },
    { key: "ordered", label: "Placed an order", tone: "ok" },
    { key: "not-interested", label: "Not interested", tone: "bad" },
  ];

  function statusOf(key) { return STATUSES.filter(function (x) { return x.key === key; })[0] || null; }

  function statusPill(key) {
    var st = statusOf(key);
    return st ? '<span class="so-pill so-pill--' + st.tone + '">' + esc(st.label) + "</span>" : "";
  }

  function stateName(code) { return STATES[String(code || "").toUpperCase()] || code || ""; }

  // Card button icons (stroke icons, currentColor).
  function icon(paths) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
  }
  var ICONS = {
    mic: icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    call: icon('<path d="M21 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.1 4.2 2 2 0 0 1 3.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L7 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/><circle cx="18.5" cy="5.5" r="2.5" fill="currentColor" stroke="none"/>'),
    status: icon('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
    task: icon('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>'),
    order: icon('<path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2"/><circle cx="10" cy="20.5" r="1.3"/><circle cx="17" cy="20.5" r="1.3"/>'),
    text: icon('<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>'),
    close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  };

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // "2026-10-29T13:14:04.373Z" → "Oct 29, 2026, 9:14 AM" (the rep's time zone).
  function dateTimeText(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d)) return iso || "";
    return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // 75 → "1:15"
  function clock(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function getJson(url, init) {
    return fetch(url || API, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || (data && data.error && !data.success)) {
          throw new Error((data && data.error) || ("Server error (status " + res.status + ")"));
        }
        return data;
      });
    });
  }

  // ?customer=58856 (replaced, not pushed; null removes it).
  function setParam(key, value) {
    var p = new URLSearchParams(window.location.search);
    if (value == null || value === "") p.delete(key); else p.set(key, value);
    var q = p.toString();
    window.history.replaceState(window.history.state, "", window.location.pathname + (q ? "?" + q : ""));
  }

  function orderUrl(c) { return ORDER_PAGE + "?e_customer_id=" + encodeURIComponent(c.e_customer_id); }

  // ── App ──────────────────────────────────────────────────────────────────

  function initApp(root) {
    initHeader(root, window.FB_USER || {});

    var state = {
      list: { loading: true },  // { loading } | { error } | { customers }
      filter: "",
      openId: new URLSearchParams(window.location.search).get("customer") || "",
      dialog: null,             // { kind: audio | call | task, customer }
      notes: {},                // e_customer_id → the card's note text
      statuses: {},             // e_customer_id → status key (STATUSES), page only
    };
    var rec = null;             // open recorder: { stream, recorder, chunks, started, timer, url, blob, error, tx }

    root.innerHTML =
      '<div class="fop-wrap so-wrap">' +
      '<div class="so-top"><div><div class="fop-kicker">Sales Outreach</div><h1 class="fop-h1">Customers</h1></div>' +
      '<input id="so-filter" class="fop-input so-filter" type="search" autocomplete="off" spellcheck="false" placeholder="Search name, ID, phone or state" aria-label="Search customers"></div>' +
      '<div data-cell="list"></div>' +
      "</div>" +
      '<div data-cell="panel"></div>' +
      '<div data-cell="dialog"></div>';

    function cell(name) { return root.querySelector('[data-cell="' + name + '"]'); }

    function customers() { return state.list.customers || []; }
    function byId(id) { return customers().filter(function (c) { return c.e_customer_id === id; })[0] || null; }

    // Every typed word must be in the name, id, a phone or the state.
    function filtered() {
      var words = state.filter.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return customers();
      return customers().filter(function (c) {
        var st = statusOf(state.statuses[c.e_customer_id]);
        var hay = [c.name, c.e_customer_id, c.phones.join(" "), c.state, stateName(c.state), st ? st.label : ""].join(" ").toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
    }

    // ── List ──
    function paintList() {
      var box = cell("list");
      if (state.list.loading) {
        box.innerHTML = '<div class="fop-center"><div class="fop-spinner"></div>Loading customers…</div>';
        return;
      }
      if (state.list.error) {
        box.innerHTML = '<div class="fop-alert fop-alert--error">Could not load customers: ' + esc(state.list.error) +
          ' <button type="button" class="fop-btn fop-btn--ghost fop-btn--sm so-retry" data-action="retry">Try again</button></div>';
        return;
      }
      var rows = filtered();
      var total = customers().length;
      box.innerHTML =
        '<div class="fop-card so-list" role="table" aria-label="Customers">' +
        '<div class="so-row so-row--head" role="row">' +
        '<span role="columnheader">Customer name</span><span role="columnheader">Status</span><span role="columnheader">Phone Numbers</span>' +
        '<span role="columnheader">Customer ID</span><span role="columnheader">State</span></div>' +
        (rows.length ? rows.map(rowHtml).join("") : '<div class="so-empty">' + (total ? "No customers match your search." : "No customers on the list.") + "</div>") +
        "</div>" +
        '<div class="so-count">' + (rows.length === total ? total + " customer" + (total === 1 ? "" : "s")
          : rows.length + " of " + total + " customers") + "</div>";
    }

    function rowHtml(c) {
      var on = c.e_customer_id === state.openId;
      return '<div class="so-row' + (on ? " so-row--on" : "") + '" role="row" data-open="' + esc(c.e_customer_id) + '">' +
        '<span role="cell" class="so-cell so-cell--name"><button type="button" class="so-name" data-open="' + esc(c.e_customer_id) + '"' +
        (on ? ' aria-current="true"' : "") + ">" + esc(c.name) + "</button></span>" +
        '<span role="cell" class="so-cell so-cell--status' + (state.statuses[c.e_customer_id] ? "" : " so-cell--empty") + '">' +
        (statusPill(state.statuses[c.e_customer_id]) || '<span class="fop-muted">--</span>') + "</span>" +
        '<span role="cell" class="so-cell so-cell--phones" data-lbl="Phone Numbers">' +
        (c.phones.length ? c.phones.map(function (p) { return '<span class="so-phone">' + esc(p) + "</span>"; }).join("") : '<span class="fop-muted">--</span>') + "</span>" +
        '<span role="cell" class="so-cell so-cell--id" data-lbl="Customer ID"><span class="fop-badge">' + esc(c.e_customer_id) + "</span></span>" +
        '<span role="cell" class="so-cell so-cell--state" data-lbl="State">' + esc(stateName(c.state)) + "</span>" +
        "</div>";
    }

    // ── Side card ──
    function paintPanel() {
      var box = cell("panel");
      var c = byId(state.openId);
      document.documentElement.classList.toggle("so-panel-open", !!c);
      if (!c) { box.innerHTML = ""; return; }
      var prop = function (label, value, cls) {
        return '<div class="so-prop"><div class="so-prop__lbl">' + esc(label) + '</div><div class="so-prop__val' + (cls ? " " + cls : "") + '">' +
          (value ? esc(value) : '<span class="fop-muted">--</span>') + "</div></div>";
      };
      var btn = function (kind, label, ic) {
        return '<button type="button" class="so-act" data-dialog="' + kind + '"><span class="so-act__ic">' + ic + '</span><span class="so-act__lbl">' + esc(label) + "</span></button>";
      };
      box.innerHTML =
        '<div class="so-scrim" data-action="close-panel"></div>' +
        '<aside class="so-panel" role="dialog" aria-modal="false" aria-labelledby="so-panel-title">' +
        '<div class="so-panel__head">' +
        '<div class="so-panel__top"><span class="so-panel__tags"><span class="fop-badge">' + esc(c.e_customer_id) + "</span>" +
        statusPill(state.statuses[c.e_customer_id]) + "</span>" +
        '<button type="button" class="so-x" data-action="close-panel" aria-label="Close">' + ICONS.close + "</button></div>" +
        '<h2 class="fop-h2 so-panel__title" id="so-panel-title">' + esc(c.name) + "</h2>" +
        '<div class="so-acts">' +
        btn("audio", "Audio Note", ICONS.mic) +
        btn("call", "Record Call", ICONS.call) +
        btn("status", "Status", ICONS.status) +
        btn("task", "Task", ICONS.task) +
        '<a class="so-act" href="' + esc(orderUrl(c)) + '" target="_blank" rel="noopener"><span class="so-act__ic">' + ICONS.order + '</span><span class="so-act__lbl">Place an order</span></a>' +
        "</div>" +
        // Free-text note, always open (was a Text Note button and dialog
        // until 2026-10-29). Kept per customer while the page is open.
        '<label class="fop-label so-note__lbl" for="so-note">Note <span class="fop-muted">(not saved to HubSpot yet)</span></label>' +
        '<textarea class="fop-input so-text so-note" id="so-note" rows="3" placeholder="What did you talk about?">' + esc(state.notes[c.e_customer_id] || "") + "</textarea>" +
        "</div>" +
        '<div class="so-panel__body">' +
        prop("Phone Numbers", c.phones.join("\n"), "so-prop__val--lines") +
        prop("Customer insights", c.insights, "so-prop__val--lines") +
        prop("Create date", dateTimeText(c.create_date)) +
        prop("Street address", c.street) +
        prop("City", c.city) +
        prop("State", stateName(c.state)) +
        "</div></aside>";
      autosize(box.querySelector("#so-note"));
    }

    // The note box grows with its text (each new line), from its 3-row
    // minimum (styles.css).
    function autosize(el) {
      if (!el) return;
      el.style.height = "auto";
      el.style.height = el.scrollHeight + (el.offsetHeight - el.clientHeight) + "px";
    }

    function openPanel(id) {
      state.openId = id;
      setParam("customer", id);
      paintList();
      paintPanel();
      var x = root.querySelector(".so-panel .so-x");
      if (x) x.focus();
    }

    function closePanel() {
      var id = state.openId;
      state.openId = "";
      setParam("customer", null);
      paintList();
      paintPanel();
      var row = root.querySelector('.so-name[data-open="' + id + '"]');
      if (row) row.focus();
    }

    // ── Dialogs (browser only, not saved to HubSpot yet) ──
    var TITLES = { audio: "Audio Note", call: "Record Call", status: "Status", task: "Task" };
    var NOT_SAVED = '<div class="fop-alert fop-alert--info">Not saved to HubSpot yet. Save closes this box.</div>';

    function paintDialog() {
      var box = cell("dialog");
      var d = state.dialog;
      if (!d) { box.innerHTML = ""; return; }
      var body = "";
      if (d.kind === "status") {
        var cur = state.statuses[d.customer.e_customer_id] || "";
        body = '<div class="so-status" role="radiogroup" aria-label="Status">' +
          STATUSES.concat([{ key: "", label: "No status" }]).map(function (st) {
            return '<label class="so-status__opt"><input type="radio" name="so-status" value="' + st.key + '"' + (st.key === cur ? " checked" : "") + ">" +
              (st.key ? statusPill(st.key) : '<span class="fop-muted">' + esc(st.label) + "</span>") + "</label>";
          }).join("") + "</div>";
      } else if (d.kind === "task") {
        body = '<div class="so-form">' +
          '<div><label class="fop-label" for="so-task-title">Task</label><input class="fop-input" id="so-task-title" autocomplete="off" placeholder="Call back about pump quote"></div>' +
          '<div><label class="fop-label" for="so-task-due">Due date</label><input class="fop-input" id="so-task-due" type="date"></div>' +
          '<div><label class="fop-label" for="so-task-notes">Notes</label><textarea class="fop-input so-text" id="so-task-notes" rows="4"></textarea></div>' +
          "</div>";
      } else {
        // Record Call: the rep must tell the customer first; the notice stays
        // up while recording (only the rec cell repaints).
        body = (d.kind === "call"
          ? '<div class="fop-alert fop-alert--warning so-consent" role="alert"><strong>Tell the customer this call is being recorded</strong> before you start recording.</div>' +
            '<p class="so-desc">Put the call on speaker, then record. The recording stays in this browser.</p>'
          : '<p class="so-desc">Record a quick voice note about this customer.</p>') +
          '<div class="so-rec" data-cell="rec">' + recHtml() + "</div>";
      }
      box.innerHTML =
        '<div class="fop-modal" role="dialog" aria-modal="true" aria-labelledby="so-dialog-title">' +
        '<div class="fop-modal__box fop-modal__box--sm">' +
        '<div><h2 class="fop-h2 so-dialog__title" id="so-dialog-title">' + esc(TITLES[d.kind]) + "</h2>" +
        '<div class="so-dialog__who">' + esc(d.customer.name) + "</div></div>" +
        body + (d.kind === "status"
          ? '<div class="fop-alert fop-alert--info">Shown on this page until you reload it. Not saved to HubSpot.</div>' : NOT_SAVED) +
        '<div class="fop-row fop-row--end">' +
        '<button type="button" class="fop-btn fop-btn--ghost" data-action="close-dialog">Cancel</button>' +
        '<button type="button" class="fop-btn" data-action="save-dialog">Save</button>' +
        "</div></div></div>";
      var first = box.querySelector("input:checked, textarea, input, .so-rec button");
      if (first) first.focus();
    }

    function openDialog(kind) {
      var c = byId(state.openId);
      if (!c) return;
      state.dialog = { kind: kind, customer: c };
      paintDialog();
    }

    function closeDialog() {
      stopRecorder(true);
      state.dialog = null;
      paintDialog();
      var btn = root.querySelector('.so-panel [data-dialog]');
      if (btn) btn.focus();
    }

    // Status: the picked status shows in the list and on the card until the
    // page is reloaded ("No status" clears it). Nothing is sent anywhere.
    function saveStatus() {
      var id = state.dialog.customer.e_customer_id;
      var pick = cell("dialog").querySelector('input[name="so-status"]:checked');
      if (pick && pick.value) state.statuses[id] = pick.value; else delete state.statuses[id];
      closeDialog();
      paintList();
      paintPanel();
      var b = root.querySelector('.so-panel [data-dialog="status"]');
      if (b) b.focus();
    }

    // Recorder (Audio Note, Record Call): Record → Stop → play back, with
    // Record again. The microphone is released on Stop and when the box
    // closes.
    function recHtml() {
      if (rec && rec.error) return '<div class="fop-alert fop-alert--error">' + esc(rec.error) + "</div>" + recBtn("rec-start", "Try again");
      if (rec && rec.recorder && rec.recorder.state === "recording") {
        return '<div class="so-rec__live"><span class="so-rec__dot" aria-hidden="true"></span>Recording <span class="so-rec__time" data-cell="rec-time">' +
          clock((Date.now() - rec.started) / 1000) + "</span></div>" + recBtn("rec-stop", "Stop");
      }
      if (rec && rec.url) {
        return '<audio class="so-rec__audio" controls src="' + rec.url + '"></audio>' +
          '<div class="so-rec__meta">' + clock(rec.seconds) + " recorded</div>" +
          '<div class="so-rec__btns">' + recBtn("rec-start", "Record again", true) +
          (rec.tx ? "" : '<button type="button" class="fop-btn so-rec__btn" data-action="transcribe">' + ICONS.text + "Transcribe</button>") +
          '</div><div class="so-tx" data-cell="tx">' + txHtml() + "</div>";
      }
      return recBtn("rec-start", "Start recording");
    }

    // Transcript (Transcribe button): the recording goes to AssemblyAI through
    // n8n, then the page asks every 3 seconds until it is done. Speakers are
    // numbered in the order they first talk. Kept with the recording only:
    // Record again or closing the box drops it.
    function txHtml() {
      var tx = rec && rec.tx;
      if (!tx) return "";
      if (tx.error) {
        return '<div class="fop-alert fop-alert--error">' + esc(tx.error) + "</div>" +
          '<button type="button" class="fop-btn fop-btn--ghost fop-btn--sm" data-action="transcribe">Try again</button>';
      }
      if (!tx.lines) return '<div class="so-tx__wait"><span class="fop-spinner" aria-hidden="true"></span>' + esc(tx.msg || "Transcribing…") + "</div>";
      if (!tx.lines.length) return '<div class="so-tx__wait">No speech was found in this recording.</div>';
      return '<div class="so-tx__head"><span class="fop-label">Transcript</span>' +
        '<button type="button" class="fop-btn fop-btn--ghost fop-btn--sm" data-action="copy-tx">' + (tx.copied ? "Copied" : "Copy") + "</button></div>" +
        '<div class="so-tx__lines">' + tx.lines.map(function (l) {
          var n = parseInt(String(l.speaker).replace(/\D/g, ""), 10) || 1;
          return '<div class="so-tx__line"><div class="so-tx__who so-tx__who--' + (((n - 1) % 4) + 1) + '">' + esc(l.speaker) + "</div>" +
            '<div class="so-tx__text">' + esc(l.text) + "</div></div>";
        }).join("") + "</div>";
    }

    function paintTx() {
      var box = cell("dialog").querySelector('[data-cell="tx"]');
      if (box) box.innerHTML = txHtml();
    }

    function transcribe() {
      var mine = rec;
      if (!mine || !mine.blob) return;
      mine.tx = { msg: "Uploading the recording…" };
      paintRec();
      var tries = 0;
      function fail(err) {
        if (rec !== mine) return;
        mine.tx = { error: "Could not transcribe: " + ((err && err.message) || "unknown error") };
        paintTx();
      }
      function poll(id) {
        if (rec !== mine) return;
        // About 10 minutes in all; AssemblyAI is usually much quicker.
        if (++tries > 200) { fail(new Error("it is taking too long. Try again in a minute.")); return; }
        getJson(TRANSCRIPT_API + "?id=" + encodeURIComponent(id)).then(function (d) {
          if (rec !== mine) return;
          if (d.status === "completed") { mine.tx = { lines: d.lines || [] }; paintTx(); return; }
          if (d.status === "error") throw new Error(d.error || "transcription failed");
          mine.tx = { msg: "Transcribing… this takes a little while for a long call." };
          paintTx();
          setTimeout(function () { poll(id); }, 3000);
        }).catch(fail);
      }
      getJson(TRANSCRIBE_API, {
        method: "POST",
        headers: { "Content-Type": mine.blob.type || "audio/webm" },
        body: mine.blob
      }).then(function (d) {
        if (!d.id) throw new Error("no transcript id came back");
        setTimeout(function () { poll(d.id); }, 2000);
      }).catch(fail);
    }

    function copyTranscript() {
      var tx = rec && rec.tx;
      if (!tx || !tx.lines || !navigator.clipboard) return;
      var text = tx.lines.map(function (l) { return l.speaker + ": " + l.text; }).join("\n\n");
      navigator.clipboard.writeText(text).then(function () {
        if (rec && rec.tx === tx) { tx.copied = true; paintTx(); }
      });
    }

    function recBtn(action, label, ghost) {
      return '<button type="button" class="fop-btn' + (ghost ? " fop-btn--ghost" : "") + ' so-rec__btn" data-action="' + action + '">' + ICONS.mic + esc(label) + "</button>";
    }

    function paintRec() {
      var box = cell("dialog").querySelector('[data-cell="rec"]');
      if (box) box.innerHTML = recHtml();
      var btn = box && box.querySelector("button");
      if (btn) btn.focus();
    }

    function startRecorder() {
      stopRecorder(true);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        rec = { error: "This browser can't record audio here." };
        paintRec();
        return;
      }
      var mine = rec = { chunks: [] };
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        if (rec !== mine) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        mine.stream = stream;
        mine.recorder = new MediaRecorder(stream);
        mine.recorder.ondataavailable = function (e) { if (e.data && e.data.size) mine.chunks.push(e.data); };
        mine.recorder.onstop = function () {
          if (rec !== mine) return;
          mine.blob = new Blob(mine.chunks, { type: mine.recorder.mimeType || "audio/webm" });
          mine.url = URL.createObjectURL(mine.blob);
          paintRec();
        };
        mine.started = Date.now();
        mine.recorder.start();
        mine.timer = setInterval(function () {
          var t = cell("dialog").querySelector('[data-cell="rec-time"]');
          if (t) t.textContent = clock((Date.now() - mine.started) / 1000);
        }, 500);
        paintRec();
      }).catch(function (err) {
        if (rec !== mine) return;
        rec = { error: err && err.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in the browser's site settings, then try again."
          : "Could not start the microphone" + (err && err.message ? ": " + err.message : ".") };
        paintRec();
      });
    }

    // drop: also forget the recording (the box is closing or a new one starts).
    function stopRecorder(drop) {
      if (!rec) return;
      var r = rec;
      clearInterval(r.timer);
      if (r.recorder && r.recorder.state === "recording") {
        r.seconds = (Date.now() - r.started) / 1000;
        r.recorder.stop();
      }
      if (r.stream) r.stream.getTracks().forEach(function (t) { t.stop(); });
      if (drop) {
        if (r.url) URL.revokeObjectURL(r.url);
        rec = null;
      }
    }

    // ── Events ──
    root.addEventListener("input", function (e) {
      if (e.target.id === "so-filter") { state.filter = e.target.value; paintList(); }
      else if (e.target.id === "so-note" && state.openId) { state.notes[state.openId] = e.target.value; autosize(e.target); }
    });

    root.addEventListener("click", function (e) {
      var t = e.target.closest("[data-action], [data-dialog], [data-open]");
      if (!t) return;
      if (t.hasAttribute("data-dialog")) { openDialog(t.getAttribute("data-dialog")); return; }
      var a = t.getAttribute("data-action");
      if (!a) {
        // A row click opens the card, but not a click on its links.
        if (e.target.closest("a")) return;
        var id = t.getAttribute("data-open");
        if (id === state.openId && t.classList.contains("so-name")) closePanel(); else openPanel(id);
      } else if (a === "close-panel") closePanel();
      else if (a === "retry") load();
      else if (a === "save-dialog" && state.dialog && state.dialog.kind === "status") saveStatus();
      else if (a === "close-dialog" || a === "save-dialog") closeDialog();
      else if (a === "rec-start") startRecorder();
      else if (a === "rec-stop") stopRecorder(false);
      else if (a === "transcribe") transcribe();
      else if (a === "copy-tx") copyTranscript();
    });

    // Escape closes the dialog first, then the card; "/" jumps to the search.
    // Capture phase, so an open header menu is still open here (its own
    // Escape handler closes it, and the card stays).
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (document.querySelector(".fop-umenu__panel:not([hidden]), .fop-tools__panel:not([hidden])")) return;
        if (state.dialog) { e.preventDefault(); closeDialog(); }
        else if (state.openId) {
          if (e.target.id === "so-filter" && e.target.value) return;
          e.preventDefault();
          closePanel();
        }
        return;
      }
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || state.dialog) return;
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      root.querySelector("#so-filter").focus();
    }, true);

    function load() {
      state.list = { loading: true };
      paintList();
      getJson().then(function (d) {
        state.list = { customers: d.customers || [] };
        // A ?customer= that is not on the list is dropped.
        if (state.openId && !byId(state.openId)) { state.openId = ""; setParam("customer", null); }
        paintList();
        paintPanel();
      }).catch(function (err) {
        state.list = { error: err.message };
        paintList();
      });
    }

    load();
  }

  // ── Page header ──────────────────────────────────────────────────────────
  // The same dark bar as order placement (initHeader() in
  // ../order-placement/app.js, styled by its styles.css): the Fairbank mark
  // and Tools menu left, the rep's user menu right (email, Eclipse ID,
  // theme, Feedback, Sign out). This page is not in the Tools menu yet, so
  // no item is marked current.
  function initHeader(root, user) {
    var name = user.name || user.e_user_id || "";
    var header = document.createElement("header");
    header.className = "fop-header";
    header.innerHTML =
      '<div class="fop-header__start">' +
      '<div class="fop-header__logo">' +
      '<img src="../order-placement/fairbank-mark.png" alt="Fairbank" width="32" height="24">' +
      "</div>" + toolsMenuHtml("sales-outreach") + "</div>" +
      '<div class="fop-header__end">' +
      '<span class="fop-header__links" data-cell="hdr-links"></span>' +
      '<div class="fop-umenu">' +
      '<button type="button" class="fop-umenu__btn" aria-haspopup="true" aria-expanded="false"' +
      (user.acting_for ? ' title="Acting as ' + esc(name) + '"' : "") + ">" +
      '<span class="fop-umenu__name fop-umenu__name--full">' + esc(name) + "</span>" +
      '<span class="fop-umenu__name fop-umenu__name--first">' + esc(name.split(/\s+/)[0]) + "</span>" +
      '<svg class="fop-umenu__caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M0 0h10L5 6z" fill="currentColor"/></svg></button>' +
      '<div class="fop-umenu__panel" hidden>' +
      '<div class="fop-umenu__tools"><span class="fop-umenu__lbl">Tools</span>' + toolsItemsHtml("sales-outreach") + "</div>" +
      // Acting as another rep (?e_user_id=): who is really signed in.
      (user.acting_for ? '<div class="fop-umenu__row"><span class="fop-umenu__lbl">Signed in as</span>' +
        esc(user.acting_for.name || user.acting_for.e_user_id) + "</div>" : "") +
      (user.email ? '<div class="fop-umenu__row"><span class="fop-umenu__lbl">Email</span>' + esc(user.email) + "</div>" : "") +
      '<div class="fop-umenu__row"><span class="fop-umenu__lbl">Eclipse ID</span>' + esc(user.e_user_id || "") + "</div>" +
      '<button type="button" class="fop-umenu__theme"></button>' +
      '<a class="fop-umenu__link" target="_blank" rel="noopener" href="' + esc(feedbackUrl(user)) + '">Feedback</a>' +
      '<button type="button" class="fop-umenu__out">Sign out</button>' +
      "</div></div>" +
      "</div>";
    root.parentNode.insertBefore(header, root);
    bindThemeBtn(header.querySelector(".fop-umenu__theme"));
    header.querySelector(".fop-umenu__out").addEventListener("click", function () { window.fbSignOut(); });

    bindHeaderMenu(header, ".fop-umenu");
    bindHeaderMenu(header, ".fop-tools");

    // Phones: hide on a scroll down past the header, show on a scroll up.
    var lastY = window.scrollY;
    window.addEventListener("scroll", function () {
      var y = window.scrollY;
      if (y <= header.offsetHeight) header.classList.remove("fop-header--hidden");
      else if (y - lastY > 4) header.classList.add("fop-header--hidden");
      else if (lastY - y > 4) header.classList.remove("fop-header--hidden");
      else return;
      lastY = y;
    }, { passive: true });
    return header;
  }

  // Feedback form, the user menu row above Sign out: a copy of order
  // placement's feedbackUrl() (no customer or order is open here).
  var FEEDBACK_URL = "https://n8n.profitpad.com/form/fairbank-feedback";

  function feedbackUrl(user, customerId, orderId) {
    var p = new URLSearchParams();
    var userId = (user.acting_for && user.acting_for.e_user_id) || user.e_user_id;
    if (userId) p.set("e_user_id", userId);
    if (customerId) p.set("e_customer_id", customerId);
    if (orderId) p.set("e_sorder_id", orderId);
    var q = p.toString();
    return FEEDBACK_URL + (q ? "?" + q : "");
  }

  // Tools menu: same list and markup as order placement's (its styles.css).
  // Sales outreach is not listed yet (2026-10-29, on request).
  // [key, label, link, only these logins (e_user_id; none = everyone)].
  var TOOLS = [
    ["order-placement", "Order placement", "../order-placement/"],
    ["product-lookup", "Find order by product", "../product-lookup/"],
    ["sales-outreach", "Sales outreach", "../sales-outreach/", ["BECCHR"]],
  ];

  function toolsMenuHtml(current) {
    return '<div class="fop-tools">' +
      '<button type="button" class="fop-tools__btn" aria-haspopup="true" aria-expanded="false">Tools' +
      '<svg class="fop-umenu__caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M0 0h10L5 6z" fill="currentColor"/></svg></button>' +
      '<div class="fop-tools__panel" hidden>' + toolsItemsHtml(current) + "</div></div>";
  }

  // The page links, also at the top of the user menu on phones, where the
  // Tools button is hidden (styles.css).
  function toolsItemsHtml(current) {
    // The signed-in login's own id, also while acting as another rep.
    var u = window.FB_USER || {};
    var me = String((u.acting_for || u).e_user_id || "").toUpperCase();
    return TOOLS.filter(function (t) { return !t[3] || t[3].indexOf(me) >= 0; }).map(function (t) {
      var on = t[0] === current;
      return '<a class="fop-tools__item' + (on ? " fop-tools__item--on" : "") + '" href="' + t[2] + '"' + (on ? ' aria-current="page"' : "") + ">" + esc(t[1]) + "</a>";
    }).join("");
  }

  // One header dropdown (wrap = ".fop-umenu" or ".fop-tools"): its button
  // toggles its panel; a click outside or Escape closes it.
  function bindHeaderMenu(header, wrap) {
    var box = header.querySelector(wrap);
    var btn = box.querySelector("button");
    var panel = box.querySelector(wrap + "__panel");
    function setOpen(open) {
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    btn.addEventListener("click", function () { setOpen(panel.hidden); });
    document.addEventListener("click", function (e) {
      if (!panel.hidden && !box.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !panel.hidden) { setOpen(false); btn.focus(); }
    });
  }

  // ── Light / dark theme toggle (shared with order placement) ─────────────
  var THEME_KEY = "fop-theme";
  var SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
  var MOON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function paintThemeBtn(btn) {
    var light = currentTheme() === "light";
    btn.innerHTML = (light ? MOON_ICON : SUN_ICON) + "<span>" + (light ? "Dark mode" : "Light mode") + "</span>";
  }

  function bindThemeBtn(btn) {
    paintThemeBtn(btn);
    btn.addEventListener("click", function () {
      var next = currentTheme() === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode: not saved */ }
      paintThemeBtn(btn);
    });
  }

  function boot() {
    initApp(document.getElementById("app"));
  }

  // Last, so the theme icons above are set before the header uses them.
  // Acting as another rep (?e_user_id=, auth.js): wait for their user.
  if (window.FB_USER) (window.FB_USER_READY || Promise.resolve()).then(boot);
  else window.addEventListener("fb:auth", boot, { once: true });
})();
