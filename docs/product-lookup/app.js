// ===========================================================================
// Fairbank Product Lookup, app.js
// ===========================================================================
//
//   1. Search: the rep types a product name, catalog number or Eclipse id
//      and picks a product (HubSpot products).
//   2. Product: every order with a line for that product (HubSpot line
//      items and deals), laid out like order placement's orders list, or the
//      customers (ship-tos) on those orders. A box filters either list on
//      the page, with no request.
//
// An order opens in order placement at the generation that has the product
// (?e_sorder_id=S2738846.0001); a customer opens its orders list there
// (?e_customer_id=…). ?e_product_id=106331 opens a product straight away,
// &view=customers shows the customers, and &include=Bid&exclude=Cancel
// sets the status filter.
//
// Backend (n8n, HubSpot only, no Eclipse):
//   e-order-placement/product-lookup?q=…             product search
//   e-order-placement/product-lookup?e_product_id=…  orders with the product
//
// The rep comes from window.FB_USER, set by ../auth.js, which also adds the
// session token to the call.
// ===========================================================================

(function () {
  "use strict";

  var API = "https://n8n.fairbankequipment.com/webhook/e-order-placement/product-lookup";
  var ORDER_PAGE = "../order-placement/";

  // Labels for every Eclipse orderStatus (same as order placement).
  var STATUS_LABELS = {
    Bid: "Bid", ShipWhenComplete: "Ship When Complete", ShipWhenAvailable: "Ship When Available",
    ShipWhenSpecified: "Ship When Specified", ShipItemComplete: "Ship Item Complete", Direct: "Vendor Direct",
    CallWhenAvailable: "Call When Available", CallWhenComplete: "Call When Complete",
    CallWhenSpecified: "Call When Specified", PickUpNow: "Pick Up Now", ShipTicket: "Ship Ticket",
    Invoice: "Invoiced", Cancel: "Cancelled",
  };

  function statusLabel(s) { return STATUS_LABELS[s] || s || "Unknown"; }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function money(v) {
    if (v == null || !isFinite(v)) return "-";
    var parts = Number(v).toFixed(2).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return "$" + parts.join(".");
  }

  // 1234.5 → "1,234.5" (quantities can be fractional, e.g. feet).
  function qtyText(v) {
    var n = Math.round(Number(v) * 1000) / 1000;
    var parts = String(n).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }

  // "2026-04-16" → "Apr 16, 2026" (same look as order placement).
  function dateText(ymd) {
    var m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return ymd || "";
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  // HubSpot product names hold the catalog number and the description on
  // separate lines; show them on one.
  function oneLine(s) { return String(s || "").replace(/\s*\n\s*/g, " ").trim(); }

  function getJson(params) {
    var u = new URL(API);
    Object.keys(params).forEach(function (k) { u.searchParams.set(k, params[k]); });
    return fetch(u.toString()).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || (data && data.error && !data.success)) {
          throw new Error((data && data.error) || ("Server error (status " + res.status + ")"));
        }
        return data;
      });
    });
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // Rewrite the query string (null removes a key). push adds a history
  // entry (a product picked); otherwise the current entry is replaced.
  function setParams(values, push) {
    var p = new URLSearchParams(window.location.search);
    Object.keys(values).forEach(function (k) {
      if (values[k] == null || values[k] === "") p.delete(k); else p.set(k, values[k]);
    });
    var q = p.toString();
    var url = window.location.pathname + (q ? "?" + q : "");
    if (push) window.history.pushState({ pl: true }, "", url);
    else window.history.replaceState(window.history.state, "", url);
  }

  // ── App ──────────────────────────────────────────────────────────────────

  function initApp(root) {
    initHeader(root, window.FB_USER || {});

    var state = {
      view: "search",       // search | product
      product: null,        // { e_product_id, name, uom }
      tab: "orders",        // orders | customers
      filter: "",
      statuses: {},         // Eclipse status → "in" | "out" (status filter chips)
      deals: null,          // { loading, error, data } for the open product
    };
    var ac = null;          // open autocomplete: { items, active, q }
    var dealsSeq = 0;       // ignores answers for a product no longer open

    function titleHtml(kicker, title) {
      return '<div class="fop-kicker">' + esc(kicker) + '</div><h1 class="fop-h1">' + esc(title) + "</h1>";
    }

    // ── Search view ──
    function viewSearch() {
      return (
        '<div class="fop-wrap fop-wrap--narrow">' + titleHtml("Product Lookup", "Find orders and customers by product") +
        '<div class="fop-card">' +
        '<label class="fop-label" for="pl-search">Product name, catalog number or Eclipse ID</label>' +
        '<div class="fop-ac">' +
        '<input id="pl-search" class="fop-input" autocomplete="off" spellcheck="false" ' +
        'placeholder="Type at least 2 characters…" role="combobox" aria-expanded="false" aria-controls="pl-search-list">' +
        '<div class="fop-ac__list pl-ac__list" id="pl-search-list" role="listbox"></div>' +
        "</div>" +
        '<div class="fop-hint">↑ ↓ to move, Enter to pick. Every word must be in the product name. Prefix with a dot (.1000) to search by ID.</div>' +
        "</div>" +
        '<a class="fop-xlink" href="../order-placement/">Place an order</a>' +
        "</div>"
      );
    }

    function acRender(items, message, more) {
      var list = root.querySelector("#pl-search-list");
      var input = root.querySelector("#pl-search");
      if (!list) return;
      ac = ac || { items: [], active: 0 };
      ac.items = items || [];
      ac.active = 0;
      if (message) list.innerHTML = '<div class="fop-ac__msg">' + esc(message) + "</div>";
      else {
        list.innerHTML = ac.items.map(function (it, i) {
          return '<div class="fop-ac__item' + (i === 0 ? " fop-ac__item--active" : "") + '" data-ac="' + i + '" role="option">' +
            '<span class="fop-badge">' + esc(it.e_product_id) + "</span> " + esc(oneLine(it.name) || "-") + "</div>";
        }).join("") + (more ? '<div class="fop-ac__msg">' + esc(more) + "</div>" : "");
      }
      list.classList.add("fop-ac__list--open");
      input.setAttribute("aria-expanded", "true");
    }

    function acClose() {
      ac = null;
      var list = root.querySelector("#pl-search-list");
      var input = root.querySelector("#pl-search");
      if (list) { list.classList.remove("fop-ac__list--open"); list.innerHTML = ""; }
      if (input) input.setAttribute("aria-expanded", "false");
    }

    function acMove(delta) {
      if (!ac || !ac.items.length) return;
      ac.active = (ac.active + delta + ac.items.length) % ac.items.length;
      var els = root.querySelectorAll("#pl-search-list .fop-ac__item");
      for (var i = 0; i < els.length; i++) els[i].classList.toggle("fop-ac__item--active", i === ac.active);
      if (els[ac.active]) els[ac.active].scrollIntoView({ block: "nearest" });
    }

    var acSearch = debounce(function (input) {
      var q = input.value.trim();
      if (document.activeElement !== input) return;
      if (q.length < 2) { acClose(); return; }
      acRender([], "Searching…");
      getJson({ q: q }).then(function (d) {
        if (document.activeElement !== input || input.value.trim() !== q) return;
        var items = d.products || [];
        var more = d.total > items.length ? "Showing " + items.length + " of " + d.total.toLocaleString("en-US") + ". Keep typing to narrow it down." : null;
        acRender(items, items.length ? null : "No matches", more);
      }).catch(function (err) {
        if (document.activeElement === input) acRender([], "Search failed: " + err.message);
      });
    }, 250);

    // ── Product view ──
    function pickProduct(p, push) {
      acClose();
      state.view = "product";
      state.product = p;
      state.filter = "";
      // A product picked from the search starts with no status filter; one
      // opened from the URL keeps the URL's (start()).
      if (push) state.statuses = {};
      setParams({ e_product_id: p.e_product_id, view: state.tab === "customers" ? "customers" : null }, push);
      if (push) saveStatuses();
      loadDeals();
      render();
    }

    function loadDeals() {
      var seq = ++dealsSeq;
      var id = state.product.e_product_id;
      state.deals = { loading: true };
      getJson({ e_product_id: id }).then(function (d) {
        if (seq !== dealsSeq) return;
        state.deals = { data: d };
        render();
      }).catch(function (err) {
        if (seq !== dealsSeq) return;
        state.deals = { error: err.message };
        render();
      });
    }

    // ?e_product_id on its own: the name comes from an id-only search
    // (leading dot).
    function openFromUrl(id) {
      var p = { e_product_id: id, name: "" };
      pickProduct(p, false);
      getJson({ q: "." + id }).then(function (d) {
        var hit = (d.products || []).filter(function (x) { return x.e_product_id === id; })[0];
        if (hit && state.product && state.product.e_product_id === id) {
          state.product = hit;
          render();
        }
      }).catch(function () { /* the title keeps the id */ });
    }

    function allOrders() { return (state.deals && state.deals.data && state.deals.data.orders) || []; }

    // Status filter: a generation passes when its status is not excluded
    // and, if any status is included, is one of them.
    function genPasses(g) {
      var mark = state.statuses[g.status];
      if (mark === "out") return false;
      var anyIn = Object.keys(state.statuses).some(function (s) { return state.statuses[s] === "in"; });
      return !anyIn || mark === "in";
    }

    // The orders with only their generations that pass the status filter;
    // an order with none left is dropped. Both tabs, their counts, totals
    // and qty use this.
    function orders() {
      return allOrders().map(function (o) {
        var gens = o.generations.filter(genPasses);
        return gens.length === o.generations.length ? o : { order_id: o.order_id, order_date: o.order_date, generations: gens };
      }).filter(function (o) { return o.generations.length; });
    }

    // Every status on the product's generations with its count, in the
    // STATUS_LABELS order (unknown ones last), for the filter chips.
    function statusCounts() {
      var n = {};
      allOrders().forEach(function (o) {
        o.generations.forEach(function (g) { n[g.status] = (n[g.status] || 0) + 1; });
      });
      var order = Object.keys(STATUS_LABELS);
      return Object.keys(n).sort(function (a, b) {
        var ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
      }).map(function (s) { return { status: s, count: n[s] }; });
    }

    // Chips cycle on click: off → include (✓) → exclude (✕) → off.
    function statusChipsHtml() {
      var list = statusCounts();
      if (!list.length) return "";
      var any = Object.keys(state.statuses).length > 0;
      return '<div class="pl-statuses" role="group" aria-label="Filter by status">' +
        '<span class="pl-statuses__lbl">Status</span>' +
        list.map(function (s) {
          var mark = state.statuses[s.status] || "";
          var title = mark === "in" ? "Included. Click to exclude." : mark === "out" ? "Excluded. Click to clear." : "Click to include only this status.";
          return '<button type="button" class="pl-st' + (mark ? " pl-st--" + mark : "") + '" data-status="' + esc(s.status) + '" title="' + title + '" aria-pressed="' + (mark ? "true" : "false") + '">' +
            (mark === "in" ? '<span class="pl-st__mark" aria-hidden="true">✓</span>' : mark === "out" ? '<span class="pl-st__mark" aria-hidden="true">✕</span>' : "") +
            esc(statusLabel(s.status)) + ' <span class="pl-st__n">' + s.count.toLocaleString("en-US") + "</span></button>";
        }).join("") +
        (any ? '<button type="button" class="pl-st__clear" data-action="clear-statuses">Clear</button>' : "") +
        "</div>";
    }

    function cycleStatus(s) {
      var next = { "": "in", "in": "out", "out": "" }[state.statuses[s] || ""];
      if (next) state.statuses[s] = next; else delete state.statuses[s];
      saveStatuses();
      render();
    }

    // &include=Bid,Invoice&exclude=Cancel (replaced, not pushed).
    function saveStatuses() {
      var pick = function (mark) {
        return Object.keys(state.statuses).filter(function (s) { return state.statuses[s] === mark; }).join(",") || null;
      };
      setParams({ include: pick("in"), exclude: pick("out") }, false);
    }

    function readStatuses(p) {
      state.statuses = {};
      String(p.get("include") || "").split(",").filter(Boolean).forEach(function (s) { state.statuses[s] = "in"; });
      String(p.get("exclude") || "").split(",").filter(Boolean).forEach(function (s) { state.statuses[s] = "out"; });
    }

    // One entry per ship-to on the product's orders, most recent order first.
    function customers() {
      var by = {};
      orders().forEach(function (o) {
        o.generations.forEach(function (g) {
          var key = g.ship_to_id || g.ship_to_name;
          if (!key) return;
          var c = by[key] || (by[key] = { id: g.ship_to_id, name: g.ship_to_name, bill_to_id: g.bill_to_id, orders: {}, qty: 0, cancelledQty: 0, uom: "", last: "" });
          c.orders[o.order_id] = true;
          if (g.qty != null) { if (g.status === "Cancel") c.cancelledQty += g.qty; else c.qty += g.qty; }
          if (!c.uom && g.uom) c.uom = g.uom;
          if (g.order_date > c.last) c.last = g.order_date;
        });
      });
      return Object.keys(by).map(function (k) {
        var c = by[k];
        c.count = Object.keys(c.orders).length;
        // Qty on live generations; a customer with only cancelled ones (e.g.
        // the Cancelled status filter) shows what was on those instead of 0.
        if (!c.qty) c.qty = c.cancelledQty;
        return c;
      }).sort(function (a, b) { return b.last.localeCompare(a.last) || a.name.localeCompare(b.name); });
    }

    function matches(text) {
      var f = state.filter.trim().toLowerCase();
      if (!f) return true;
      return f.split(/\s+/).every(function (w) { return text.indexOf(w) !== -1; });
    }

    function ordersListHtml() {
      // Only what the row shows (HubSpot's bill-to name holds the city too,
      // so "yuma" would match customers that are not Yuma's).
      var list = orders().filter(function (o) {
        return matches([o.order_id].concat(o.generations.map(function (g) {
          return [g.e_sorder_id, g.ship_to_name, g.ship_to_id, g.po].join(" ");
        })).join(" ").toLowerCase());
      });
      if (!list.length) return '<div class="fop-muted">' + (state.filter.trim() || Object.keys(state.statuses).length ? "No orders match." : "No orders have this product.") + "</div>";
      return '<div class="fop-orders" aria-label="Orders">' + list.map(function (o) {
        var g0 = o.generations[0] || {};
        var total = o.generations.reduce(function (t, g) { return g.status === "Cancel" || g.sales_total == null ? t : t + g.sales_total; }, 0);
        // The product's qty on the live generations; an all-cancelled order
        // shows what was on it instead of 0.
        var live = o.generations.filter(function (g) { return g.status !== "Cancel"; });
        var qty = (live.length ? live : o.generations).reduce(function (t, g) { return g.qty == null ? t : t + g.qty; }, 0);
        var uom = o.generations.map(function (g) { return g.uom; }).filter(Boolean)[0] || "";
        return '<a class="fop-order pl-row" href="' + esc(ORDER_PAGE + "?e_sorder_id=" + encodeURIComponent(g0.e_sorder_id)) + '">' +
          '<span class="fop-order__top"><b>' + esc(o.order_id) + "</b>" +
          '<span class="fop-order__date">' + esc(dateText(o.order_date)) + "</span></span>" +
          '<span class="fop-order__mid fop-muted">' + esc(g0.ship_to_name || "") + (g0.ship_to_id ? " (" + esc(g0.ship_to_id) + ")" : "") +
          (g0.po ? " · PO " + esc(g0.po) : "") +
          '<span class="fop-order__total">' + money(total) + "</span></span>" +
          '<span class="fop-order__gens">' + o.generations.map(function (g) {
            return '<span class="fop-status fop-status--sm fop-status--' + esc(String(g.status).toLowerCase()) + '">' +
              esc("Gen " + g.generation_id + " · " + statusLabel(g.status)) + "</span>";
          }).join("") +
          '<span class="pl-qty">Qty ' + esc(qtyText(qty)) + (uom ? " " + esc(uom) : "") + "</span></span></a>";
      }).join("") + "</div>";
    }

    function customersListHtml() {
      var list = customers().filter(function (c) {
        return matches([c.name, c.id, c.bill_to_id].join(" ").toLowerCase());
      });
      if (!list.length) return '<div class="fop-muted">' + (state.filter.trim() || Object.keys(state.statuses).length ? "No customers match." : "No customers have ordered this product.") + "</div>";
      return '<div class="fop-orders" aria-label="Customers">' + list.map(function (c) {
        // Id tile left of the name (it wraps under itself); last order date,
        // bill-to and order count on the second line, qty right.
        var inner =
          '<span class="pl-cust__top">' + (c.id ? '<span class="fop-badge">' + esc(c.id) + "</span>" : "") +
          "<b>" + esc(c.name || "Unknown ship-to") + "</b></span>" +
          '<span class="fop-order__mid fop-muted"><span class="pl-cust__facts">' +
          "Last order " + esc(dateText(c.last)) + " · " + c.count + (c.count === 1 ? " order" : " orders") +
          (c.bill_to_id && c.bill_to_id !== c.id ? " · Bill-to " + esc(c.bill_to_id) : "") + "</span>" +
          '<span class="fop-order__total pl-cust__qty">Qty ' + esc(qtyText(c.qty)) + (c.uom ? " " + esc(c.uom) : "") + "</span></span>";
        return c.id
          ? '<a class="fop-order pl-row" href="' + esc(ORDER_PAGE + "?e_customer_id=" + encodeURIComponent(c.id)) + '">' + inner + "</a>"
          : '<div class="fop-order pl-row pl-row--plain">' + inner + "</div>";
      }).join("") + "</div>";
    }

    function listHtml() {
      return state.tab === "customers" ? customersListHtml() : ordersListHtml();
    }

    function viewProduct() {
      var p = state.product;
      var dl = state.deals || {};
      var name = oneLine(p.name);
      var body;
      if (dl.loading) body = '<div class="fop-card"><div class="fop-center fop-center--sm"><div class="fop-spinner"></div><div>Loading orders…</div></div></div>';
      else if (dl.error) {
        body = '<div class="fop-alert fop-alert--error">' + esc(dl.error) + "</div>" +
          '<div class="fop-row"><button class="fop-btn" data-action="retry">Retry</button></div>';
      } else {
        var nOrders = orders().length;
        var nCust = customers().length;
        var tab = function (key, label, n) {
          var on = state.tab === key;
          return '<button class="fop-tab' + (on ? " fop-tab--active" : "") + '" role="tab" aria-selected="' + on + '" data-tab="' + key + '">' +
            esc(label) + ' <span class="pl-count">' + n.toLocaleString("en-US") + "</span></button>";
        };
        body =
          '<div class="pl-bar">' +
          '<div class="fop-tabs" role="tablist" aria-label="Show">' + tab("orders", "Orders", nOrders) + tab("customers", "Customers", nCust) + "</div>" +
          '<input id="pl-filter" class="fop-input pl-filter" type="search" autocomplete="off" spellcheck="false" value="' + esc(state.filter) + '" ' +
          'placeholder="' + (state.tab === "customers" ? "Search customers by name or ID" : "Search orders by customer, order or PO") + '" aria-label="Search the list">' +
          "</div>" +
          statusChipsHtml() +
          '<div class="fop-card"><div data-cell="list">' + listHtml() + "</div>" +
          (dl.data && dl.data.truncated ? '<div class="fop-hint">HubSpot returns at most 10,000 lines, so older orders may be missing.</div>' : "") +
          "</div>";
      }
      return (
        '<div class="fop-wrap fop-wrap--orders">' +
        '<div class="fop-top"><div>' +
        '<div class="fop-kicker">Product Lookup</div>' +
        '<h1 class="fop-h1 pl-title"><span class="fop-badge" title="Eclipse product id">' + esc(p.e_product_id) + "</span> " + esc(name || "Product " + p.e_product_id) + "</h1>" +
        "</div>" +
        '<div class="fop-row"><button class="fop-btn fop-btn--ghost fop-btn--sm" data-action="change-product">Change product</button></div></div>' +
        body + "</div>"
      );
    }

    function render() {
      root.innerHTML = state.view === "product" ? viewProduct() : viewSearch();
      if (state.view === "search") {
        var s = root.querySelector("#pl-search");
        if (s) s.focus();
      }
    }

    // Filter typing redraws the list only, so the box keeps focus.
    function paintList() {
      var cell = root.querySelector('[data-cell="list"]');
      if (cell) cell.innerHTML = listHtml();
    }

    function backToSearch() {
      dealsSeq++;
      state.view = "search";
      state.product = null;
      state.deals = null;
      state.filter = "";
      state.tab = "orders";
      state.statuses = {};
      setParams({ e_product_id: null, view: null, include: null, exclude: null }, true);
      render();
    }

    // ── Events ──
    root.addEventListener("input", function (e) {
      if (e.target.id === "pl-search") acSearch(e.target);
      else if (e.target.id === "pl-filter") { state.filter = e.target.value; paintList(); }
    });

    root.addEventListener("keydown", function (e) {
      if (e.target.id === "pl-search") {
        if (e.key === "ArrowDown") { e.preventDefault(); acMove(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); acMove(-1); }
        else if (e.key === "Enter") {
          e.preventDefault();
          if (ac && ac.items[ac.active]) pickProduct(ac.items[ac.active], true);
        } else if (e.key === "Escape") acClose();
      } else if (e.target.id === "pl-filter" && e.key === "Escape" && e.target.value) {
        e.preventDefault();
        e.target.value = state.filter = "";
        paintList();
      }
    });

    // Press-down picks, so the input's blur never closes the list first.
    root.addEventListener("mousedown", function (e) {
      var item = e.target.closest("[data-ac]");
      if (item && ac) { e.preventDefault(); pickProduct(ac.items[Number(item.getAttribute("data-ac"))], true); }
    });

    root.addEventListener("click", function (e) {
      var t = e.target.closest("[data-tab], [data-action], [data-status]");
      if (!t) return;
      if (t.hasAttribute("data-status")) cycleStatus(t.getAttribute("data-status"));
      else if (t.hasAttribute("data-tab")) {
        state.tab = t.getAttribute("data-tab");
        setParams({ view: state.tab === "customers" ? "customers" : null }, false);
        render();
        var f = root.querySelector("#pl-filter");
        if (f && state.filter) f.focus();
      } else {
        var a = t.getAttribute("data-action");
        if (a === "change-product") backToSearch();
        else if (a === "retry") { loadDeals(); render(); }
        else if (a === "clear-statuses") { state.statuses = {}; saveStatuses(); render(); }
      }
    });

    root.addEventListener("focusout", function (e) {
      if (e.target.id === "pl-search") setTimeout(acClose, 150);
    });

    // "/" jumps to the list search, as on many list pages.
    document.addEventListener("keydown", function (e) {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      var f = root.querySelector("#pl-filter") || root.querySelector("#pl-search");
      if (f) { e.preventDefault(); f.focus(); }
    });

    // Back / Forward: the URL holds the product and the tab.
    window.addEventListener("popstate", function () { start(); });

    function start() {
      var p = new URLSearchParams(window.location.search);
      var id = String(p.get("e_product_id") || "").trim();
      state.tab = p.get("view") === "customers" ? "customers" : "orders";
      readStatuses(p);
      if (/^\d+$/.test(id)) {
        if (state.product && state.product.e_product_id === id && state.view === "product") { render(); return; }
        openFromUrl(id);
      } else {
        dealsSeq++;
        state.view = "search";
        state.product = null;
        state.deals = null;
        state.filter = "";
        render();
      }
    }

    start();
  }

  // ── Page header ──────────────────────────────────────────────────────────
  // The same dark bar as order placement (initHeader() in
  // ../order-placement/app.js, styled by its styles.css): the Fairbank mark
  // left, the rep's user menu right (email, Eclipse ID, theme, Sign out).
  // The links slot stays empty here (no deal or customer is open). A Tools
  // menu beside the mark links to the site's pages.
  function initHeader(root, user) {
    var name = user.name || user.e_user_id || "";
    var header = document.createElement("header");
    header.className = "fop-header";
    header.innerHTML =
      '<div class="fop-header__start">' +
      '<div class="fop-header__logo">' +
      '<img src="../order-placement/fairbank-mark.png" alt="Fairbank" width="32" height="24">' +
      "</div>" + toolsMenuHtml("product-lookup") + "</div>" +
      '<div class="fop-header__end">' +
      '<span class="fop-header__links" data-cell="hdr-links"></span>' +
      '<div class="fop-umenu">' +
      '<button type="button" class="fop-umenu__btn" aria-haspopup="true" aria-expanded="false"' +
      (user.acting_for ? ' title="Acting as ' + esc(name) + '"' : "") + ">" +
      '<span class="fop-umenu__name fop-umenu__name--full">' + esc(name) + "</span>" +
      '<span class="fop-umenu__name fop-umenu__name--first">' + esc(name.split(/\s+/)[0]) + "</span>" +
      '<svg class="fop-umenu__caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M0 0h10L5 6z" fill="currentColor"/></svg></button>' +
      '<div class="fop-umenu__panel" hidden>' +
      '<div class="fop-umenu__tools"><span class="fop-umenu__lbl">Tools</span>' + toolsItemsHtml("product-lookup") + "</div>" +
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
