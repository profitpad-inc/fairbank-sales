// ===========================================================================
// Fairbank Order Placement, app.js
// ===========================================================================
//
// Keyboard-first order entry, modelled on Eclipse e-term:
//
//   1. Customer: ?e_customer_id=… from the HubSpot customer card, or a
//      search box when the parameter is absent.
//   2. Orders: the customer's recent orders (one opens it) and "New order".
//   3. Ship-to: for a new order on a bill-to, the rep picks a ship-to.
//   4. Order grid: header (branch, ship via, status, dates, PO, notes) and
//      a line chart (product, description, qty, price, ext, stock).
//   5. Place as Bid (Alt+B) or as an Order (Alt+O), confirm, done.
//
// ?e_sorder_id=S123.0001 opens an existing order instead. A Bid can have
// its lines and shipping header changed (Update Bid, Alt+B) and be turned
// into an order (Convert to Order, Alt+O); customers, PO and release stay
// locked. Any order that is not invoiced or cancelled can be cancelled.
//
// Each line ships from the branch picked on its inventory tiles (default:
// the header's ship branch). Lines on several branches are placed as one
// generation per branch.
//
// Backends (all n8n):
//   e-order-placement/create-order  creates the Eclipse sales order
//   e-order-placement/order         reads an existing order (one generation)
//   e-order-placement/update-bid    changes a bid (lines, header, status)
//   e-order-placement/cancel-order  sets an order's status to Cancel
//   e-order-placement/customer      one call per customer: the customer,
//                                   its bill-to and ship-tos (Eclipse) plus
//                                   HubSpot record ids and coordinates
//   fairbank-product-inquiry        customer search (only when searching),
//                                   product search, price/stock (the same
//                                   flow docs/product-inquiry uses)
//
// Ship via is required and chosen by the rep; terms and blank PO/release
// are filled in server-side by create-order from the Eclipse customer.
//
// The rep (writer, email, territories, default territory, default branch) comes from
// window.FB_USER, set by ../auth.js.
//
// Rendering: full re-render on structural changes (view change, add/remove
// line, product picked); targeted cell updates for prices, stock, and
// totals so typing never loses focus.
// ===========================================================================

(function () {
  "use strict";

  var N8N = "https://n8n.fairbankequipment.com/webhook/";
  var API = {
    createOrder: N8N + "e-order-placement/create-order",
    order: N8N + "e-order-placement/order",
    updateBid: N8N + "e-order-placement/update-bid",
    cancelOrder: N8N + "e-order-placement/cancel-order",
    customer: N8N + "e-order-placement/customer",
    customerOrders: N8N + "e-order-placement/customer-orders",
    orderChangelog: N8N + "e-order-placement/order-changelog",
    quote: N8N + "e-order-placement/quote",
    createQuote: N8N + "e-order-placement/create-quote",
    sendQuote: N8N + "e-order-placement/send-quote",
    inquiry: N8N + "fairbank-product-inquiry",
  };
  var HS_COMPANY = "https://app.hubspot.com/contacts/43793456/record/0-2/";
  var HS_DEAL = "https://app.hubspot.com/contacts/43793456/record/0-3/";

  // External-link icon (HubSpot's ExternalLink glyph), after every link that
  // opens in a new tab. Sized and coloured by .fop-ext in styles.css.
  var EXT_ICON = '<svg class="fop-ext" role="img" aria-label="Link opens in a new window" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" focusable="false">' +
    '<path d="M13.31 20.69c-.29 0-.58-.11-.81-.33a1.14 1.14 0 0 1 0-1.62L27.04 4.2c.45-.45 1.17-.45 1.62 0s.45 1.17 0 1.62L14.12 20.36c-.22.22-.52.33-.81.33"></path>' +
    '<path d="M27.86 15.29c-.63 0-1.14-.51-1.14-1.14v-8h-8a1.14 1.14 0 1 1 0-2.28h9.14c.63 0 1.14.51 1.14 1.14v9.14c0 .63-.51 1.14-1.14 1.14M23.29 29H5c-.63 0-1.14-.51-1.14-1.14V9.57c0-.63.51-1.14 1.14-1.14h9.14a1.14 1.14 0 1 1 0 2.28h-8v16h16v-8a1.14 1.14 0 1 1 2.28 0v9.14c0 .63-.51 1.14-1.14 1.14Z"></path></svg>';

  // Branch ids and names, same list as the v1 inventory flow.
  var BRANCHES = [
    ["1", "Wichita"], ["2", "Grand Island"], ["3", "Yankton"], ["4", "El Reno"],
    ["5", "Grain Valley"], ["6", "Garden City"], ["7", "Caldwell"], ["8", "Evans"],
    ["9", "Brush"], ["12", "Pasco"], ["14", "Stockton"], ["15", "Fresno"],
    ["16", "Salinas"], ["17", "Yuma"],
  ];

  // Branch GPS coordinates, copied from BRANCH_COORDS in the v1 inventory
  // flow (eclipseInventoryLookup.js), for ship-to → branch distances.
  var BRANCH_COORDS = {
    "1":  [37.6369, -97.3503],  "2":  [40.8755, -98.3492],  "3":  [42.8943, -97.4106],
    "4":  [35.5335, -97.9549],  "5":  [39.0189, -94.2255],  "6":  [37.9546, -100.8354],
    "7":  [43.6749, -116.7025], "8":  [40.3775, -104.7214], "9":  [40.2694, -103.6214],
    "12": [46.2378, -119.0906], "14": [37.9392, -121.3115], "15": [36.6975, -119.7423],
    "16": [36.6433, -121.5898], "17": [32.6841, -114.5683],
  };

  // Straight-line ("as the crow flies") miles, same haversine as v1.
  function milesBetween(lat1, lng1, lat2, lng2) {
    var R = 3958.8;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.pow(Math.sin(dLng / 2), 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // [label, value]. The first 9 are the common ones.
  var SHIP_VIAS = [
    ["SEE INSTRUCTION", "SEE INSTRUCTION"], ["SALESMAN DELIVERY", "SALESMAN DELIVR"], ["CPU PICK UP", "CPU PICK UP"],
    ["UPS", "UPS"], ["BW BEST WAY", "BW BEST WAY"], ["OT OUR TRUCK", "OT OUR TRUCK"],
    ["FEDEX AIR", "FEDEX AIR"], ["FEDEX FRT", "FEDEX FRT"], ["FEDEX GRD", "FEDEX GRD"],
    ["ACI", "ACI"], ["ARCBEST", "ARCBEST"], ["ASAP EXPRESS", "ASAP EXPRESS"],
    ["ASAP EXPRESS CC", "ASAP EXPRESS CC"], ["BC FREIGHTWAYS", "BC FREIGHTWAYS"], ["BEAVER", "BEAVER"],
    ["BW BEST WAY CC", "BW BEST WAY CC"], ["CAPITAL EXPRESS", "CAPITAL EXPRESS"],
    ["CC COMMON CARRY", "CC COMMON CARRY"], ["CHIEF", "CHIEF"], ["CON-WAY", "CON-WAY"],
    ["CORE CREDIT", "CORE CREDIT"], ["COUNTER SALE", "COUNTER SALE"], ["COUNTER SALE CC", "COUNTER SALE CC"],
    ["CPU PICK UP CC", "CPU PICK UP CC"], ["CPU SET OUTSIDE", "CPU SET OUTSIDE"], ["CPU-BR-AG", "CPU-BR-AG"],
    ["CREDIT MEMO", "CREDIT MEMO"], ["CROSS COUNTRY", "CROSS COUNTRY"], ["CS SHIP TICKET", "CS SHIP TICKET"],
    ["CS SHIPTICKET CC", "CS SHIPTICKET CC"], ["DAYTON FREIGHT", "DAYTON FREIGHT"], ["DELIVER", "DELIVER"],
    ["DELIVERY CC", "DELIVERY CC"], ["DORHN", "DORHN"], ["DUGAN", "DUGAN"],
    ["EAGLE GLOBAL LOG", "EAGLE GLOBAL LOG"], ["ESTES", "ESTES"], ["FOODMASTER", "FOODMASTER"],
    ["FOODMASTER LOGIS", "FOODMASTER LOGIS"], ["GI CONT CARRIER", "GI CONT CARRIER"],
    ["GO-FER IT EXPRES", "GO-FER IT EXPRES"], ["HI - HENRY IND", "HI - HENRY IND"],
    ["HVH TRANSPORT", "HVH TRANSPORT"], ["JOBBOX", "JOBBOX"], ["JOBBOX CC", "JOBBOX CC"],
    ["MAGNUM FREIGHT", "MAGNUM FREIGHT"], ["METRO", "METRO"], ["MIDWEST MOTOR", "MIDWEST MOTOR"],
    ["MIDWEST TRANSFER", "MIDWEST TRANSFER"], ["OLD DOMINION", "OLD DOMINION"], ["PANAMA", "PANAMA"],
    ["PPI", "PPI"], ["PREPAID", "PREPAID"], ["PRICE", "PRICE"], ["QUOTE / BID", "QUOTE / BID"],
    ["R&L CARRIERS", "R&L CARRIERS"], ["RAC TRANSPORT", "RAC TRANSPORT"], ["SAIA", "SAIA"],
    ["SALESMAN DELI CC", "SALESMAN DELI CC"], ["SERVICE CALL", "SERVICE CALL"], ["SPEE-DEE", "SPEE-DEE"],
    ["SPEE-DEE CC", "SPEE-DEE CC"], ["UPS CC", "UPS CC"], ["UPS COLLECT", "UPS COLLECT"],
    ["UPS FREIGHT", "UPS FREIGHT"], ["UPS RED SAVER", "UPS RED SAVER"], ["UPS RESIDENTIAL", "UPS RESIDENTIAL"],
    ["UPS.BLUE", "UPS.BLUE"], ["UPS.RED", "UPS.RED"], ["US ROAD", "US ROAD"],
    ["VENDOR DIRECT", "VENDOR DIRECT"], ["WCPU WILL CPU", "WCPU WILL CPU"], ["WEEKLY", "WEEKLY"],
    ["XPO", "XPO"], ["UPS.RED CC", "UPS.RED CC"], ["PONY EXPRESS", "PONY EXPRESS"],
    ["WC WILL CALL", "WC WILL CALL"], ["SHOP ASSEMBLY", "SHOP ASSEMBLY"],
  ];
  var COMMON_SHIP_VIAS = 9;

  // Order statuses, in the order reps asked for: the common ones first,
  // then the rest alphabetically. Values are the Eclipse orderStatus enum.
  // "Vendor Direct" is Eclipse's "Direct" status (the enum has no
  // separate VendorDirect value). Bid is not here: Place as Bid (Alt+B)
  // is the only way to place a bid.
  var ORDER_STATUSES = [
    ["Ship When Complete", "ShipWhenComplete"],
    ["Ship When Available", "ShipWhenAvailable"],
    ["Ship When Specified", "ShipWhenSpecified"],
    ["Ship Item Complete", "ShipItemComplete"],
    ["Vendor Direct", "Direct"],
    // Hidden for now at the user's request; add back here when needed:
    // ["Call When Available", "CallWhenAvailable"],
    // ["Call When Complete", "CallWhenComplete"],
    // ["Call When Specified", "CallWhenSpecified"],
    // ["Pick Up Now", "PickUpNow"],
    // ["Ship Ticket", "ShipTicket"],
  ];

  // Labels for every Eclipse orderStatus an existing order can have.
  var STATUS_LABELS = {
    Bid: "Bid", ShipWhenComplete: "Ship When Complete", ShipWhenAvailable: "Ship When Available",
    ShipWhenSpecified: "Ship When Specified", ShipItemComplete: "Ship Item Complete", Direct: "Vendor Direct",
    CallWhenAvailable: "Call When Available", CallWhenComplete: "Call When Complete",
    CallWhenSpecified: "Call When Specified", PickUpNow: "Pick Up Now", ShipTicket: "Ship Ticket",
    Invoice: "Invoiced", Cancel: "Cancelled",
  };

  function statusLabel(s) { return STATUS_LABELS[s] || s || "Unknown"; }

  // Pick Up Now: offered in Place Order and Convert to Order only when the
  // ship via is CPU PICK UP; the rep then picks a printer at the ship branch.
  var PICK_UP_NOW = ["Pick Up Now", "PickUpNow"];
  var PICK_UP_SHIP_VIA = "CPU PICK UP";

  // Printers by ship branch id: [printerId, printerName]. Static for now
  // (the list the user gave on 2026-10-22).
  var PRINTERS = {
    "1": [[17, "01-CanonOFC-LP1"], [23, "01-CFO-LP8"], [29, "01-Sales1-LP15"], [33, "01-Purchasing-LP44"], [38, "01-ReceivingLaser-LP46"], [48, "01-WHSEOffice1-LP45"], [55, "09-Laser1-LP36"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [85, "01-Warehouse1-LP16"], [86, "01-Starship"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "2": [[55, "09-Laser1-LP36"], [57, "02-GI Laser-LP6"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [84, "02-Office-HP"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "3": [[49, "03-Laser1-LP12"], [55, "09-Laser1-LP36"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [81, "03-Counter"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "4": [[3, "04-Laser1-LP19"], [50, "04-CTR"], [55, "09-Laser1-LP36"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "5": [[51, "05-Laser1-LP21"], [55, "09-Laser1-LP36"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "6": [[52, "06-Laser1-LP27"], [55, "09-Laser1-LP36"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [77, "02-Shipping"], [79, "03-Shipping"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "7": [[53, "07-Office1-LP24"], [55, "09-Laser1-LP36"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [92, "07-Counter"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "8": [[55, "09-Laser1-LP36"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [85, "01-Warehouse1-LP16"], [89, "08-Shipping"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "9": [[55, "09-Laser1-LP36"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "12": [[55, "09-Laser1-LP36"], [58, "12-Reports1-Lp34"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "14": [[55, "09-Laser1-LP36"], [59, "06-Shipping"], [61, "14-Counter"], [65, "12-Shipping"], [67, "14-Shipping"], [68, "14-BudOffice"], [69, "14-Accounting2"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [82, "14-EdOffice"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [95, "Brothers Model HL-L6200DW"], [97, "17-Shipping"]],
    "15": [[55, "09-Laser1-LP36"], [59, "06-Shipping"], [65, "12-Shipping"], [67, "14-Shipping"], [71, "15-ManagerOffice"], [72, "15-Shipping"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [83, "Fresno Counter"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "16": [[55, "09-Laser1-LP36"], [59, "06-Shipping"], [62, "16-Warehouse"], [63, "16-Marlon"], [65, "12-Shipping"], [67, "14-Shipping"], [72, "15-Shipping"], [76, "16-Counter"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
    "17": [[55, "09-Laser1-LP36"], [59, "06-Shipping"], [62, "16-Warehouse"], [65, "12-Shipping"], [66, "17-Counter"], [67, "14-Shipping"], [72, "15-Shipping"], [73, "17-IP50-HPColorLaserJetProMFPM479"], [74, "17-IP42-HPPageWidePro"], [75, "17-IP114"], [77, "02-Shipping"], [78, "05-Shipping"], [79, "03-Shipping"], [85, "01-Warehouse1-LP16"], [90, "08-Counter"], [91, "07-Shipping"], [94, "04- Shipping"], [97, "17-Shipping"]],
  };

  // Bill-to terms that pay up front, so a credit limit never blocks them.
  var COD_TERMS = ["COD.CO.CHECK", "COD.CC"];

  // Grid columns that hold an input, in keyboard order.
  var COLS = ["product", "qty", "price"];

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Unit prices keep Eclipse's third decimal when there is one (183.619).
  function unitText(v) {
    if (v == null || !isFinite(v)) return "";
    var n = Math.round(Number(v) * 1000) / 1000;
    return Math.abs(n * 100 - Math.round(n * 100)) > 1e-6 ? n.toFixed(3) : n.toFixed(2);
  }

  function unitMoney(v) {
    if (v == null || !isFinite(v)) return "-";
    var t = unitText(v).split(".");
    t[0] = t[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return "$" + t.join(".");
  }

  function money(v) {
    if (v == null || !isFinite(v)) return "-";
    var parts = Number(v).toFixed(2).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return "$" + parts.join(".");
  }

  // Local date as YYYY-MM-DD (Eclipse validates dates in US Central, so a
  // UTC-based toISOString can land on the wrong day).
  // weekdayOnly pushes a Saturday or Sunday forward to Monday.
  function isoDate(offsetDays, weekdayOnly) {
    var d = new Date();
    d.setDate(d.getDate() + (offsetDays || 0));
    if (weekdayOnly) {
      if (d.getDay() === 6) d.setDate(d.getDate() + 2);
      else if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    }
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // "17 - YUMA (YUMA, AZ)" → "17"; "17" → "17"
  function branchIdOf(v) {
    var s = String(v == null ? "" : v).trim();
    if (/^\d+$/.test(s)) return s;
    var m = s.match(/^(\d+)\s*-/);
    return m ? m[1] : "";
  }

  function getJson(url, params) {
    var u = new URL(url);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] != null && params[k] !== "") u.searchParams.set(k, params[k]);
    });
    return fetch(u.toString()).then(readJson);
  }

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(readJson);
  }

  function readJson(res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok || (data && data.error && !data.success)) {
        var err = new Error((data && data.error) || ("Server error (status " + res.status + ")"));
        err.data = data;
        throw err;
      }
      return data;
    });
  }

  // product-inquiry returns error_message as a JSON string from Eclipse.
  function inquiryError(data) {
    if (!data || (!data.error_message && data.unit_price !== "error" && data.stock_info !== "error")) return null;
    var msg = "Pricing lookup failed.";
    if (data.error_message) {
      try {
        var parsed = JSON.parse(data.error_message);
        var first = parsed && parsed.errors && parsed.errors[0];
        if (first && first.message) msg = first.message;
      } catch (e) { msg = String(data.error_message); }
    }
    return msg;
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // URL params, tolerating "?" used in place of "&" between parameters
  // (e.g. ?e_customer_id=1?e_product_ids=2 or a trailing "?").
  function readParams() {
    var q = window.location.search.replace(/^\?/, "").replace(/\?/g, "&");
    return new URLSearchParams(q);
  }

  // Shortcut modifier: Control on a Mac (Option+I / Option+N are accent dead
  // keys there and type "ˆ" / "˜" whatever the page does), Alt elsewhere.
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  function altKey(letter) { return (isMac ? "\u2303" : "Alt+") + letter; }
  function isShortcutMod(e) { return isMac ? e.ctrlKey && !e.altKey && !e.metaKey : e.altKey && !e.ctrlKey && !e.metaKey; }

  // Rewrite one query param (null removes it). Also normalizes a URL that
  // used "?" between params into a proper "&"-joined query.
  function setUrlParam(key, value) {
    var p = readParams();
    if (value == null) p.delete(key); else p.set(key, value);
    var q = p.toString().replace(/%2C/gi, ",");
    window.history.replaceState(null, "", window.location.pathname + (q ? "?" + q : "") + window.location.hash);
  }

  // ?e_product_ids=106331,110723&quantities=50,1 → [{id, qty}]. Missing or
  // invalid quantities default to 1; non-numeric ids are skipped.
  function productsFromParams(params) {
    var ids = String(params.get("e_product_ids") || "").split(",").map(function (x) { return x.trim(); });
    var qtys = String(params.get("quantities") || "").split(",").map(function (x) { return x.trim(); });
    var out = [];
    ids.forEach(function (id, i) {
      if (!/^\d+$/.test(id)) return;
      var n = Math.round(Number(qtys[i]));
      out.push({ id: id, qty: isFinite(n) && n > 0 ? n : 1 });
    });
    return out;
  }

  // ── App ──────────────────────────────────────────────────────────────────

  function initApp(root) {
    var user = window.FB_USER || {};
    var header = initHeader(root, user);
    // HS Deal / HS Customer follow the open order and customer (every render).
    function paintHeader() {
      header.querySelector('[data-cell="hdr-links"]').innerHTML = dealLinkHtml() + customerLinkHtml();
    }
    // Layout variant: <main id="app" data-layout="side"> (side.html)
    // shows stock + qty breaks for every line in a box to the
    // right of the lines, open by default. data-layout="details"
    // (details.html) has no box: a Details button on each line opens a dialog
    // with its stock, qty breaks and comment. index.html (the default) has no
    // data-layout and shows stock, qty breaks and the comment in a strip under the
    // focused line.
    var layout = root.getAttribute("data-layout") || "inline";
    var sideLayout = layout === "side";
    var detailsLayout = layout === "details";
    var inlineLayout = !sideLayout && !detailsLayout;
    var params = readParams();
    var urlProducts = productsFromParams(params);
    // ?e_customer_id with both e_product_ids and quantities skips the orders
    // list once and starts a new order with those lines.
    var urlAutoNew = !!(params.get("e_product_ids") && params.get("quantities")) && urlProducts.length > 0;

    var state = {
      view: "customer",          // customer | loading | orders | shipto | order | done | error
      error: null,
      customerId: params.get("e_customer_id") || "",
      customer: null,            // /customer response
      shipTo: null,              // chosen ship-to { e_customer_id, name, address }
      header: null,              // order header values
      lines: [],                 // [{ key, productId, description, qty, price, priceOverride, quote }]
      customModal: null,         // { r (-1 = new), at, draft, errors }: "Custom line" dialog
      focus: { r: 0, c: 0 },     // last focused grid cell
      placing: false,
      confirm: null,             // { mode: "bid" | "order" }
      placeError: null,
      result: null,
      orderId: params.get("e_sorder_id") || "",
      existing: null,            // the open generation of an existing order (+ order-level fields)
      order: null,               // full /order response: every generation of the open order
      genEdits: {},              // generation_id → { lines, focus, dirty }: unsaved edits per tab
      ordersList: null,          // { billTo, loading, error, data } from customer-orders
      listCustomer: null,        // { id, data }: the customer the orders list was opened for (Exit returns to it)
      ordersShipToOnly: true,    // orders list: only the picked ship-to's orders
      logModal: false,           // "Change log" dialog open
      logGenOnly: false,         // change log filtered to the open generation
      changeLog: null,           // { orderId, loading, error, data } from order-changelog
      cancelAsk: false,          // "Cancel this order?" dialog open
      sidePanel: true,           // side layout only: stock / breaks box open
      detailsModal: null,        // details layout only: { r, comment } "Line details" dialog
      notice: null,              // { text, hubspotError }: "Bid / Order placed" note after a save
      quoteModal: null,          // { id, quote, emails, sending, note }: "View Quote" dialog
      quoteError: null,          // View Quote could not make a quote (shown above the action bar)
    };
    // Inline layout: the line whose stock / qty breaks / comment strip is shown.
    var stripRow = -1;
    var lineSeq = 0;
    var quoteCache = {};         // productId → { loading, error, data }
    var hsQuotes = {};           // e_sorder_id → "checking" | "creating": View Quote in flight (nothing cached)

    function newLine() {
      // comment: the line's Eclipse line comment (lineItemProduct.comments).
      // branch: the branch this line ships from, picked on its inventory
      // tiles; "" follows the header's ship branch (lineBranch()).
      return { key: ++lineSeq, productId: "", description: "", qty: 1, price: null, priceOverride: false, comment: "", branch: "" };
    }

    // Existing order: the customers are always locked. A Bid unlocks its
    // lines, the shipping fields of its header and outside sales (BID_HEAD,
    // sent by Update Bid); PO, release and every field of any other order
    // stay locked.
    // headLocked(key): that header field; headLocked(): the whole header.
    var BID_HEAD = ["shipVia", "shipBranch", "shipDate", "requiredDate", "shippingInstructions", "internalNotes", "outsideSales"];
    function headLocked(key) {
      var ex = state.existing;
      if (!ex) return false;
      if (!ex.editable) return true;
      return key != null && BID_HEAD.indexOf(key) < 0;
    }
    function linesLocked() { return !!state.existing && !state.existing.editable; }

    // Default ship branch: the ship-to's Eclipse home branch, else the
    // bill-to's, else the rep's default branch.
    function defaultShipBranch(shipTo) {
      var bt = (state.customer && state.customer.bill_to) || {};
      return branchIdOf(shipTo && shipTo.home_branch) || branchIdOf(bt.home_branch) || branchIdOf(user.default_branch) || "";
    }

    function defaultHeader() {
      // Ship via starts blank (required for orders, optional for bids).
      // Customer release # is pre-filled from the bill-to's Eclipse default
      // release number; a blank PO falls back to the customer's default PO
      // in create-order.
      var bt = (state.customer && state.customer.bill_to) || {};
      return {
        shipBranch: defaultShipBranch(state.shipTo),
        shipVia: "",
        orderStatus: "",         // picked in the Place Order dialog; blank until then
        shipDate: isoDate(0),
        requiredDate: isoDate(7, true),
        po: "",
        release: bt.release_number || "",
        internalNotes: "",
        shippingInstructions: "",
        freightIn: "",           // totals box; sent to create-order as freight_in
        outsideSales: String(user.default_territory || "").trim(),  // outsideSalesOptions()
      };
    }

    // Outside sales choices: the rep's territories (HubSpot
    // e_user_all_territories) plus their default territory
    // (e_user_default_territory), once each, as [text, value] pairs.
    function outsideSalesOptions() {
      var list = (user.territories || []).concat([user.default_territory || ""]);
      return list.map(function (v) { return String(v).trim(); })
        .filter(function (v, i, a) { return v && a.indexOf(v) === i; })
        .map(function (v) { return [v, v]; });
    }

    // The rep's freight in on a new order, in dollars (0 when blank or invalid).
    function freightInValue() {
      var v = parseFloat(state.header && state.header.freightIn);
      return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0;
    }

    function pricingCustomerId() {
      return (state.customer && state.customer.bill_to && state.customer.bill_to.e_customer_id) || state.customerId;
    }

    // ── Data loading ───────────────────────────────────────────────────────

    // A picked customer (search or ?e_customer_id) opens its orders list:
    // the bill-to's recent orders plus a "New order" button.
    function loadCustomer(id) {
      state.customerId = String(id);
      state.view = "loading";
      state.loadingMsg = "";
      state.error = null;
      setUrlParam("e_customer_id", state.customerId);
      render();

      resolveCustomer(state.customerId)
        .then(function (data) {
          state.customer = data;
          state.listCustomer = { id: state.customerId, data: data };
          quoteCache = {};
          state.ordersShipToOnly = true;
          // Always refetch here, so an order placed earlier shows up.
          state.ordersList = null;
          state.view = "orders";
          // A picked ship-to shows as the Ship to card on the orders list.
          state.shipTo = pickedShipTo();
          if (data.bill_to) fetchOrders(String(data.bill_to.e_customer_id));
          if (urlAutoNew) { urlAutoNew = false; newOrderFromList(); return; }
          render();
        })
        .catch(function (err) {
          state.view = "error";
          state.error = err.message;
          render();
        });
    }

    // One call to e-order-placement/customer resolves the customer, its
    // bill-to and its ship-tos from Eclipse (names, addresses, branch,
    // price class, credit limit) plus HubSpot record ids and coordinates.
    function resolveCustomer(id) {
      return getJson(API.customer, { e_customer_id: id }).then(function (d) {
        var party = function (p) {
          if (!p) return null;
          p.address_lines = addressLines(p);
          p.address = p.address_lines.join(", ");
          return p;
        };
        return {
          customer: party(d.customer),
          bill_to: party(d.bill_to),
          ship_tos: (d.ship_tos || []).map(party),
          ship_to: party(d.ship_to),
          needs_ship_to_choice: !!d.needs_ship_to_choice,
        };
      });
    }

    // ["717 BRIDGE ST", "SUITE 2", "YUBA CITY, CA 95991"]
    function addressLines(a) {
      var zip = String(a.postal_code || "");
      if (/^\d{9}$/.test(zip)) zip = zip.slice(0, 5) + "-" + zip.slice(5);
      var cityLine = [a.city, [a.state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      return [a.address_line1, a.address_line2, cityLine].filter(function (x) { return x && String(x).trim(); });
    }

    // The picked customer when it is a ship-to other than its bill-to.
    function pickedShipTo() {
      var c = state.customer || {};
      var p = c.customer, bt = c.bill_to;
      return p && bt && String(p.e_customer_id) !== String(bt.e_customer_id) ? p : null;
    }

    // "New order" on the orders list: a bill-to with ship-tos picks one
    // first, otherwise straight to the grid.
    function newOrderFromList() {
      var c = state.customer;
      if (c.needs_ship_to_choice) {
        state.keepOrder = false;
        state.view = "shipto";
        render();
      } else if (c.ship_to) {
        startOrder(c.ship_to);
      } else {
        state.view = "error";
        state.error = "This customer has no ship-to to place an order against.";
        render();
      }
    }

    function startOrder(shipTo) {
      // Changing the ship-to mid-order keeps the lines and header.
      if (state.keepOrder && state.header) {
        state.keepOrder = false;
        // Follow the new ship-to's home branch unless the rep picked one.
        if (state.header.shipBranch === defaultShipBranch(state.shipTo)) {
          state.header.shipBranch = defaultShipBranch(shipTo);
        }
        state.shipTo = shipTo;
        state.view = "order";
        render();
        return;
      }
      state.keepOrder = false;
      state.shipTo = shipTo;
      state.header = defaultHeader();
      state.lines = [newLine()];
      state.customModal = null;
      state.detailsModal = null;
      state.focus = { r: 0, c: 0 };
      // Products from the URL (?e_product_ids=…&quantities=…) seed the first
      // order only; "New order" and later orders start blank.
      if (urlProducts.length) {
        state.lines = urlProducts.map(function (p) {
          var line = newLine();
          line.productId = p.id;
          line.qty = p.qty;
          line.lookingUp = true;
          return line;
        }).concat([newLine()]);
        state.focus = { r: state.lines.length - 1, c: 0 };
        urlProducts.forEach(function (p) { fetchQuote(p.id); lookupDescription(p.id); });
        urlProducts = [];
      }
      state.placeError = null;
      state.result = null;
      state.view = "order";
      render();
    }

    // ?e_sorder_id=S123.0001: read the order, resolve its customers with
    // e-order-placement/customer (on the bill-to, so every ship-to is known),
    // then open the grid with the order's header and lines.
    // One call returns every generation (Eclipse GET on the base order id);
    // the tabs then switch between them without another request. An id
    // without a suffix (S2659464) opens the lowest generation.
    function loadExistingOrder(id) {
      state.orderId = String(id).trim().toUpperCase();
      state.view = "loading";
      state.loadingMsg = "Loading order " + state.orderId + "…";
      state.notice = null;
      state.error = null;
      state.genEdits = {};
      state.changeLog = null;
      state.logModal = false;
      state.quoteModal = null;
      hsQuotes = {};
      render();

      getJson(API.order, { e_sorder_id: state.orderId })
        .then(function (o) {
          state.order = o;
          return openGen(o.generation_id);
        })
        .catch(function (err) {
          state.view = "error";
          state.error = err.message;
          render();
        });
    }

    // The bill-to (with its ship-tos) and the ship-to for a generation.
    // Reuses the loaded customer when the bill-to is the same one.
    function partiesFor(gen) {
      var billTo = String(gen.bill_to_id || gen.ship_to_id);
      var have = state.customer && state.customer.bill_to && String(state.customer.bill_to.e_customer_id) === billTo;
      return (have ? Promise.resolve(state.customer) : resolveCustomer(billTo)).then(function (data) {
        var all = [data.ship_to, data.customer].concat(data.ship_tos || []);
        var st = all.filter(function (p) { return p && String(p.e_customer_id) === String(gen.ship_to_id); })[0];
        // A ship-to that is not under this bill-to: resolve it on its own.
        if (st || !gen.ship_to_id) return { data: data, shipTo: st || data.ship_to || data.customer, same: have };
        return resolveCustomer(gen.ship_to_id).then(function (d2) {
          return { data: data, shipTo: d2.customer, same: have };
        });
      });
    }

    function genLabel(g, short) {
      return (short ? "Gen. " : "Generation ") + g.generation_id +
        (g.invoice_number != null ? (short ? " / Inv. " : " / Invoice ") + g.invoice_number : "");
    }

    // Keep the open tab's lines and header (and whether they differ from
    // Eclipse) so switching away and back does not lose a bid's unsaved edits.
    function saveGenEdits() {
      var ex = state.existing;
      if (!ex || !ex.editable || state.view !== "order") return;
      state.genEdits[ex.generation_id] = { lines: state.lines, header: state.header, focus: state.focus, dirty: bidChanges().any };
    }

    function hasUnsavedEdits() {
      saveGenEdits();
      return Object.keys(state.genEdits).some(function (k) { return state.genEdits[k].dirty; });
    }

    // Open one generation of the loaded order (first load and tab clicks).
    function openGen(genId) {
      var o = state.order;
      var gen = (o.generations || []).filter(function (g) { return String(g.generation_id) === String(genId); })[0];
      if (!gen) return Promise.resolve();
      saveGenEdits();
      return partiesFor(gen).then(function (res) {
        if (!res.same) quoteCache = {};
        state.customer = res.data;
        state.customerId = String(gen.bill_to_id || gen.ship_to_id);
        state.orderId = gen.e_sorder_id;
        setUrlParam("e_sorder_id", gen.e_sorder_id);
        openExisting(Object.assign({}, gen, {
          order_id: o.order_id, last_modified: o.last_modified, last_modified_by: o.last_modified_by,
        }), res.shipTo, state.genEdits[gen.generation_id]);
      });
    }

    function openExisting(order, shipTo, saved) {
      state.existing = order;
      state.shipTo = shipTo;
      state.keepOrder = false;
      state.header = {
        shipBranch: branchIdOf(order.ship_branch),
        shipVia: order.ship_via || "",
        orderStatus: order.status,
        shipDate: order.ship_date || "",
        requiredDate: order.required_date || "",
        po: order.po || "",
        release: order.release || "",
        internalNotes: order.internal_notes || "",
        shippingInstructions: order.shipping_instructions || "",
        outsideSales: order.outside_sales || "",
      };
      // A bid's unsaved header edits on this tab.
      if (saved && saved.header) state.header = saved.header;
      // Loaded lines keep the order's price (keepPrice) until the rep edits
      // it; orig is what Eclipse has, so Update Bid sends only the changes.
      state.lines = saved ? saved.lines : (order.lines || []).map(function (l) {
        var line = newLine();
        line.productId = String(l.product_id);
        line.description = l.description || "";
        line.qty = Number(l.qty) || 1;
        // Eclipse's unit on the order line, shown when HubSpot has no e_uom.
        line.orderUm = l.um || "";
        line.price = l.unit_price;
        line.priceOverride = l.unit_price != null;
        line.keepPrice = l.unit_price != null;
        line.orig = { lineId: l.line_id, qty: Number(l.qty) || 0, price: l.unit_price };
        // Eclipse's own line comments (order-lookup), shown under the description.
        line.eclipseComments = Array.isArray(l.comments) ? l.comments.filter(Boolean).map(String) : [];
        // The COGS saved on the order line (Eclipse `cogs`, not `cost`, which
        // is 0 on some lines that have a real COGS).
        line.orderCost = l.unit_cogs != null && isFinite(l.unit_cogs) ? Number(l.unit_cogs) : null;
        return line;
      });
      if (!saved && (order.editable || !state.lines.length)) state.lines.push(newLine());
      state.customModal = null;
      state.detailsModal = null;
      state.quoteModal = null;
      state.quoteError = null;
      state.lines.forEach(function (l) { if (l.productId) fetchQuote(l.productId); });
      // Nothing is focused or highlighted on load (r -1), so the page opens at
      // its top; only a brand new order jumps to its new line. Alt+L or a
      // click still moves into the lines.
      state.focus = saved ? saved.focus : { r: -1, c: 0 };
      state.confirm = null;
      state.cancelAsk = false;
      state.placeError = null;
      state.result = null;
      state.view = "order";
      render();
      // Opened from a long orders list: start at the top, not where it was scrolled.
      if (!saved) window.scrollTo(0, 0);
    }

    // Leave an existing order (Change customer, New order).
    function leaveExisting() {
      state.notice = null;
      state.existing = null;
      state.order = null;
      state.genEdits = {};
      state.orderId = "";
      setUrlParam("e_sorder_id", null);
    }

    // Description for a product id: product-inquiry product search with a
    // leading dot (".106331" = exact id), matching e_product_id exactly.
    function lookupDescription(pid) {
      getJson(API.inquiry, { e_customer_id: pricingCustomerId(), e_product_name: "." + pid })
        .then(function (d) {
          var list = Array.isArray(d.e_products) ? d.e_products : [];
          var hit = list.filter(function (p) { return String(p.e_product_id) === String(pid); })[0];
          return hit || null;
        })
        .catch(function () { return null; })
        .then(function (hit) {
          state.lines.forEach(function (l, r) {
            if (String(l.productId) !== String(pid) || !l.lookingUp) return;
            l.lookingUp = false;
            l.description = hit ? (hit.description || "") : "";
            l.uom = hit ? (hit.uom || "") : "";
            l.notFound = !hit;
            if (state.view === "order") refreshRow(r);
          });
        });
    }

    function fetchQuote(productId) {
      var pid = String(productId);
      if (quoteCache[pid] && !quoteCache[pid].error) return;
      quoteCache[pid] = { loading: true };
      inquiryQueue.push(pid);
      pumpQueue();
    }

    // At most 3 pricing lookups in flight; each one is a separate call to
    // the product-inquiry flow (it prices one product per request).
    var inquiryQueue = [];
    var inFlight = 0;
    function pumpQueue() {
      while (inFlight < 3 && inquiryQueue.length) {
        (function (pid) {
          inFlight++;
          getJson(API.inquiry, { e_customer_id: pricingCustomerId(), e_product_id: pid })
            .then(function (data) {
              var err = inquiryError(data);
              quoteCache[pid] = err ? { error: err } : { data: data };
            })
            .catch(function (err) { quoteCache[pid] = { error: err.message }; })
            .then(function () {
              inFlight--;
              refreshLinesFor(pid);
              if (state.customModal && String(state.customModal.draft.variationSku) === pid) refreshCustomOrig();
              pumpQueue();
            });
        })(inquiryQueue.shift());
      }
    }

    // ── Pricing / stock derivations ────────────────────────────────────────

    // The line's unit, lower case ("ft", "ea"): the product search's uom,
    // else the unit on the loaded order line, else none.
    function uomOf(line) {
      if (!line.productId) return "";
      return String(line.uom || line.orderUm || "").toLowerCase();
    }

    // Qty box: the input always holds the bare number. While it is not
    // focused and the line has a unit, its text is hidden and the overlay
    // shows "50 ft" (unit in grey), matching the input's own padding,
    // alignment and font, so the number does not move on focus. Its colour
    // comes from styles.css (theme tokens), so a theme switch repaints it.
    var QTY_STYLE = ["paddingLeft", "paddingRight", "textAlign", "fontFamily", "fontSize", "fontWeight"];
    function showQty(r) {
      var el = cellInput(r, 1);
      var line = state.lines[r];
      if (!el || !line) return;
      el.value = String(line.qty);
      var box = el.parentNode;
      var show = box.querySelector(".fop-qty__show");
      var um = uomOf(line);
      var on = !!um && document.activeElement !== el;
      box.classList.toggle("fop-qty--unit", on);
      if (!show) return;
      if (!on) { show.innerHTML = ""; return; }
      var cs = getComputedStyle(el);
      QTY_STYLE.forEach(function (k) { show.style[k] = cs[k]; });
      // The overlay covers the border too, so add the border to the padding.
      show.style.paddingLeft = (parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)) + "px";
      show.style.paddingRight = (parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth)) + "px";
      show.innerHTML = "<span>" + esc(line.qty) + ' <span class="fop-qty__um">' + esc(um) + "</span></span>";
    }

    function showAllQty() {
      if (state.view !== "order") return;
      state.lines.forEach(function (l, r) { if (!l.custom) showQty(r); });
    }

    function quoteOf(line) {
      return line.productId ? quoteCache[String(line.productId)] : null;
    }

    // Unit price for a qty from the cached quantity breaks.
    function breakPrice(data, qty) {
      var base = parseFloat(data.unit_price);
      var breaks = Array.isArray(data.quantity_breaks) ? data.quantity_breaks : [];
      var price = isFinite(base) ? base : null;
      for (var i = 0; i < breaks.length; i++) {
        var start = Number(breaks[i].startQuantity) || 0;
        var p = parseFloat(breaks[i].unitPrice);
        if (start <= qty && isFinite(p)) price = p;
      }
      return price;
    }

    // Unit cost: a loaded order line's own Eclipse COGS (orderCost, from
    // e-order-placement/order), else unit_cost from the product-inquiry price
    // lookup. NaN when neither is known.
    function lineCost(line) {
      if (line.orderCost != null) return line.orderCost;
      var q = quoteOf(line);
      return q && q.data ? parseFloat(q.data.unit_cost) : NaN;
    }

    // Floor for any unit price: unit cost + $0.01. Null when cost is unknown.
    function minPrice(line) {
      var cost = lineCost(line);
      return isFinite(cost) ? Math.round((cost + 0.01) * 1000) / 1000 : null;
    }

    // Eclipse's own price for the qty (quantity breaks), before the floor.
    function autoPrice(line) {
      var q = quoteOf(line);
      if (!q || !q.data) return null;
      return breakPrice(q.data, Number(line.qty) || 0);
    }

    // Ceiling for any unit price: a loaded bid line's own Eclipse price (the
    // original unit price already on the order), else the auto / qty-break
    // price. Null when neither is known, same as minPrice.
    function maxPrice(line) {
      if (line.orig && line.orig.price != null) return line.orig.price;
      return autoPrice(line);
    }

    // True when the order must send an explicit unitPrice: the rep typed
    // one, or Eclipse's price is under the cost + $0.01 floor.
    function sendsPrice(line) {
      if (line.priceOverride) return true;
      var a = autoPrice(line), m = minPrice(line);
      return a != null && m != null && a < m;
    }

    function linePrice(line) {
      // A loaded line's own Eclipse price, untouched: no floor (bids often
      // carry $0 kit components) and no re-pricing on a qty change.
      if (line.keepPrice) return line.price;
      var m = minPrice(line);
      if (line.priceOverride) return m != null && line.price < m ? m : line.price;
      var a = autoPrice(line);
      if (a != null && m != null && a < m) return m;
      var q = quoteOf(line);
      if (!q || !q.data) return null;
      return breakPrice(q.data, Number(line.qty) || 0);
    }

    // ── Ship branch per line ───────────────────────────────────────────────
    // A line ships from the branch picked on its inventory tiles, else the
    // header's ship branch. Lines on different branches are placed (or saved
    // on a bid) as one generation per branch.

    function lineBranch(line) {
      return (line && !line.custom && line.branch) || (state.header ? state.header.shipBranch : "") || "";
    }

    // Branches the lines ship from, in line order (custom lines ship from
    // the header's).
    function orderBranches() {
      var out = [];
      sentLines().forEach(function (l) {
        var b = lineBranch(l);
        if (b && out.indexOf(b) < 0) out.push(b);
      });
      return out;
    }

    function branchName(id) {
      var known = BRANCHES.filter(function (b) { return b[0] === String(id); })[0];
      return id ? id + (known ? " - " + known[1] : "") : "";
    }

    // An inventory tile picked: line r ships from that branch. When every
    // line with a product then ships from one branch, that becomes the
    // header's ship branch (and the lines follow it again).
    function pickBranch(r, id) {
      var line = state.lines[r];
      if (!line || line.custom || linesLocked() || !id) return;
      line.branch = id === state.header.shipBranch ? "" : id;
      state.branchMenu = null;
      var ls = state.lines.filter(function (l) { return !l.custom && l.productId; });
      var first = ls.length ? lineBranch(ls[0]) : "";
      if (first && ls.every(function (l) { return lineBranch(l) === first; })) {
        state.header.shipBranch = first;
        state.lines.forEach(function (l) { l.branch = ""; });
      }
      state.focus = { r: r, c: state.focus.c };
      render();
    }

    function lineStock(line) {
      var q = quoteOf(line);
      if (!q || !q.data) return null;
      var stock = Array.isArray(q.data.stock_info) ? q.data.stock_info : [];
      var branch = lineBranch(line);
      var atBranch = 0, total = 0;
      for (var i = 0; i < stock.length; i++) {
        var qty = parseInt(stock[i].warehouseQty, 10) || 0;
        total += qty;
        if (branch && branchIdOf(stock[i].warehouse) === branch) atBranch += qty;
      }
      return { atBranch: atBranch, total: total, rows: stock };
    }

    function filledLines() {
      return state.lines.filter(function (l) { return l.productId && Number(l.qty) > 0; });
    }

    function orderTotal() {
      var total = 0, unknown = false, cost = 0, costUnknown = false;
      filledLines().forEach(function (l) {
        var p = linePrice(l);
        if (p == null) unknown = true;
        else total += p * Number(l.qty);
        // Same unit cost as the line's Unit cost cell.
        var c = lineCost(l);
        if (!isFinite(c)) costUnknown = true;
        else cost += c * Number(l.qty);
      });
      // Custom lines: the rep's own price and estimated COGS.
      customLines().forEach(function (l) {
        var cl = l.custom;
        total += cl.price * cl.qty;
        cost += cl.cogs * cl.qty;
      });
      return { total: total, unknown: unknown, cost: cost, costUnknown: costUnknown };
    }

    // ── Custom lines ───────────────────────────────────────────────────────
    // A line for something that is not an Eclipse product yet (a one-off or
    // a variation of an existing product). New orders and bids; an order with
    // any custom line can only be placed as a bid (it needs approval), and a
    // bid can't be converted while one is unsaved. They go to Eclipse as
    // product 15680 ("ITEM:") with their text in the line comment, so once
    // saved they come back as regular lines.
    // Custom lines sit in state.lines like any other line (line.custom holds
    // the dialog's values), so they keep the position the rep added them at.

    // A saved custom line comes back from Eclipse as a regular line on
    // product 15680 ("ITEM:"). Its id shows as "Custom", and it has no
    // inventory or quantity breaks to show.
    var ITEM_PRODUCT_ID = "15680";
    function isItemLine(line) { return !!line && String(line.productId) === ITEM_PRODUCT_ID; }
    function pidText(line) { return isItemLine(line) ? "Custom" : line.productId; }
    // Product id cell of the confirm dialogs: 15680 as a Custom tag.
    function pidCellHtml(id) { return String(id) === ITEM_PRODUCT_ID ? '<span class="fop-badge">Custom</span>' : esc(id); }

    function customLines() {
      return state.lines.filter(function (l) { return l.custom; });
    }

    // Lines that go out with a placement, in page order: filled regular
    // lines and custom lines.
    function sentLines() {
      return state.lines.filter(function (l) { return l.custom || (l.productId && Number(l.qty) > 0); });
    }

    function emptyCustomDraft() {
      return { name: "", idealSku: "", qty: "1", price: "", cogs: "", variation: false, variationSku: "", variationDesc: "", serial: "", customizations: "" };
    }

    function customDraftFrom(cl) {
      return {
        name: cl.name, idealSku: cl.idealSku, qty: String(cl.qty), price: String(cl.price), cogs: String(cl.cogs),
        variation: !!cl.variationSku, variationSku: cl.variationSku, pickedSku: cl.variationSku, variationDesc: cl.variationDesc, serial: cl.serial, customizations: cl.customizations.join("\n"),
      };
    }

    // Draft (strings from the dialog) → { line, errors }. Errors are keyed
    // by field; line is null while any field is invalid.
    function customLineFrom(d) {
      var errors = {};
      var num = function (v) { var s = String(v).trim(); return s === "" ? NaN : Number(s); };
      var name = d.name.trim();
      var qty = num(d.qty), price = num(d.price), cogs = num(d.cogs);
      if (!name) errors.name = "Enter a name.";
      if (!(qty > 0) || Math.round(qty) !== qty) errors.qty = "Enter a whole number above 0.";
      if (!isFinite(price) || price < 0) errors.price = "Enter a price (0 or more).";
      if (!isFinite(cogs) || cogs < 0) errors.cogs = "Enter the estimated COGS (0 or more).";
      if (!errors.price && !errors.cogs && price < cogs) errors.price = BELOW_COGS;
      if (!errors.name && customSameName(d)) errors.name = SAME_NAME;
      var vSku = d.variation ? d.variationSku.trim() : "";
      // The existing SKU must be picked from the product search (variationDesc
      // is set on pick and cleared when the rep types over it).
      if (d.variation && (!vSku || !d.variationDesc)) errors.variationSku = vSku ? "Pick the product from the list." : "Search for the product it is a variation of.";
      if (Object.keys(errors).length) return { line: null, errors: errors };
      return {
        errors: {},
        line: {
          name: name,
          idealSku: d.idealSku.trim(),
          qty: qty,
          price: Math.round(price * 1000) / 1000,
          cogs: Math.round(cogs * 1000) / 1000,
          variationSku: vSku,
          variationDesc: d.variation ? d.variationDesc : "",
          serial: d.variation ? d.serial.trim() : "",
          // One customization per line of the text box.
          customizations: d.customizations.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean),
        },
      };
    }

    // r: the custom line to edit, or -1 for a new one. A new line goes where
    // the rep is: in place of the focused line when that one is blank (the
    // blank moves down), else right after it.
    function openCustomModal(r) {
      if (linesLocked()) return;
      var line = r >= 0 ? state.lines[r] : null;
      var at = state.lines.length;
      var f = state.lines[state.focus.r];
      if (f) at = !f.custom && !f.productId ? state.focus.r : state.focus.r + 1;
      state.customModal = {
        r: line && line.custom ? r : -1, at: at,
        draft: line && line.custom ? customDraftFrom(line.custom) : emptyCustomDraft(), errors: {},
      };
      // The variation's own pricing, for the "Original" hints.
      if (state.customModal.draft.variationSku) fetchQuote(state.customModal.draft.variationSku);
      render();
    }

    function closeCustomModal() {
      state.customModal = null;
      render();
    }

    function saveCustomModal() {
      var m = state.customModal;
      var res = customLineFrom(m.draft);
      if (!res.line) { m.errors = res.errors; render(); return; }
      if (m.r >= 0) state.lines[m.r].custom = res.line;
      else {
        var line = newLine();
        line.custom = res.line;
        state.lines.splice(m.at, 0, line);
        // Focus stays on (or moves to) the next regular line.
        var nr = nextGridRow(m.at, 1);
        if (nr >= 0) state.focus = { r: nr, c: 0 };
      }
      state.customModal = null;
      render();
    }

    // Custom lines as create-order and update-bid take them (both send them
    // to Eclipse as product 15680, "ITEM:", with the text in the line
    // comment). line_number: the line's place among all sent lines (regular
    // and custom, 1-based, in page order).
    function customPayload() {
      return sentLines().map(function (l, i) { return { l: l, n: i + 1 }; }).filter(function (x) { return x.l.custom; }).map(function (x) {
        var cl = x.l.custom;
        return {
          line_number: x.n,
          name: cl.name,
          ideal_sku: cl.idealSku,
          quantity: cl.qty,
          unit_price: cl.price,
          est_cogs: cl.cogs,
          variation_of: cl.variationSku ? { product_id: cl.variationSku, description: cl.variationDesc, serial_number: cl.serial } : null,
          customizations: cl.customizations,
          ship_branch: lineBranch(x.l),
        };
      });
    }

    // Header fields a bid can change (BID_HEAD), as update-bid takes them.
    function headerPayload() {
      var h = state.header;
      return {
        ship_via: h.shipVia, ship_branch: h.shipBranch, ship_date: h.shipDate, required_date: h.requiredDate,
        shipping_instructions: h.shippingInstructions, internal_notes: h.internalNotes,
        outside_sales: h.outsideSales,
      };
    }

    // The bid's header fields that differ from Eclipse: [{ label, from, to }].
    function headChanges() {
      var ex = state.existing, h = state.header;
      var t = function (v) { return String(v == null ? "" : v).trim(); };
      var out = [];
      var add = function (label, from, to, show) {
        if (t(from) !== t(to)) out.push({ label: label, from: show ? show(t(from)) : t(from), to: show ? show(t(to)) : t(to) });
      };
      add("Ship via", ex.ship_via, h.shipVia);
      add("Ship branch", branchIdOf(ex.ship_branch), h.shipBranch, branchName);
      add("Ship date", ex.ship_date, h.shipDate, dateText);
      add("Required date", ex.required_date, h.requiredDate, dateText);
      add("Shipping instructions", ex.shipping_instructions, h.shippingInstructions);
      add("Internal notes", ex.internal_notes, h.internalNotes);
      add("Outside sales", ex.outside_sales, h.outsideSales);
      return out;
    }

    // Update Bid payload: the header, and every line the bid should end up
    // with. Loaded lines carry line_id (unitPrice only when the price
    // changed; comments when the rep added one, which re-creates the line);
    // new lines have none. Each line says the branch it ships from: a line
    // on another branch than the bid's moves to that branch's generation.
    // Loaded lines left out (removed, or product retyped) are deleted by the
    // update-bid flow.
    function bidChanges() {
      var ex = state.existing;
      var kept = {};
      var added = 0, changed = 0, moved = 0, commented = 0;
      var home = branchIdOf(ex.ship_branch);
      var lines = filledLines().map(function (l) {
        var qty = Number(l.qty);
        var br = lineBranch(l);
        var cmt = lineComment(l);
        if (l.orig) {
          kept[l.orig.lineId] = true;
          var out = { line_id: l.orig.lineId, productId: l.productId, quantity: qty, ship_branch: br };
          var p = linePrice(l);
          var priceChanged = p != null && (l.orig.price == null || Math.abs(p - l.orig.price) >= 0.0005);
          if (priceChanged) out.unitPrice = p;
          if (cmt) { out.comments = cmt; commented++; }
          if (br !== home) moved++;
          else if (priceChanged || qty !== l.orig.qty) changed++;
          return out;
        }
        added++;
        var line = { productId: l.productId, quantity: qty, ship_branch: br };
        if (sendsPrice(l)) line.unitPrice = linePrice(l);
        if (cmt) line.comments = cmt;
        return line;
      });
      var custom = customPayload();
      added += custom.length;
      var removed = (ex.lines || []).filter(function (l) { return !kept[l.line_id]; }).length;
      var head = headChanges();
      return {
        header: headerPayload(), lines: lines, custom_lines: custom, head: head,
        added: added, changed: changed, removed: removed, moved: moved, commented: commented,
        any: added + changed + removed + moved + commented + head.length > 0,
      };
    }

    // The comment sent with a line (create-order and update-bid pass it to
    // Eclipse as lineItemProduct.comments); "" for none. On a loaded bid
    // line it is added to the line's comments (update-bid re-creates it).
    function lineComment(l) {
      return String(l.comment || "").trim();
    }

    // Over the bill-to's credit limit: blocks an order (and Convert to
    // Order), not a bid, unless the bill-to pays COD (cash, check or card
    // up front at order time, so there is nothing to extend credit for).
    function creditLimitReason() {
      var bt = state.customer && state.customer.bill_to;
      var cl = bt && bt.credit_limit;
      if (!bt || !cl || cl.value == null || !isFinite(cl.value)) return null;
      if (COD_TERMS.indexOf(bt.terms_code) !== -1) return null;
      if (orderTotal().total <= cl.value) return null;
      return "Over the credit limit (" + money(cl.value) + "); it can only be placed as a bid.";
    }

    // Ship via "SEE INSTRUCTION" is not useful on its own: require real
    // shipping instructions (at least 5 characters) before a bid, order,
    // update or convert, in every mode.
    function seeInstructionReason() {
      if (state.header.shipVia !== "SEE INSTRUCTION") return null;
      if (String(state.header.shippingInstructions || "").trim().length >= 5) return null;
      return 'Ship via is "SEE INSTRUCTION": add at least 5 characters to Shipping instructions.';
    }

    function placeBlockedReason(mode) {
      var h = state.header;
      if (!filledLines().length && !customLines().length) return "Add at least one product with a quantity.";
      var missing = state.lines.filter(function (l) { return l.productId && l.notFound; })[0];
      if (missing) return "Product " + missing.productId + " was not found. Fix or remove that line.";
      if (seeInstructionReason()) return seeInstructionReason();
      if (mode === "update" || mode === "convert") {
        if (!state.existing || !state.existing.editable) return "Only a bid can be " + (mode === "update" ? "updated." : "converted.");
        if (!h.shipBranch) return "Pick a ship branch.";
        // Convert to Order: an order needs a ship via, and custom lines that
        // are not saved yet keep it a bid (same rule as a new order).
        if (mode === "convert" && customLines().length) return "An order with custom lines can only be placed as a bid.";
        if (mode === "convert" && !h.shipVia) return "Pick a ship via.";
        if (mode === "convert" && creditLimitReason()) return creditLimitReason();
        if (h.requiredDate && h.shipDate && h.requiredDate < h.shipDate) return "Required date cannot be before ship date.";
        if (!user.e_user_id) return "Sign in again: no Eclipse user on this session.";
        if (mode === "convert") return null;
        return bidChanges().any ? null : "No changes to save.";
      }
      if (state.existing) return "This order already exists.";
      // Custom lines need approval, so only a bid can carry them.
      if (mode === "order" && customLines().length) return "An order with custom lines can only be placed as a bid.";
      if (!h.shipBranch) return "Pick a ship branch.";
      // Ship via is required for an order but not a bid; a blank bid is sent
      // without one (the create-order flow omits shipVia).
      if (mode !== "bid" && !h.shipVia) return "Pick a ship via.";
      if (mode === "order" && creditLimitReason()) return creditLimitReason();
      if (h.requiredDate && h.shipDate && h.requiredDate < h.shipDate) return "Required date cannot be before ship date.";
      if (!user.e_user_id) return "Sign in again: no Eclipse user on this session.";
      return null;
    }

    // ── Rendering ──────────────────────────────────────────────────────────

    function render() {
      var html;
      switch (state.view) {
        case "customer": html = viewCustomerSearch(); break;
        case "loading": html = viewLoading(state.loadingMsg || "Loading customer…"); break;
        case "orders": html = viewOrders(); break;
        case "shipto": html = viewShipTo(); break;
        case "order": html = viewOrder(); break;
        case "done": html = viewDone(); break;
        default: html = viewError();
      }
      // Keep the stock card's own scroll position across full re-renders.
      var oldSide = root.querySelector('[data-cell="side"]');
      var sideTop = oldSide ? oldSide.scrollTop : 0;
      // The tab strip's scroll, so a tab click slides from where it was.
      var oldTabs = root.querySelector(".fop-tabs");
      if (oldTabs) tabsWas = { order: tabsOrderId(), left: oldTabs.scrollLeft };
      root.innerHTML = html;
      var newSide = root.querySelector('[data-cell="side"]');
      if (newSide) newSide.scrollTop = sideTop;
      scrollActiveTab();
      paintHeader();
      afterRender();
    }

    // Phones: the generation tabs scroll sideways, so bring the selected one
    // into view (the strip only; scrollIntoView would also scroll the page).
    // Switching tabs on the same order slides from the strip's last position;
    // opening or reloading an order jumps straight there.
    var tabsWas = null;
    function tabsOrderId() { return state.order ? String(state.order.order_id) : ""; }
    function scrollActiveTab() {
      var strip = root.querySelector(".fop-tabs");
      var tab = strip && strip.querySelector(".fop-tab--active");
      if (!tab) return; // e.g. a loading screen between tabs: keep tabsWas
      if (strip.scrollWidth <= strip.clientWidth) { tabsWas = null; return; }
      var slide = tabsWas && tabsWas.order === tabsOrderId();
      if (slide) strip.scrollLeft = tabsWas.left;
      tabsWas = null;
      var left = tab.offsetLeft - strip.offsetLeft, target = strip.scrollLeft;
      if (left < target) target = left;
      else if (left + tab.offsetWidth > target + strip.clientWidth) target = left + tab.offsetWidth - strip.clientWidth;
      if (target === strip.scrollLeft) return;
      if (slide) strip.scrollTo({ left: target, behavior: "smooth" });
      else strip.scrollLeft = target;
    }

    // Phones: the action bar is `position: fixed`, so the page needs bottom
    // padding at least as tall as it, or content underneath (the header's
    // notes fields, the last line) renders hidden behind it. The bar's
    // height varies (Last modified on its own row, the number of buttons,
    // whether they wrap to a second row), so it's measured after every
    // render instead of guessed at in CSS (--fop-bar-h on <html>, read by
    // .fop-app's padding-bottom).
    function syncBarSpace() {
      var bar = root.querySelector(".fop-bar");
      if (!bar) { document.documentElement.style.removeProperty("--fop-bar-h"); return; }
      document.documentElement.style.setProperty("--fop-bar-h", (bar.offsetHeight + 16) + "px");
    }

    // Grow a notes textarea to fit its text (never below its 1.5-line CSS minimum).
    function autosize(el) {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + 2 + "px";
    }

    // Shipping instructions and internal notes sit side by side, so they
    // always share one height: the taller of the two (on request).
    function autosizeNotesPair() {
      var pair = [root.querySelector('[data-head="shippingInstructions"]'), root.querySelector('[data-head="internalNotes"]')]
        .filter(Boolean);
      // Phones stack them, each its own height. An empty, unfocused one is
      // only its label there (styles.css stretches the box over the row),
      // so it takes no height of its own.
      if (window.matchMedia && window.matchMedia("(max-width: 767px)").matches) {
        pair.forEach(function (el) {
          if (getComputedStyle(el).position === "absolute") el.style.height = "";
          else autosize(el);
        });
        return;
      }
      pair.forEach(function (el) { el.style.height = "auto"; });
      var h = Math.max.apply(null, pair.map(function (el) { return el.scrollHeight; }).concat([0]));
      pair.forEach(function (el) { el.style.height = h + 2 + "px"; });
    }

    function autosizeNotes(el) {
      var paired = el && /^(shippingInstructions|internalNotes)$/.test(el.getAttribute("data-head") || "");
      if (paired) autosizeNotesPair(); else if (el) autosize(el);
    }

    // Date fields use Flatpickr (vendor/, same setup as the camo-cpq
    // quote expiration picker): the native date popup can't be styled.
    // #app's innerHTML is replaced on every render, so old instances are
    // destroyed and new ones attached each time.
    var datePickers = [];

    function dateErrorOn() {
      var h = state.header;
      // An order that can't be edited (invoiced, cancelled, non-bid) shows its
      // dates as Eclipse has them (e.g. a cancelled ship date in 2241); there
      // is nothing to fix, so no red outline.
      if (linesLocked()) return false;
      return !!(h && h.requiredDate && h.shipDate && h.requiredDate < h.shipDate);
    }

    function refreshDateError() {
      datePickers.forEach(function (fp) {
        if (fp.input.getAttribute("data-date") === "requiredDate" && fp.altInput) {
          fp.altInput.classList.toggle("fop-input--err", dateErrorOn());
        }
      });
    }

    // "2026-10-20" (also 2026/10/20 or 2026-10-2) → Date, else null.
    function isoDateOnly(s) {
      var m = /^\s*(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\s*$/.exec(s || "");
      if (!m) return null;
      var d = new Date(+m[1], +m[2] - 1, +m[3]);
      return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
    }

    // Flatpickr parseDate for one picker: typed YYYY-MM-DD first, then the
    // given format ("M j, Y" for the visible field, "Y-m-d" for state). The
    // static flatpickr.parseDate has no config, so this isn't called again.
    // Typed text (read with altFormat) that isn't a date, or is outside the
    // allowed range, keeps the current date instead of clearing it (an empty
    // field still clears). Internal parses (minDate, setDate) use dateFormat.
    function typedDateParser(getFp) {
      return function (str, format) {
        var d = isoDateOnly(str) || window.flatpickr.parseDate(str, format);
        var fp = getFp();
        var typed = fp && fp.config && format === fp.config.altFormat;
        if (typed && (!d || !fp.isEnabled(d))) return fp.selectedDates[0];
        return d || undefined;
      };
    }

    // Phone width (the styles.css breakpoint) or a touch screen without
    // hover: date fields can't be typed in and keep "Oct 26, 2026".
    function phoneDates() {
      return !!(window.matchMedia && window.matchMedia("(max-width: 767px), (hover: none) and (pointer: coarse)").matches);
    }

    // While the calendar is open, the visible field shows YYYY-MM-DD
    // (only where it can be typed in).
    function showIso(fp) {
      if (fp && fp.isOpen && fp.altInput && fp.config.allowInput) fp.altInput.value = fp.input.value;
    }

    // Earliest pickable date: today (ship date) or the ship date (required
    // date). On a bid a date already in the past stays pickable, because
    // flatpickr clears a selected date that falls below minDate.
    function dateMin(key) {
      var h = state.header;
      var min = key === "requiredDate" && h.shipDate ? h.shipDate : isoDate(0);
      if (state.existing && h[key] && h[key] < min) min = h[key];
      return min;
    }

    function initDatePickers() {
      datePickers.forEach(function (fp) { fp.destroy(); });
      datePickers = [];
      if (!window.flatpickr || state.view !== "order") return;
      var els = root.querySelectorAll(".fop-date");
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          var key = el.getAttribute("data-date");
          var locked = headLocked(key);
          var fp = window.flatpickr(el, {
            dateFormat: "Y-m-d",           // state + create-order keep YYYY-MM-DD
            altInput: true,
            altFormat: "M j, Y",           // "Oct 26, 2026"
            altInputClass: "fop-input fop-date-alt",
            defaultDate: state.header[key] || undefined,
            // A locked order's dates can be in the past. Required date cannot
            // be before the ship date.
            minDate: locked ? null : dateMin(key),
            clickOpens: !locked,
            disableMobile: true,           // keep the themed calendar on phones
            // The field can be typed in. While the calendar is open it shows
            // YYYY-MM-DD (onOpen / onValueUpdate below); typed text is read
            // on Enter or blur by typedDateParser(). Not on phones or touch
            // tablets (on request): there the field stays a plain tap-to-open
            // "Oct 26, 2026", with no keyboard.
            allowInput: !phoneDates(),
            parseDate: typedDateParser(function () { return fp; }),
            onChange: function (_dates, dateStr) {
              state.header[key] = dateStr;
              if (key === "shipDate" && !headLocked("requiredDate")) {
                datePickers.forEach(function (p) {
                  if (p.input.getAttribute("data-date") === "requiredDate") p.set("minDate", dateStr || "today");
                });
              }
              refreshDateError();
              refreshTotals();
            },
            // Opening Required date while it is before Ship date moves it to
            // the ship date (selected, so closing keeps it).
            onOpen: function () {
              var h = state.header;
              if (key === "requiredDate" && h.shipDate && (!h.requiredDate || h.requiredDate < h.shipDate)) {
                fp.setDate(h.shipDate, true);
              }
              showIso(fp);
              // Selected, so typing replaces the date.
              if (fp.altInput && fp.config.allowInput && document.activeElement === fp.altInput) fp.altInput.select();
            },
            onValueUpdate: function () { showIso(fp); },
            // Back to "Oct 26, 2026" once closed (an unparseable entry
            // falls back to the selected date).
            onClose: function () {
              if (fp.altInput) fp.altInput.value = fp.selectedDates.length ? fp.formatDate(fp.selectedDates[0], fp.config.altFormat) : "";
            },
          });
          // Typing a full YYYY-MM-DD moves the calendar to that month.
          if (fp.altInput) fp.altInput.addEventListener("input", function () {
            var d = isoDateOnly(fp.altInput.value);
            if (d && fp.isOpen) fp.jumpToDate(d);
          });
          if (fp.altInput) fp.altInput.setAttribute("aria-label", key === "shipDate" ? "Ship date" : "Required date");
          if (fp.altInput && locked) fp.altInput.disabled = true;
          datePickers.push(fp);
        })(els[i]);
      }
      refreshDateError();
    }

    function afterRender() {
      initDatePickers();
      showAllQty();
      // Empty header values read "--" (HubSpot's empty property). After the
      // date pickers, whose visible inputs are created there.
      var heads = root.querySelectorAll(".fop-head input.fop-input:not([placeholder]), .fop-head textarea.fop-input:not([placeholder])");
      for (var hp = 0; hp < heads.length; hp++) heads[hp].placeholder = "--";
      // A locked select with no value (e.g. no ship via) shows "--" too.
      var hsel = root.querySelectorAll(".fop-head select.fop-input:disabled");
      for (var hs = 0; hs < hsel.length; hs++) {
        var opt = hsel[hs].options[hsel[hs].selectedIndex];
        if (opt && !opt.text.trim()) opt.text = "--";
      }
      var notes = root.querySelectorAll(".fop-notes");
      for (var n = 0; n < notes.length; n++) autosize(notes[n]);
      autosizeNotesPair();
      // Inline line comment: only the shown one (a hidden box measures 0).
      var lcs = root.querySelectorAll("[data-comment]");
      for (var k = 0; k < lcs.length; k++) if (!lcs[k].closest("[hidden]")) autosize(lcs[k]);
      if (state.view === "customer") {
        var cs = root.querySelector("#fop-customer-search");
        if (cs) cs.focus();
      } else if (state.view === "orders") {
        var nb0 = root.querySelector("[data-action=new-from-list]");
        if (nb0) nb0.focus();
      } else if (state.view === "shipto") {
        var first = root.querySelector("[data-shipto]");
        if (first) first.focus();
      } else if (state.view === "order") {
        if (state.quoteModal) {
          fitQuoteFrame();
          // The email box (no scroll, so the quote shows from its top). Not on
          // touch screens: the keyboard would cover the quote on open.
          var qin = root.querySelector("#fop-quote-email");
          if (qin && !(window.matchMedia && window.matchMedia("(hover: none)").matches)) qin.focus({ preventScroll: true });
        } else if (state.logModal) {
          var lc = root.querySelector("[data-action=close-log]");
          // Close sits below the log: no scroll, so the log opens at the top.
          if (lc) lc.focus({ preventScroll: true });
        } else if (state.cancelAsk) {
          // Default to the safe choice.
          var keep = root.querySelector("[data-action=keep-order]");
          if (keep) keep.focus();
        } else if (state.confirm) {
          var ok = root.querySelector("#fop-confirm-status") || root.querySelector("[data-action=confirm-place]");
          if (ok) ok.focus();
        } else if (state.customModal) {
          // First field with an error, else the name.
          var errKey = ["name", "qty", "price", "cogs", "variationSku"].filter(function (k) { return state.customModal.errors[k]; })[0];
          var cfEl = root.querySelector("#fop-cf-" + (errKey || "name"));
          if (cfEl) { cfEl.focus(); if (errKey) cfEl.select(); }
        } else if (state.detailsModal) {
          // Qty (selected), else Close on a read-only order.
          var dc = root.querySelector("#fop-details-comment");
          if (dc) autosize(dc);
          var dq = root.querySelector("#fop-dm-qty:not([readonly])");
          if (dq) { dq.focus(); dq.select(); }
          else { var dx = root.querySelector("[data-action=close-details]"); if (dx) dx.focus(); }
        } else if (state.focus.r >= 0) {
          focusCell(state.focus.r, state.focus.c);
        }
      } else if (state.view === "done") {
        var nb = root.querySelector("[data-action=new-order]");
        if (nb) nb.focus();
      }
      syncBarSpace();
    }

    function titleHtml(kicker, title) {
      return '<div class="fop-kicker">' + esc(kicker) + '</div><h1 class="fop-h1">' + esc(title) + "</h1>";
    }

    function viewLoading(msg) {
      return '<div class="fop-center"><div class="fop-spinner"></div><div>' + esc(msg) + "</div></div>";
    }

    function viewError() {
      return (
        '<div class="fop-wrap">' + titleHtml("Order Placement", "Something went wrong") +
        '<div class="fop-alert fop-alert--error">' + esc(state.error || "Unknown error") + "</div>" +
        '<div class="fop-row">' +
        (state.orderId ? '<button class="fop-btn" data-action="retry-order">Retry</button>'
          : state.customerId ? '<button class="fop-btn" data-action="retry-customer">Retry</button>' : "") +
        '<button class="fop-btn fop-btn--ghost" data-action="change-customer">Choose another customer</button>' +
        "</div></div>"
      );
    }

    function viewCustomerSearch() {
      return (
        '<div class="fop-wrap fop-wrap--narrow">' + titleHtml("Order Placement", "Choose a customer") +
        '<div class="fop-card">' +
        '<label class="fop-label" for="fop-customer-search">Customer name or Eclipse ID</label>' +
        '<div class="fop-ac">' +
        '<input id="fop-customer-search" class="fop-input" autocomplete="off" spellcheck="false" ' +
        'placeholder="Type at least 2 characters…" role="combobox" aria-expanded="false" aria-controls="fop-customer-list">' +
        '<div class="fop-ac__list" id="fop-customer-list" role="listbox"></div>' +
        "</div>" +
        '<div class="fop-hint">↑ ↓ to move, Enter to pick. Prefix with a dot (.12345) to search by ID.</div>' +
        "</div></div>"
      );
    }

    // Bill-to and ship-to side by side, each with its Eclipse address. The
    // Eclipse id sits in a tile top right (after topExtra, e.g. the ship-to's
    // "Change" link); nameExtra (the bill-to's price level) follows the name.
    function partyHtml(label, p, nameExtra, topExtra, corner) {
      if (!p) return "";
      var lines = p.address_lines || [];
      return (
        '<div class="fop-party">' +
        '<div class="fop-party__top"><span class="fop-party__lbl">' + esc(label) + "</span>" +
        '<span class="fop-party__topr">' + (topExtra || "") + '<span class="fop-badge" title="Eclipse customer id">' + esc(p.e_customer_id) + "</span></span></div>" +
        '<div class="fop-party__name">' + esc(p.name) + (nameExtra ? " " + nameExtra : "") + "</div>" +
        '<div class="fop-party__body"><div class="fop-party__addr">' +
        (lines.length
          ? lines.map(function (l) { return "<div>" + esc(l) + "</div>"; }).join("")
          : '<span class="fop-muted">' + (p.missing ? "Not found in Eclipse" : "No address on file") + "</span>") +
        "</div>" + (corner || "") + "</div></div>"
      );
    }

    // Bottom-right of the Ship to card: the ship-to's own Eclipse home branch.
    function homeBranchHtml(st) {
      var id = st && branchIdOf(st.home_branch);
      if (!id) return "";
      var known = BRANCHES.filter(function (b) { return b[0] === id; })[0];
      return '<div class="fop-party__corner"><span class="fop-party__lbl2">Home branch</span>' +
        '<span class="fop-party__amt">' + esc(id + (known ? " - " + known[1] : "")) + "</span></div>";
    }

    // Bottom-right of the Bill to card: Eclipse defaultTerms (terms_code)
    // left of creditLimit ({ value, currency }), bottoms aligned.
    function creditHtml(bt) {
      var items = [];
      if (bt && bt.terms_code) {
        items.push('<div class="fop-party__corner"><span class="fop-party__lbl2">Terms</span>' +
          '<span class="fop-party__amt">' + esc(bt.terms_code) + "</span></div>");
      }
      var cl = bt && bt.credit_limit;
      if (cl && cl.value != null && isFinite(cl.value)) {
        var whole = Math.round(cl.value) === cl.value;
        var amt = whole ? "$" + String(cl.value).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : money(cl.value);
        items.push('<div class="fop-party__corner"><span class="fop-party__lbl2">Credit limit</span>' +
          '<span class="fop-party__amt">' + amt + (cl.currency && cl.currency !== "USD" ? " " + esc(cl.currency) : "") + "</span></div>");
      }
      return items.length > 1 ? '<div class="fop-party__corners">' + items.join("") + "</div>" : items.join("");
    }

    function customerSummaryHtml() {
      var c = state.customer || {};
      var bt = c.bill_to || {};
      // Orders list with no picked ship-to: a customer with exactly one
      // ship-to (often the bill-to shipping to itself) shows it too
      // (2026-10-19, on request). Display only; the list is not filtered.
      var only = (c.ship_tos || []).length === 1 ? c.ship_tos[0] : null;
      var st = state.shipTo || (state.view === "orders" ? only : null);
      // Prices are quoted against the bill-to, so its price class is the
      // level the rep is selling at.
      var level = '<span class="fop-level" title="Price level">' + esc(bt.price_class || "Price level unknown") + "</span>";
      var change = st && (c.ship_tos || []).length > 1 && state.view === "order" && !state.existing
        ? '<button class="fop-linkbtn" data-action="change-shipto">Change</button>' : "";
      return (
        '<div class="fop-parties">' +
        partyHtml("Bill to", bt, level, "", creditHtml(bt)) +
        (st ? partyHtml("Ship to", st, "", change, homeBranchHtml(st)) : "") +
        "</div>"
      );
    }

    // Home branch on the right of each ship-to in the picker (spans, since
    // it sits inside a <button>).
    function pickBranchHtml(st) {
      var id = branchIdOf(st && st.home_branch);
      if (!id) return "";
      var known = BRANCHES.filter(function (b) { return b[0] === id; })[0];
      return '<span class="fop-pick__branch"><span class="fop-party__lbl2">Home branch</span>' +
        '<span class="fop-party__amt">' + esc(id + (known ? " - " + known[1] : "")) + "</span></span>";
    }

    // Step 2: the customer's orders (customer-orders on the bill-to) and a
    // "New order" button. A picked ship-to filters the list to its orders;
    // "Show orders from other ShipTos" (unchecked by default) lists the
    // whole bill-to's.
    function viewOrders() {
      var st = pickedShipTo();
      var filter = st && state.ordersShipToOnly ? st.e_customer_id : null;
      return (
        '<div class="fop-wrap fop-wrap--narrow fop-wrap--orders">' +
        '<div class="fop-top"><div>' + titleHtml("Order Placement", "Orders") + "</div>" +
        '<div class="fop-row">' +
        '<button class="fop-btn fop-btn--ghost fop-btn--sm" data-action="change-customer">Change customer</button></div></div>' +
        customerSummaryHtml() +
        '<div class="fop-row">' +
        // Phones: floats fixed in the bottom right of the screen (.fop-fab).
        '<button class="fop-btn fop-fab" data-action="new-from-list">New order <span class="fop-key fop-key--dark">' + altKey("N") + '</span></button>' +
        (st ? '<label class="fop-check"><input type="checkbox" data-action="orders-shipto-only"' + (state.ordersShipToOnly ? "" : " checked") + "> " +
          "Show orders from other ShipTos</label>" : "") +
        "</div>" +
        '<div class="fop-card">' + ordersBodyHtml(filter) +
        '<div class="fop-hint fop-hint--keys">↑ ↓ to move, Enter to open, N for a new order, Esc to change customer.</div>' +
        "</div></div>"
      );
    }

    function viewShipTo() {
      var list = (state.customer.ship_tos || []).map(function (s, i) {
        return (
          '<button class="fop-pick" data-shipto="' + i + '">' +
          '<span class="fop-pick__num">' + (i < 9 ? i + 1 : "") + "</span>" +
          '<span class="fop-pick__main"><b>' + esc(s.name) + '</b> <span class="fop-badge">' + esc(s.e_customer_id) + "</span>" +
          ((s.address_lines || []).length ? '<span class="fop-muted fop-block">' + (s.address_lines || []).map(esc).join("<br>") + "</span>" : "") +
          "</span>" + pickBranchHtml(s) + "</button>"
        );
      }).join("");
      return (
        '<div class="fop-wrap fop-wrap--narrow">' + titleHtml("Order Placement", "Choose a ship-to") +
        customerSummaryHtml() +
        '<div class="fop-card"><div class="fop-picklist" role="listbox">' +
        (list || '<div class="fop-muted">No ship-tos on this bill-to.</div>') +
        "</div>" +
        '<div class="fop-hint fop-hint--keys">↑ ↓ to move, Enter or 1–9 to pick, Esc to ' + (state.keepOrder ? "go back to the order" : "go back to the orders") + ".</div>" +
        "</div></div>"
      );
    }

    // Header inputs are disabled on an existing order, except a bid's
    // shipping fields (headLocked(key)).
    function lockAttr(key) { return headLocked(key) ? " disabled" : ""; }

    function selectHtml(field, options, value, placeholder, groups) {
      var html = '<select class="fop-input" data-head="' + field + '" id="fop-h-' + field + '"' + lockAttr(field) + ">";
      // Placeholder only while nothing is picked (both selects are required).
      // A locked field (existing order) shows a blank box, not "Select…".
      if (placeholder && !value) html += '<option value="" selected disabled>' + (headLocked(field) ? "" : esc(placeholder)) + "</option>";
      var opt = function (o) {
        return '<option value="' + esc(o[1]) + '"' + (String(o[1]) === String(value) ? " selected" : "") + ">" + esc(o[0]) + "</option>";
      };
      if (groups) {
        html += '<optgroup label="Common">' + options.slice(0, groups).map(opt).join("") + "</optgroup>";
        html += '<optgroup label="All">' + options.slice(groups).map(opt).join("") + "</optgroup>";
      } else {
        html += options.map(opt).join("");
      }
      // Keep an unknown current value (e.g. a customer default not in the list).
      var known = options.some(function (o) { return String(o[1]) === String(value); });
      if (value && !known) html += '<option value="' + esc(value) + '" selected>' + esc(value) + "</option>";
      return html + "</select>";
    }

    function field(label, inner, cls) {
      return '<div class="fop-field ' + (cls || "") + '"><label class="fop-label">' + esc(label) + "</label>" + inner + "</div>";
    }

    // Miles from the ship-to to branch id, or null (no ship-to coordinates,
    // or a branch with none).
    function shipToMiles(id) {
      var st = state.shipTo || {};
      var c = BRANCH_COORDS[id];
      if (st.latitude == null || st.longitude == null || !c) return null;
      return milesBetween(st.latitude, st.longitude, c[0], c[1]);
    }

    // Sort {id} rows closest to the ship-to first; branches with no distance
    // (and every branch, without ship-to coordinates) follow in
    // branch-number order.
    function byShipToDistance(a, b) {
      var ma = shipToMiles(a.id), mb = shipToMiles(b.id);
      if (ma != null || mb != null) return (ma == null ? 1e9 : ma) - (mb == null ? 1e9 : mb);
      return (Number(a.id) || 999) - (Number(b.id) || 999);
    }

    // Ship branch options with distance from the ship-to, closest first.
    // Without ship-to coordinates the list keeps branch-number order.
    function branchOptions() {
      var list = BRANCHES.map(function (b) {
        return { id: b[0], name: b[1], mi: shipToMiles(b[0]) };
      });
      list.sort(byShipToDistance);
      return list.map(function (b) {
        return [b.id + " - " + b.name + (b.mi != null ? " · " + Math.round(b.mi).toLocaleString("en-US") + " mi" : ""), b.id];
      });
    }

    // Under Ship branch while the lines ship from more than one branch.
    function branchHintHtml() {
      if (linesLocked()) return "";
      var bs = orderBranches();
      if (bs.length < 2) return "";
      return "Lines ship from branches " + esc(bs.join(", ")) + ": one generation per branch.";
    }

    // "2026-04-16" → "Apr 16, 2026" (same look as the date pickers).
    function dateText(ymd) {
      var m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return ymd || "";
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }

    // "2026-04-28T01:00:11Z" → "Apr 27, 2026, 8:00 PM CDT" in the browser's
    // time zone, with its short name (outside the US this can be "GMT+1").
    function dateTimeText(iso) {
      var d = new Date(iso);
      if (!iso || isNaN(d)) return iso || "";
      return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    }

    // Existing orders that are not bids also show writer, outside sales,
    // inside sales, order date and print status, in that order (read-only,
    // from e-order-placement/order). Print status is Eclipse's one-letter
    // code as stored.
    // Top right of the header, read-only: an existing order's own price
    // branch, else the bill-to's Eclipse home branch, which create-order uses
    // as the price branch (the page never sends one).
    function priceBranchField() {
      var bt = (state.customer && state.customer.bill_to) || {};
      var id = branchIdOf(state.existing ? state.existing.price_branch : bt.home_branch);
      var known = BRANCHES.filter(function (b) { return b[0] === id; })[0];
      var text = id ? id + (known ? " - " + known[1] : "") : "";
      return field("Price branch", '<input class="fop-input" value="' + esc(text) + '" disabled>', "fop-field--end");
    }

    // Read-only order info for an existing order that is not a bid; "" on a
    // new order or a bid. cls is extra field classes (row start).
    function orderInfoField(key, cls) {
      var ex = state.existing;
      if (!ex || ex.editable) return "";
      var info = {
        writer: ["Writer", ex.writer], outsideSales: ["Outside sales", ex.outside_sales],
        insideSales: ["Inside sales", ex.inside_sales],
        printStatus: ["Print status", ex.print_status],
      }[key];
      return field(info[0], '<input class="fop-input" value="' + esc(info[1] || "") + '" disabled>', cls);
    }

    // Writer, read-only on every order: the signed-in rep on a new order,
    // the order's own writer on an existing one.
    function writerField() {
      var v = state.existing ? state.existing.writer : user.e_user_id;
      return field("Writer", '<input class="fop-input" value="' + esc(v || "") + '" disabled>', "fop-field--row");
    }

    // Outside sales: a dropdown on a new order or a bid (outsideSalesOptions(),
    // defaulting to the rep's default territory); read-only on other orders.
    function outsideSalesField() {
      if (linesLocked()) return orderInfoField("outsideSales");
      return field("Outside sales", selectHtml("outsideSales", outsideSalesOptions(), state.header.outsideSales, "Select…"));
    }

    function poField(cls) {
      var h = state.header;
      return field("Customer P/O #", '<input class="fop-input" data-head="po" maxlength="30" value="' + esc(h.po) + '"' + lockAttr("po") + ">", cls);
    }

    // Page header links (paintHeader()). The bill-to's HubSpot company
    // (hs_id from e-order-placement/customer), on new and existing orders
    // alike.
    function customerLinkHtml() {
      var bt = state.customer && state.customer.bill_to;
      if (!bt || !bt.hs_id) return "";
      return '<a class="fop-header__link" href="' + HS_COMPANY + encodeURIComponent(bt.hs_id) + '" target="_blank" rel="noopener"' +
        ' title="' + esc(bt.name + " (" + bt.e_customer_id + ")") + '">HS Customer ' + EXT_ICON + "</a>";
    }

    // Existing order: the open generation's HubSpot deal (order-lookup reads
    // every generation's deal in one Batch Read on e_sorder_id).
    function dealLinkHtml() {
      var id = state.existing && state.existing.hs_deal_id;
      if (!id) return "";
      return '<a class="fop-header__link" href="' + HS_DEAL + encodeURIComponent(id) + '" target="_blank" rel="noopener"' +
        (state.existing.hs_deal_name ? ' title="' + esc(state.existing.hs_deal_name) + '"' : "") + ">HS Deal " + EXT_ICON + "</a>";
    }

    // Escaped text with every http(s) URL turned into a link (new tab).
    // Only http:// and https:// match, so nothing else becomes clickable;
    // trailing punctuation stays outside the link.
    function linkifyText(text) {
      return esc(text).replace(/https?:\/\/[^\s<"']+/gi, function (url) {
        var tail = url.match(/[).,;:!?]+$/);
        var core = tail ? url.slice(0, -tail[0].length) : url;
        return '<a href="' + core + '" target="_blank" rel="noopener noreferrer">' + core + "</a>" + (tail ? tail[0] : "");
      });
    }

    // HubSpot Tracking Details (delivery_details) is one block per package,
    // separated by a dashed line (" - - - - -"):
    //   Status: On the Way / Pickup Date: 2026-10-16 / Delivery Date: 2026-10-21 /
    //   https://www.ups.com/track?tracknum=1Z… / Recent Update: / Departed from Facility (2026-10-17)
    // Returns [{ status, pickup, delivery, url, tracking, update, updateDate, extra[] }],
    // or null when nothing in it looks like a package (the raw text is shown then).
    function parseTracking(text) {
      var blocks = String(text || "").split(/^\s*-(?:\s*-)+\s*$/m);
      var pkgs = blocks.map(function (b) {
        var pkg = { status: "", pickup: "", delivery: "", url: "", tracking: "", update: "", updateDate: "", extra: [] };
        var lines = b.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
        for (var i = 0; i < lines.length; i++) {
          var l = lines[i], m;
          if ((m = l.match(/^status\s*:\s*(.*)$/i))) pkg.status = m[1];
          else if ((m = l.match(/^pickup date\s*:\s*(.*)$/i))) pkg.pickup = m[1];
          else if ((m = l.match(/^delivery date\s*:\s*(.*)$/i))) pkg.delivery = m[1];
          else if ((m = l.match(/^recent update\s*:\s*(.*)$/i))) {
            // The update is usually on the next line ("Recent Update:" then the text).
            pkg.update = m[1] || (lines[i + 1] && !/^[a-z ]+:/i.test(lines[i + 1]) ? lines[++i] : "");
          } else if (/^https?:\/\/\S+$/i.test(l) && !pkg.url) pkg.url = l;
          else pkg.extra.push(l);
        }
        var d = pkg.update.match(/^(.*?)\s*\((\d{4}-\d{2}-\d{2})\)\s*$/);
        if (d) { pkg.update = d[1]; pkg.updateDate = d[2]; }
        if (pkg.url) {
          var t = pkg.url.match(/[?&](?:tracknum|tracknumbers?|trknbr|tLabels)=([^&#]+)/i);
          pkg.tracking = t ? decodeURIComponent(t[1]) : "";
        }
        return pkg;
      }).filter(function (p) { return p.status || p.url || p.pickup || p.delivery || p.update || p.extra.length; });
      var parsed = pkgs.filter(function (p) { return p.status || p.url || p.delivery; }).length;
      return pkgs.length && parsed ? pkgs : null;
    }

    function isDelivered(st) { return /deliver(ed|y complete)/i.test(st) && !/out for/i.test(st); }

    function pkgStatusClass(st) {
      return isDelivered(st) ? "fop-status--invoice"
        : /exception|delay|return|fail|cancel/i.test(st) ? "fop-status--cancel" : "";
    }

    function tdate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v) ? dateText(v) : v; }

    function trackingPackagesHtml(pkgs) {
      var uniq = function (k) { return pkgs.map(function (p) { return p[k]; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }); };
      var statuses = uniq("status"), deliveries = uniq("delivery");
      var sum = [pkgs.length + (pkgs.length === 1 ? " package" : " packages")];
      // One status: "On the Way"; several: "2 On the Way, 1 Delivered".
      if (statuses.length === 1) sum.push(statuses[0]);
      else if (statuses.length > 1) sum.push(statuses.map(function (st) {
        return pkgs.filter(function (p) { return p.status === st; }).length + " " + st;
      }).join(", "));
      if (deliveries.length === 1) sum.push("Delivery " + tdate(deliveries[0]));
      return '<div class="fop-pkgs">' +
        '<div class="fop-pkgs__sum">' + sum.map(esc).join(" · ") + "</div>" +
        '<div class="fop-pkgs__grid">' + pkgs.map(function (p, i) {
          var row = function (label, v) { return v ? "<dt>" + esc(label) + "</dt><dd>" + esc(v) + "</dd>" : ""; };
          var trk = p.url
            ? '<a class="fop-pkg__trk" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(p.url) + '">' +
              esc(p.tracking || "Track package") + EXT_ICON + "</a>"
            : "";
          return '<div class="fop-pkg">' +
            '<div class="fop-pkg__top"><span class="fop-pkg__n">Package ' + (i + 1) + (pkgs.length > 1 ? " of " + pkgs.length : "") + "</span>" +
            (p.status ? '<span class="fop-status fop-status--sm ' + pkgStatusClass(p.status) + '">' + esc(p.status) + "</span>" : "") + "</div>" +
            trk +
            '<dl class="fop-pkg__dates">' + row("Pickup", tdate(p.pickup)) + row("Delivery", tdate(p.delivery)) + "</dl>" +
            // A delivered package skips "Latest" (it only repeats DELIVERED and the date).
            (p.update && !isDelivered(p.status) && !isDelivered(p.update) ? '<div class="fop-pkg__upd"><span class="fop-pkg__lbl">Latest</span> ' + esc(p.update) +
              (p.updateDate ? ' <span class="fop-muted">· ' + esc(tdate(p.updateDate)) + "</span>" : "") + "</div>" : "") +
            (p.extra.length ? '<div class="fop-pkg__extra">' + p.extra.map(linkifyText).join("<br>") + "</div>" : "") +
            "</div>";
        }).join("") + "</div></div>";
    }

    // Row under the notes on an existing order: HubSpot's Tracking Details
    // (delivery_details), read-only, full width: a summary and one card per
    // package (parseTracking). Text that doesn't parse is shown as written
    // with its links clickable. It replaced a separate Tracking link field
    // (HubSpot delivery_tracking_link), since the details carry every link.
    function trackingHtml() {
      var ex = state.existing;
      if (!ex) return "";
      var text = String(ex.tracking_details || "").replace(/\s+$/, "");
      // No tracking in HubSpot: no row at all (on request).
      if (!text) return "";
      var pkgs = parseTracking(text);
      var inner = pkgs ? trackingPackagesHtml(pkgs)
        : '<div class="fop-input fop-linkbox fop-trackbox">' + linkifyText(text) + "</div>";
      return field("Tracking details", inner, "fop-field--full");
    }

    function headerHtml() {
      var h = state.header;
      var branches = branchOptions();
      return (
        // Always open (no longer collapsible, on request).
        '<section class="fop-head' + (headLocked() ? " fop-head--locked" : "") + '" id="fop-head" aria-labelledby="fop-head-title">' +
        '<div class="fop-head__sum" id="fop-head-title">Header</div>' +
        // Rows of up to three (user's order); fop-field--row starts a new row.
        // Writer and outside sales show on every order; inside sales and
        // print status only on an existing order that is not a bid.
        '<div class="fop-head__grid">' +
        // Phones: ship via and ship branch each take a full row (--mfull).
        field("Ship via", selectHtml("shipVia", SHIP_VIAS, h.shipVia, "Select…", COMMON_SHIP_VIAS), "fop-field--row fop-field--mfull") +
        // Lines on several branches: the hint under it says so (it is the
        // branch of the lines that follow the header).
        field("Ship branch", selectHtml("shipBranch", branches, h.shipBranch, "Select…") +
          '<span class="fop-branch-hint" data-cell="branch-hint">' + branchHintHtml() + "</span>", "fop-field--mfull") +
        priceBranchField() +
        // Flatpickr calendars (initDatePickers) replace these plain inputs.
        field("Ship date", '<input class="fop-input fop-date" data-date="shipDate" value="' + esc(h.shipDate) + '"' + lockAttr("shipDate") + ">", "fop-field--row") +
        field("Required date", '<input class="fop-input fop-date" data-date="requiredDate" value="' + esc(h.requiredDate) + '"' + lockAttr("requiredDate") + ">") +
        // Order date is never editable: the order's own, or today on a new
        // order (Eclipse dates it when it is created).
        field("Order date", '<input class="fop-input" value="' + esc(dateText(state.existing ? state.existing.order_date : isoDate(0))) + '" disabled>') +
        writerField() + outsideSalesField() + orderInfoField("insideSales") +
        // A new order or a bid: P/O ends the writer row and release is hidden
        // (a new order still sends the bill-to's default release). Other
        // orders: P/O, release and print status on their own row.
        poField(linesLocked() ? "fop-field--row" : "") +
        (linesLocked() ? field("Customer release #", '<input class="fop-input" data-head="release" maxlength="30" value="' + esc(h.release) + '"' + lockAttr("release") + ">") : "") +
        orderInfoField("printStatus") +
        // Bottom row: shipping instructions left, internal notes right.
        // Multi-line notes; textareas grow with their content (autosize()).
        field("Shipping instructions", '<textarea class="fop-input fop-notes" rows="1" data-head="shippingInstructions"' + lockAttr("shippingInstructions") + ">" + esc(h.shippingInstructions) + "</textarea>", "fop-field--half") +
        field("Internal notes (no credit cards)", '<textarea class="fop-input fop-notes" rows="1" data-head="internalNotes"' + lockAttr("internalNotes") + ">" + esc(h.internalNotes) + "</textarea>", "fop-field--half") +
        trackingHtml() +
        "</div></section>"
      );
    }

    function lineRowHtml(line, r) {
      // A non-bid existing order shows its lines read-only (arrows still move).
      var ro = linesLocked() ? " readonly" : "";
      var edited = line.priceOverride && !line.keepPrice;
      return (
        '<div class="fop-line' + (r % 2 ? " fop-line--alt" : "") + (ro ? " fop-line--ro" : "") + '" data-row="' + r + '" role="row">' +
        '<div class="fop-cell fop-cell--num" role="cell">' + (r + 1) + "</div>" +
        '<div class="fop-cell fop-cell--product' + (!ro && line.productId ? " fop-cell--tiled" : "") + '" role="cell">' +
        '<label class="fop-mlabel">Product</label>' +
        // An editable line with a product shows its id as a tile (like the
        // customer id tiles); a click, or focus reaching the box (arrows,
        // Tab), turns it back into the product box (tileProduct).
        (ro ? "" : '<button type="button" class="fop-badge fop-pid" tabindex="-1" data-action="edit-product" data-r="' + r + '" ' +
          'title="Change product" aria-label="Change product, line ' + (r + 1) + '">' + esc(pidText(line)) + "</button>") +
        '<div class="fop-ac">' +
        '<input class="fop-input fop-grid-in" data-r="' + r + '" data-c="0" autocomplete="off" spellcheck="false" ' +
        'placeholder="' + (ro ? "" : "Search…") + '" value="' + esc(ro ? pidText(line) : line.productId) + '" aria-label="Product, line ' + (r + 1) + '"' + ro + ">" +
        '<div class="fop-ac__list" role="listbox"></div></div>' +
        // Phones: a read-only line shows its product id in a tile top right
        // instead of the (read-only) product box.
        (ro && line.productId ? '<span class="fop-badge fop-line__id">' + esc(pidText(line)) + "</span>" : "") +
        "</div>" +
        '<div class="fop-cell fop-cell--desc" role="cell" data-cell="desc">' + descHtml(line) + "</div>" +
        '<div class="fop-cell fop-cell--qty" role="cell">' +
        '<label class="fop-mlabel">Qty</label>' +
        '<div class="fop-qty">' +
        (ro ? "" : '<button class="fop-step" tabindex="-1" data-action="qty-dec" data-r="' + r + '" aria-label="Decrease">−</button>') +
        // The box holds the bare number; showQty lays "50 ft" over it
        // (unit in grey) while it is not focused.
        '<span class="fop-qty__box">' +
        '<input class="fop-input fop-grid-in fop-num" data-r="' + r + '" data-c="1" inputmode="numeric" ' +
        'value="' + esc(line.qty) + '" aria-label="Quantity, line ' + (r + 1) + '"' + ro + ">" +
        '<span class="fop-qty__show" aria-hidden="true"></span></span>' +
        (ro ? "" : '<button class="fop-step" tabindex="-1" data-action="qty-inc" data-r="' + r + '" aria-label="Increase">+</button>') +
        "</div></div>" +
        '<div class="fop-cell fop-cell--price" role="cell">' +
        '<label class="fop-mlabel">Unit price</label>' +
        '<input class="fop-input fop-grid-in fop-num' + (edited ? " fop-input--override" : "") + '" data-r="' + r + '" data-c="2" ' +
        'inputmode="decimal" value="' + esc(priceText(line)) + '" aria-label="Unit price, line ' + (r + 1) + '"' + ro + ">" +
        "</div>" +
        '<div class="fop-cell fop-cell--cost fop-num" role="cell" data-cell="cost">' + costHtml(line) + "</div>" +
        '<div class="fop-cell fop-cell--ext fop-num" role="cell" data-cell="ext">' + extHtml(line) + "</div>" +
        // No stock columns at all on an invoiced / cancelled order.
        (noStock() ? "" : '<div class="fop-cell fop-cell--stock fop-num" role="cell" data-cell="avail">' + availHtml(line) + "</div>" +
          (inlineLayout ? '<div class="fop-cell fop-cell--stock fop-num" role="cell" data-cell="total">' + totalStockHtml(line) + "</div>" : "")) +
        '<div class="fop-cell fop-cell--del" role="cell">' +
        (detailsLayout ? '<span data-cell="details-btn">' + detailsBtnHtml(line, r) + "</span>" : "") +
        (ro ? "" : '<button class="fop-icon-btn" tabindex="-1" data-action="remove-line" data-r="' + r + '" aria-label="Remove line ' + (r + 1) + '">×</button>') +
        "</div>" +
        (inlineLayout ? inlineStripsHtml(line, r) : "") +
        "</div>"
      );
    }

    // Inline layout: stock, qty breaks and the line comment in one panel
    // under the focused line only (stripShown). The comment box is drawn once
    // here and only shown / hidden afterwards, so typing in it never loses
    // focus to a refresh.
    function stripShown(r) {
      var line = state.lines[r];
      // Invoiced / cancelled: no stock, and their lines take no comment.
      return inlineLayout && r === state.focus.r && !!line && !line.custom && !!line.productId &&
        (!noStock() || commentEditable(line));
    }

    function inlineStripsHtml(line, r) {
      var on = stripShown(r);
      var hid = on ? "" : " hidden";
      var shid = on && !isItemLine(line) ? "" : " hidden";
      var withStock = !noStock();
      return (withStock ? '<div class="fop-stockstrip" data-cell="strip"' + shid + ">" + (on ? stockStripHtml(line, false, r) : "") + "</div>" : "") +
        (withStock ? '<div class="fop-stockstrip" data-cell="breaks"' + shid + ">" + (on ? breaksStripHtml(line) : "") + "</div>" : "") +
        '<div class="fop-stockstrip fop-stockstrip--comment' + (withStock ? "" : " fop-stockstrip--solo") +
        (commentClosed(line) ? " fop-stockstrip--cmt-closed" : "") + '" data-cell="comment"' + hid + ">" +
        commentFieldHtml(line, r, "fop-ic-" + line.key) + "</div>";
    }

    // Line comment box (inline strip and the Line details dialog). Every
    // line of a new order or a bid takes one. On a loaded bid line it is
    // added to the line's Eclipse comments (shown under the description):
    // Eclipse cannot edit a line's comments, so update-bid re-creates the line.
    function commentEditable(line) { return !linesLocked() && !line.custom; }

    // Phones: an empty comment box stays folded behind an "Add line comment"
    // button (CSS shows the button only under 768px; desktop always shows the
    // box). It folds again when left empty.
    function commentClosed(line) { return commentEditable(line) && !(line.comment || "").trim(); }

    function commentFieldHtml(line, r, id, value) {
      var lbl = '<label class="fop-strip__lbl" for="' + id + '">Line comment</label>';
      if (!commentEditable(line)) return lbl + '<span class="fop-muted">Comments can only be added on a new order or a bid.</span>';
      return lbl + '<textarea class="fop-input fop-line-comment" id="' + id + '" data-comment="' + r + '" rows="1" maxlength="500" ' +
        (line.orig ? 'placeholder="Added to this line\'s comments on Update Bid" ' : "") +
        'aria-label="Comment, line ' + (r + 1) + '">' + esc(value != null ? value : line.comment) + "</textarea>" +
        '<button type="button" class="fop-btn fop-btn--ghost fop-btn--sm fop-addcmt" tabindex="-1" data-action="open-comment" data-r="' + r + '">+ Add line comment</button>';
    }

    // Details layout: the button left of the × on a line with a product. It
    // is gold-dotted when the line has a comment.
    function detailsBtnHtml(line, r) {
      if (!line.productId || (noStock() && !commentEditable(line))) return "";
      var has = !!(line.comment && line.comment.trim());
      return '<button class="fop-icon-btn fop-detail-btn' + (has ? " fop-detail-btn--has" : "") + '" tabindex="-1" data-action="open-details" data-r="' + r + '" ' +
        'aria-label="Details, line ' + (r + 1) + (has ? " (has a comment)" : "") + '" title="Inventory, quantity breaks and line comment (' + altKey("D") + ')">' +
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>' +
        "</button>";
    }

    // A custom line, numbered with the others: a Custom tag with the ideal
    // SKU (click to edit), the name with its variation and customizations,
    // and the rep's qty / price / est. COGS. It has no inputs, so the arrow
    // keys skip it (nextGridRow); edited in the Custom line dialog.
    function customRowHtml(cl, r) {
      var sub = [];
      if (cl.variationSku) sub.push("Variation of " + cl.variationSku + (cl.variationDesc ? " " + cl.variationDesc : "") + (cl.serial ? " · SN " + cl.serial : ""));
      if (cl.customizations.length) sub.push(cl.customizations.join(" · "));
      return (
        '<div class="fop-line fop-line--custom' + (r % 2 ? " fop-line--alt" : "") + '" data-custom="' + r + '" role="row">' +
        '<div class="fop-cell fop-cell--num" role="cell">' + (r + 1) + "</div>" +
        '<div class="fop-cell fop-cell--product" role="cell">' +
        '<button class="fop-custom-tag" data-action="edit-custom" data-r="' + r + '" title="Edit custom line">' +
        '<span class="fop-badge">Custom</span>' + (cl.idealSku ? '<span class="fop-custom-tag__sku">' + esc(cl.idealSku) + "</span>" : "") +
        "</button></div>" +
        '<div class="fop-cell fop-cell--desc" role="cell">' + esc(cl.name) +
        (sub.length ? '<span class="fop-muted fop-block">' + esc(sub.join(" · ")) + "</span>" : "") + "</div>" +
        '<div class="fop-cell fop-cell--qty fop-num fop-custom-num" role="cell"><span class="fop-mlabel">Qty </span>' + cl.qty + "</div>" +
        '<div class="fop-cell fop-cell--price fop-num fop-custom-num" role="cell"><span class="fop-mlabel">Unit price </span>' + unitMoney(cl.price) + "</div>" +
        '<div class="fop-cell fop-cell--cost fop-num" role="cell" title="Estimated COGS"><span class="fop-mlabel">Est. COGS </span>' + money(cl.cogs) + "</div>" +
        '<div class="fop-cell fop-cell--ext fop-num" role="cell"><span class="fop-mlabel">Ext. </span>' + money(cl.price * cl.qty) + "</div>" +
        (noStock() ? "" : '<div class="fop-cell fop-cell--stock" role="cell" data-cell="avail"></div>' +
          (inlineLayout ? '<div class="fop-cell fop-cell--stock" role="cell" data-cell="total"></div>' : "")) +
        '<div class="fop-cell fop-cell--del" role="cell">' +
        '<button class="fop-icon-btn" tabindex="-1" data-action="remove-line" data-r="' + r + '" aria-label="Remove line ' + (r + 1) + '">×</button>' +
        "</div></div>"
      );
    }

    // "Custom line" dialog: add or edit one custom line.
    function customModalHtml() {
      var m = state.customModal, d = m.draft, er = m.errors;
      var input = function (key, label, attrs, cls, origCell) {
        return '<div class="fop-field ' + (cls || "") + '"><label class="fop-label" for="fop-cf-' + key + '">' + label + "</label>" +
          '<input class="fop-input' + (er[key] ? " fop-input--err" : "") + '" id="fop-cf-' + key + '" data-cf="' + key + '" autocomplete="off" ' +
          (attrs || "") + ' value="' + esc(d[key]) + '">' +
          (origCell ? '<span class="fop-muted fop-block fop-custom-orig" data-cell="' + origCell + '">' + customOrigHtml(d, key) + "</span>" : "") +
          (er[key] ? '<span class="fop-warn-text fop-block">' + esc(er[key]) + "</span>" : "") + "</div>";
      };
      return (
        '<div class="fop-modal" role="dialog" aria-modal="true" aria-labelledby="fop-custom-title">' +
        '<div class="fop-modal__box">' +
        '<h2 class="fop-h2" id="fop-custom-title">' + (m.r >= 0 ? "Edit custom line " + (m.r + 1) : "Add custom line") + "</h2>" +
        '<div class="fop-custom-form">' +
        // Slider switch (a styled checkbox, so Space and the change events still work).
        // First, so a picked product can fill the name, price and COGS below.
        '<label class="fop-toggle fop-custom-form__wide"><input type="checkbox" role="switch" data-cf="variation"' + (d.variation ? " checked" : "") + ">" +
        '<span class="fop-toggle__track" aria-hidden="true"></span>Variation of an existing product</label>' +
        '<div class="fop-custom-form__wide fop-custom-var" data-cell="custom-var"' + (d.variation ? "" : " hidden") + ">" +
        variationFieldHtml(d, er) +
        input("serial", 'Serial number <span class="fop-muted">(optional)</span>', 'maxlength="60" spellcheck="false"') +
        "</div>" +
        input("name", "Suggested Name", 'maxlength="120"', "fop-custom-form__wide") +
        input("qty", "Quantity", 'inputmode="numeric"') +
        input("price", "Unit price", 'inputmode="decimal" placeholder="0.00"', "", "orig-price") +
        input("cogs", "Unit COGS (estimate)", 'inputmode="decimal" placeholder="0.00"', "", "orig-cogs") +
        '<div class="fop-custom-form__wide fop-custom-margin" data-cell="custom-margin">' + customMarginHtml(d) + "</div>" +
        '<div class="fop-field fop-custom-form__wide"><label class="fop-label" for="fop-cf-customizations">Customizations <span class="fop-muted">(one per line, e.g. 3" rear fill)</span></label>' +
        '<textarea class="fop-input fop-notes" id="fop-cf-customizations" data-cf="customizations" rows="3">' + esc(d.customizations) + "</textarea></div>" +
        "</div>" +
        '<div class="fop-alert fop-alert--info">' + (state.existing ? "Saved to the bid with Update Bid, as Eclipse product 15680 (ITEM:) with these details in its line comment. A bid with unsaved custom lines can't be converted to an order."
          : "An order with custom lines can only be placed as a bid. They go to Eclipse as product 15680 (ITEM:) with these details in the line comment.") + "</div>" +
        '<div class="fop-row fop-row--end">' +
        '<button class="fop-btn fop-btn--ghost" data-action="close-custom">Cancel <span class="fop-key">Esc</span></button>' +
        '<button class="fop-btn" data-action="save-custom"' + (customSaveBlock(d) ? ' aria-disabled="true" title="' + customSaveBlock(d) + '"' : "") + ">" + (m.r >= 0 ? "Save" : "Add line") + ' <span class="fop-key fop-key--dark">Enter</span></button>' +
        "</div></div></div>"
      );
    }

    // Existing SKU: the same product search as the grid's Product cell
    // (acSearch kind "variation"). A picked product shows as one box with a
    // small id tile inside it, before the name (2026-10-22, was the tile
    // beside the box); a click on it, or focus reaching the search box,
    // turns it back into the search box (tileVariation).
    function variationFieldHtml(d, er) {
      var picked = !!(d.variationSku && d.variationDesc);
      return '<div class="fop-field"><label class="fop-label" for="fop-cf-variationSku">Existing product</label>' +
        '<div class="fop-cpick' + (picked ? " fop-cpick--tiled" : "") + '" data-cell="variation-pick">' +
        '<div class="fop-input fop-cpick__name" data-action="edit-variation" data-cell="variation-desc" title="Change product: ' + esc(d.variationDesc) + '">' +
        '<span class="fop-badge fop-cpick__id">' + esc(d.variationSku) + "</span>" +
        '<span class="fop-cpick__txt">' + esc(d.variationDesc) + "</span></div>" +
        '<div class="fop-ac"><input class="fop-input' + (er.variationSku ? " fop-input--err" : "") + '" id="fop-cf-variationSku" data-cf="variationSku" ' +
        'autocomplete="off" spellcheck="false" placeholder="Search…" aria-expanded="false" value="' + esc(d.variationSku) + '">' +
        '<div class="fop-ac__list" role="listbox"></div></div></div>' +
        (er.variationSku ? '<span class="fop-warn-text fop-block">' + esc(er.variationSku) + "</span>" : "") + "</div>";
    }

    // Custom line dialog: on shows the picked product's box (id tile + name)
    // (only while a product is picked), off shows the search box.
    function tileVariation(on) {
      var m = state.customModal;
      var box = root.querySelector('[data-cell="variation-pick"]');
      if (!m || !box) return;
      var d = m.draft;
      box.querySelector(".fop-cpick__id").textContent = d.variationSku;
      box.querySelector(".fop-cpick__txt").textContent = d.variationDesc;
      box.querySelector(".fop-cpick__name").title = "Change product: " + d.variationDesc;
      box.classList.toggle("fop-cpick--tiled", !!(on && d.variationSku && d.variationDesc));
    }

    // The picked product's own unit price (for the dialog's qty) or unit
    // cost, from the product-inquiry lookup, shown under the Unit price and
    // Unit COGS fields of a variation. Empty with no product picked.
    function customOrigHtml(d, key) {
      if (!d.variation || !d.variationDesc || !d.variationSku) return "";
      var q = quoteCache[String(d.variationSku)];
      if (!q || q.loading) return "Original: loading…";
      if (!q.data) return "Original: not available";
      var v = key === "price" ? breakPrice(q.data, Number(d.qty) || 1) : parseFloat(q.data.unit_cost);
      return v != null && isFinite(v) ? "Original: " + money(v) : "Original: not available";
    }

    // Refresh the "Original" hints and fill Name, Unit price and Unit COGS
    // from the picked product where the rep left them blank.
    function refreshCustomOrig() {
      var m = state.customModal;
      if (!m) return;
      var d = m.draft;
      var q = d.variation && d.variationDesc ? quoteCache[String(d.variationSku)] : null;
      if (q && q.data) {
        var fill = { price: breakPrice(q.data, Number(d.qty) || 1), cogs: parseFloat(q.data.unit_cost) };
        Object.keys(fill).forEach(function (k) {
          if (String(d[k]).trim() !== "" || fill[k] == null || !isFinite(fill[k])) return;
          d[k] = String(Math.round(fill[k] * 100) / 100);
          var inp = root.querySelector("#fop-cf-" + k);
          if (inp) inp.value = d[k];
        });
      }
      refreshCustomMargin(d);
      ["price", "cogs"].forEach(function (k) {
        var el = root.querySelector('[data-cell="orig-' + k + '"]');
        if (el) el.textContent = customOrigHtml(d, k);
      });
    }

    // A custom line can't be added while it is priced below its estimated
    // COGS, or while a variation keeps the picked product's own name: Add
    // line / Save is soft-disabled (a click or Enter still runs the
    // validation, which marks the field).
    var BELOW_COGS = "The price is below the estimated COGS.";
    var SAME_NAME = "Change the name: it matches the original product.";
    function customBelowCogs(d) {
      var p = String(d.price).trim(), c = String(d.cogs).trim();
      return p !== "" && c !== "" && isFinite(p) && isFinite(c) && Number(p) < Number(c);
    }
    // Names compare on letters and digits only, ignoring case, so an added
    // space, dot or other punctuation does not count as a change.
    function customSameName(d) {
      if (!d.variation || !d.variationDesc) return false;
      var norm = function (v) { return String(v).toLowerCase().replace(/[^a-z0-9]/g, ""); };
      return norm(d.name) !== "" && norm(d.name) === norm(d.variationDesc);
    }
    function customSaveBlock(d) {
      return customSameName(d) ? SAME_NAME : customBelowCogs(d) ? BELOW_COGS : "";
    }

    // Live ext and margin, and the Add line button's state, after an edit.
    function refreshCustomMargin(d) {
      var mg = root.querySelector('[data-cell="custom-margin"]');
      if (mg) mg.innerHTML = customMarginHtml(d);
      var btn = root.querySelector('[data-action="save-custom"]');
      if (btn) setSoftDisabled(btn, customSaveBlock(d));
      // Fixing the field clears its error from a save attempt.
      var er = state.customModal.errors;
      [["price", BELOW_COGS, customBelowCogs], ["name", SAME_NAME, customSameName]].forEach(function (c) {
        if (er[c[0]] !== c[1] || c[2](d)) return;
        delete er[c[0]];
        var inp = root.querySelector("#fop-cf-" + c[0]);
        if (inp) {
          inp.classList.remove("fop-input--err");
          var msg = inp.parentNode.querySelector(".fop-warn-text");
          if (msg) msg.remove();
        }
      });
    }

    // Live ext and margin under the price fields while the rep types.
    function customMarginHtml(d) {
      var qty = Number(d.qty), price = Number(d.price), cogs = Number(d.cogs);
      if (!(qty > 0) || String(d.price).trim() === "" || !isFinite(price)) return "";
      var out = "Ext. " + money(price * qty);
      if (String(d.cogs).trim() !== "" && isFinite(cogs) && price > 0) {
        var margin = (price - cogs) / price * 100;
        out += " · Margin " + margin.toFixed(1) + "%";
        if (cogs > price) return '<span class="fop-warn-text">' + out + " (price is below the estimated COGS)</span>";
      }
      return '<span class="fop-muted">' + out + "</span>";
    }

    // Quantity breaks for one line, like Eclipse's Quantity Breaks box:
    // break qty and unit price (no extension). The tier the line's
    // qty falls in is outlined in gold.
    function breaksStripHtml(line) {
      var q = quoteOf(line);
      if (!q || q.loading) return '<span class="fop-strip__lbl">Quantity breaks</span><span class="fop-dots">···</span>';
      if (q.error) return '<span class="fop-strip__lbl">Quantity breaks</span><span class="fop-warn-text">' + esc(q.error) + "</span>";
      var breaks = (Array.isArray(q.data.quantity_breaks) ? q.data.quantity_breaks : [])
        .map(function (b) { return { qty: Math.max(1, Number(b.startQuantity) || 0), price: parseFloat(b.unitPrice) }; })
        .filter(function (b) { return isFinite(b.price); })
        .sort(function (a, b) { return a.qty - b.qty; });
      var label = '<span class="fop-strip__lbl">Quantity breaks</span>';
      if (breaks.length <= 1) {
        var base = breaks.length ? breaks[0].price : parseFloat(q.data.unit_price);
        return label + '<span class="fop-muted">None · ' + unitMoney(base) + " each</span>";
      }
      var qty = Number(line.qty) || 0;
      var active = -1;
      breaks.forEach(function (b, i) { if (b.qty <= qty) active = i; });
      return label + breaks.map(function (b, i) {
        return '<span class="fop-chip fop-chip--break' + (i === active ? " fop-chip--ship" : "") + '">' +
          '<span class="fop-chip__br">' + b.qty + "+</span>" +
          "<span>" + unitMoney(b.price) + "</span></span>";
      }).join("");
    }


    // Per-branch stock for one line (side box, inline strip, details dialog).
    // Branches with stock, closest to the ship-to first (branch-number order
    // without ship-to coordinates); the line's ship branch is
    // always shown and highlighted. On a new order or a bid each tile is a
    // button: a click ships line r from that branch (pickBranch).
    // withTotal: label reads "Inventory (1,136)" (side and details layouts, which
    // have no All column).
    function stockStripHtml(line, withTotal, r) {
      var q = quoteOf(line);
      // Labelled in every state, so the strip's columns stay aligned.
      if (!q || q.loading) return '<span class="fop-strip__lbl">Inventory</span><span class="fop-dots">···</span>';
      if (q.error) return '<span class="fop-strip__lbl">Inventory</span><span class="fop-warn-text">' + esc(q.error) + "</span>";
      var s = lineStock(line);
      var ship = lineBranch(line);
      var pick = r != null && r >= 0 && !linesLocked();
      var need = Number(line.qty) || 1;
      var rows = s.rows.map(function (x) {
        var id = branchIdOf(x.warehouse);
        var known = BRANCHES.filter(function (b) { return b[0] === id; })[0];
        return { id: id, name: known ? known[1] : String(x.warehouse || "").replace(/^\d+\s*-\s*/, ""), qty: parseInt(x.warehouseQty, 10) || 0 };
      }).filter(function (x) { return x.qty > 0 || (ship && x.id === ship); });
      // A ship branch with no stock row at all still gets its tile.
      if (ship && !rows.some(function (x) { return x.id === ship; })) {
        var sk = BRANCHES.filter(function (b) { return b[0] === ship; })[0];
        rows.push({ id: ship, name: sk ? sk[1] : "", qty: 0 });
      }
      // Closest to the ship-to first (2026-10-22), not by quantity.
      rows.sort(byShipToDistance);
      var lbl = '<span class="fop-strip__lbl">Inventory' + (withTotal ? " (" + s.total.toLocaleString("en-US") + ")" : "") + "</span>";
      if (!rows.length) return lbl + '<span class="fop-muted">No stock at any branch.</span>' + (pick ? branchMoreHtml(rows, r) : "");
      return lbl + rows.map(function (x) {
        var on = ship && x.id === ship;
        var inner = '<span class="fop-chip__br">' + esc(x.id) + " " + esc(x.name) + '</span><span class="fop-stock ' +
          stockClass(x.qty, need) + '">' + x.qty + "</span>";
        if (!pick || !x.id) return '<span class="fop-chip' + (on ? " fop-chip--ship" : "") + '">' + inner + "</span>";
        return '<button type="button" class="fop-chip fop-chip--pick' + (on ? " fop-chip--ship" : "") + '" tabindex="-1" data-action="pick-branch" data-r="' + r +
          '" data-branch="' + esc(x.id) + '" aria-pressed="' + !!on + '" title="' + (on ? "Ships from " : "Ship this line from ") + esc(x.id + " " + x.name) + '">' + inner + "</button>";
      }).join("") + (pick ? branchMoreHtml(rows, r) : "");
    }

    // The + after the inventory tiles lists the branches without a tile
    // (no stock there), so a line can ship from one anyway. A click on one
    // picks it like a tile (pickBranch); the + closes the list again.
    function branchMoreHtml(shown, r) {
      var rest = BRANCHES.filter(function (b) {
        return !shown.some(function (x) { return x.id === b[0]; });
      }).sort(function (a, b) { return byShipToDistance({ id: a[0] }, { id: b[0] }); });
      if (!rest.length) return "";
      var open = state.branchMenu === r;
      return '<button type="button" class="fop-chip fop-chip--pick fop-chip--more" tabindex="-1" data-action="branch-menu" data-r="' + r +
        '" aria-expanded="' + open + '" title="' + (open ? "Hide the other branches" : "Ship from a branch with no stock") + '">' + (open ? "−" : "+") + "</button>" +
        (open ? rest.map(function (b) {
          return '<button type="button" class="fop-chip fop-chip--pick fop-chip--empty" tabindex="-1" data-action="pick-branch" data-r="' + r +
            '" data-branch="' + esc(b[0]) + '" title="Ship this line from ' + esc(b[0] + " " + b[1]) + ' (no stock)">' +
            '<span class="fop-chip__br">' + esc(b[0]) + " " + esc(b[1]) + '</span><span class="fop-stock ' + stockClass(0, Number((state.lines[r] || {}).qty) || 1) + '">0</span></button>';
        }).join("") : "");
    }

    // Side layout: Alt+S / the "Stock & qty breaks" button open or close the
    // box. The inline and details layouts have no toggle.
    function toggleStock() {
      if (noStock() || !sideLayout) return;
      state.sidePanel = !state.sidePanel;
      render();
    }

    function descHtml(line) {
      if (!line.productId) return "";
      if (line.lookingUp) return '<span class="fop-dots">···</span>';
      if (line.notFound) return '<span class="fop-warn-text">Product ' + esc(line.productId) + " not found. Retype it or remove the line.</span>";
      var q = quoteOf(line);
      var err = q && q.error ? '<span class="fop-warn-text fop-block">' + esc(q.error) + "</span>" : "";
      var m = minPrice(line);
      var a = autoPrice(line);
      var autoLow = !line.priceOverride && a != null && m != null && a < m;
      var raised = (line.priceRaised || autoLow) && m != null
        ? '<span class="fop-warn-text fop-block">Price raised to the minimum, cost + $0.01 (' + unitMoney(m) + ")</span>" : "";
      var mx = maxPrice(line);
      var capped = line.priceCapped && mx != null
        ? '<span class="fop-warn-text fop-block">Price capped at the original unit price (' + unitMoney(mx) + ")</span>" : "";
      return esc(line.description || "") + err + raised + capped + lineBranchHtml(line) + eclipseCommentsHtml(line);
    }

    // A line shipping from another branch than the header's says so under
    // its description (every width, so phones see it too).
    function lineBranchHtml(line) {
      var b = lineBranch(line);
      if (!b || b === state.header.shipBranch) return "";
      return '<span class="fop-line-br">Ships from ' + esc(branchName(b)) + "</span>";
    }

    // A loaded line's Eclipse comments under its description, each on its
    // own line (line breaks inside a comment are kept).
    function eclipseCommentsHtml(line) {
      var list = line.eclipseComments || [];
      if (!list.length) return "";
      return '<span class="fop-line-notes">' + list.map(function (c) {
        return '<span class="fop-line-note">' + esc(c) + "</span>";
      }).join("") + "</span>";
    }

    function priceText(line) {
      return unitText(linePrice(line));
    }

    // Unit cost: the order's own cost on a loaded line, else the price lookup.
    function costHtml(line) {
      if (!line.productId) return "";
      var q = quoteOf(line);
      if (line.orderCost == null && (!q || q.loading)) return '<span class="fop-dots">···</span>';
      var cost = lineCost(line);
      return '<span class="fop-mlabel">Unit cost </span>' + (isFinite(cost) ? money(cost) : "-");
    }

    function extHtml(line) {
      if (!line.productId) return "";
      var p = linePrice(line);
      if (p == null) {
        var q = quoteOf(line);
        return q && q.loading ? '<span class="fop-dots">···</span>' : "-";
      }
      return '<span class="fop-mlabel">Ext. </span>' + money(p * (Number(line.qty) || 0));
    }

    function stockClass(have, need) {
      return have >= need ? "fop-stock--ok" : have > 0 ? "fop-stock--low" : "fop-stock--none";
    }

    function availHtml(line) {
      if (!line.productId || noStock() || isItemLine(line)) return "";
      var s = lineStock(line);
      if (!s) return '<span class="fop-dots">···</span>';
      // No ship branch picked yet: no branch count to show.
      if (!lineBranch(line)) return '<span class="fop-muted">-</span>';
      // The count is at the line's own branch; one that differs from the
      // header's (the column title) is prefixed with its id.
      var b = lineBranch(line);
      var other = b !== state.header.shipBranch;
      return '<span class="fop-mlabel">At branch </span>' + (other ? '<span class="fop-muted" title="At branch ' + esc(branchName(b)) + '">' + esc(b) + ": </span>" : "") +
        '<span class="fop-stock ' + stockClass(s.atBranch, Number(line.qty) || 1) + '">' + s.atBranch + "</span>";
    }

    function totalStockHtml(line) {
      if (!line.productId || noStock() || isItemLine(line)) return "";
      var s = lineStock(line);
      if (!s) return "";
      return '<span class="fop-mlabel">All branches </span>' + s.total;
    }

    // Subtotal, freight, tax and total. Subtotal is the lines as they are on
    // the page. Freight in / out, handling and sales tax are Eclipse's
    // (order-lookup); a new order has none until Eclipse creates it.
    // Total is Eclipse's own total while an existing order's lines are
    // unchanged, otherwise subtotal + freight + handling + tax.
    function summary() {
      var t = orderTotal();
      var ex = state.existing;
      var num = function (v) { return v != null && isFinite(v) ? Number(v) : null; };
      // Eclipse leaves freight / tax null when none is billed: $0.00 on an
      // existing order (a field order-lookup does not send at all stays "-").
      var amt = function (k) { return !ex || !(k in ex) ? null : num(ex[k]) || 0; };
      var s = {
        subtotal: t.total, unknown: t.unknown, cost: t.cost, costUnknown: t.costUnknown,
        freightIn: amt("freight_in"), freightOut: amt("freight_out"),
        handling: amt("handling"), tax: amt("tax_total"),
      };
      var unchanged = ex && (!ex.editable || !bidChanges().any);
      if (!ex) s.freightIn = freightInValue();
      s.total = unchanged && num(ex.order_total) != null ? num(ex.order_total)
        : s.subtotal + (s.freightIn || 0) + (s.freightOut || 0) + (s.handling || 0) + (s.tax || 0);
      return s;
    }

    // A new order or an editable bid over the bill-to's credit limit: a red
    // "Over credit limit" tag, title = the full reason. Shown below the
    // subtotal box on desktop (.fop-credit-tag--sum) and next to the Total
    // in the action bar on phones (.fop-credit-tag--bar); CSS picks one.
    function creditTagHtml() {
      var ex = state.existing;
      var overLimit = (!ex || ex.editable) && creditLimitReason();
      return overLimit ? '<span class="fop-status fop-status--cancel" title="' + esc(overLimit) + '">Over credit limit</span>' : "";
    }

    // Bottom bar: the order total only (cost is in the summary box).
    function totalsHtml() {
      var s = summary();
      return '<b class="fop-total">' + money(s.total) + "</b>" +
        (s.unknown ? ' <span class="fop-muted">(some prices pending)</span>' : "") +
        '<span class="fop-credit-tag--bar">' + creditTagHtml() + "</span>";
    }

    // The summary box under the lines, right-aligned (like a quote's totals).
    // A new order shows an editable Freight in and the Total: freight out and
    // tax are unknown until Eclipse creates the order.
    function summaryHtml() {
      var s = summary();
      if (!state.existing) {
        return '<div class="fop-sum__row"><label class="fop-sum__lbl" for="fop-freight-in">Freight in</label>' +
          '<input id="fop-freight-in" class="fop-input fop-sum__in" data-head="freightIn" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' +
          esc(state.header.freightIn) + '"></div>' +
          '<div class="fop-sum__row fop-sum__row--total"><span class="fop-sum__lbl">Total</span><span class="fop-sum__val" data-cell="sum-total">' +
          sumTotalHtml(s) + "</span></div>";
      }
      var row = function (label, v) {
        return '<div class="fop-sum__row"><span class="fop-sum__lbl">' + esc(label) + "</span>" +
          '<span class="fop-sum__val">' + (v == null ? "-" : money(v)) + "</span></div>";
      };
      return (state.existing ? row("Subtotal", s.subtotal) +
        row("Freight in", s.freightIn) + row("Freight out", s.freightOut) +
        // Handling only when Eclipse has some, so the rows add up to the total.
        (s.handling ? row("Handling", s.handling) : "") +
        row("Sales tax", s.tax) : "") +
        '<div class="fop-sum__row fop-sum__row--total"><span class="fop-sum__lbl">Total</span><span class="fop-sum__val" data-cell="sum-total">' +
        sumTotalHtml(s) + "</span></div>";
    }

    function sumTotalHtml(s) {
      return money(s.total) +
        (filledLines().length || customLines().length ? '<small class="fop-sum__cost">Cost ' + money(s.cost) + (s.costUnknown ? " (some pending)" : "") + "</small>" : "");
    }

    // Invoiced and cancelled orders show no stock (nothing will ship).
    function noStock() { return !!state.existing && !state.existing.cancellable; }

    function stockShown() { return sideLayout && !noStock() && state.sidePanel; }

    // Side layout: stock + qty breaks for every line with a product, one
    // section per line; the focused line's section is outlined in gold and
    // scrolled into view.
    function sideHtml() {
      var head = '<div class="fop-side__head"><span class="fop-party__lbl">Stock &amp; qty breaks</span>' +
        '<button class="fop-icon-btn" data-action="close-side" aria-label="Close stock and qty breaks" title="Close (' + altKey("S") + ')">×</button></div>';
      var items = state.lines.map(function (line, r) {
        if (!line.productId || isItemLine(line)) return "";
        // Name capped at 35 characters plus "..."; the full name is the tooltip.
        var name = (line.description || ("Product " + line.productId)).trim();
        var short = name.length > 35 ? name.slice(0, 35).replace(/\s+$/, "") + "..." : name;
        return '<div class="fop-side__line' + (r === state.focus.r ? " fop-side__line--active" : "") + '" data-side-row="' + r + '">' +
          '<div class="fop-side__item">' + (r + 1) + " · " +
          '<span class="fop-side__desc" title="' + esc(name) + '">' + esc(short) + "</span></div>" +
          // Stock (left) and qty breaks (right) side by side.
          '<div class="fop-side__cols">' +
          '<div class="fop-side__sec">' + stockStripHtml(line, true, r) + "</div>" +
          '<div class="fop-side__sec">' + breaksStripHtml(line) + "</div></div></div>";
      }).join("");
      return head + (items || '<div class="fop-muted fop-side__empty">Add products to see stock by branch and quantity breaks.</div>');
    }

    var sideRow = -1;
    function refreshSide() {
      if (!sideLayout || !stockShown()) return;
      var el = root.querySelector('[data-cell="side"]');
      if (!el) return;
      el.innerHTML = sideHtml();
      sideRow = state.focus.r;
      var active = el.querySelector(".fop-side__line--active");
      // Scroll only the card, never the page (scrollIntoView would also
      // scroll the window, so the main page jumped as the rep moved lines).
      if (active) {
        var a = active.getBoundingClientRect(), box = el.getBoundingClientRect();
        if (a.top < box.top) el.scrollTop += a.top - box.top - 8;
        else if (a.bottom > box.bottom) el.scrollTop += a.bottom - box.bottom + 8;
      }
    }

    // ── Line details dialog (details layout) ───────────────────────────────
    // Qty and unit price (applied to the line as the rep edits, through the
    // grid's own setQty / setPrice, so pricing rules and totals stay the
    // same), read-only unit cost and ext, stock by branch and qty breaks
    // (live: they redraw as the quote loads or the qty / ship branch
    // changes), and the line comment. Save keeps it all; Esc / Cancel put
    // the line back as it was when the dialog opened and drop the comment edit.

    function openDetails(r) {
      var line = state.lines[r];
      if (!detailsLayout || !line || line.custom || !line.productId) return;
      if (noStock() && !commentEditable(line)) return;
      state.detailsModal = {
        r: r, comment: line.comment || "",
        orig: { qty: line.qty, price: line.price, priceOverride: line.priceOverride, keepPrice: line.keepPrice, priceRaised: line.priceRaised, priceCapped: line.priceCapped },
        // A branch tile picked here can move the header's ship branch and
        // every line's branch (pickBranch), so Cancel puts all of them back.
        branches: state.lines.map(function (l) { return l.branch; }), shipBranch: state.header.shipBranch,
      };
      render();
    }

    // keep: false (Esc / Cancel) restores the line's qty, price and branch.
    function closeDetails(keep) {
      var m = state.detailsModal;
      var line = state.lines[m.r];
      if (!keep && line) {
        Object.assign(line, m.orig);
        state.lines.forEach(function (l, i) { l.branch = m.branches[i]; });
        state.header.shipBranch = m.shipBranch;
      }
      state.detailsModal = null;
      state.focus = { r: m.r, c: state.focus.c };
      render();
    }

    function saveDetails() {
      // Apply a qty / price still being typed before closing.
      var a = document.activeElement;
      if (a && a.hasAttribute && a.hasAttribute("data-dm")) a.dispatchEvent(new Event("change", { bubbles: true }));
      var m = state.detailsModal;
      var line = state.lines[m.r];
      if (line && commentEditable(line)) line.comment = m.comment.trim();
      closeDetails(true);
    }

    function detailsStockHtml(line) {
      if (noStock() || isItemLine(line)) return "";
      return '<div class="fop-details__cols">' +
        '<div class="fop-side__sec" data-cell="details-stock">' + stockStripHtml(line, true, state.detailsModal.r) + "</div>" +
        '<div class="fop-side__sec" data-cell="details-breaks">' + breaksStripHtml(line) + "</div></div>";
    }

    // Qty, Unit price, Unit cost, Ext in one row.
    function detailsNumsHtml(line, r) {
      var ro = linesLocked() ? " readonly" : "";
      var edited = line.priceOverride && !line.keepPrice;
      var cell = function (label, inner, extra) {
        return '<div class="fop-field' + (extra || "") + '"><span class="fop-label">' + label + "</span>" + inner + "</div>";
      };
      return '<div class="fop-details__nums">' +
        '<div class="fop-field"><label class="fop-label" for="fop-dm-qty">Qty</label>' +
        '<input class="fop-input fop-num" id="fop-dm-qty" data-dm="qty" inputmode="numeric" autocomplete="off" value="' + esc(line.qty) + '"' + ro + "></div>" +
        '<div class="fop-field"><label class="fop-label" for="fop-dm-price">Unit price</label>' +
        '<input class="fop-input fop-num' + (edited ? " fop-input--override" : "") + '" id="fop-dm-price" data-dm="price" inputmode="decimal" autocomplete="off" value="' +
        esc(priceText(line)) + '"' + ro + "></div>" +
        cell("Unit cost", '<div class="fop-details__val fop-num" data-cell="details-cost">' + costHtml(line) + "</div>") +
        cell("Ext.", '<div class="fop-details__val fop-num" data-cell="details-ext">' + extHtml(line) + "</div>") +
        "</div>";
    }

    function detailsModalHtml() {
      var m = state.detailsModal;
      var line = state.lines[m.r];
      var editable = commentEditable(line);
      var canSave = !linesLocked();
      return (
        '<div class="fop-modal" role="dialog" aria-modal="true" aria-labelledby="fop-details-title">' +
        '<div class="fop-modal__box fop-details">' +
        '<h2 class="fop-h2" id="fop-details-title">Line ' + (m.r + 1) + " · " + esc(pidText(line)) + "</h2>" +
        '<div class="fop-details__desc" data-cell="details-desc">' + descHtml(line) + "</div>" +
        detailsNumsHtml(line, m.r) +
        detailsStockHtml(line) +
        '<div class="fop-field fop-details__comment">' +
        (editable
          ? '<label class="fop-label" for="fop-details-comment">Line comment</label>' +
            '<textarea class="fop-input fop-line-comment" id="fop-details-comment" data-details-comment rows="3" maxlength="500"' +
            (line.orig ? ' placeholder="Added to this line\'s comments on Update Bid"' : "") + ">" + esc(m.comment) + "</textarea>"
          : '<span class="fop-label">Line comment</span><span class="fop-muted">Comments can only be added on a new order or a bid.</span>') +
        "</div>" +
        '<div class="fop-row fop-row--end">' +
        (canSave
          ? '<button class="fop-btn fop-btn--ghost" data-action="close-details">Cancel <span class="fop-key">Esc</span></button>' +
            '<button class="fop-btn" data-action="save-details">Save <span class="fop-key fop-key--dark">Ctrl+Enter</span></button>'
          : '<button class="fop-btn fop-btn--ghost" data-action="close-details">Close <span class="fop-key">Esc</span></button>') +
        "</div></div></div>"
      );
    }

    // Title of the order view: "New order", or the existing order's id and
    // its status badge.
    function orderTitleHtml() {
      var ex = state.existing;
      if (!ex) return titleHtml("Order Placement", "New order");
      return '<div class="fop-kicker">Order Placement</div><h1 class="fop-h1">' +
        esc(ex.e_sorder_id) +
        ' <span class="fop-status fop-status--' + esc(String(ex.status).toLowerCase()) + '">' + esc(statusLabel(ex.status)) + "</span>" +
        deliveredHtml() + paymentHtml() + "</h1>";
    }

    // Payment tile after Delivered: order-lookup's payment_status (Eclipse
    // balanceDue vs salesTotal, the same rule as the HubSpot deal sync's
    // e_payment_status). "Paid" green, "Partially Paid" orange, nothing when
    // unpaid. Bids and cancelled orders show none (nothing is billed).
    function paymentHtml() {
      var ex = state.existing;
      if (!ex || ex.status === "Bid" || ex.status === "Cancel") return "";
      var due = ex.balance_due != null ? " title=\"Balance due " + money(ex.balance_due) + "\"" : "";
      if (ex.payment_status === "fully_paid") return '<span class="fop-status fop-status--invoice">Paid</span>';
      if (ex.payment_status === "partially_paid") return '<span class="fop-status fop-status--partial"' + due + ">Partially Paid</span>";
      return "";
    }

    // A green Delivered tile right of the status once every package in the
    // order's Tracking details (parseTracking) is delivered. Its tooltip
    // carries the delivery date when the packages share one.
    function deliveredHtml() {
      var pkgs = parseTracking(state.existing && state.existing.tracking_details);
      if (!pkgs) return "";
      var withStatus = pkgs.filter(function (p) { return p.status; });
      if (!withStatus.length || !withStatus.every(function (p) { return isDelivered(p.status); })) return "";
      var dates = withStatus.map(function (p) { return p.delivery; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
      return '<span class="fop-status fop-status--invoice"' +
        (dates.length === 1 ? ' title="Delivered ' + esc(tdate(dates[0])) + '"' : "") + ">Delivered</span>";
    }

    // Action bar buttons. New order: Place as Bid + Place Order. Existing
    // bid: Update Bid. Any existing order not invoiced or cancelled: Cancel.
    function actionsHtml() {
      var ex = state.existing;
      if (!ex) {
        var bidReason = placeBlockedReason("bid");
        var orderReason = placeBlockedReason("order");
        // Every place / bid button is aria-disabled, not disabled: a disabled
        // button gets no clicks, and a click on a blocked one must reach
        // requestPlace() so it flashes the field at fault (flashBlockedField).
        return '<button class="fop-btn fop-btn--ghost" data-action="place-bid"' + (bidReason ? ' aria-disabled="true" title="' + esc(bidReason) + '"' : "") +
          ">Place as Bid <span class=\"fop-key\">" + altKey("B") + "</span></button>" +
          '<button class="fop-btn" data-action="place-order"' + (orderReason ? ' aria-disabled="true" title="' + esc(orderReason) + '"' : "") +
          ">Place Order <span class=\"fop-key fop-key--dark\">" + altKey("O") + "</span></button>";
      }
      var html = quoteBtnHtml() + (ex.cancellable
        ? '<button class="fop-btn fop-btn--danger" data-action="ask-cancel">Cancel ' + (ex.editable ? "Bid" : "Order") + "</button>" : "");
      if (ex.editable) {
        var updReason = placeBlockedReason("update");
        var convReason = placeBlockedReason("convert");
        // aria-disabled like Place Order, so a blocked click still flashes
        // the field at fault. Convert also saves any changes on the page.
        html += '<button class="fop-btn fop-btn--ghost" data-action="update-bid"' + (updReason ? ' aria-disabled="true" title="' + esc(updReason) + '"' : "") +
          ">Update Bid <span class=\"fop-key\">" + altKey("B") + "</span></button>" +
          '<button class="fop-btn" data-action="convert-bid"' + (convReason ? ' aria-disabled="true" title="' + esc(convReason) + '"' : "") +
          '><span class="fop-lbl-full">Convert to Order</span><span class="fop-lbl-short">To Order</span> <span class="fop-key fop-key--dark">' + altKey("O") + "</span></button>";
      }
      return html;
    }

    // Under the title on an existing order: what can be changed here.
    function existingNoteHtml() {
      var ex = state.existing;
      if (!ex) return "";
      var msg = ex.editable
        ? "On a bid the lines, ship via, ship branch, dates and notes can be changed (Update Bid), and Convert to Order makes it an order. " +
          "Customers, PO and release stay as they are in Eclipse."
        : "This order is " + statusLabel(ex.status) + ", so it can't be edited here." +
          (ex.cancellable ? " It can still be cancelled." : "");
      var n = state.notice;
      return (n ? '<div class="fop-alert fop-alert--success">' + esc(n.text) + "</div>" +
          (n.warning ? '<div class="fop-alert fop-alert--warning">' + esc(n.warning) + "</div>" : "") +
          (n.hubspotError ? '<div class="fop-alert fop-alert--warning">HubSpot sync did not start: ' + esc(n.hubspotError) +
            ". The deal will appear on the next scheduled sync.</div>" : "") : "") +
        '<div class="fop-alert fop-alert--info">' + esc(msg) + "</div>";
    }

    // Right side of the action bar on an existing order: Eclipse's last change
    // to the order (lastUpdateDateTime; order-level, not per generation).
    function lastModifiedHtml() {
      var ex = state.existing;
      if (!ex || !ex.last_modified) return "";
      return '<span class="fop-lastmod"><span class="fop-lastmod__lbl">Last modified</span> ' + esc(dateTimeText(ex.last_modified)) + "</span>";
    }

    // Above the customer cards, on an existing order: one tab per generation
    // and "Change log".
    function switcherHtml() {
      if (!state.existing) return "";
      var gens = state.order ? (state.order.generations || []) : [];
      var cur = state.existing.generation_id;
      return '<div class="fop-switch">' +
        (gens.length ? '<div class="fop-tabs" role="tablist" aria-label="Generations">' + gens.map(function (g) {
          var on = g.generation_id === cur;
          return '<button class="fop-tab' + (on ? " fop-tab--active" : "") + '" role="tab" aria-selected="' + on + '" data-gen="' + esc(g.generation_id) +
            '" title="' + esc(g.e_sorder_id + " · " + statusLabel(g.status)) + '">' +
            // Full words on desktop, "Gen. 1 / Inv. 2" on phones (CSS swaps them).
            '<span class="fop-tab__full">' + esc(genLabel(g)) + '</span><span class="fop-tab__short">' + esc(genLabel(g, true)) + "</span>" +
            tabStatusHtml(g) + "</button>";
        }).join("") + "</div>" : "") +
        // Far right of the row (on request): Change log, then Exit.
        '<div class="fop-row fop-switch__end">' +
        '<button class="fop-btn fop-btn--ghost fop-btn--sm" data-action="change-log">Change log</button>' +
        exitBtnHtml() + "</div>" +
        "</div>";
    }

    // A generation tab's status (2026-10-20, on request): one word in a small
    // tile like the header's status (2026-10-21),
    // Bid (gray), Open (blue: any order status still to ship, e.g. Ship When
    // Complete), Invoiced (green), Cancelled (red). The tab's tooltip keeps
    // Eclipse's full status.
    function tabStatusHtml(g) {
      var s = String(g.status || "");
      var kind = s === "Bid" ? "bid" : s === "Invoice" ? "invoice" : s === "Cancel" ? "cancel" : "open";
      var word = { bid: "Bid", invoice: "Invoiced", cancel: "Cancelled", open: "Open" }[kind];
      return '<span class="fop-tabst fop-tabst--' + kind + '">' + word + "</span>";
    }

    function exitBtnHtml() {
      return '<button class="fop-btn fop-btn--ghost fop-btn--sm" data-action="exit-order">Exit <span class="fop-key">' + altKey("Q") + "</span></button>";
    }

    // The bill-to's recent orders (customer-orders flow), newest first; a row
    // opens that order at its lowest generation.
    // The orders list itself, for the orders view. shipToId (optional) keeps only orders with a generation
    // for that ship-to.
    function ordersBodyHtml(shipToId) {
      var ol = state.ordersList || {};
      var body;
      if (ol.loading) body = '<div class="fop-center fop-center--sm"><div class="fop-spinner"></div><div>Loading orders…</div></div>';
      else if (ol.error) body = '<div class="fop-alert fop-alert--error">' + esc(ol.error) + "</div>";
      else {
        var orders = (ol.data && ol.data.orders) || [];
        if (shipToId) orders = orders.filter(function (o) {
          return o.generations.some(function (g) { return String(g.ship_to_id) === String(shipToId); });
        });
        var openId = state.order ? state.order.order_id : "";
        body = orders.length ? '<div class="fop-orders" role="listbox" aria-label="Orders">' + orders.map(function (o) {
          var g0 = o.generations[0] || {};
          var total = o.generations.reduce(function (t, g) { return g.status === "Cancel" || g.sales_total == null ? t : t + g.sales_total; }, 0);
          return '<button class="fop-order' + (o.order_id === openId ? " fop-order--open" : "") + '" data-open-order="' + esc(o.order_id) + '">' +
            '<span class="fop-order__top"><b>' + esc(o.order_id) + "</b>" +
            (o.order_id === openId ? ' <span class="fop-muted">(open)</span>' : "") +
            '<span class="fop-order__date">' + esc(dateText(o.order_date)) + "</span></span>" +
            '<span class="fop-order__mid fop-muted">' + esc(g0.ship_to_name || "") + (g0.ship_to_id ? " (" + esc(g0.ship_to_id) + ")" : "") +
            (g0.po ? " · PO " + esc(g0.po) : "") + '<span class="fop-order__total">' + money(total) + "</span></span>" +
            '<span class="fop-order__gens">' + o.generations.map(function (g) {
              return '<span class="fop-status fop-status--sm fop-status--' + esc(String(g.status).toLowerCase()) + '">' +
                esc("Gen " + g.generation_id + " · " + statusLabel(g.status)) + "</span>";
            }).join("") + "</span></button>";
        }).join("") + "</div>" : '<div class="fop-muted">' + (shipToId ? "No orders found for this ship-to." : "No orders found for this customer.") + "</div>";
        if (ol.data && ol.data.truncated) body += '<div class="fop-hint">Showing the ' + esc(ol.data.page_size) + " most recent order generations.</div>";
      }
      return body;
    }

    // "2026-10-17T17:12:21Z" → "Oct 17, 2026, 1:12:21 PM EDT" (browser's zone).
    function logTimeText(iso) {
      var d = new Date(iso);
      if (!iso || isNaN(d)) return iso || "";
      return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
    }

    // Eclipse's order change log for the whole order (order-changelog flow),
    // in Eclipse's order. "ALL" entries apply to every generation.
    function changeLogHtml() {
      var cl = state.changeLog || {};
      var ex = state.existing;
      var gid = String(ex.generation_id);
      var body;
      if (cl.loading) body = '<div class="fop-center fop-center--sm"><div class="fop-spinner"></div><div>Loading change log…</div></div>';
      else if (cl.error) body = '<div class="fop-alert fop-alert--error">' + esc(cl.error) + "</div>";
      else {
        var all = (cl.data && cl.data.entries) || [];
        var rows = state.logGenOnly ? all.filter(function (e) {
          return e.gens.some(function (g) { return g === "ALL" || String(Number(g)) === gid; });
        }) : all;
        body = rows.length ? '<div class="fop-table-wrap fop-log-wrap"><table class="fop-table fop-log"><thead><tr>' +
          "<th>Gens</th><th>Date &amp; time</th><th>User</th><th>Comment</th></tr></thead><tbody>" +
          rows.map(function (e) {
            var mine = e.gens.some(function (g) { return g === "ALL" || String(Number(g)) === gid; });
            var gens = e.gens.join(", ") || "-";
            // Phones stack each entry (styles.css), so the gens cell carries a
            // label there: "All gens" / "Gen. 1, 2".
            var gensShort = gens === "ALL" ? "All gens" : gens === "-" ? "-" : "Gen. " + gens;
            return '<tr class="' + (mine ? "" : "fop-log--other") + '"><td class="fop-log__gens">' +
              '<span class="fop-log__gfull">' + esc(gens) + '</span><span class="fop-log__gshort">' + esc(gensShort) + "</span></td>" +
              '<td class="fop-log__at">' + esc(logTimeText(e.at)) + '</td><td class="fop-log__user">' + esc(e.user) + '</td><td class="fop-log__c">' + esc(e.comment) + "</td></tr>";
          }).join("") + "</tbody></table></div>"
          : '<div class="fop-muted">' + (all.length ? "No entries for this generation." : "No change log entries for this order.") + "</div>";
        if (all.length) body = '<div class="fop-muted fop-log__count">' + rows.length + (rows.length === all.length ? "" : " of " + all.length) + " entries</div>" + body;
      }
      return (
        '<div class="fop-modal" role="dialog" aria-modal="true" aria-labelledby="fop-log-title">' +
        '<div class="fop-modal__box fop-modal__box--wide">' +
        '<div class="fop-log__head"><h2 class="fop-h2" id="fop-log-title">Change log · ' + esc(ex.order_id) + "</h2>" +
        '<label class="fop-check"><input type="checkbox" data-action="log-gen-only"' + (state.logGenOnly ? " checked" : "") + "> " +
        esc(genLabel(ex)) + " only</label></div>" +
        body +
        '<div class="fop-row fop-row--end"><button class="fop-btn fop-btn--ghost" data-action="close-log">Close <span class="fop-key">Esc</span></button></div>' +
        "</div></div>"
      );
    }

    function openChangeLog() {
      var ex = state.existing;
      if (!ex) return;
      state.logModal = true;
      var id = ex.order_id;
      // Cached per order for the session (reloading the order refetches).
      if (!state.changeLog || state.changeLog.orderId !== id || state.changeLog.error) {
        state.changeLog = { orderId: id, loading: true };
        getJson(API.orderChangelog, { e_sorder_id: id })
          .then(function (d) { if (state.changeLog.orderId === id) state.changeLog = { orderId: id, data: d }; })
          .catch(function (err) { if (state.changeLog.orderId === id) state.changeLog = { orderId: id, error: err.message }; })
          .then(function () { if (state.logModal) render(); });
      }
      render();
    }

    // ── View Quote (2026-10-19; live check 2026-10-21) ──────────────────
    // An existing order's HubSpot quote (the generation's deal's newest quote
    // with a public link). Nothing is remembered: every click asks the quote
    // lookup flow in the moment, opens the quote it finds, and with none yet
    // makes one (create-quote flow) and opens that. Grayed out (disabled)
    // while checking or making one. On a bid with unsaved changes a click
    // opens the Update Bid confirm dialog instead (2026-10-22, was grayed out
    // and flashed Update Bid): the quote shows what is saved, so save first;
    // once the bid saves, the quote opens on its own.
    // Not shown on invoiced or cancelled orders (quoteBtnHtml).

    // Why View Quote can't open now, or null when it can.
    function quoteBlockedReason() {
      var ex = state.existing, busy = ex && hsQuotes[ex.e_sorder_id];
      if (busy === "checking") return "Checking HubSpot for a quote…";
      if (busy === "creating") return "Creating the quote in HubSpot…";
      return null;
    }

    // A bid with unsaved changes: View Quote saves them first (Update Bid).
    function quoteNeedsUpdate() {
      var ex = state.existing;
      return !!(ex && ex.editable && bidChanges().any);
    }

    function quoteBtnHtml() {
      var ex = state.existing;
      if (!ex || ex.status === "Invoice" || ex.status === "Cancel") return "";
      var busy = hsQuotes[ex.e_sorder_id];
      var why = quoteBlockedReason() || (quoteNeedsUpdate() ? "Your changes are saved with Update Bid first, then the quote opens." : null);
      return '<button class="fop-btn fop-btn--ghost" data-action="view-quote"' +
        (busy ? " disabled" : "") +
        (why ? ' title="' + esc(why) + '"' : "") + ">" + (busy === "creating" ? "Creating quote…" : "View Quote") + "</button>";
    }

    // Only the button: a full render would reload an open quote's iframe.
    function refreshQuoteBtn() {
      var btn = root.querySelector("[data-action=view-quote]");
      if (!btn || !state.existing) return;
      btn.outerHTML = quoteBtnHtml();
    }

    // Show the quote above the action bar's error, never inside the dialog.
    function showQuoteError(msg) {
      state.quoteError = msg;
      var cell = root.querySelector('[data-cell="quote-error"]');
      if (cell) cell.innerHTML = msg ? '<div class="fop-alert fop-alert--error">' + esc(msg) + "</div>" : "";
    }

    function openQuote() {
      var ex = state.existing;
      if (!ex || hsQuotes[ex.e_sorder_id]) return;
      // Unsaved bid changes: Update Bid first; once it saves, updateBid
      // opens the quote (thenQuote).
      if (quoteNeedsUpdate()) {
        requestPlace("update");
        if (state.confirm) state.confirm.thenQuote = true;
        return;
      }
      var id = ex.e_sorder_id, fail = "Could not check HubSpot for a quote: ";
      var here = function () { return state.existing && state.existing.e_sorder_id === id; };
      var show = function (q) {
        delete hsQuotes[id];
        if (here() && !state.quoteModal) {
          state.quoteModal = { id: id, quote: q, emails: [], sending: false, note: null };
          render();
        } else refreshQuoteBtn();
      };
      hsQuotes[id] = "checking";
      showQuoteError(null);
      refreshQuoteBtn();
      getJson(API.quote, { e_sorder_id: id })
        .then(function (d) {
          if (d.quote && d.quote.link) return show(d.quote);
          if (!d.hs_deal_id) { fail = ""; throw new Error("No HubSpot deal for this order yet, so there is nothing to quote."); }
          // No quote yet: make one (create-quote returns an existing one
          // instead if another rep got there first), then open it.
          hsQuotes[id] = "creating";
          fail = "Could not create the quote: ";
          refreshQuoteBtn();
          return postJson(API.createQuote, { e_sorder_id: id }).then(function (c) {
            fail = "";
            if (!(c.quote && c.quote.link)) throw new Error("HubSpot made the quote but has not published its link yet. Try View Quote again in a minute.");
            // create-quote waits (up to 20 s) for the new quote's page to stop
            // answering 404; page_ready false means it was still not up.
            if (c.page_ready === false) throw new Error("HubSpot is still preparing the quote. Try View Quote again in a moment.");
            show(c.quote);
          });
        })
        .catch(function (err) {
          delete hsQuotes[id];
          if (here()) showQuoteError(fail + err.message);
          refreshQuoteBtn();
        });
    }

    function closeQuote() {
      state.quoteModal = null;
      render();
    }

    // Email format: letters, digits and . _ + - before the @, a domain with
    // at least one dot after it and a 2+ letter ending. Lowercase only.
    var EMAIL_RE = /^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
    var EMAIL_CHARS = /[^a-z0-9._+@-]/g;

    function quoteModalHtml() {
      var m = state.quoteModal, q = m.quote;
      return (
        // Closed by the × (top right), Esc or a backdrop click. Phones
        // (styles.css): near full screen, the quote scaled to the screen's
        // width (fitQuoteFrame), pinch to zoom.
        '<div class="fop-modal fop-modal--quote" role="dialog" aria-modal="true" aria-labelledby="fop-quote-title">' +
        '<div class="fop-modal__box fop-modal__box--wide fop-quote">' +
        '<div class="fop-quote__head"><div class="fop-quote__titles"><h2 class="fop-h2" id="fop-quote-title">Quote · ' + esc(m.id) + "</h2></div>" +
        '<a class="fop-btn fop-btn--ghost fop-btn--sm fop-quote__newtab" href="' + esc(q.link) + '" target="_blank" rel="noopener" aria-label="Open the quote in a new tab">' +
        '<span class="fop-quote__newtab-txt">Open in new tab </span>' + EXT_ICON + "</a>" +
        '<button type="button" class="fop-icon-btn fop-quote__x" data-action="close-quote" aria-label="Close">×</button></div>' +
        '<div class="fop-quote__viewport"><iframe class="fop-quote__frame" src="' + esc(q.link) + '" title="Quote ' + esc(q.number || m.id) + '"></iframe>' +
        (quoteTouch() ? '<div class="fop-quote__touch" aria-hidden="true"></div>' : "") + "</div>" +
        '<div class="fop-quote__foot">' +
        '<div class="fop-field"><label class="fop-label" for="fop-quote-email">Send to <span class="fop-muted fop-quote__hint">(comma or Enter after each address)</span></label>' +
        '<div class="fop-input fop-emails" data-cell="emails">' + emailChipsHtml() +
        '<input class="fop-emails__in" id="fop-quote-email" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="email"' +
        (m.emails.length ? "" : ' placeholder="name@example.com"') + "></div>" +
        '<span class="fop-warn-text fop-block" data-cell="email-msg"></span></div>' +
        '<div class="fop-quote__note" data-cell="send-note">' + sendNoteHtml() + "</div>" +
        '<div class="fop-row fop-row--end">' +
        // aria-disabled, not disabled: a click with no address flashes the box.
        sendBtnHtml() +
        "</div></div></div></div>"
      );
    }

    function sendBtnHtml() {
      var m = state.quoteModal;
      return '<button class="fop-btn" data-action="send-quote"' + (m.sending ? " disabled" : m.emails.length ? "" : ' aria-disabled="true" title="Add an email address."') + ">" +
        (m.sending ? "Sending…" : 'Send<span class="fop-quote__q"> Quote</span> <span class="fop-key fop-key--dark">Ctrl+Enter</span>') + "</button>";
    }

    // The quote template is a fixed 8.5in (816px) sheet. Where the dialog is
    // narrower (phones), the iframe is laid out at that width and scaled down
    // to fit, so the whole page width shows.
    //
    // Touch screens get pinch-to-zoom (2026-10-19, on request): the browser
    // gives a cross-origin iframe's gestures to the iframe, so a transparent
    // layer (.fop-quote__touch) sits over it and handles them here: two
    // fingers zoom (fit width up to 4x), one finger pans, a double tap zooms
    // in at that spot or back out to fit. The iframe is laid out tall enough
    // for the whole quote (quoteSheetHeight) and moved with a transform, so
    // panning replaces its own scrolling. Trade-off: links and buttons inside
    // the quote can't be tapped there (Open in new tab has them).
    var QUOTE_PAGE_W = 816;
    var QUOTE_MAX_ZOOM = 4;

    function quoteTouch() {
      return !!(window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches);
    }

    // The quote's height can't be read (another site), so allow for it: an
    // 11in sheet, or more for long orders (about 90px a line, generous, so a
    // long quote is never cut off; the cost is blank space below a short one).
    function quoteSheetHeight() {
      var n = state.existing && state.existing.lines ? state.existing.lines.length : filledLines().length;
      return Math.max(1100, 700 + n * 90);
    }

    function fitQuoteFrame() {
      var m = state.quoteModal;
      var vp = root.querySelector(".fop-quote__viewport");
      var fr = vp && vp.querySelector("iframe");
      if (!m || !fr) return;
      var w = vp.clientWidth, h = vp.clientHeight;
      var k = w && w < QUOTE_PAGE_W ? w / QUOTE_PAGE_W : 1;
      if (quoteTouch()) {
        var H = quoteSheetHeight();
        var v = m.view;
        if (!v || v.fit !== k) v = m.view = { fit: k, s: k, x: 0, y: 0 };
        fr.style.width = QUOTE_PAGE_W + "px";
        fr.style.height = H + "px";
        clampQuoteView(v, w, h, H);
        fr.style.transform = "translate(" + v.x + "px," + v.y + "px) scale(" + v.s + ")";
      } else if (k < 1) {
        fr.style.width = QUOTE_PAGE_W + "px";
        fr.style.height = Math.ceil(h / k) + "px";
        fr.style.transform = "scale(" + k + ")";
      } else {
        fr.style.width = fr.style.height = fr.style.transform = "";
      }
    }

    // Keep the sheet covering the box: no panning past its edges, centred
    // when it is narrower than the box.
    function clampQuoteView(v, w, h, H) {
      v.s = Math.min(Math.max(v.s, v.fit), v.fit * QUOTE_MAX_ZOOM);
      var cw = QUOTE_PAGE_W * v.s, ch = H * v.s;
      v.x = cw <= w ? (w - cw) / 2 : Math.min(0, Math.max(w - cw, v.x));
      v.y = ch <= h ? 0 : Math.min(0, Math.max(h - ch, v.y));
    }

    // Zoom to scale s keeping the sheet point under (px, py) (box coords) there.
    function zoomQuoteAt(v, s, px, py, from) {
      var f = from || v;
      var cx = (px - f.x) / f.s, cy = (py - f.y) / f.s;
      v.s = s;
      v.x = px - cx * s;
      v.y = py - cy * s;
    }

    var qt = null;   // the gesture in progress on the quote's touch layer
    var lastTap = 0;
    function touchPts(e, box) {
      var r = box.getBoundingClientRect();
      return Array.prototype.map.call(e.touches, function (t) { return { x: t.clientX - r.left, y: t.clientY - r.top }; });
    }
    function quoteTouchStart(e) {
      var m = state.quoteModal, vp = root.querySelector(".fop-quote__viewport");
      if (!m || !m.view || !vp) return;
      e.preventDefault();
      var p = touchPts(e, vp), v = m.view;
      if (p.length >= 2) {
        qt = { pinch: true, d: Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) || 1,
          mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2, v: { s: v.s, x: v.x, y: v.y } };
      } else if (p.length === 1) {
        qt = { pinch: false, sx: p[0].x, sy: p[0].y, v: { s: v.s, x: v.x, y: v.y }, moved: false };
      }
    }
    function quoteTouchMove(e) {
      var m = state.quoteModal, vp = root.querySelector(".fop-quote__viewport");
      if (!m || !m.view || !vp || !qt) return;
      e.preventDefault();
      var p = touchPts(e, vp), v = m.view;
      if (qt.pinch && p.length >= 2) {
        var d = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) || 1;
        var mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
        var s = Math.min(Math.max(qt.v.s * d / qt.d, v.fit), v.fit * QUOTE_MAX_ZOOM);
        // The point under the fingers' first midpoint follows the midpoint.
        zoomQuoteAt(v, s, qt.mx, qt.my, qt.v);
        v.x += mx - qt.mx;
        v.y += my - qt.my;
      } else if (!qt.pinch && p.length === 1) {
        var dx = p[0].x - qt.sx, dy = p[0].y - qt.sy;
        if (Math.abs(dx) + Math.abs(dy) > 6) qt.moved = true;
        v.x = qt.v.x + dx;
        v.y = qt.v.y + dy;
      }
      fitQuoteFrame();
    }
    function quoteTouchEnd(e) {
      var m = state.quoteModal, vp = root.querySelector(".fop-quote__viewport");
      if (!m || !m.view || !vp) { qt = null; return; }
      e.preventDefault();
      var g = qt;
      // A finger lifted mid-pinch: carry on panning with the one left.
      if (e.touches.length) { quoteTouchStart(e); return; }
      qt = null;
      if (!g || g.pinch || g.moved) { lastTap = 0; return; }
      // Double tap: zoom in 2.5x at the spot, or back out to fit.
      var now = Date.now();
      if (now - lastTap < 300) {
        var v = m.view;
        if (v.s > v.fit * 1.05) { v.s = v.fit; v.x = 0; v.y = Math.min(0, v.y); }
        else zoomQuoteAt(v, v.fit * 2.5, g.sx, g.sy);
        fitQuoteFrame();
        lastTap = 0;
      } else lastTap = now;
    }
    window.addEventListener("resize", function () {
      if (state.quoteModal) fitQuoteFrame();
      // Phone and desktop qty boxes differ in padding and alignment.
      showAllQty();
      // Orientation change / font reflow can rewrap the action bar's buttons
      // without a render happening on its own.
      syncBarSpace();
    });

    function sendNoteHtml() {
      var n = state.quoteModal.note;
      return n ? '<div class="fop-alert fop-alert--' + n.kind + '">' + esc(n.text) + "</div>" : "";
    }

    function emailChipsHtml() {
      return state.quoteModal.emails.map(function (em, i) {
        return '<span class="fop-chip">' + esc(em) + '<button type="button" class="fop-chip__x" data-action="remove-email" data-i="' + i + '" aria-label="Remove ' + esc(em) + '">×</button></span>';
      }).join("");
    }

    // Redraw the chips, message and Send button in place (not render(), which
    // would reload the iframe). Keeps the typed text and focus.
    function refreshEmails(msg) {
      var m = state.quoteModal;
      var box = root.querySelector('[data-cell="emails"]');
      var input = root.querySelector("#fop-quote-email");
      if (!m || !box || !input) return;
      Array.prototype.slice.call(box.querySelectorAll(".fop-chip")).forEach(function (c) { c.remove(); });
      input.insertAdjacentHTML("beforebegin", emailChipsHtml());
      if (m.emails.length) input.removeAttribute("placeholder"); else input.placeholder = "name@example.com";
      box.classList.toggle("fop-input--err", !!msg);
      var mc = root.querySelector('[data-cell="email-msg"]');
      if (mc) mc.textContent = msg || "";
      var btn = root.querySelector("[data-action=send-quote]");
      if (btn) btn.outerHTML = sendBtnHtml();
    }

    // Turn the typed text into a chip. Returns false (and says why) when it is
    // not a valid address; an empty box or a repeat is fine.
    function addEmail(text) {
      var em = String(text || "").trim();
      if (!em) return true;
      if (!EMAIL_RE.test(em)) { refreshEmails("\u201c" + em + "\u201d is not a valid email address."); return false; }
      if (state.quoteModal.emails.indexOf(em) < 0) state.quoteModal.emails.push(em);
      refreshEmails(null);
      return true;
    }

    // Typing or pasting: lowercase only, characters an address can't hold are
    // dropped, and a comma (or ; or a space) ends an address.
    function onEmailInput(input) {
      var raw = input.value;
      var v = raw.toLowerCase();
      var parts = v.split(/[,;\s]+/);
      var rest = parts.pop();
      var dropped = false;
      var clean = function (x) { var c = x.replace(EMAIL_CHARS, ""); if (c !== x) dropped = true; return c; };
      var bad = null;
      parts.forEach(function (x) { x = clean(x); if (x && !bad && !addEmail(x)) bad = x; });
      rest = clean(rest);
      // A part that failed goes back in the box to be fixed.
      var next = bad || rest;
      if (input.value !== next) input.value = next;
      if (bad) return;
      if (dropped) refreshEmails("Only lowercase letters, numbers and . _ + - @ can be used.");
      else if (parts.length || root.querySelector('[data-cell="email-msg"]').textContent) refreshEmails(null);
    }

    function removeEmail(i) {
      state.quoteModal.emails.splice(i, 1);
      refreshEmails(null);
      var input = root.querySelector("#fop-quote-email");
      if (input) input.focus();
    }

    function setSendNote(kind, text) {
      var m = state.quoteModal;
      if (!m) return;
      m.note = text ? { kind: kind, text: text } : null;
      var note = root.querySelector('[data-cell="send-note"]');
      if (note) note.innerHTML = sendNoteHtml();
    }

    // Send Quote: with no address, flash the box. Otherwise the send-quote
    // flow emails the quote (link + PDF) from the signed-in rep's Outlook
    // mailbox; the chips clear once it is sent.
    function sendQuote() {
      var m = state.quoteModal;
      if (!m || m.sending) return;
      var input = root.querySelector("#fop-quote-email");
      if (input && input.value.trim() && !addEmail(input.value)) { input.focus(); return; }
      if (input) input.value = "";
      if (!m.emails.length) {
        flashField(root.querySelector('[data-cell="emails"]'));
        if (input) input.focus();
        return;
      }
      if (!user.email) { setSendNote("error", "Sign in again: no email address on this session, so there is no mailbox to send from."); return; }
      var to = m.emails.slice();
      m.sending = true;
      setSendNote(null, null);
      refreshEmails(null);
      postJson(API.sendQuote, { e_sorder_id: m.id, to_emails: to, from_email: user.email })
        .then(function (d) {
          if (state.quoteModal !== m) return;
          m.sending = false;
          m.emails = [];
          refreshEmails(null);
          setSendNote("success", "Sent from " + (d.from || user.email) + " to " + (d.sent_to || to).join(", ") + ".");
        })
        .catch(function (err) {
          if (state.quoteModal !== m) return;
          m.sending = false;
          refreshEmails(null);
          setSendNote("error", "Not sent: " + err.message);
        });
    }

    function closeChangeLog() {
      state.logModal = false;
      render();
    }

    // customer-orders for a bill-to. Cached per bill-to for the session
    // (loadCustomer clears the cache).
    function fetchOrders(id) {
      if (state.ordersList && state.ordersList.billTo === id && !state.ordersList.error) return;
      state.ordersList = { billTo: id, loading: true };
      getJson(API.customerOrders, { e_customer_id: id })
        .then(function (d) { if (state.ordersList && state.ordersList.billTo === id) state.ordersList = { billTo: id, data: d }; })
        .catch(function (err) { if (state.ordersList && state.ordersList.billTo === id) state.ordersList = { billTo: id, error: err.message }; })
        .then(function () { if (state.view === "orders") render(); });
    }

    // Leaving the open order (or a new order with lines) asks first.
    function confirmLeave() {
      if (state.existing ? hasUnsavedEdits() : filledLines().length > 0 || customLines().length > 0) {
        return window.confirm("Leave this order? Unsaved changes will be lost.");
      }
      return true;
    }

    function openOtherOrder(orderId) {
      urlProducts = [];
      loadExistingOrder(orderId);
    }

    function cancelHtml() {
      var ex = state.existing;
      var what = ex.editable ? "bid" : "order";
      return (
        '<div class="fop-modal" role="alertdialog" aria-modal="true" aria-labelledby="fop-cancel-title" aria-describedby="fop-cancel-desc">' +
        '<div class="fop-modal__box fop-modal__box--sm">' +
        '<h2 class="fop-h2" id="fop-cancel-title">Cancel ' + what + " " + esc(ex.e_sorder_id) + "?</h2>" +
        '<p class="fop-cancel-desc" id="fop-cancel-desc">Are you sure? This sets the ' + what + "'s status to Cancel in Eclipse. " +
        "It can't be undone from this page.</p>" +
        (state.placeError ? '<div class="fop-alert fop-alert--error">' + esc(state.placeError) + "</div>" : "") +
        '<div class="fop-row fop-row--end">' +
        '<button class="fop-btn fop-btn--ghost" data-action="keep-order"' + (state.placing ? " disabled" : "") + ">Keep " + what + ' <span class="fop-key">Esc</span></button>' +
        '<button class="fop-btn fop-btn--danger-solid" data-action="confirm-cancel"' + (state.placing ? " disabled" : "") + ">" +
        (state.placing ? "Cancelling…" : "Yes, cancel " + what) + "</button>" +
        "</div></div></div>"
      );
    }

    function viewOrder() {
      stripRow = inlineLayout ? state.focus.r : -1;
      // A locked order (invoiced, cancelled, non-bid) skips blank lines (the
      // empty entry line) and says so when it has none at all.
      var hideBlank = linesLocked();
      var linesHtml = state.lines.map(function (l, r) {
        if (l.custom) return customRowHtml(l.custom, r);
        return hideBlank && !l.productId ? "" : lineRowHtml(l, r);
      }).join("");
      if (hideBlank && !linesHtml) {
        linesHtml = '<div class="fop-line fop-line--empty" role="row"><div class="fop-cell fop-muted" role="cell">No lines on this order.</div></div>';
      }
      return (
        // Side layout widens the page only while the card is open; closed, it
        // is the same centred width as the regular page.
        '<div class="fop-wrap fop-wrap--wide' + (sideLayout && stockShown() ? " fop-wrap--sideopen" : "") + '">' +
        '<div class="fop-top">' +
        '<div>' + orderTitleHtml() + "</div>" +
        // Existing orders: Exit sits right of Change log in the switcher row
        // (2026-10-19, on request); new orders keep it here.
        (state.existing ? "" : '<div class="fop-row">' + exitBtnHtml() + "</div>") +
        "</div>" +
        switcherHtml() +
        existingNoteHtml() +
        // Side layout: bill-to/ship-to, lines and header in the left column,
        // the stock / qty breaks card in the right column beside all three.
        (sideLayout ? '<div class="fop-split' + (stockShown() ? "" : " fop-split--closed") + '"><div class="fop-split__main">' : "") +
        customerSummaryHtml() +
        '<div class="fop-grid' + (inlineLayout ? "" : " fop-grid--noall") + (detailsLayout ? " fop-grid--details" : "") + (noStock() ? " fop-grid--nostock" : "") + (linesLocked() ? " fop-grid--locked" : "") + '" role="table" aria-label="Order lines">' +
        // "Lines" title like the Bill to / Ship to cards (phones, locked orders only).
        '<div class="fop-lines-lbl" aria-hidden="true"><span class="fop-party__lbl">Lines</span></div>' +
        '<div class="fop-line fop-line--head" role="row">' +
        '<div class="fop-cell fop-cell--num">#</div><div class="fop-cell fop-cell--product">Product</div>' +
        '<div class="fop-cell fop-cell--desc">Description</div><div class="fop-cell fop-cell--qty">Qty</div>' +
        '<div class="fop-cell fop-cell--price">Unit price</div><div class="fop-cell fop-cell--cost">Unit cost</div>' +
        '<div class="fop-cell fop-cell--ext">Ext.</div>' +
        // Invoiced / cancelled: no Br / All columns, so the numbers sit against
        // the right edge (.fop-grid--nostock).
        (noStock() ? "" : '<div class="fop-cell fop-cell--stock">Br ' + esc(state.header.shipBranch || "-") + "</div>" +
          (inlineLayout ? '<div class="fop-cell fop-cell--stock">All</div>' : "")) + '<div class="fop-cell fop-cell--del"></div>' +
        "</div>" + linesHtml + "</div>" +
        // Under the lines: grid buttons left, the totals summary box right.
        '<div class="fop-gridfoot"><div class="fop-row fop-gridtools">' +
        (linesLocked() ? "" : '<button class="fop-btn fop-btn--ghost fop-btn--sm" data-action="add-line">+ Add line <span class="fop-key">Ins</span></button>') +
        // Custom lines: new orders and bids (they go to Eclipse as product 15680).
        (linesLocked() ? "" : '<button class="fop-btn fop-btn--ghost fop-btn--sm" data-action="add-custom">+ Custom line</button>') +
        // Stock & qty breaks button: side layout only.
        (noStock() || !sideLayout ? "" : '<button class="fop-btn fop-btn--ghost fop-btn--sm' + (stockShown() ? " fop-btn--on" : "") + '" data-action="toggle-stock" aria-pressed="' + stockShown() + '">' +
        (stockShown() ? "Hide" : "Show") + ' stock &amp; qty breaks <span class="fop-key">' + altKey("S") + '</span></button>') +
        "</div>" + '<div class="fop-sum" data-cell="summary" aria-label="Order totals">' + summaryHtml() + "</div></div>" +
        '<div class="fop-credit-tag--sum" data-cell="credit-tag">' + creditTagHtml() + "</div>" +
        // Order header sits below the lines (user request).
        headerHtml() +
        // Error + action bar: in the side layout they stay in the left column
        // (under the header), so the stock card's column runs the full height.
        (state.placeError ? '<div class="fop-alert fop-alert--error">' + esc(state.placeError) + "</div>" : "") +
        '<div data-cell="quote-error">' + (state.quoteError ? '<div class="fop-alert fop-alert--error">' + esc(state.quoteError) + "</div>" : "") + "</div>" +
        '<div class="fop-bar">' +
        '<div class="fop-bar__totals" data-cell="totals">' + totalsHtml() + "</div>" +
        '<div class="fop-bar__actions">' + lastModifiedHtml() + actionsHtml() + "</div></div>" +
        // Keyboard legend sits under the action bar (moved out of it on request).
        '<div class="fop-legend"><span class="fop-key">↑↓←→</span> move <span class="fop-key">Enter</span> next ' +
        '<span class="fop-key">Ins</span> add <span class="fop-key">Ctrl+Del</span> remove ' +
        (noStock() || !sideLayout ? "" : '<span class="fop-key">' + altKey("S") + '</span> stock &amp; breaks ') +
        (detailsLayout ? '<span class="fop-key">' + altKey("D") + '</span> line details ' : "") + '<span class="fop-key">' + altKey("H") + '</span> header <span class="fop-key">' + altKey("L") + '</span> lines ' +
        '<span class="fop-key">' + altKey("I") + '</span> shipping instructions <span class="fop-key">' + altKey("N") + '</span> internal notes <span class="fop-key">' + altKey("Q") + '</span> exit</div>' +
        (sideLayout ? "</div>" + (stockShown() ? '<aside class="fop-side" data-cell="side" aria-label="Stock and quantity breaks">' + sideHtml() + "</aside>" : "") + "</div>" : "") +
        (state.confirm ? confirmHtml() : "") +
        (state.customModal ? customModalHtml() : "") +
        (state.detailsModal ? detailsModalHtml() : "") +
        (state.cancelAsk ? cancelHtml() : "") +
        (state.logModal ? changeLogHtml() : "") +
        (state.quoteModal ? quoteModalHtml() : "") +
        "</div>"
      );
    }

    // Alt+B → fixed Bid. Alt+O → the rep picks the order status here (it is not
    // in the header); Bid is not one of the choices.
    function confirmIsBid() {
      return state.confirm.mode === "bid";
    }

    // Place Order or Convert to Order (not a bid).
    function confirmIsOrder() {
      return !!state.confirm && (state.confirm.mode === "order" || state.confirm.mode === "convert");
    }

    // The statuses the dialog offers: Place Order and Convert to Order with
    // ship via CPU PICK UP add "6. Pick Up Now".
    function confirmStatuses() {
      var pickUp = confirmIsOrder() && state.header.shipVia === PICK_UP_SHIP_VIA;
      return pickUp ? ORDER_STATUSES.concat([PICK_UP_NOW]) : ORDER_STATUSES;
    }

    function isPickUpNow() {
      return confirmIsOrder() && state.header.orderStatus === PICK_UP_NOW[1];
    }

    // Printers at the order's ship branch (location is ignored).
    function branchPrinters() {
      return PRINTERS[branchIdOf(state.header.shipBranch)] || [];
    }

    function statusPickerHtml() {
      var h = state.header;
      var list = confirmStatuses();
      return '<div class="fop-field fop-confirm-status"><label class="fop-label" for="fop-confirm-status">Order status ' +
        '<span class="fop-muted">(↑↓ or 1–' + list.length + ")</span></label>" +
        '<select class="fop-input" id="fop-confirm-status" data-head="orderStatus">' +
        // Starts on "Select…"; placing with it blank flashes the box.
        '<option value="" disabled' + (h.orderStatus ? "" : " selected") + ">Select…</option>" +
        list.map(function (o, i) {
          return '<option value="' + esc(o[1]) + '"' + (o[1] === h.orderStatus ? " selected" : "") + ">" + (i + 1) + ". " + esc(o[0]) + "</option>";
        }).join("") + "</select></div>" +
        (isPickUpNow() ? printerPickerHtml() : "");
    }

    // Pick Up Now: the printer at the ship branch that prints the order.
    function printerPickerHtml() {
      var pid = state.confirm.printerId || "";
      var list = branchPrinters();
      var br = branchIdOf(state.header.shipBranch);
      return '<div class="fop-field fop-confirm-status"><label class="fop-label" for="fop-confirm-printer">Printer ' +
        '<span class="fop-muted">(branch ' + esc(br || "--") + ")</span></label>" +
        '<select class="fop-input" id="fop-confirm-printer">' +
        '<option value="" disabled' + (pid ? "" : " selected") + ">" + (list.length ? "Select…" : "No printers for this branch") + "</option>" +
        list.map(function (p) {
          return '<option value="' + p[0] + '"' + (String(p[0]) === pid ? " selected" : "") + ">" + esc(p[1]) + " (" + p[0] + ")</option>";
        }).join("") + "</select></div>";
    }

    // Keep the dialog title and button in step with the picked status.
    function refreshConfirmText() {
      var isBid = confirmIsBid();
      var placing = state.confirm.mode === "bid" || state.confirm.mode === "order";
      var title = root.querySelector("#fop-confirm-title");
      var btn = root.querySelector("[data-action=confirm-place]");
      if (title && placing) title.textContent = isBid ? "Place as Bid?" : "Place Order?";
      if (btn && placing && !state.placing) btn.innerHTML = (isBid ? "Place Bid" : isPickUpNow() ? "Print Now" : "Place Order") + ' <span class="fop-key fop-key--dark">Enter</span>';
      if (btn) {
        if (needsStatus()) { btn.setAttribute("aria-disabled", "true"); btn.title = "Pick an order status."; }
        else if (needsPrinter()) { btn.setAttribute("aria-disabled", "true"); btn.title = "Pick a printer."; }
        else { btn.removeAttribute("aria-disabled"); btn.removeAttribute("title"); }
      }
    }

    // An order (not a bid) with no status picked yet: Place Order is grayed
    // out (aria-disabled, so a click still reaches place() and flashes the box).
    function needsStatus() {
      return state.confirm && (state.confirm.mode === "order" || state.confirm.mode === "convert") && !state.header.orderStatus;
    }

    // Pick Up Now with no printer picked yet: Print Now is grayed out the same way.
    function needsPrinter() {
      return isPickUpNow() && !state.confirm.printerId;
    }

    // A line's comment under its description in the confirm dialogs.
    function commentNoteHtml(l) {
      var c = lineComment(l);
      return c ? '<span class="fop-muted fop-block fop-confirm-comment">' + (l.orig ? "Add comment: " : "Comment: ") + esc(c) + "</span>" : "";
    }

    // Several ship branches: the Br column in the confirm tables and a note
    // that each branch is its own generation.
    function branchesNoteHtml(what) {
      var bs = orderBranches();
      if (bs.length < 2) return "";
      return '<div class="fop-alert fop-alert--info">The lines ship from ' + bs.length + " branches (" + esc(bs.join(", ")) +
        "), so this " + what + " one generation per branch.</div>";
    }

    function brCellHtml(l, on) {
      return on ? '<td class="fop-num">' + esc(lineBranch(l)) + "</td>" : "";
    }

    function confirmHtml() {
      if (state.confirm.mode === "update" || state.confirm.mode === "convert") return updateConfirmHtml();
      var h = state.header;
      var isBid = confirmIsBid();
      var t = orderTotal();
      var multi = orderBranches().length > 1;
      // Regular and custom lines in page order.
      var nCustom = customLines().length;
      var rows = sentLines().map(function (l) {
        if (l.custom) {
          var cl = l.custom;
          return '<tr><td><span class="fop-badge">Custom</span> ' + esc(cl.idealSku) + "</td><td>" + esc(cl.name) +
            "</td>" + brCellHtml(l, multi) + '<td class="fop-num">' + cl.qty + '</td><td class="fop-num">' + money(cl.price * cl.qty) + "</td></tr>";
        }
        var p = linePrice(l);
        return "<tr><td>" + pidCellHtml(l.productId) + "</td><td>" + esc(l.description) + commentNoteHtml(l) + "</td>" + brCellHtml(l, multi) + '<td class="fop-num">' + esc(l.qty) +
          '</td><td class="fop-num">' + (p == null ? "Eclipse price" : money(p * Number(l.qty))) + "</td></tr>";
      }).join("");
      return (
        '<div class="fop-modal" role="dialog" aria-modal="true" aria-labelledby="fop-confirm-title">' +
        '<div class="fop-modal__box">' +
        '<h2 class="fop-h2" id="fop-confirm-title">' + (isBid ? "Place as Bid?" : "Place Order?") + "</h2>" +
        (nCustom ? '<div class="fop-alert fop-alert--info">' + nCustom + " custom line" +
          (nCustom > 1 ? "s" : "") + " included, so this can only be placed as a bid.</div>" : "") +
        branchesNoteHtml("places") +
        '<div class="fop-confirm-meta">' +
        "<div><span>Ship-to</span> " + esc(state.shipTo.name) + " (" + esc(state.shipTo.e_customer_id) + ")</div>" +
        "<div><span>Price level</span> " + esc(state.customer.bill_to.price_class || "Unknown") + "</div>" +
        "<div><span>Branch</span> " + esc(multi ? orderBranches().join(", ") : h.shipBranch) + "</div>" +
        "<div><span>Ship via</span> " + esc(h.shipVia || "None") + "</div>" +
        "<div><span>Ship / Req</span> " + esc(h.shipDate) + " / " + esc(h.requiredDate) + "</div>" +
        (h.po ? "<div><span>PO</span> " + esc(h.po) + "</div>" : "") +
        "</div>" +
        (state.confirm.mode === "order" ? statusPickerHtml() : "") +
        '<div class="fop-table-wrap"><table class="fop-table"><thead><tr><th>Product</th><th>Description</th>' + (multi ? '<th class="fop-num">Br</th>' : "") +
        '<th class="fop-num">Qty</th><th class="fop-num">Ext.</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        (freightInValue() ? '<div class="fop-confirm-total fop-confirm-freight">Freight in ' + money(freightInValue()) + "</div>" : "") +
        '<div class="fop-confirm-total">Total ' + money(t.total + freightInValue()) + (t.unknown ? " + Eclipse pricing" : "") + "</div>" +
        (state.placeError ? '<div class="fop-alert fop-alert--error">' + esc(state.placeError) + "</div>" : "") +
        '<div class="fop-row fop-row--end">' +
        '<button class="fop-btn fop-btn--ghost" data-action="cancel-place"' + (state.placing ? " disabled" : "") + ">Back <span class=\"fop-key\">Esc</span></button>" +
        '<button class="fop-btn" data-action="confirm-place"' + (state.placing ? " disabled" : "") +
        (needsStatus() ? ' aria-disabled="true" title="Pick an order status."' : needsPrinter() ? ' aria-disabled="true" title="Pick a printer."' : "") + ">" +
        (state.placing ? (isPickUpNow() ? "Fake printing..." : "Placing…") : (isBid ? "Place Bid" : isPickUpNow() ? "Print Now" : "Place Order") + ' <span class="fop-key fop-key--dark">Enter</span>') +
        "</button></div></div></div>"
      );
    }

    // Update Bid and Convert to Order: the header changes, each line marked
    // New / Changed / Comment / branch, the lines that will be removed and,
    // when the bid moves to another generation, why. Convert to Order adds
    // the status picker and the generations it converts; it saves the same
    // changes first (one update-bid call).
    function updateConfirmHtml() {
      var ex = state.existing;
      var convert = state.confirm.mode === "convert";
      var ch = bidChanges();
      var t = orderTotal();
      var home = branchIdOf(ex.ship_branch);
      var multi = orderBranches().length > 1 || orderBranches()[0] !== home;
      var rows = filledLines().map(function (l) {
        var p = linePrice(l);
        var tags = [];
        if (!l.orig) tags.push("New");
        else if (Number(l.qty) !== l.orig.qty || (p != null && (l.orig.price == null || Math.abs(p - l.orig.price) >= 0.0005))) tags.push("Changed");
        if (l.orig && lineComment(l)) tags.push("Comment added");
        if (lineBranch(l) !== home) tags.push("To branch " + lineBranch(l));
        return "<tr><td>" + pidCellHtml(l.productId) + "</td><td>" + esc(l.description) + commentNoteHtml(l) + "</td>" + brCellHtml(l, multi) + '<td class="fop-num">' + esc(l.qty) +
          '</td><td class="fop-num">' + (p == null ? "Eclipse price" : money(p * Number(l.qty))) + '</td><td class="fop-muted">' + esc(tags.join(" · ")) + "</td></tr>";
      }).join("");
      rows += customLines().map(function (l) {
        var cl = l.custom;
        return '<tr><td><span class="fop-badge">Custom</span> ' + esc(cl.idealSku) + "</td><td>" + esc(cl.name) + "</td>" + brCellHtml(l, multi) +
          '<td class="fop-num">' + cl.qty + '</td><td class="fop-num">' + money(cl.price * cl.qty) + '</td><td class="fop-muted">New</td></tr>';
      }).join("");
      var kept = {};
      filledLines().forEach(function (l) { if (l.orig) kept[l.orig.lineId] = true; });
      rows += (ex.lines || []).filter(function (l) { return !kept[l.line_id]; }).map(function (l) {
        return '<tr class="fop-row--removed"><td>' + pidCellHtml(l.product_id) + "</td><td>" + esc(l.description) + "</td>" + (multi ? "<td></td>" : "") + '<td class="fop-num">' + esc(l.qty) +
          '</td><td class="fop-num">-</td><td class="fop-warn-text">Removed</td></tr>';
      }).join("");
      var summary = [ch.added && ch.added + " added", ch.changed && ch.changed + " changed", ch.commented && ch.commented + " commented",
        ch.moved && ch.moved + " to another branch", ch.removed && ch.removed + " removed", ch.head.length && ch.head.length + " header field" + (ch.head.length > 1 ? "s" : "")]
        .filter(Boolean).join(" · ");
      // A new required date, or no line left on the bid's branch, moves the
      // lines to another generation and cancels this one.
      var h = state.header;
      var leaves = h.requiredDate !== (ex.required_date || "") || !filledLines().concat(customLines()).some(function (l) { return lineBranch(l) === home; });
      var gens = convert ? ((state.order && state.order.generations) || []).filter(function (g) { return g.status === "Bid"; }).map(function (g) { return g.e_sorder_id; }) : [];
      return (
        '<div class="fop-modal" role="dialog" aria-modal="true" aria-labelledby="fop-confirm-title">' +
        '<div class="fop-modal__box">' +
        '<h2 class="fop-h2" id="fop-confirm-title">' + (convert ? "Convert bid " + esc(ex.e_sorder_id) + " to an order?" : "Update bid " + esc(ex.e_sorder_id) + "?") + "</h2>" +
        (convert ? statusPickerHtml() +
          '<div class="fop-muted fop-confirm-gens">Converts ' + (gens.length > 1 ? "every bid generation: " : "") + esc(gens.join(", ") || ex.e_sorder_id) + "." +
          (ch.any ? " The changes below are saved first." : "") + "</div>" : "") +
        (ch.any ? '<div class="fop-muted">' + esc(summary) + ".</div>" : "") +
        (ch.head.length ? '<ul class="fop-confirm-head">' + ch.head.map(function (x) {
          return "<li><span>" + esc(x.label) + "</span> " + esc(x.from || "--") + " → " + esc(x.to || "--") + "</li>";
        }).join("") + "</ul>" : "") +
        (ch.any && leaves ? '<div class="fop-alert fop-alert--info">Eclipse can\'t change a generation\'s ship branch or required date, so the lines move to ' +
          "a generation that has them (a new one if needed) and " + esc(ex.e_sorder_id) + " is cancelled.</div>" : "") +
        (ch.any && !leaves && ch.moved ? '<div class="fop-alert fop-alert--info">Lines for another branch move to that branch\'s generation (a new one if needed).</div>' : "") +
        (ch.commented ? '<div class="fop-muted">A line that gets a comment is re-created in Eclipse with the same product, qty and price (Eclipse can\'t edit the comments of a line).</div>' : "") +
        '<div class="fop-table-wrap"><table class="fop-table"><thead><tr><th>Product</th><th>Description</th>' + (multi ? '<th class="fop-num">Br</th>' : "") +
        '<th class="fop-num">Qty</th><th class="fop-num">Ext.</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        '<div class="fop-confirm-total">Total ' + money(t.total) + (t.unknown ? " + Eclipse pricing" : "") + "</div>" +
        (state.placeError ? '<div class="fop-alert fop-alert--error">' + esc(state.placeError) + "</div>" : "") +
        '<div class="fop-row fop-row--end">' +
        '<button class="fop-btn fop-btn--ghost" data-action="cancel-place"' + (state.placing ? " disabled" : "") + ">Back <span class=\"fop-key\">Esc</span></button>" +
        '<button class="fop-btn" data-action="confirm-place"' + (state.placing ? " disabled" : "") +
        (needsStatus() ? ' aria-disabled="true" title="Pick an order status."' : needsPrinter() ? ' aria-disabled="true" title="Pick a printer."' : "") + ">" +
        (state.placing ? (isPickUpNow() ? "Fake printing..." : convert ? "Converting…" : "Updating…") : (convert ? (isPickUpNow() ? "Print Now" : "Convert to Order") : "Update Bid") + ' <span class="fop-key fop-key--dark">Enter</span>') +
        "</button></div></div></div>"
      );
    }

    function viewDone() {
      var r = state.result || {};
      var c = state.customer || {};
      var hsId = (c.customer && c.customer.hs_id) || "";
      // Deal id comes back from create-order (via update-hs-deal); empty when
      // the HubSpot sync failed or had not made the deal yet.
      var dealId = r.hs_deal_id || "";
      var soId = esc(r.e_sorder_id || r.order_id || "(no id returned)");
      var title = { bid: "Bid placed", order: "Order placed", update: "Bid updated", cancel: r.what === "bid" ? "Bid cancelled" : "Order cancelled" }[r.mode];
      var msg = r.mode === "update"
        ? (r.unchanged ? "Eclipse sales order <b>" + soId + "</b> already matched; nothing was changed."
          : "Eclipse sales order <b>" + soId + "</b> was updated.")
        : r.mode === "cancel" ? "Eclipse sales order <b>" + soId + "</b> was cancelled."
        : "Eclipse sales order <b>" + soId + "</b> was created for " + esc(state.shipTo ? state.shipTo.name : "") + ".";
      return (
        '<div class="fop-wrap fop-wrap--narrow">' + titleHtml("Order Placement", title) +
        '<div class="fop-alert fop-alert--success">' + msg + "</div>" +
        (r.hubspot_sync && r.hubspot_sync.ok === false
          ? '<div class="fop-alert fop-alert--warning">HubSpot sync did not start: ' + esc(r.hubspot_sync.error) + ". The deal will appear on the next scheduled sync.</div>"
          : "") +
        '<div class="fop-row">' +
        (r.mode === "update" ? '<button class="fop-btn fop-btn--ghost" data-action="reload-order">Back to bid</button>' : "") +
        (r.mode === "cancel" ? '<button class="fop-btn fop-btn--ghost" data-action="reload-order">Back to order</button>' : "") +
        '<button class="fop-btn" data-action="new-order">New order, same ship-to <span class="fop-key fop-key--dark">' + altKey("N") + '</span></button>' +
        '<button class="fop-btn fop-btn--ghost" data-action="change-customer">Change customer</button>' +
        (dealId ? '<a class="fop-btn fop-btn--ghost" href="' + HS_DEAL + encodeURIComponent(dealId) + '" target="_blank" rel="noopener">HS Deal ' + EXT_ICON + "</a>" : "") +
        (hsId ? '<a class="fop-btn fop-btn--ghost" href="' + HS_COMPANY + encodeURIComponent(hsId) + '" target="_blank" rel="noopener">HS Customer ' + EXT_ICON + "</a>" : "") +
        "</div></div>"
      );
    }

    // ── Targeted updates (no re-render) ────────────────────────────────────

    function rowEl(r) { return root.querySelector('.fop-line[data-row="' + r + '"]'); }

    function refreshRow(r, opts) {
      var el = rowEl(r);
      var line = state.lines[r];
      if (!el || !line || line.custom) return;
      if (sideLayout) refreshSide();
      el.querySelector('[data-cell="desc"]').innerHTML = descHtml(line);
      el.querySelector('[data-cell="cost"]').innerHTML = costHtml(line);
      el.querySelector('[data-cell="ext"]').innerHTML = extHtml(line);
      var availCell = el.querySelector('[data-cell="avail"]');
      if (availCell) availCell.innerHTML = availHtml(line);
      var totalCell = el.querySelector('[data-cell="total"]');
      if (totalCell) totalCell.innerHTML = totalStockHtml(line);
      refreshStrips(r);
      var dBtn = el.querySelector('[data-cell="details-btn"]');
      if (dBtn) dBtn.innerHTML = detailsBtnHtml(line, r);
      // Line details dialog open on this line: redraw its stock and breaks.
      if (state.detailsModal && state.detailsModal.r === r) {
        var ds = root.querySelector('[data-cell="details-stock"]');
        var db = root.querySelector('[data-cell="details-breaks"]');
        if (ds) ds.innerHTML = stockStripHtml(line, true, r);
        if (db) db.innerHTML = breaksStripHtml(line);
        ["cost", "ext", "desc"].forEach(function (k) {
          var c = root.querySelector('[data-cell="details-' + k + '"]');
          if (c) c.innerHTML = k === "cost" ? costHtml(line) : k === "ext" ? extHtml(line) : descHtml(line);
        });
        var dp = root.querySelector('[data-dm="price"]');
        if (dp) {
          dp.classList.toggle("fop-input--override", line.priceOverride && !line.keepPrice);
          if (!(opts && opts.keepPrice) && document.activeElement !== dp) dp.value = priceText(line);
        }
      }
      // A focused qty box keeps what the rep is typing.
      var qtyIn = el.querySelector('[data-c="1"]');
      if (qtyIn && document.activeElement !== qtyIn) showQty(r);
      var priceIn = el.querySelector('[data-c="2"]');
      if (priceIn && !(opts && opts.keepPrice) && document.activeElement !== priceIn) {
        priceIn.value = priceText(line);
      }
      refreshTotals();
    }

    // Inline layout: show or hide line r's strips (stock, qty breaks,
    // comment). Stock and breaks are redrawn; the comment box is never
    // redrawn, only shown / hidden, so it keeps its text and focus.
    function refreshStrips(r) {
      var el = rowEl(r);
      var line = state.lines[r];
      if (!inlineLayout || !el || !line) return;
      var on = stripShown(r);
      var strip = el.querySelector('[data-cell="strip"]');
      var brk = el.querySelector('[data-cell="breaks"]');
      var cm = el.querySelector('[data-cell="comment"]');
      var stockOn = on && !isItemLine(line);
      if (strip) { strip.hidden = !stockOn; if (stockOn) strip.innerHTML = stockStripHtml(line, false, r); }
      if (brk) { brk.hidden = !stockOn; if (stockOn) brk.innerHTML = breaksStripHtml(line); }
      if (cm) {
        var wasHidden = cm.hidden;
        cm.hidden = !on;
        var ta = cm.querySelector("textarea");
        if (on && wasHidden && ta) autosize(ta);
      }
    }

    // Inline layout: move the strips to the newly focused line.
    function moveStrips() {
      if (!inlineLayout || stripRow === state.focus.r) return;
      var old = stripRow;
      stripRow = state.focus.r;
      if (old >= 0) refreshStrips(old);
      refreshStrips(stripRow);
    }

    // Inline layout: select line r and put the cursor at the end of its line
    // comment; a line with no comment box (no product, or a loaded line)
    // just gets its product cell focused.
    function focusLineComment(r) {
      var line = state.lines[r];
      if (!line || line.custom) return;
      state.focus = { r: r, c: state.focus.c };
      moveStrips();
      var el = rowEl(r);
      var ta = el && el.querySelector("[data-comment]");
      // Phones, comment still folded: just select the line.
      if (ta && !ta.closest("[hidden]") && ta.offsetParent === null) return;
      if (ta && !ta.closest("[hidden]")) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } else focusCell(r, 0);
    }

    function refreshTotals() {
      var t = root.querySelector('[data-cell="totals"]');
      if (t) t.innerHTML = totalsHtml();
      // New order: only the total, so the freight input keeps focus.
      var sm = root.querySelector('[data-cell="summary"]');
      var st = sm && sm.querySelector('[data-cell="sum-total"]');
      if (sm && !state.existing && st) st.innerHTML = sumTotalHtml(summary());
      else if (sm) sm.innerHTML = summaryHtml();
      var ct = root.querySelector('[data-cell="credit-tag"]');
      if (ct) ct.innerHTML = creditTagHtml();
      var bid = root.querySelector("[data-action=place-bid]");
      var ord = root.querySelector("[data-action=place-order]");
      var upd = root.querySelector("[data-action=update-bid]");
      var conv = root.querySelector("[data-action=convert-bid]");
      if (bid) setSoftDisabled(bid, placeBlockedReason("bid"));
      if (ord) setSoftDisabled(ord, placeBlockedReason("order"));
      if (upd) setSoftDisabled(upd, placeBlockedReason("update"));
      if (conv) setSoftDisabled(conv, placeBlockedReason("convert"));
      refreshQuoteBtn();
      // Lines on several branches: the hint under Ship branch.
      var hint = root.querySelector('[data-cell="branch-hint"]');
      if (hint) hint.innerHTML = branchHintHtml();
    }

    // Looks disabled but still takes clicks (every place / bid button), so a
    // blocked click can flash the field at fault.
    function setSoftDisabled(btn, reason) {
      if (reason) { btn.setAttribute("aria-disabled", "true"); btn.title = reason; }
      else { btn.removeAttribute("aria-disabled"); btn.removeAttribute("title"); }
    }

    function refreshLinesFor(pid) {
      if (state.view !== "order") return;
      state.lines.forEach(function (l, r) {
        if (String(l.productId) === String(pid)) refreshRow(r);
      });
    }

    function refreshAllRows() {
      state.lines.forEach(function (l, r) { refreshRow(r); });
      var head = root.querySelector(".fop-line--head .fop-cell--stock");
      if (head) head.textContent = noStock() ? "" : "Br " + (state.header.shipBranch || "-");
    }

    // ── Grid focus + line ops ──────────────────────────────────────────────

    // Product id tile on an editable line (lineRowHtml): on shows the tile
    // (only while the line has a product), off shows the product box.
    function tileProduct(r, on) {
      var el = rowEl(r);
      var cell = el && el.querySelector(".fop-cell--product");
      var line = state.lines[r];
      var tile = cell && cell.querySelector(".fop-pid");
      if (!tile || !line) return;
      tile.textContent = pidText(line);
      cell.classList.toggle("fop-cell--tiled", !!(on && line.productId));
    }

    function cellInput(r, c) {
      return root.querySelector('.fop-grid-in[data-r="' + r + '"][data-c="' + c + '"]');
    }

    // The nearest line from r in direction dir (1 / -1) that has inputs
    // (custom lines have none), or -1.
    function nextGridRow(r, dir) {
      for (; r >= 0 && r < state.lines.length; r += dir) if (!state.lines[r].custom) return r;
      return -1;
    }

    function focusCell(r, c) {
      r = Math.max(0, Math.min(state.lines.length - 1, r));
      // Step over custom lines in the direction of travel, else the other way.
      var dir = r >= state.focus.r ? 1 : -1;
      var g = nextGridRow(r, dir);
      if (g < 0) g = nextGridRow(r, -dir);
      if (g < 0) return;
      r = g;
      c = Math.max(0, Math.min(COLS.length - 1, c));
      var el = cellInput(r, c);
      if (!el) return;
      state.focus = { r: r, c: c };
      // Phones: a focused field already sits in view (it's a card the rep
      // just tapped near, not an off-screen grid cell), so don't let focus()
      // scroll the page out from under them when the keyboard opens.
      if (window.matchMedia && window.matchMedia("(max-width: 767px), (hover: none) and (pointer: coarse)").matches) el.focus({ preventScroll: true });
      else el.focus();
      if (el.select) el.select();
    }

    function addLine(after) {
      var idx = after == null ? state.lines.length : after + 1;
      state.lines.splice(idx, 0, newLine());
      state.focus = { r: idx, c: 0 };
      render();
    }

    function removeLine(r) {
      if (state.lines.length <= 1) {
        state.lines = [newLine()];
        state.focus = { r: 0, c: 0 };
      } else {
        state.lines.splice(r, 1);
        // Keep at least one regular line to type into (custom lines have none).
        if (nextGridRow(0, 1) < 0) state.lines.push(newLine());
        state.focus = { r: Math.min(r, state.lines.length - 1), c: state.focus.c };
      }
      render();
    }

    function setProduct(r, product) {
      var line = state.lines[r];
      line.productId = String(product.e_product_id);
      line.description = product.description || "";
      line.uom = product.uom || "";
      line.orderUm = "";
      line.lookingUp = false;
      line.notFound = false;
      line.priceOverride = false;
      line.keepPrice = false;
      line.price = null;
      // A new product on a loaded bid line is a new line; the old one is removed.
      line.orig = null;
      line.orderCost = null;
      line.eclipseComments = null;
      fetchQuote(line.productId);
      // Keep a blank line at the bottom so the rep can keep typing.
      if (r === state.lines.length - 1) state.lines.push(newLine());
      state.focus = { r: r, c: 1 };
      render();
    }

    function setQty(r, raw) {
      var n = Math.round(Number(raw));
      state.lines[r].qty = isFinite(n) && n > 0 ? n : 1;
      refreshRow(r);
    }

    function setPrice(r, raw) {
      var line = state.lines[r];
      var s = String(raw).replace(/[$,\s]/g, "");
      if (line.keepPrice && s !== "" && Math.abs(Number(s) - line.price) < 0.0005) {
        // Unchanged price on a loaded bid line: keep the bid's own price.
      } else if (s === "") {
        line.keepPrice = false;
        line.priceOverride = false;
        line.priceRaised = false;
        line.priceCapped = false;
        line.price = null;
      } else if (isFinite(Number(s)) && Number(s) >= 0) {
        line.keepPrice = false;
        var auto = line.priceOverride ? null : linePrice(line);
        var v = Math.round(Number(s) * 1000) / 1000;
        var m = minPrice(line);
        line.priceRaised = m != null && v < m;
        if (line.priceRaised) v = m;
        // Ceiling: never let the rep raise a price above the original unit
        // price (checked after the floor, so a line priced under cost still
        // gets raised to the floor even if that is above the ceiling).
        var mx = maxPrice(line);
        line.priceCapped = mx != null && v > mx;
        if (line.priceCapped) v = mx;
        if (auto == null || Math.abs(v - auto) >= 0.0005) {
          line.priceOverride = true;
          line.price = v;
        }
      }
      var input = cellInput(r, 2);
      if (input) input.classList.toggle("fop-input--override", line.priceOverride && !line.keepPrice);
      refreshRow(r, { keepPrice: true });
    }

    // ── Autocomplete (customer search + product cells) ─────────────────────

    // One open list at a time. ac = { input, list, items, active, kind, r }
    var ac = null;

    function acClose() {
      if (!ac) return;
      ac.list.classList.remove("fop-ac__list--open");
      ac.list.innerHTML = "";
      ac.input.setAttribute("aria-expanded", "false");
      ac = null;
    }

    function acRender(input, kind, r, items, message) {
      var list = input.parentNode.querySelector(".fop-ac__list");
      if (!ac || ac.input !== input) {
        acClose();
        ac = { input: input, list: list, kind: kind, r: r, items: [], active: 0 };
      }
      ac.items = items || [];
      ac.active = 0;
      if (message) {
        list.innerHTML = '<div class="fop-ac__msg">' + esc(message) + "</div>";
      } else {
        list.innerHTML = ac.items.map(function (it, i) {
          var badge = kind === "customer" ? it.e_customer_id : it.e_product_id;
          var label = kind === "customer" ? it.name : it.description;
          return '<div class="fop-ac__item' + (i === 0 ? " fop-ac__item--active" : "") + '" data-ac="' + i + '" role="option">' +
            '<span class="fop-badge">' + esc(badge) + "</span> " + esc(label || "-") + "</div>";
        }).join("");
      }
      list.classList.add("fop-ac__list--open");
      input.setAttribute("aria-expanded", "true");
    }

    function acMove(delta) {
      if (!ac || !ac.items.length) return;
      ac.active = (ac.active + delta + ac.items.length) % ac.items.length;
      var els = ac.list.querySelectorAll(".fop-ac__item");
      for (var i = 0; i < els.length; i++) els[i].classList.toggle("fop-ac__item--active", i === ac.active);
      if (els[ac.active]) els[ac.active].scrollIntoView({ block: "nearest" });
    }

    function acPick(i) {
      if (!ac || !ac.items[i]) return;
      var kind = ac.kind, r = ac.r, item = ac.items[i];
      acClose();
      if (kind === "customer") loadCustomer(item.e_customer_id);
      else if (kind === "variation") pickVariation(item);
      else setProduct(r, item);
    }

    // Custom line dialog: the product picked as "Existing product".
    function pickVariation(item) {
      var m = state.customModal;
      if (!m) return;
      m.draft.variationSku = m.draft.pickedSku = String(item.e_product_id);
      m.draft.variationDesc = item.description || "";
      var inp = root.querySelector("#fop-cf-variationSku");
      if (inp) inp.value = m.draft.variationSku;
      tileVariation(true);
      // A blank Name takes the product's; price and COGS fill when its
      // pricing arrives (refreshCustomOrig).
      if (!m.draft.name.trim() && m.draft.variationDesc) {
        m.draft.name = m.draft.variationDesc.slice(0, 120);
        var nm = root.querySelector("#fop-cf-name");
        if (nm) nm.value = m.draft.name;
      }
      fetchQuote(m.draft.variationSku);
      refreshCustomOrig();
      var sn = root.querySelector("#fop-cf-serial");
      if (sn) sn.focus();
    }

    var acSearch = debounce(function (input, kind, r) {
      var q = input.value.trim();
      // Focus already left (a pick, or a click elsewhere before the delay ran).
      if (document.activeElement !== input) return;
      if (q.length < 2) { acClose(); return; }
      acRender(input, kind, r, [], "Searching…");
      var req = kind === "customer"
        ? getJson(API.inquiry, { e_customer_name: q }).then(function (d) { return d.e_customers || []; })
        : getJson(API.inquiry, { e_customer_id: pricingCustomerId(), e_product_name: q }).then(function (d) { return d.e_products || []; });
      req.then(function (items) {
        if (document.activeElement !== input || input.value.trim() !== q) return;
        acRender(input, kind, r, items, items.length ? null : "No matches");
      }).catch(function (err) {
        if (document.activeElement === input) acRender(input, kind, r, [], "Search failed: " + err.message);
      });
    }, 250);

    // ── Placing ────────────────────────────────────────────────────────────

    // Every placeBlockedReason() message that points at one header field
    // flashes that field (so Alt+B / Alt+O, or a soft-disabled click on
    // Place Order / Convert to Order, always shows the rep exactly what to
    // fix, not just a tooltip on the button). A reason with no single field
    // to blame (no lines, a product not found, custom lines, over the
    // credit limit, no Eclipse user, no changes to save) flashes nothing.
    function flashBlockedField(blocked) {
      var field =
        blocked === "Pick a ship branch." ? "shipBranch" :
        blocked === "Pick a ship via." ? "shipVia" :
        blocked === seeInstructionReason() ? "shippingInstructions" :
        blocked === "Required date cannot be before ship date." ? "requiredDate" : null;
      if (field) flashField(root.querySelector('#fop-head [data-head="' + field + '"]'));
    }

    function requestPlace(mode) {
      if (state.placing) return;
      var blocked = placeBlockedReason(mode);
      if (blocked) {
        flashBlockedField(blocked);
        return;
      }
      // Convert to Order: the status is picked in the dialog (a bid's header
      // holds "Bid" until then).
      if (mode === "convert") state.header.orderStatus = "";
      state.confirm = { mode: mode };
      state.placeError = null;
      render();
    }

    // Flash a box yellow twice (restarts if already flashing), and scroll it
    // into view when it is off screen. Used for a blank Ship via (Place
    // Order) and a blank order status (Place Order in the dialog).
    function flashField(el) {
      if (!el) return;
      el.classList.remove("fop-flash");
      void el.offsetWidth;
      el.classList.add("fop-flash");
      el.addEventListener("animationend", function done() {
        el.classList.remove("fop-flash");
        el.removeEventListener("animationend", done);
      });
      var b = el.getBoundingClientRect();
      if (b.top < 0 || b.bottom > (window.innerHeight || document.documentElement.clientHeight)) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }

    // After a bid or order is placed, a bid updated, or an order cancelled
    // (any status): load it from Eclipse
    // and show it like any existing order, with a note saying what happened. The confirm dialog
    // stays up (Placing… / Updating…) until it has loaded. If the reload
    // fails, the done screen is shown instead (the bid was saved either way).
    function reopenAfterSave(id, data) {
      return getJson(API.order, { e_sorder_id: id })
        .then(function (o) {
          var placed = data.mode === "bid" || data.mode === "order";
          var what = data.what === "bid" ? "Bid " : "Order ";
          state.notice = {
            text: data.mode === "cancel" ? what + (data.e_sorder_id || id) + " cancelled."
              : placed ? (data.mode === "bid" ? "Bid " : "Order ") + (data.e_sorder_id || id) + " placed." + splitNote(data)
              : data.mode === "convert" ? "Bid converted to an order (" + statusLabel(data.status) + ")" + savedAt(o) + "." + movedNote(data)
              : data.unchanged ? "Nothing to update; the bid already matched Eclipse." : "Bid updated" + savedAt(o) + "." + movedNote(data),
            // create-order: a generation for another branch could not be finished.
            warning: data.warning || "",
            hubspotError: data.hubspot_sync && data.hubspot_sync.ok === false ? String(data.hubspot_sync.error || "") : "",
          };
          state.orderId = String(id).toUpperCase();
          state.order = o;
          state.existing = null;   // so openGen does not save the old edits
          state.genEdits = {};
          state.changeLog = null;
          state.logModal = false;
          state.confirm = null;
          state.cancelAsk = false;
          return openGen(o.generation_id);
        })
        .catch(function () {
          state.notice = null;
          state.confirm = null;
          state.cancelAsk = false;
          state.view = "done";
        });
    }

    // " Oct 20, 2026, 9:14 AM CDT": when Eclipse last changed the reloaded
    // order (order-lookup's last_modified, Eclipse lastUpdateDateTime), for
    // the "Bid updated" note; "" when Eclipse sent none.
    function savedAt(o) {
      return o && o.last_modified ? " " + dateTimeText(o.last_modified) : "";
    }

    // Placed on several branches: the other generations, after "… placed."
    function splitNote(data) {
      var gens = (data.generations || []).slice(1);
      if (!gens.length) return "";
      return " One generation per ship branch: " + gens.map(function (g) { return g.e_sorder_id + " (branch " + g.ship_branch + ")"; }).join(", ") + ".";
    }

    // Update Bid / Convert: generations made or cancelled on the way.
    function movedNote(data) {
      var c = data.changes || {};
      var made = (c.generations || []).map(function (g) { return g.e_sorder_id + " (branch " + g.ship_branch + ")"; });
      var out = made.length ? " New generation" + (made.length > 1 ? "s " : " ") + made.join(", ") + "." : "";
      if ((c.cancelled || []).length) out += " " + c.cancelled.join(", ") + " was cancelled; its lines moved.";
      return out;
    }

    // Update Bid, or Convert to Order (orderStatus: the picked status). One
    // update-bid call saves the header and line changes, then converts.
    function updateBid(orderStatus) {
      var ex = state.existing;
      var ch = bidChanges();
      // Started from View Quote: open the quote once the bid is saved.
      var thenQuote = !orderStatus && !!(state.confirm && state.confirm.thenQuote);
      var saved = false;
      state.placing = true;
      state.placeError = null;
      render();
      var body = {
        e_sorder_id: ex.e_sorder_id,
        writer: user.e_user_id,
        header: ch.header,
        lines: ch.lines,
        custom_lines: ch.custom_lines,
      };
      if (orderStatus) body.order_status = orderStatus;
      // Pick Up Now: the printer the rep picked (update-bid does not use it yet).
      if (orderStatus === PICK_UP_NOW[1] && state.confirm && state.confirm.printerId) body.printer_id = Number(state.confirm.printerId);
      postJson(API.updateBid, body)
        .then(function (data) {
          data.mode = orderStatus ? "convert" : "update";
          data.status = orderStatus;
          state.result = data;
          state.ordersList = null;  // the list shows the old totals
          // Back on the bid itself, reloaded from Eclipse.
          saved = true;
          return reopenAfterSave(data.e_sorder_id || ex.e_sorder_id, data);
        })
        .catch(function (err) {
          state.placeError = err.message + (err.data && err.data.step ? " (step: " + err.data.step + ")" : "");
        })
        .then(function () {
          state.placing = false;
          render();
          // Only when the bid reloaded (not the done-screen fallback).
          if (thenQuote && saved && state.view === "order" && state.existing && !quoteNeedsUpdate()) openQuote();
        });
    }

    function cancelOrder() {
      var ex = state.existing;
      state.placing = true;
      state.placeError = null;
      render();
      postJson(API.cancelOrder, { e_sorder_id: ex.e_sorder_id, writer: user.e_user_id })
        .then(function (data) {
          data.mode = "cancel";
          data.what = ex.editable ? "bid" : "order";
          state.result = data;
          state.ordersList = null;  // the list shows the old status
          // Back on the order, now shown as cancelled (the dialog stays on
          // "Cancelling…" until it has loaded).
          return reopenAfterSave(data.e_sorder_id || ex.e_sorder_id, data);
        })
        .catch(function (err) {
          state.placeError = err.message + (err.data && err.data.step ? " (step: " + err.data.step + ")" : "");
        })
        .then(function () {
          state.placing = false;
          render();
        });
    }

    function askCancel() {
      if (state.placing || !state.existing || !state.existing.cancellable) return;
      state.cancelAsk = true;
      state.placeError = null;
      render();
    }

    function closeCancel() {
      if (state.placing) return;
      state.cancelAsk = false;
      state.placeError = null;
      render();
    }

    // Pick Up Now: printing is not wired up yet, so Print Now only pretends
    // (3 seconds of "Fake printing...") and closes the dialog. Nothing is
    // sent to n8n or Eclipse.
    function fakePrint() {
      state.placing = true;
      state.placeError = null;
      render();
      setTimeout(function () {
        state.placing = false;
        state.confirm = null;
        render();
      }, 3000);
    }

    function place() {
      var mode = state.confirm.mode;
      var h = state.header;
      if (mode === "update") { updateBid(); return; }
      // An order needs a status picked in the dialog; blank flashes the box.
      if ((mode === "order" || mode === "convert") && !h.orderStatus) {
        var st = root.querySelector("#fop-confirm-status");
        flashField(st);
        if (st) st.focus();
        return;
      }
      // Pick Up Now needs a printer; blank flashes the printer box.
      if (needsPrinter()) {
        var pr = root.querySelector("#fop-confirm-printer");
        flashField(pr);
        if (pr) pr.focus();
        return;
      }
      if (isPickUpNow()) { fakePrint(); return; }
      if (mode === "convert") { updateBid(h.orderStatus); return; }
      var c = state.customer;
      state.placing = true;
      state.placeError = null;
      render();
      postJson(API.createOrder, {
        bill_to_id: c.bill_to.e_customer_id,
        ship_to_id: state.shipTo.e_customer_id,
        ship_branch: h.shipBranch,
        // price_branch omitted: the flow uses the bill-to's home branch,
        // so changing the ship branch never changes pricing.
        order_status: mode === "bid" ? "Bid" : h.orderStatus,
        ship_via: h.shipVia,
        ship_date: h.shipDate,
        required_date: h.requiredDate,
        po: h.po,
        release: h.release,
        internal_notes: h.internalNotes,
        shipping_instructions: h.shippingInstructions,
        // create-order sends it to Eclipse as freightCharges (UNVERIFIED that
        // Eclipse books that as freight in).
        freight_in: freightInValue(),
        writer: user.e_user_id,
        outside_sales: h.outsideSales || "",
        email: user.email || "",
        // ship_branch per line: lines on another branch than the header's
        // become their own generation (one per branch) in create-order.
        lines: filledLines().map(function (l) {
          var line = { productId: l.productId, quantity: Number(l.qty), ship_branch: lineBranch(l) };
          if (sendsPrice(l)) line.unitPrice = linePrice(l);
          if (lineComment(l)) line.comments = lineComment(l);
          return line;
        }),
        // Custom lines (bid only), placed in their page order as product 15680.
        custom_lines: customPayload(),
        // Pick Up Now: the printer the rep picked (create-order does not use it yet).
        printer_id: isPickUpNow() && state.confirm.printerId ? Number(state.confirm.printerId) : undefined,
      })
        .then(function (data) {
          data.mode = mode;
          state.result = data;
          state.ordersList = null;  // the new order belongs in the list
          // The new bid or order opens as the existing order it now is.
          if (data.e_sorder_id) return reopenAfterSave(data.e_sorder_id, data);
          state.confirm = null;
          state.view = "done";
        })
        .catch(function (err) {
          state.placeError = err.message + (err.data && err.data.step ? " (step: " + err.data.step + ")" : "");
        })
        .then(function () {
          state.placing = false;
          render();
        });
    }

    // ── Events ─────────────────────────────────────────────────────────────

    // Exit on an order (new or existing): back to the orders list it was opened from,
    // with no new requests (the customer and its orders are already loaded;
    // fetchOrders reuses the cache). An order opened straight from
    // ?e_sorder_id has no list yet, so it loads its bill-to's.
    function exitToOrders() {
      var lc = state.listCustomer;
      leaveExisting();
      if (!lc) { loadCustomer(state.customerId); return; }
      if (state.customer !== lc.data) quoteCache = {};
      state.customer = lc.data;
      state.customerId = lc.id;
      setUrlParam("e_customer_id", lc.id);
      state.shipTo = pickedShipTo();
      state.view = "orders";
      if (lc.data.bill_to) fetchOrders(String(lc.data.bill_to.e_customer_id));
      render();
    }

    function goToCustomerSearch() {
      leaveExisting();
      state.view = "customer";
      state.customer = null;
      state.shipTo = null;
      setUrlParam("e_customer_id", null);
      render();
    }

    // Desktop: a click on the dimmed backdrop around any dialog closes it,
    // the same as Esc (change log on request, then every dialog 2026-10-19).
    // Press and release must both be on the backdrop, so selecting text and
    // letting go outside the box keeps it open. Nothing closes while placing.
    // Phones keep Close / Esc only.
    var backdropDown = null;
    root.addEventListener("mousedown", function (e) { backdropDown = e.target; });
    root.addEventListener("click", function (e) {
      var t = e.target;
      if (state.view !== "order" || t !== backdropDown || !t.classList.contains("fop-modal") ||
          (window.matchMedia && window.matchMedia("(max-width: 767px)").matches)) return;
      if (state.quoteModal) closeQuote();
      else if (state.logModal) closeChangeLog();
      else if (state.cancelAsk) closeCancel();
      else if (state.customModal) closeCustomModal();
      else if (state.detailsModal) closeDetails(false);
      else if (state.confirm && !state.placing) { state.confirm = null; state.placeError = null; render(); }
    });

    root.addEventListener("click", function (e) {
      var acItem = e.target.closest("[data-ac]");
      if (acItem && ac) { acPick(Number(acItem.getAttribute("data-ac"))); return; }

      var tab = e.target.closest("[data-gen]");
      if (tab && state.view === "order") {
        if (Number(tab.getAttribute("data-gen")) !== state.existing.generation_id) { state.notice = null; openGen(tab.getAttribute("data-gen")); }
        return;
      }
      var oo = e.target.closest("[data-open-order]");
      if (oo) { openOtherOrder(oo.getAttribute("data-open-order")); return; }

      // Inline layout: clicking a line's description selects that line and
      // puts the cursor in its line comment.
      var descCell = inlineLayout && state.view === "order" && e.target.closest('.fop-line[data-row] [data-cell="desc"]');
      if (descCell) { focusLineComment(Number(descCell.closest(".fop-line").getAttribute("data-row"))); return; }

      var pick = e.target.closest("[data-shipto]");
      if (pick) { startOrder(state.customer.ship_tos[Number(pick.getAttribute("data-shipto"))]); return; }

      // Quote dialog: a click anywhere in the email box (not a chip's ×) types there.
      if (state.quoteModal && e.target.closest('[data-cell="emails"]') && !e.target.closest("[data-action]")) {
        var qe = root.querySelector("#fop-quote-email");
        if (qe && e.target !== qe) qe.focus();
        return;
      }

      var el = e.target.closest("[data-action]");
      if (!el || el.disabled) return;
      if (el.getAttribute("data-action") === "log-gen-only") { state.logGenOnly = el.checked; render(); return; }
      if (el.getAttribute("data-action") === "orders-shipto-only") { state.ordersShipToOnly = !el.checked; render(); return; }
      var r = Number(el.getAttribute("data-r"));
      switch (el.getAttribute("data-action")) {
        case "retry-customer": loadCustomer(state.customerId); break;
        case "retry-order": loadExistingOrder(state.orderId); break;
        case "change-customer": goToCustomerSearch(); break;
        case "exit-order": if (confirmLeave()) exitToOrders(); break;
        case "add-line": if (!linesLocked()) addLine(); break;
        case "remove-line": if (!linesLocked()) removeLine(r); break;
        case "edit-product": focusCell(r, 0); break;
        case "edit-variation": { var vs = root.querySelector("#fop-cf-variationSku"); if (vs) { vs.focus(); vs.select(); } break; }
        case "open-comment": {
          var cs = el.closest('[data-cell="comment"]');
          if (cs) cs.classList.remove("fop-stockstrip--cmt-closed");
          var cta = cs && cs.querySelector("[data-comment]");
          if (cta) { autosize(cta); cta.focus(); }
          break;
        }
        case "update-bid": requestPlace("update"); break;
        case "convert-bid": requestPlace("convert"); break;
        case "pick-branch": pickBranch(r, el.getAttribute("data-branch")); break;
        case "branch-menu": state.branchMenu = state.branchMenu === r ? null : r; render(); break;
        case "new-from-list": newOrderFromList(); break;
        case "change-log": openChangeLog(); break;
        case "close-log": closeChangeLog(); break;
        case "view-quote": openQuote(); break;
        case "close-quote": closeQuote(); break;
        case "send-quote": sendQuote(); break;
        case "remove-email": removeEmail(Number(el.getAttribute("data-i"))); break;
        case "ask-cancel": askCancel(); break;
        case "keep-order": closeCancel(); break;
        case "confirm-cancel": cancelOrder(); break;
        case "reload-order": loadExistingOrder(state.orderId); break;
        case "qty-dec": setQty(r, (Number(state.lines[r].qty) || 1) - 1); break;
        case "qty-inc": setQty(r, (Number(state.lines[r].qty) || 0) + 1); break;
        case "place-bid": requestPlace("bid"); break;
        case "place-order": requestPlace("order"); break;
        case "cancel-place": state.confirm = null; state.placeError = null; render(); break;
        case "confirm-place": place(); break;
        case "new-order": leaveExisting(); startOrder(state.shipTo); break;
        case "change-shipto": state.keepOrder = true; state.view = "shipto"; render(); break;
        case "toggle-stock": toggleStock(); break;
        case "close-side": state.sidePanel = false; render(); break;
        case "add-custom": openCustomModal(-1); break;
        case "edit-custom": openCustomModal(r); break;
        case "close-custom": closeCustomModal(); break;
        case "save-custom": saveCustomModal(); break;
        case "open-details": openDetails(r); break;
        case "close-details": closeDetails(false); break;
        case "save-details": saveDetails(); break;
      }
    });

    // Custom line dialog: keep the draft in step with the fields (no
    // re-render while typing, so focus stays put).
    function onCustomField(t, isChange) {
      var key = t.getAttribute("data-cf");
      // The product search reacts to typing only: its change event fires when
      // focus leaves after a pick and must not clear the pick or search again.
      if (key === "variationSku" && isChange) return;
      var d = state.customModal.draft;
      if (key === "variation") {
        d.variation = t.checked;
        var box = root.querySelector('[data-cell="custom-var"]');
        if (box) box.hidden = !t.checked;
        if (t.checked && !d.variationDesc) { var sku = root.querySelector("#fop-cf-variationSku"); if (sku) sku.focus(); }
        refreshCustomOrig();
        return;
      }
      d[key] = t.value;
      if (key === "variationSku") {
        // Typing over a picked product clears it until a new one is picked.
        if (d.variationDesc && t.value.trim() !== d.pickedSku) {
          d.variationDesc = "";
          refreshCustomOrig();
        }
        acSearch(t, "variation", null);
        return;
      }
      if (key === "customizations") autosize(t);
      if (key === "qty" || key === "price" || key === "cogs" || key === "name") {
        refreshCustomMargin(d);
      }
      // The original price follows the qty (quantity breaks).
      if (key === "qty") {
        var op = root.querySelector('[data-cell="orig-price"]');
        if (op) op.textContent = customOrigHtml(d, "price");
      }
    }

    root.addEventListener("input", function (e) {
      var t = e.target;
      if (state.quoteModal && t.id === "fop-quote-email") { onEmailInput(t); return; }
      if (state.customModal && t.hasAttribute("data-cf")) { onCustomField(t); return; }
      // Line comments: the inline strip writes straight to the line, the
      // details dialog to its draft.
      if (t.hasAttribute("data-comment")) {
        var cl = state.lines[Number(t.getAttribute("data-comment"))];
        if (cl) cl.comment = t.value;
        autosize(t);
        // On a bid a comment is a change Update Bid saves.
        if (state.existing) refreshTotals();
        return;
      }
      if (state.detailsModal && t.hasAttribute("data-details-comment")) { state.detailsModal.comment = t.value; autosize(t); return; }
      // Line details qty: live, like the grid's qty cell.
      if (state.detailsModal && t.getAttribute("data-dm") === "qty") {
        if (t.value.trim() !== "") {
          setQty(state.detailsModal.r, t.value);
        }
        return;
      }
      if (t.id === "fop-customer-search") { acSearch(t, "customer", null); return; }
      if (t.id === "fop-freight-in") { state.header.freightIn = t.value; refreshTotals(); return; }
      if (t.classList.contains("fop-notes")) {
        autosizeNotes(t);
        state.header[t.getAttribute("data-head")] = t.value;
        // A bid's notes count as a change for Update Bid; shipping
        // instructions also feed the "SEE INSTRUCTION" ship via check on
        // every mode, including a new order, so this always refreshes.
        refreshTotals();
        return;
      }
      if (t.classList.contains("fop-grid-in")) {
        var r = Number(t.getAttribute("data-r"));
        var c = Number(t.getAttribute("data-c"));
        if (c === 0) {
          // Typing over a picked product clears it until a new one is picked.
          var line = state.lines[r];
          if (line.productId && t.value.trim() !== line.productId) {
            line.productId = "";
            line.description = "";
            line.priceOverride = false;
            line.keepPrice = false;
            line.orig = null;
            line.orderCost = null;
            line.eclipseComments = null;
            refreshRow(r);
          }
          acSearch(t, "product", r);
        } else if (c === 1) {
          if (t.value.trim() !== "") setQty(r, t.value);
        }
      }
    });

    root.addEventListener("change", function (e) {
      var t = e.target;
      if (state.customModal && t.hasAttribute("data-cf")) { onCustomField(t, true); return; }
      if (state.detailsModal && t.hasAttribute("data-dm")) {
        var dr = state.detailsModal.r;
        if (t.getAttribute("data-dm") === "qty") { setQty(dr, t.value); t.value = state.lines[dr].qty; }
        else { setPrice(dr, t.value); t.value = priceText(state.lines[dr]); }
        return;
      }
      var key = t.getAttribute("data-head");
      if (key === "freightIn") {
        // Tidy to two decimals on leaving the box; blank or invalid → empty.
        state.header.freightIn = t.value;
        var fv = freightInValue();
        state.header.freightIn = t.value = fv ? fv.toFixed(2) : "";
        refreshTotals();
        return;
      }
      if (key) {
        state.header[key] = t.value;
        // A ship branch picked in the header: every line ships from it again.
        if (key === "shipBranch") {
          state.lines.forEach(function (l) { l.branch = ""; });
          refreshAllRows();
        }
        if (key === "shipVia") refreshAllRows();
        if (key === "orderStatus") {
          // Place Order and Convert to Order redraw: Pick Up Now shows the
          // printer box and turns the button into Print Now.
          if (confirmIsOrder()) render();
          else refreshConfirmText();
        }
        refreshTotals();
        return;
      }
      if (t.id === "fop-confirm-printer") {
        state.confirm.printerId = t.value;
        refreshConfirmText();
        return;
      }
      if (t.classList.contains("fop-grid-in")) {
        var r = Number(t.getAttribute("data-r"));
        var c = Number(t.getAttribute("data-c"));
        if (c === 1) { setQty(r, t.value); showQty(r); }
        if (c === 2) { setPrice(r, t.value); t.value = priceText(state.lines[r]); }
      }
    });

    // Phones: an inline comment box left empty folds back behind its button.
    root.addEventListener("focusout", function (e) {
      var t = e.target;
      if (!t.hasAttribute || !t.hasAttribute("data-comment")) return;
      var line = state.lines[Number(t.getAttribute("data-comment"))];
      var cs = t.closest('[data-cell="comment"]');
      if (line && cs && commentClosed(line)) cs.classList.add("fop-stockstrip--cmt-closed");
    });

    // Phones: an empty notes box switches between label-only (blurred) and
    // a normal box (focused), so its height is measured again each time.
    function resizeHeadNotes(e) {
      var t = e.target;
      if (t.classList && t.classList.contains("fop-notes") && t.closest(".fop-head")) autosizeNotes(t);
    }
    // Quote dialog: pinch / pan / double tap on the quote (touch screens).
    // Non-passive, so preventDefault stops the page scrolling or zooming.
    ["touchstart", "touchmove", "touchend", "touchcancel"].forEach(function (type) {
      root.addEventListener(type, function (e) {
        if (!e.target.classList || !e.target.classList.contains("fop-quote__touch")) return;
        if (type === "touchstart") quoteTouchStart(e);
        else if (type === "touchmove") quoteTouchMove(e);
        else quoteTouchEnd(e);
      }, { passive: false });
    });

    // Quote dialog: leaving the email box turns a valid address left in it
    // into a chip (an invalid one stays, with its message).
    root.addEventListener("focusout", function (e) {
      if (state.quoteModal && e.target.id === "fop-quote-email" && e.target.value.trim() && addEmail(e.target.value)) e.target.value = "";
    });
    root.addEventListener("focusin", resizeHeadNotes);
    root.addEventListener("focusout", function (e) { setTimeout(function () { resizeHeadNotes(e); }, 0); });

    // Leaving a product box that still holds its picked product turns it
    // back into the id tile.
    root.addEventListener("focusout", function (e) {
      var t = e.target;
      if (!t.classList || !t.classList.contains("fop-grid-in") || t.getAttribute("data-c") !== "0") return;
      var r = Number(t.getAttribute("data-r"));
      var line = state.lines[r];
      if (line && line.productId && t.value.trim() === line.productId) tileProduct(r, true);
    });

    // Leaving a qty box shows the unit again ("50" → "50 ft").
    root.addEventListener("focusout", function (e) {
      var t = e.target;
      if (!t.classList || !t.classList.contains("fop-grid-in") || t.getAttribute("data-c") !== "1") return;
      var r = Number(t.getAttribute("data-r"));
      setTimeout(function () { showQty(r); }, 0);
    });

    // Custom line dialog: focus reaching the existing product's search box
    // shows the box; leaving it with the picked product still there tiles it.
    root.addEventListener("focusin", function (e) { if (e.target.id === "fop-cf-variationSku") tileVariation(false); });
    root.addEventListener("focusout", function (e) {
      var m = state.customModal;
      if (e.target.id === "fop-cf-variationSku" && m && e.target.value.trim() === m.draft.pickedSku) tileVariation(true);
    });

    root.addEventListener("focusin", function (e) {
      var t = e.target;
      if (t.classList && t.classList.contains("fop-grid-in")) {
        state.focus = { r: Number(t.getAttribute("data-r")), c: Number(t.getAttribute("data-c")) };
        if (state.focus.c === 0) tileProduct(state.focus.r, false);
        if (state.focus.c === 1) showQty(state.focus.r);
        if (sideLayout && state.focus.r !== sideRow) refreshSide();
        moveStrips();
      }
      if (ac && t !== ac.input) acClose();
    });

    // Caret at the edge of a text input → arrows leave the cell.
    function atEdge(el, dir) {
      if (typeof el.selectionStart !== "number") return true;
      if (el.selectionStart !== el.selectionEnd) return el.selectionStart === 0 && el.selectionEnd === el.value.length;
      return dir < 0 ? el.selectionStart === 0 : el.selectionEnd === el.value.length;
    }

    function commitCell(el) {
      // Fire the change handler before moving, so qty/price are applied.
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function onGridKey(e, el) {
      var r = Number(el.getAttribute("data-r"));
      var c = Number(el.getAttribute("data-c"));
      var acOpen = ac && ac.input === el && ac.items.length;

      if (acOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        acMove(e.key === "ArrowDown" ? 1 : -1);
        return true;
      }
      if (e.key === "Escape" && ac && ac.input === el) { e.preventDefault(); acClose(); return true; }
      if (e.key === "Escape" && sideLayout && state.sidePanel) {
        e.preventDefault(); state.sidePanel = false; render(); return true;
      }

      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp":
          e.preventDefault();
          commitCell(el);
          focusCell(r + (e.key === "ArrowDown" ? 1 : -1), c);
          return true;
        case "ArrowLeft":
        case "ArrowRight":
          var dir = e.key === "ArrowRight" ? 1 : -1;
          if (!atEdge(el, dir)) return false;
          e.preventDefault();
          commitCell(el);
          focusCell(r, c + dir);
          return true;
        case "Enter":
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) { addLine(r); return true; }
          if (c === 0) {
            if (acOpen) { acPick(ac.active); return true; }
            if (state.lines[r].productId) focusCell(r, 1);
            return true;
          }
          commitCell(el);
          // Only custom lines (or nothing) below: add a line at the end.
          if (nextGridRow(r + 1, 1) < 0) addLine(state.lines.length - 1);
          else focusCell(r + 1, 0);
          return true;
        case "Insert":
          e.preventDefault();
          addLine(r);
          return true;
        case "Delete":
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); removeLine(r); return true; }
          return false;
      }
      return false;
    }

    function onKey(e) {
      var t = e.target;

      // Quote dialog: Esc closes, Ctrl+Enter sends, Tab stays in the dialog.
      // In the email box Enter or a comma ends an address and Backspace on
      // an empty box removes the last one.
      if (state.view === "order" && state.quoteModal) {
        if (e.key === "Escape") { e.preventDefault(); closeQuote(); }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendQuote(); }
        else if (t.id === "fop-quote-email" && (e.key === "Enter" || e.key === ",")) {
          e.preventDefault();
          if (addEmail(t.value)) t.value = "";
        } else if (t.id === "fop-quote-email" && e.key === "Backspace" && !t.value && state.quoteModal.emails.length) {
          e.preventDefault();
          state.quoteModal.emails.pop();
          refreshEmails(null);
        } else if (e.key === "Tab") {
          var qf = Array.prototype.slice.call(root.querySelectorAll(".fop-modal a, .fop-modal input, .fop-modal button:not([disabled])"));
          if (qf.length) {
            e.preventDefault();
            var qi = qf.indexOf(document.activeElement);
            qf[(qi + (e.shiftKey ? -1 : 1) + qf.length) % qf.length].focus();
          }
        }
        return;
      }

      // Change log dialog: Esc closes, Tab stays in the dialog.
      if (state.view === "order" && state.logModal) {
        var lf = Array.prototype.slice.call(root.querySelectorAll(".fop-modal input, .fop-modal button"));
        if (e.key === "Escape") { e.preventDefault(); closeChangeLog(); }
        else if (e.key === "Tab" && lf.length) {
          e.preventDefault();
          var li = lf.indexOf(document.activeElement);
          lf[(li + (e.shiftKey ? -1 : 1) + lf.length) % lf.length].focus();
        }
        return;
      }

      // Cancel dialog: Esc keeps the order; Enter and Space act on the
      // focused button (focus starts on "Keep"); Tab stays in the dialog.
      if (state.view === "order" && state.cancelAsk) {
        if (e.key === "Escape") { e.preventDefault(); closeCancel(); }
        else if (e.key === "Tab") {
          var cbtns = root.querySelectorAll(".fop-modal button:not([disabled])");
          if (cbtns.length) {
            var ci = Array.prototype.indexOf.call(cbtns, document.activeElement);
            e.preventDefault();
            cbtns[(ci + (e.shiftKey ? -1 : 1) + cbtns.length) % cbtns.length].focus();
          }
        }
        return;
      }

      // Custom line dialog: Esc closes, Enter saves (Ctrl+Enter inside the
      // customizations box, where Enter is a new line), Tab stays in the dialog.
      if (state.view === "order" && state.customModal) {
        var inBox = t.tagName === "TEXTAREA";
        var onBtn = t.tagName === "BUTTON" || t.type === "checkbox";
        // Existing product search list: ↑↓ move, Enter picks, Esc closes the list.
        var cfAc = ac && ac.input === t;
        if (cfAc && ac.items.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); acMove(e.key === "ArrowDown" ? 1 : -1); }
        else if (cfAc && e.key === "Escape") { e.preventDefault(); acClose(); }
        else if (cfAc && ac.items.length && e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); acPick(ac.active); }
        else if (e.key === "Escape") { e.preventDefault(); closeCustomModal(); }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (!inBox && !onBtn))) { e.preventDefault(); saveCustomModal(); }
        else if (e.key === "Tab") {
          var cf = Array.prototype.slice.call(root.querySelectorAll(".fop-modal input, .fop-modal textarea, .fop-modal button"))
            .filter(function (x) { return !x.closest("[hidden]"); });
          if (cf.length) {
            e.preventDefault();
            var ci2 = cf.indexOf(document.activeElement);
            cf[(ci2 + (e.shiftKey ? -1 : 1) + cf.length) % cf.length].focus();
          }
        }
        return;
      }

      // Line details dialog: Esc cancels, Ctrl+Enter saves (Enter is a new
      // line in the comment, and saves from qty / price), Tab stays in the dialog.
      if (state.view === "order" && state.detailsModal) {
        if (e.key === "Escape") { e.preventDefault(); closeDetails(false); }
        // Ctrl+Enter anywhere, or Enter in the qty / price box, saves.
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (t.hasAttribute("data-dm") && !linesLocked()))) { e.preventDefault(); saveDetails(); }
        else if (e.key === "Tab") {
          var df = Array.prototype.slice.call(root.querySelectorAll(".fop-modal input, .fop-modal textarea, .fop-modal button"));
          if (df.length) {
            e.preventDefault();
            var di = df.indexOf(document.activeElement);
            df[(di + (e.shiftKey ? -1 : 1) + df.length) % df.length].focus();
          }
        }
        return;
      }

      // Confirm dialog owns the keyboard.
      if (state.view === "order" && state.confirm) {
        if (e.key === "Escape" && !state.placing) { e.preventDefault(); state.confirm = null; state.placeError = null; render(); }
        else if (e.key === "Enter" && !state.placing && !(t.getAttribute && t.getAttribute("data-action") === "cancel-place")) {
          e.preventDefault(); place();
        } else if (t.id === "fop-confirm-status" && (e.key === "ArrowDown" || e.key === "ArrowUp" || /^[1-9]$/.test(e.key))) {
          // Pick the status without opening the native list. Option 0 is the
          // blank "Select…", so status k is option k and ↑ stops at status 1.
          var n = confirmStatuses().length;
          var next = /^[1-9]$/.test(e.key) ? Number(e.key) : t.selectedIndex + (e.key === "ArrowDown" ? 1 : -1);
          if (next >= 1 && next <= n) {
            e.preventDefault();
            t.selectedIndex = next;
            t.dispatchEvent(new Event("change", { bubbles: true }));
          }
        } else if (t.id === "fop-confirm-printer" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          // Same for the printer: option 0 is the blank "Select…".
          var pnext = t.selectedIndex + (e.key === "ArrowDown" ? 1 : -1);
          e.preventDefault();
          if (pnext >= 1 && pnext < t.options.length) {
            t.selectedIndex = pnext;
            t.dispatchEvent(new Event("change", { bubbles: true }));
          }
        } else if (e.key === "Tab") {
          var btns = root.querySelectorAll(".fop-modal select, .fop-modal button:not([disabled])");
          if (btns.length) {
            var idx = Array.prototype.indexOf.call(btns, document.activeElement);
            e.preventDefault();
            btns[(idx + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
          }
        }
        return;
      }

      if (t.id === "fop-customer-search") {
        if (ac && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); acMove(e.key === "ArrowDown" ? 1 : -1); }
        else if (e.key === "Enter") {
          e.preventDefault();
          if (ac && ac.items.length) acPick(ac.active);
          else if (/^\.?\d+$/.test(t.value.trim())) loadCustomer(t.value.trim().replace(/^\./, ""));
        } else if (e.key === "Escape") acClose();
        return;
      }

      // Orders list: ↑↓ move between "New order" and the orders, Enter opens
      // (native button click), Alt+N (Control+N on a Mac) starts a new order,
      // Esc changes customer.
      if (state.view === "orders") {
        if (t.type === "checkbox" && e.key !== "Escape") return;
        var items = Array.prototype.slice.call(root.querySelectorAll("[data-action=new-from-list], [data-open-order]"));
        var oi = items.indexOf(document.activeElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (items.length) items[oi < 0 ? 0 : (oi + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
        } else if (isShortcutMod(e) && e.code === "KeyN") {
          e.preventDefault();
          newOrderFromList();
        } else if (e.key === "Escape") {
          e.preventDefault();
          goToCustomerSearch();
        }
        return;
      }

      if (state.view === "shipto") {
        var picks = root.querySelectorAll("[data-shipto]");
        var cur = Array.prototype.indexOf.call(picks, document.activeElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          var next = cur < 0 ? 0 : (cur + (e.key === "ArrowDown" ? 1 : -1) + picks.length) % picks.length;
          if (picks[next]) picks[next].focus();
        } else if (/^[1-9]$/.test(e.key) && picks[Number(e.key) - 1]) {
          e.preventDefault();
          startOrder(state.customer.ship_tos[Number(e.key) - 1]);
        } else if (e.key === "Escape") {
          if (state.keepOrder) { state.keepOrder = false; state.view = "order"; render(); return; }
          state.view = "orders";
          state.shipTo = pickedShipTo();
          render();
        }
        return;
      }

      if (state.view === "done") {
        if (isShortcutMod(e) && e.code === "KeyN") { e.preventDefault(); leaveExisting(); startOrder(state.shipTo); }
        return;
      }

      if (state.view !== "order") return;

      // Page-level shortcuts: Alt (Control on a Mac) + a letter, matched on
      // e.code.
      // Existing order: Alt+B is Update Bid and Alt+O Convert to Order (bids
      // only; requestPlace refuses anything else).
      if (isShortcutMod(e)) {
        var focusEl = function (sel) { var el = root.querySelector(sel); if (el) el.focus(); };
        switch (e.code) {
          case "KeyQ": e.preventDefault(); if (confirmLeave()) exitToOrders(); return;
          case "KeyB": e.preventDefault(); requestPlace(state.existing ? "update" : "bid"); return;
          case "KeyO": e.preventDefault(); requestPlace(state.existing ? "convert" : "order"); return;
          case "KeyH": e.preventDefault(); focusEl("#fop-head [data-head]"); return;
          case "KeyL": e.preventDefault(); focusCell(state.focus.r, state.focus.c); return;
          case "KeyS": e.preventDefault(); toggleStock(); return;
          // Details layout: the focused line's Line details dialog.
          case "KeyD": if (detailsLayout) { e.preventDefault(); openDetails(state.focus.r); } return;
          case "KeyI": e.preventDefault(); focusEl('[data-head="shippingInstructions"]'); return;
          case "KeyN": e.preventDefault(); focusEl('[data-head="internalNotes"]'); return;
        }
      }

      // Enter on a header select (ship via, ship branch) opens its list.
      // showPicker() needs a recent browser; older ones just ignore Enter.
      if (e.key === "Enter" && t.tagName === "SELECT" && t.hasAttribute("data-head") && !t.disabled) {
        e.preventDefault();
        try { if (t.showPicker) t.showPicker(); } catch (err) { /* not allowed here */ }
        return;
      }

      // Backspace on Ship via clears it (a native select has no other way
      // to blank a picked value); ship via is optional on a bid.
      if (e.key === "Backspace" && t.tagName === "SELECT" && t.getAttribute("data-head") === "shipVia" && !t.disabled && state.header.shipVia) {
        e.preventDefault();
        state.header.shipVia = t.value = "";
        refreshAllRows();
        refreshTotals();
        return;
      }

      if (linesLocked() && (e.key === "Insert" || e.key === "Enter" || (e.key === "Delete" && (e.ctrlKey || e.metaKey)))) {
        // Read-only order: no adding, removing or Enter-adds-a-line.
        if (e.key !== "Enter" || (t.classList && t.classList.contains("fop-grid-in"))) e.preventDefault();
        return;
      }
      if (t.classList && t.classList.contains("fop-grid-in")) {
        onGridKey(e, t);
      } else if (e.key === "Insert") {
        e.preventDefault();
        addLine();
      }
    }

    root.addEventListener("keydown", onKey);
    // A click on a dialog's text (not a button) leaves focus on <body>,
    // outside #app, so its keys never reached the handler (Esc did not
    // close the change log). While a dialog is open, Esc and Tab from outside
    // #app go through the same handler; Enter does not, so stray focus can
    // never confirm a placement.
    // Alt (Control on a Mac) + letter shortcuts also go through from outside
    // #app (focus on <body> or the page header), or Control+Q on a Mac did
    // nothing after a click on blank space.
    document.addEventListener("keydown", function (e) {
      if (root.contains(e.target)) return;
      if (isShortcutMod(e)) { onKey(e); return; }
      if (e.key !== "Escape" && e.key !== "Tab") return;
      if (state.view === "order" && (state.quoteModal || state.logModal || state.cancelAsk || state.confirm || state.customModal || state.detailsModal)) onKey(e);
    });

    // Close an open list when clicking elsewhere.
    document.addEventListener("mousedown", function (e) {
      if (ac && !ac.list.contains(e.target) && e.target !== ac.input) acClose();
    });

    // ── Boot ───────────────────────────────────────────────────────────────
    // ?e_sorder_id wins over ?e_customer_id (the order names its customers),
    // and URL products never seed a later "New order" from it.
    if (state.orderId) { urlProducts = []; urlAutoNew = false; loadExistingOrder(state.orderId); }
    else if (state.customerId) loadCustomer(state.customerId);
    else render();
  }

  // ── Page header (2026-10-19) ─────────────────────────────────────────────
  // Dark bar above the app on every view, both themes: the Fairbank mark
  // (the favicon's icon, no wordmark) left;
  // HS Deal, HS Customer (filled by paintHeader() in initApp) and a user
  // menu right (the rep's name with a caret, like HubSpot's account menu;
  // it opens the rep's email, Eclipse user id, the theme toggle and Sign out). It replaces auth.js's sign-in
  // chip on these pages (hidden in styles.css). Sticky on desktop; on phones
  // it slides away while scrolling down and comes back on any scroll up.
  function initHeader(root, user) {
    var name = user.name || user.e_user_id || "";
    var header = document.createElement("header");
    header.className = "fop-header";
    header.innerHTML =
      '<div class="fop-header__logo">' +
      '<img src="fairbank-mark.png" alt="Fairbank" width="32" height="24">' +
      "</div>" +
      '<div class="fop-header__end">' +
      '<span class="fop-header__links" data-cell="hdr-links"></span>' +
      '<div class="fop-umenu">' +
      '<button type="button" class="fop-umenu__btn" aria-haspopup="true" aria-expanded="false">' +
      // Phones show the first name only (CSS swaps the two spans).
      '<span class="fop-umenu__name fop-umenu__name--full">' + esc(name) + "</span>" +
      '<span class="fop-umenu__name fop-umenu__name--first">' + esc(name.split(/\s+/)[0]) + "</span>" +
      '<svg class="fop-umenu__caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M0 0h10L5 6z" fill="currentColor"/></svg></button>' +
      '<div class="fop-umenu__panel" hidden>' +
      (user.email ? '<div class="fop-umenu__row"><span class="fop-umenu__lbl">Email</span>' + esc(user.email) + "</div>" : "") +
      '<div class="fop-umenu__row"><span class="fop-umenu__lbl">Eclipse ID</span>' + esc(user.e_user_id || "") + "</div>" +
      '<button type="button" class="fop-umenu__theme"></button>' +
      '<button type="button" class="fop-umenu__out">Sign out</button>' +
      "</div></div>" +
      "</div>";
    root.parentNode.insertBefore(header, root);
    bindThemeBtn(header.querySelector(".fop-umenu__theme"));
    header.querySelector(".fop-umenu__out").addEventListener("click", function () { window.fbSignOut(); });

    // User menu: the name button toggles it; a click outside or Escape
    // closes it (Escape puts focus back on the button).
    var menuBtn = header.querySelector(".fop-umenu__btn");
    var menu = header.querySelector(".fop-umenu__panel");
    function setMenu(open) {
      menu.hidden = !open;
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    menuBtn.addEventListener("click", function () { setMenu(menu.hidden); });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !header.querySelector(".fop-umenu").contains(e.target)) setMenu(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) { setMenu(false); menuBtn.focus(); }
    });

    // Phones only (the class does nothing on desktop, see styles.css): hide
    // on a scroll down past the header, show again on a scroll up. Moves
    // under 4px are ignored so a resting finger does not flicker it.
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

  function boot() {
    initApp(document.getElementById("app"));
  }


  // ── Light / dark theme toggle ──────────────────────────────────────────
  // The <head> of each page sets html[data-theme] before paint (saved
  // choice, else the system setting). The "Dark mode" / "Light mode" row in the user
  // menu (initHeader()) switches it and saves the choice in localStorage
  // ("fop-theme").
  var THEME_KEY = "fop-theme";
  var SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
  var MOON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  // The user menu row shows the theme a click switches to.
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

  // Last, so the theme icons above are set before the header uses them.
  // Loaded with defer, so the DOM is ready. Wait for the password gate so
  // FB_USER (writer, branch) is known.
  if (window.FB_USER) boot();
  else window.addEventListener("fb:auth", boot, { once: true });
})();
