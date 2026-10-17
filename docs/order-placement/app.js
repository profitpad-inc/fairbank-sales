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
//   5. Place as Bid (F9) or as an Order (F10), confirm, done.
//
// ?e_sorder_id=S123.0001 opens an existing order instead. A Bid can have
// its lines changed (Update Bid, F9); the header and customers stay locked.
// Any order that is not invoiced or cancelled can be cancelled.
//
// Backends (all n8n):
//   e-order-placement/create-order  creates the Eclipse sales order
//   e-order-placement/order         reads an existing order (one generation)
//   e-order-placement/update-bid    changes a bid's lines
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
// The rep (writer, email, territory, default branch) comes from
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
    ["SEE INSTRUCTION", "SEE INSTRUCTION"], ["SALESMAN DELIVERY", "SALESMAN DELIVR"], ["UPS", "UPS"],
    ["BW BEST WAY", "BW BEST WAY"], ["CPU PICK UP", "CPU PICK UP"], ["OT OUR TRUCK", "OT OUR TRUCK"],
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
  // separate VendorDirect value).
  var ORDER_STATUSES = [
    ["Bid", "Bid"],
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
    // Layout variant: <main id="app" data-layout="side"> (index.html,
    // the default) shows stock + qty breaks for every line in a box to the
    // right of the lines, open by default. inline.html has no data-layout and
    // shows strips under every line instead.
    var sideLayout = root.getAttribute("data-layout") === "side";
    var params = readParams();
    var urlProducts = productsFromParams(params);

    var state = {
      view: "customer",          // customer | loading | orders | shipto | order | done | error
      error: null,
      customerId: params.get("e_customer_id") || "",
      customer: null,            // /customer response
      shipTo: null,              // chosen ship-to { e_customer_id, name, address }
      header: null,              // order header values
      lines: [],                 // [{ key, productId, description, qty, price, priceOverride, quote }]
      focus: { r: 0, c: 0 },     // last focused grid cell
      placing: false,
      confirm: null,             // { mode: "bid" | "order" }
      placeError: null,
      result: null,
      orderId: params.get("e_sorder_id") || "",
      existing: null,            // the open generation of an existing order (+ order-level fields)
      order: null,               // full /order response: every generation of the open order
      genEdits: {},              // generation_id → { lines, focus, dirty }: unsaved edits per tab
      ordersModal: false,        // "Other orders" dialog open
      ordersList: null,          // { billTo, loading, error, data } from customer-orders
      ordersShipToOnly: true,    // orders list: only the picked ship-to's orders
      logModal: false,           // "Change log" dialog open
      logGenOnly: false,         // change log filtered to the open generation
      changeLog: null,           // { orderId, loading, error, data } from order-changelog
      cancelAsk: false,          // "Cancel this order?" dialog open
      stockAll: false,          // per-branch stock strips shown under every line (F4)
      breaksAll: false,          // quantity-break strips, toggled with stockAll (F4)
      sidePanel: true,           // side layout only: stock / breaks box open
    };
    var lineSeq = 0;
    var quoteCache = {};         // productId → { loading, error, data }

    function newLine() {
      return { key: ++lineSeq, productId: "", description: "", qty: 1, price: null, priceOverride: false };
    }

    // Existing order: the header and customers are always locked; the lines
    // only unlock for a Bid.
    function headLocked() { return !!state.existing; }
    function linesLocked() { return !!state.existing && !state.existing.editable; }

    // Default ship branch: the ship-to's Eclipse home branch, else the
    // bill-to's, else the rep's default branch.
    function defaultShipBranch(shipTo) {
      var bt = (state.customer && state.customer.bill_to) || {};
      return branchIdOf(shipTo && shipTo.home_branch) || branchIdOf(bt.home_branch) || branchIdOf(user.default_branch) || "";
    }

    function defaultHeader() {
      // Ship via starts blank (required for orders, optional for bids).
      // Customer rel # is pre-filled from the bill-to's Eclipse default
      // release number; a blank PO falls back to the customer's default PO
      // in create-order.
      var bt = (state.customer && state.customer.bill_to) || {};
      return {
        shipBranch: defaultShipBranch(state.shipTo),
        shipVia: "",
        orderStatus: "Bid",
        shipDate: isoDate(0),
        requiredDate: isoDate(7, true),
        po: "",
        release: bt.release_number || "",
        internalNotes: "",
        shippingInstructions: "",
        freightIn: "",           // totals box; sent to create-order as freight_in
      };
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
          quoteCache = {};
          state.ordersShipToOnly = true;
          // Always refetch here, so an order placed earlier shows up.
          state.ordersList = null;
          state.view = "orders";
          // A picked ship-to shows as the Ship to card on the orders list.
          state.shipTo = pickedShipTo();
          if (data.bill_to) fetchOrders(String(data.bill_to.e_customer_id));
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
      state.error = null;
      state.genEdits = {};
      state.changeLog = null;
      state.logModal = false;
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

    function genLabel(g) {
      return "Generation " + g.generation_id + (g.invoice_number != null ? " / Invoice " + g.invoice_number : "");
    }

    // Keep the open tab's lines (and whether they differ from Eclipse) so
    // switching away and back does not lose a bid's unsaved edits.
    function saveGenEdits() {
      var ex = state.existing;
      if (!ex || !ex.editable || state.view !== "order") return;
      state.genEdits[ex.generation_id] = { lines: state.lines, focus: state.focus, dirty: bidChanges().any };
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
      };
      // Loaded lines keep the order's price (keepPrice) until the rep edits
      // it; orig is what Eclipse has, so Update Bid sends only the changes.
      state.lines = saved ? saved.lines : (order.lines || []).map(function (l) {
        var line = newLine();
        line.productId = String(l.product_id);
        line.description = l.description || "";
        line.qty = Number(l.qty) || 1;
        line.price = l.unit_price;
        line.priceOverride = l.unit_price != null;
        line.keepPrice = l.unit_price != null;
        line.orig = { lineId: l.line_id, qty: Number(l.qty) || 0, price: l.unit_price };
        // The COGS saved on the order line (Eclipse `cogs`, not `cost`, which
        // is 0 on some lines that have a real COGS).
        line.orderCost = l.unit_cogs != null && isFinite(l.unit_cogs) ? Number(l.unit_cogs) : null;
        return line;
      });
      if (!saved && (order.editable || !state.lines.length)) state.lines.push(newLine());
      state.lines.forEach(function (l) { if (l.productId) fetchQuote(l.productId); });
      // Not a bid: nothing is focused or highlighted on load (r -1); F3 or a
      // click still moves into the lines.
      state.focus = saved ? saved.focus : { r: order.editable ? state.lines.length - 1 : -1, c: 0 };
      // No under-line stock strips on an invoiced or cancelled order.
      if (!order.cancellable) { state.stockAll = false; state.breaksAll = false; }
      state.confirm = null;
      state.cancelAsk = false;
      state.placeError = null;
      state.result = null;
      state.view = "order";
      render();
    }

    // Leave an existing order (Change customer, New order).
    function leaveExisting() {
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
          return hit ? (hit.description || "") : null;
        })
        .catch(function () { return null; })
        .then(function (desc) {
          state.lines.forEach(function (l, r) {
            if (String(l.productId) !== String(pid) || !l.lookingUp) return;
            l.lookingUp = false;
            l.description = desc == null ? "" : desc;
            l.notFound = desc == null;
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
              pumpQueue();
            });
        })(inquiryQueue.shift());
      }
    }

    // ── Pricing / stock derivations ────────────────────────────────────────

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

    function lineStock(line) {
      var q = quoteOf(line);
      if (!q || !q.data) return null;
      var stock = Array.isArray(q.data.stock_info) ? q.data.stock_info : [];
      var branch = state.header ? state.header.shipBranch : "";
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
      return { total: total, unknown: unknown, cost: cost, costUnknown: costUnknown };
    }

    // Update Bid payload: every line the bid should end up with. Loaded lines
    // carry line_id (unitPrice only when the price changed); new lines have
    // none. Loaded lines left out (removed, or product retyped) are deleted
    // by the update-bid flow.
    function bidChanges() {
      var kept = {};
      var added = 0, changed = 0;
      var lines = filledLines().map(function (l) {
        var qty = Number(l.qty);
        if (l.orig) {
          kept[l.orig.lineId] = true;
          var out = { line_id: l.orig.lineId, productId: l.productId, quantity: qty };
          var p = linePrice(l);
          var priceChanged = p != null && (l.orig.price == null || Math.abs(p - l.orig.price) >= 0.0005);
          if (priceChanged) out.unitPrice = p;
          if (priceChanged || qty !== l.orig.qty) changed++;
          return out;
        }
        added++;
        var line = { productId: l.productId, quantity: qty };
        if (sendsPrice(l)) line.unitPrice = linePrice(l);
        return line;
      });
      var removed = (state.existing.lines || []).filter(function (l) { return !kept[l.line_id]; }).length;
      return { lines: lines, added: added, changed: changed, removed: removed, any: added + changed + removed > 0 };
    }

    function placeBlockedReason(mode) {
      var h = state.header;
      if (!filledLines().length) return "Add at least one product with a quantity.";
      var missing = state.lines.filter(function (l) { return l.productId && l.notFound; })[0];
      if (missing) return "Product " + missing.productId + " was not found. Fix or remove that line.";
      if (mode === "update") {
        // Only the lines change, so the header checks below do not apply.
        if (!state.existing || !state.existing.editable) return "Only a bid can be updated.";
        if (!user.e_user_id) return "Sign in again: no Eclipse user on this session.";
        return bidChanges().any ? null : "No changes to save.";
      }
      if (state.existing) return "This order already exists.";
      if (!h.shipBranch) return "Pick a ship branch.";
      // Ship via is required for an order but not a bid; a blank bid is sent
      // without one (the create-order flow omits shipVia).
      if (mode !== "bid" && !h.shipVia) return "Pick a ship via.";
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
      root.innerHTML = html;
      var newSide = root.querySelector('[data-cell="side"]');
      if (newSide) newSide.scrollTop = sideTop;
      afterRender();
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
      // A cancelled order's dates are whatever Eclipse left (e.g. a ship date
      // in 2241); no red outline for them.
      if (state.existing && state.existing.status === "Cancel") return false;
      return !!(h && h.requiredDate && h.shipDate && h.requiredDate < h.shipDate);
    }

    function refreshDateError() {
      datePickers.forEach(function (fp) {
        if (fp.input.getAttribute("data-date") === "requiredDate" && fp.altInput) {
          fp.altInput.classList.toggle("fop-input--err", dateErrorOn());
        }
      });
    }

    function initDatePickers() {
      datePickers.forEach(function (fp) { fp.destroy(); });
      datePickers = [];
      if (!window.flatpickr || state.view !== "order") return;
      var els = root.querySelectorAll(".fop-date");
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          var key = el.getAttribute("data-date");
          var fp = window.flatpickr(el, {
            dateFormat: "Y-m-d",           // state + create-order keep YYYY-MM-DD
            altInput: true,
            altFormat: "M j, Y",           // "Oct 26, 2026"
            altInputClass: "fop-input fop-date-alt",
            defaultDate: state.header[key] || undefined,
            // An existing order's dates can be in the past, and are locked.
            minDate: headLocked() ? null : "today",
            clickOpens: !headLocked(),
            disableMobile: true,           // keep the themed calendar on phones
            onChange: function (_dates, dateStr) {
              state.header[key] = dateStr;
              refreshDateError();
              refreshTotals();
            },
          });
          if (fp.altInput) fp.altInput.setAttribute("aria-label", key === "shipDate" ? "Ship date" : "Required date");
          if (fp.altInput && headLocked()) fp.altInput.disabled = true;
          datePickers.push(fp);
        })(els[i]);
      }
      refreshDateError();
    }

    function afterRender() {
      initDatePickers();
      var notes = root.querySelectorAll(".fop-notes");
      for (var n = 0; n < notes.length; n++) autosize(notes[n]);
      autosizeNotesPair();
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
        if (state.logModal) {
          var lc = root.querySelector("[data-action=close-log]");
          if (lc) lc.focus();
        } else if (state.ordersModal) {
          var row = root.querySelector(".fop-order--open") || root.querySelector("[data-open-order]") || root.querySelector("[data-action=close-orders]");
          if (row) row.focus();
        } else if (state.cancelAsk) {
          // Default to the safe choice.
          var keep = root.querySelector("[data-action=keep-order]");
          if (keep) keep.focus();
        } else if (state.confirm) {
          var ok = root.querySelector("#fop-confirm-status") || root.querySelector("[data-action=confirm-place]");
          if (ok) ok.focus();
        } else if (state.focus.r >= 0) {
          focusCell(state.focus.r, state.focus.c);
        }
      } else if (state.view === "done") {
        var nb = root.querySelector("[data-action=new-order]");
        if (nb) nb.focus();
      }
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

    // Bill-to and ship-to side by side, each with its Eclipse address.
    function partyHtml(label, p, extra, corner) {
      if (!p) return "";
      var lines = p.address_lines || [];
      return (
        '<div class="fop-party">' +
        '<div class="fop-party__top"><span class="fop-party__lbl">' + esc(label) + "</span>" + (extra || "") + "</div>" +
        '<div class="fop-party__name">' + esc(p.name) + ' <span class="fop-badge">' + esc(p.e_customer_id) + "</span></div>" +
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

    // Bottom-right of the Bill to card: Eclipse creditLimit ({ value, currency }).
    function creditHtml(bt) {
      var cl = bt && bt.credit_limit;
      if (!cl || cl.value == null || !isFinite(cl.value)) return "";
      var whole = Math.round(cl.value) === cl.value;
      var amt = whole ? "$" + String(cl.value).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : money(cl.value);
      return '<div class="fop-party__corner"><span class="fop-party__lbl2">Credit limit</span>' +
        '<span class="fop-party__amt">' + amt + (cl.currency && cl.currency !== "USD" ? " " + esc(cl.currency) : "") + "</span></div>";
    }

    function customerSummaryHtml() {
      var c = state.customer || {};
      var bt = c.bill_to || {};
      var st = state.shipTo;
      // Prices are quoted against the bill-to, so its price class is the
      // level the rep is selling at.
      var level = '<span class="fop-level" title="Price level">' + esc(bt.price_class || "Price level unknown") + "</span>";
      var change = st && (c.ship_tos || []).length > 1 && state.view === "order" && !state.existing
        ? '<button class="fop-linkbtn" data-action="change-shipto">Change</button>' : "";
      return (
        '<div class="fop-parties">' +
        partyHtml("Bill to", bt, level, creditHtml(bt)) +
        (st ? partyHtml("Ship to", st, change, homeBranchHtml(st)) : "") +
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
        '<div class="fop-wrap fop-wrap--narrow">' +
        '<div class="fop-top"><div>' + titleHtml("Order Placement", "Orders") + "</div>" +
        '<div class="fop-row">' + customerLinkHtml() +
        '<button class="fop-btn fop-btn--ghost fop-btn--sm" data-action="change-customer">Change customer</button></div></div>' +
        customerSummaryHtml() +
        '<div class="fop-row">' +
        '<button class="fop-btn" data-action="new-from-list">New order <span class="fop-key fop-key--dark">N</span></button>' +
        (st ? '<label class="fop-check"><input type="checkbox" data-action="orders-shipto-only"' + (state.ordersShipToOnly ? "" : " checked") + "> " +
          "Show orders from other ShipTos</label>" : "") +
        "</div>" +
        '<div class="fop-card">' + ordersBodyHtml(filter) +
        '<div class="fop-hint">↑ ↓ to move, Enter to open, N for a new order, Esc to change customer.</div>' +
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
        '<div class="fop-hint">↑ ↓ to move, Enter or 1–9 to pick, Esc to ' + (state.keepOrder ? "go back to the order" : "go back to the orders") + ".</div>" +
        "</div></div>"
      );
    }

    // Header inputs are disabled on an existing order (lines only).
    function lockAttr() { return headLocked() ? " disabled" : ""; }

    function selectHtml(field, options, value, placeholder, groups) {
      var html = '<select class="fop-input" data-head="' + field + '" id="fop-h-' + field + '"' + lockAttr() + ">";
      // Placeholder only while nothing is picked (both selects are required).
      if (placeholder && !value) html += '<option value="" selected disabled>' + esc(placeholder) + "</option>";
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

    // Ship branch options with distance from the ship-to, closest first.
    // Without ship-to coordinates the list keeps branch-number order.
    function branchOptions() {
      var st = state.shipTo || {};
      var has = st.latitude != null && st.longitude != null;
      var list = BRANCHES.map(function (b) {
        var c = BRANCH_COORDS[b[0]];
        var mi = has && c ? milesBetween(st.latitude, st.longitude, c[0], c[1]) : null;
        return { id: b[0], name: b[1], mi: mi };
      });
      if (has) list.sort(function (a, b) { return (a.mi == null ? 1e9 : a.mi) - (b.mi == null ? 1e9 : b.mi); });
      return list.map(function (b) {
        return [b.id + " - " + b.name + (b.mi != null ? " · " + Math.round(b.mi).toLocaleString("en-US") + " mi" : ""), b.id];
      });
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

    // The bill-to's HubSpot company (hs_id from e-order-placement/customer),
    // on new and existing orders alike.
    function customerLinkHtml() {
      var bt = state.customer && state.customer.bill_to;
      if (!bt || !bt.hs_id) return "";
      return '<a class="fop-btn fop-btn--ghost fop-btn--sm" href="' + HS_COMPANY + encodeURIComponent(bt.hs_id) + '" target="_blank" rel="noopener"' +
        ' title="' + esc(bt.name + " (" + bt.e_customer_id + ")") + '">HS Customer ' + EXT_ICON + "</a>";
    }

    // Existing order: the open generation's HubSpot deal (order-lookup reads
    // every generation's deal in one Batch Read on e_sorder_id).
    function dealLinkHtml() {
      var id = state.existing && state.existing.hs_deal_id;
      if (!id) return "";
      return '<a class="fop-btn fop-btn--ghost fop-btn--sm" href="' + HS_DEAL + encodeURIComponent(id) + '" target="_blank" rel="noopener"' +
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
        // Writer / outside / inside sales and print status only show on an
        // existing order that is not a bid.
        '<div class="fop-head__grid">' +
        field("Ship via", selectHtml("shipVia", SHIP_VIAS, h.shipVia, "Select…", COMMON_SHIP_VIAS), "fop-field--row") +
        field("Ship branch", selectHtml("shipBranch", branches, h.shipBranch, "Select…")) +
        priceBranchField() +
        // Flatpickr calendars (initDatePickers) replace these plain inputs.
        field("Ship date", '<input class="fop-input fop-date" data-date="shipDate" value="' + esc(h.shipDate) + '"' + lockAttr() + ">", "fop-field--row") +
        field("Required date", '<input class="fop-input fop-date" data-date="requiredDate" value="' + esc(h.requiredDate) + '"' + lockAttr() + ">") +
        // Order date is never editable: the order's own, or today on a new
        // order (Eclipse dates it when it is created).
        field("Order date", '<input class="fop-input" value="' + esc(dateText(state.existing ? state.existing.order_date : isoDate(0))) + '" disabled>') +
        orderInfoField("writer", "fop-field--row") + orderInfoField("outsideSales") + orderInfoField("insideSales") +
        field("Customer P/O #", '<input class="fop-input" data-head="po" maxlength="30" value="' + esc(h.po) + '"' + lockAttr() + ">", "fop-field--row") +
        field("Customer rel #", '<input class="fop-input" data-head="release" maxlength="30" value="' + esc(h.release) + '"' + lockAttr() + ">") +
        orderInfoField("printStatus") +
        // Bottom row: shipping instructions left, internal notes right.
        // Multi-line notes; textareas grow with their content (autosize()).
        field("Shipping instructions", '<textarea class="fop-input fop-notes" rows="1" data-head="shippingInstructions"' + lockAttr() + ">" + esc(h.shippingInstructions) + "</textarea>", "fop-field--half") +
        field("Internal notes (no credit cards)", '<textarea class="fop-input fop-notes" rows="1" data-head="internalNotes"' + lockAttr() + ">" + esc(h.internalNotes) + "</textarea>", "fop-field--half") +
        trackingHtml() +
        "</div></section>"
      );
    }

    function lineRowHtml(line, r) {
      // A non-bid existing order shows its lines read-only (arrows still move).
      var ro = linesLocked() ? " readonly" : "";
      var edited = line.priceOverride && !line.keepPrice;
      return (
        '<div class="fop-line' + (r % 2 ? " fop-line--alt" : "") + '" data-row="' + r + '" role="row">' +
        '<div class="fop-cell fop-cell--num" role="cell">' + (r + 1) + "</div>" +
        '<div class="fop-cell fop-cell--product" role="cell">' +
        '<label class="fop-mlabel">Product</label>' +
        '<div class="fop-ac">' +
        '<input class="fop-input fop-grid-in" data-r="' + r + '" data-c="0" autocomplete="off" spellcheck="false" ' +
        'placeholder="' + (ro ? "" : "Search…") + '" value="' + esc(line.productId) + '" aria-label="Product, line ' + (r + 1) + '"' + ro + ">" +
        '<div class="fop-ac__list" role="listbox"></div></div></div>' +
        '<div class="fop-cell fop-cell--desc" role="cell" data-cell="desc">' + descHtml(line) + "</div>" +
        '<div class="fop-cell fop-cell--qty" role="cell">' +
        '<label class="fop-mlabel">Qty</label>' +
        '<div class="fop-qty">' +
        (ro ? "" : '<button class="fop-step" tabindex="-1" data-action="qty-dec" data-r="' + r + '" aria-label="Decrease">−</button>') +
        '<input class="fop-input fop-grid-in fop-num" data-r="' + r + '" data-c="1" inputmode="numeric" ' +
        'value="' + esc(line.qty) + '" aria-label="Quantity, line ' + (r + 1) + '"' + ro + ">" +
        (ro ? "" : '<button class="fop-step" tabindex="-1" data-action="qty-inc" data-r="' + r + '" aria-label="Increase">+</button>') +
        "</div></div>" +
        '<div class="fop-cell fop-cell--price" role="cell">' +
        '<label class="fop-mlabel">Unit price</label>' +
        '<input class="fop-input fop-grid-in fop-num' + (edited ? " fop-input--override" : "") + '" data-r="' + r + '" data-c="2" ' +
        'inputmode="decimal" value="' + esc(priceText(line)) + '" aria-label="Unit price, line ' + (r + 1) + '"' + ro + ">" +
        "</div>" +
        '<div class="fop-cell fop-cell--cost fop-num" role="cell" data-cell="cost">' + costHtml(line) + "</div>" +
        '<div class="fop-cell fop-cell--ext fop-num" role="cell" data-cell="ext">' + extHtml(line) + "</div>" +
        '<div class="fop-cell fop-cell--stock fop-num" role="cell" data-cell="avail">' + availHtml(line) + "</div>" +
        (sideLayout ? "" : '<div class="fop-cell fop-cell--stock fop-num" role="cell" data-cell="total">' + totalStockHtml(line) + "</div>") +
        '<div class="fop-cell fop-cell--del" role="cell">' +
        (ro ? "" : '<button class="fop-icon-btn" tabindex="-1" data-action="remove-line" data-r="' + r + '" aria-label="Remove line ' + (r + 1) + '">×</button>') +
        "</div>" +
        '<div class="fop-stockstrip" data-cell="strip"' + (state.stockAll && line.productId ? "" : " hidden") + ">" +
        (state.stockAll && line.productId ? stockStripHtml(line) : "") + "</div>" +
        '<div class="fop-stockstrip" data-cell="breaks"' + (state.breaksAll && line.productId ? "" : " hidden") + ">" +
        (state.breaksAll && line.productId ? breaksStripHtml(line) : "") + "</div>" +
        "</div>"
      );
    }

    // Quantity breaks for one line, like Eclipse's Quantity Breaks box:
    // break qty and unit price (no extension). The tier the line's
    // qty falls in is outlined in gold.
    function breaksStripHtml(line) {
      var q = quoteOf(line);
      if (!q || q.loading) return '<span class="fop-strip__lbl">Qty breaks</span><span class="fop-dots">···</span>';
      if (q.error) return '<span class="fop-strip__lbl">Qty breaks</span><span class="fop-warn-text">' + esc(q.error) + "</span>";
      var breaks = (Array.isArray(q.data.quantity_breaks) ? q.data.quantity_breaks : [])
        .map(function (b) { return { qty: Math.max(1, Number(b.startQuantity) || 0), price: parseFloat(b.unitPrice) }; })
        .filter(function (b) { return isFinite(b.price); })
        .sort(function (a, b) { return a.qty - b.qty; });
      var label = '<span class="fop-strip__lbl">Qty breaks</span>';
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


    // Per-branch stock for one line, shown on demand (F4 or click "All").
    // Branches with stock in branch-number order; the ship branch is always
    // shown and highlighted.
    // withTotal: label reads "Stock (1,136)" (side layout, which has no All column).
    function stockStripHtml(line, withTotal) {
      var q = quoteOf(line);
      if (!q || q.loading) return '<span class="fop-dots">Loading stock···</span>';
      if (q.error) return '<span class="fop-warn-text">' + esc(q.error) + "</span>";
      var s = lineStock(line);
      var ship = state.header.shipBranch;
      var need = Number(line.qty) || 1;
      var rows = s.rows.map(function (x) {
        var id = branchIdOf(x.warehouse);
        var known = BRANCHES.filter(function (b) { return b[0] === id; })[0];
        return { id: id, name: known ? known[1] : String(x.warehouse || "").replace(/^\d+\s*-\s*/, ""), qty: parseInt(x.warehouseQty, 10) || 0 };
      }).filter(function (x) { return x.qty > 0 || (ship && x.id === ship); });
      // Branch-number order (1 → 17), not by quantity.
      rows.sort(function (a, b) { return (Number(a.id) || 999) - (Number(b.id) || 999); });
      var lbl = '<span class="fop-strip__lbl">Stock' + (withTotal ? " (" + s.total.toLocaleString("en-US") + ")" : "") + "</span>";
      if (!rows.length) return lbl + '<span class="fop-muted">No stock at any branch.</span>';
      return lbl + rows.map(function (x) {
        return '<span class="fop-chip' + (ship && x.id === ship ? " fop-chip--ship" : "") + '">' +
          '<span class="fop-chip__br">' + esc(x.id) + " " + esc(x.name) + '</span><span class="fop-stock ' +
          stockClass(x.qty, need) + '">' + x.qty + "</span></span>";
      }).join("");
    }

    // F4 / the "Stock & qty breaks" button / an "All" count: show or hide
    // both strips (stock by branch and quantity breaks) under every line.
    function toggleStock() {
      if (noStock()) return;
      if (sideLayout) { state.sidePanel = !state.sidePanel; render(); return; }
      var on = !(state.stockAll || state.breaksAll);
      state.stockAll = on;
      state.breaksAll = on;
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
      return esc(line.description || "") + err + raised;
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
      return '<span class="fop-mlabel">Ext </span>' + money(p * (Number(line.qty) || 0));
    }

    function stockClass(have, need) {
      return have >= need ? "fop-stock--ok" : have > 0 ? "fop-stock--low" : "fop-stock--none";
    }

    function availHtml(line) {
      if (!line.productId || noStock()) return "";
      var s = lineStock(line);
      if (!s) return '<span class="fop-dots">···</span>';
      // No ship branch picked yet: no branch count to show.
      if (!state.header.shipBranch) return '<span class="fop-muted">-</span>';
      return '<span class="fop-mlabel">At branch </span><span class="fop-stock ' + stockClass(s.atBranch, Number(line.qty) || 1) +
        '">' + s.atBranch + "</span>";
    }

    function totalStockHtml(line) {
      if (!line.productId || noStock()) return "";
      var s = lineStock(line);
      if (!s) return "";
      var open = stockShown();
      return '<button class="fop-stockbtn' + (open ? " fop-stockbtn--open" : "") + '" tabindex="-1" data-action="toggle-stock"' +
        ' aria-expanded="' + open + '" title="Stock & qty breaks (F4)"><span class="fop-mlabel">All branches </span>' + s.total + "</button>";
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

    // Bottom bar: the order total only (cost is in the summary box).
    function totalsHtml() {
      var s = summary();
      return '<b class="fop-total">' + money(s.total) + "</b>" +
        (s.unknown ? ' <span class="fop-muted">(some prices pending)</span>' : "");
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
        (filledLines().length ? '<small class="fop-sum__cost">Cost ' + money(s.cost) + (s.costUnknown ? " (some pending)" : "") + "</small>" : "");
    }

    // Invoiced and cancelled orders show no stock (nothing will ship).
    function noStock() { return !!state.existing && !state.existing.cancellable; }

    function stockShown() { return !noStock() && (sideLayout ? state.sidePanel : state.stockAll); }

    // Side layout: stock + qty breaks for every line with a product, one
    // section per line; the focused line's section is outlined in gold and
    // scrolled into view.
    function sideHtml() {
      var head = '<div class="fop-side__head"><span class="fop-party__lbl">Stock &amp; qty breaks</span>' +
        '<button class="fop-icon-btn" data-action="close-side" aria-label="Close stock and qty breaks" title="Close (F4)">×</button></div>';
      var items = state.lines.map(function (line, r) {
        if (!line.productId) return "";
        // Name capped at 35 characters plus "..."; the full name is the tooltip.
        var name = (line.description || ("Product " + line.productId)).trim();
        var short = name.length > 35 ? name.slice(0, 35).replace(/\s+$/, "") + "..." : name;
        return '<div class="fop-side__line' + (r === state.focus.r ? " fop-side__line--active" : "") + '" data-side-row="' + r + '">' +
          '<div class="fop-side__item">' + (r + 1) + " · " +
          '<span class="fop-side__desc" title="' + esc(name) + '">' + esc(short) + "</span></div>" +
          // Stock (left) and qty breaks (right) side by side.
          '<div class="fop-side__cols">' +
          '<div class="fop-side__sec">' + stockStripHtml(line, true) + "</div>" +
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

    // Title of the order view: "New order", or the existing order's id and
    // its status badge.
    function orderTitleHtml() {
      var ex = state.existing;
      if (!ex) return titleHtml("Order Placement", "New order");
      return '<div class="fop-kicker">Order Placement</div><h1 class="fop-h1">' +
        esc(ex.e_sorder_id) +
        ' <span class="fop-status fop-status--' + esc(String(ex.status).toLowerCase()) + '">' + esc(statusLabel(ex.status)) + "</span></h1>";
    }

    // Action bar buttons. New order: Place as Bid + Place Order. Existing
    // bid: Update Bid. Any existing order not invoiced or cancelled: Cancel.
    function actionsHtml() {
      var ex = state.existing;
      if (!ex) {
        var bidReason = placeBlockedReason("bid");
        var orderReason = placeBlockedReason("order");
        return '<button class="fop-btn fop-btn--ghost" data-action="place-bid"' + (bidReason ? ' disabled title="' + esc(bidReason) + '"' : "") +
          ">Place as Bid <span class=\"fop-key\">F9</span></button>" +
          '<button class="fop-btn" data-action="place-order"' + (orderReason ? ' disabled title="' + esc(orderReason) + '"' : "") +
          ">Place Order <span class=\"fop-key fop-key--dark\">F10</span></button>";
      }
      var html = ex.cancellable
        ? '<button class="fop-btn fop-btn--danger" data-action="ask-cancel">Cancel ' + (ex.editable ? "Bid" : "Order") + "</button>" : "";
      if (ex.editable) {
        var updReason = placeBlockedReason("update");
        html += '<button class="fop-btn" data-action="update-bid"' + (updReason ? ' disabled title="' + esc(updReason) + '"' : "") +
          ">Update Bid <span class=\"fop-key fop-key--dark\">F9</span></button>";
      }
      return html;
    }

    // Under the title on an existing order: what can be changed here.
    function existingNoteHtml() {
      var ex = state.existing;
      if (!ex) return "";
      var msg = ex.editable
        ? "Only the lines can be changed on an existing bid. The header and customers stay as they are in Eclipse."
        : "This order is " + statusLabel(ex.status) + ", so it can't be edited here." +
          (ex.cancellable ? " It can still be cancelled." : "");
      return '<div class="fop-alert fop-alert--info">' + esc(msg) + "</div>";
    }

    // Right side of the action bar on an existing order: Eclipse's last change
    // to the order (lastUpdateDateTime; order-level, not per generation).
    function lastModifiedHtml() {
      var ex = state.existing;
      if (!ex || !ex.last_modified) return "";
      return '<span class="fop-lastmod"><span class="fop-lastmod__lbl">Last modified</span> ' + esc(dateTimeText(ex.last_modified)) + "</span>";
    }

    // Above the customer cards: "Other orders" (this bill-to's orders, in a
    // dialog) and, on an existing order, one tab per generation.
    function switcherHtml() {
      var bt = state.customer && state.customer.bill_to;
      if (!bt) return "";
      var gens = state.order && state.existing ? (state.order.generations || []) : [];
      var cur = state.existing ? state.existing.generation_id : null;
      return '<div class="fop-switch">' +
        '<button class="fop-btn fop-btn--ghost fop-btn--sm" data-action="other-orders">Other orders</button>' +
        (gens.length ? '<div class="fop-tabs" role="tablist" aria-label="Generations">' + gens.map(function (g) {
          var on = g.generation_id === cur;
          return '<button class="fop-tab' + (on ? " fop-tab--active" : "") + '" role="tab" aria-selected="' + on + '" data-gen="' + esc(g.generation_id) +
            '" title="' + esc(g.e_sorder_id + " · " + statusLabel(g.status)) + '">' + esc(genLabel(g)) + "</button>";
        }).join("") + "</div>" : "") +
        // Far right of the row (on request).
        (state.existing ? '<button class="fop-btn fop-btn--ghost fop-btn--sm fop-switch__end" data-action="change-log">Change log</button>' : "") +
        "</div>";
    }

    // The bill-to's recent orders (customer-orders flow), newest first; a row
    // opens that order at its lowest generation.
    // The orders list itself, shared by the "Other orders" dialog and the
    // orders view. shipToId (optional) keeps only orders with a generation
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

    function ordersHtml() {
      var body = ordersBodyHtml();
      var bt = state.customer.bill_to;
      return (
        '<div class="fop-modal" role="dialog" aria-modal="true" aria-labelledby="fop-orders-title">' +
        '<div class="fop-modal__box">' +
        '<h2 class="fop-h2" id="fop-orders-title">Orders for ' + esc(bt.name) + ' <span class="fop-badge">' + esc(bt.e_customer_id) + "</span></h2>" +
        body +
        '<div class="fop-row fop-row--end"><button class="fop-btn fop-btn--ghost" data-action="close-orders">Close <span class="fop-key">Esc</span></button></div>' +
        "</div></div>"
      );
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
            return '<tr class="' + (mine ? "" : "fop-log--other") + '"><td class="fop-log__gens">' + esc(e.gens.join(", ") || "-") + "</td>" +
              '<td class="fop-log__at">' + esc(logTimeText(e.at)) + "</td><td>" + esc(e.user) + '</td><td class="fop-log__c">' + esc(e.comment) + "</td></tr>";
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

    function closeChangeLog() {
      state.logModal = false;
      render();
    }

    function openOrdersModal() {
      var bt = state.customer && state.customer.bill_to;
      if (!bt) return;
      state.ordersModal = true;
      fetchOrders(String(bt.e_customer_id));
      render();
    }

    // customer-orders for a bill-to. Cached per bill-to for the session;
    // reopening the dialog does not refetch (loadCustomer clears the cache).
    function fetchOrders(id) {
      if (state.ordersList && state.ordersList.billTo === id && !state.ordersList.error) return;
      state.ordersList = { billTo: id, loading: true };
      getJson(API.customerOrders, { e_customer_id: id })
        .then(function (d) { if (state.ordersList && state.ordersList.billTo === id) state.ordersList = { billTo: id, data: d }; })
        .catch(function (err) { if (state.ordersList && state.ordersList.billTo === id) state.ordersList = { billTo: id, error: err.message }; })
        .then(function () { if (state.ordersModal || state.view === "orders") render(); });
    }

    function closeOrdersModal() {
      state.ordersModal = false;
      render();
    }

    // Leaving the open order (or a new order with lines) asks first.
    function confirmLeave() {
      if (state.existing ? hasUnsavedEdits() : filledLines().length > 0) {
        return window.confirm("Leave this order? Unsaved changes will be lost.");
      }
      return true;
    }

    function openOtherOrder(orderId) {
      if (state.view === "orders") { urlProducts = []; loadExistingOrder(orderId); return; }
      if (state.order && state.order.order_id === orderId) { closeOrdersModal(); return; }
      if (!confirmLeave()) return;
      state.ordersModal = false;
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
      var linesHtml = state.lines.map(lineRowHtml).join("");
      return (
        // Side layout widens the page only while the card is open; closed, it
        // is the same centred width as the regular page.
        '<div class="fop-wrap fop-wrap--wide' + (sideLayout && stockShown() ? " fop-wrap--sideopen" : "") + '">' +
        '<div class="fop-top">' +
        '<div>' + orderTitleHtml() + "</div>" +
        '<div class="fop-row">' + customerLinkHtml() + dealLinkHtml() +
        '<button class="fop-btn fop-btn--ghost fop-btn--sm" data-action="change-customer">' + (state.existing ? "Exit" : "Change customer") + "</button></div>" +
        "</div>" +
        switcherHtml() +
        existingNoteHtml() +
        // Side layout: bill-to/ship-to, lines and header in the left column,
        // the stock / qty breaks card in the right column beside all three.
        (sideLayout ? '<div class="fop-split' + (stockShown() ? "" : " fop-split--closed") + '"><div class="fop-split__main">' : "") +
        customerSummaryHtml() +
        '<div class="fop-grid' + (sideLayout ? " fop-grid--noall" : "") + '" role="table" aria-label="Order lines">' +
        '<div class="fop-line fop-line--head" role="row">' +
        '<div class="fop-cell fop-cell--num">#</div><div class="fop-cell fop-cell--product">Product</div>' +
        '<div class="fop-cell fop-cell--desc">Description</div><div class="fop-cell fop-cell--qty">Qty</div>' +
        '<div class="fop-cell fop-cell--price">Unit price</div><div class="fop-cell fop-cell--cost">Unit cost</div>' +
        '<div class="fop-cell fop-cell--ext">Ext</div>' +
        '<div class="fop-cell fop-cell--stock">' + (noStock() ? "" : "Br " + esc(state.header.shipBranch || "-")) + "</div>" +
        (sideLayout ? "" : '<div class="fop-cell fop-cell--stock">All</div>') + '<div class="fop-cell fop-cell--del"></div>' +
        "</div>" + linesHtml + "</div>" +
        // Under the lines: grid buttons left, the totals summary box right.
        '<div class="fop-gridfoot"><div class="fop-row fop-gridtools">' +
        (linesLocked() ? "" : '<button class="fop-btn fop-btn--ghost fop-btn--sm" data-action="add-line">+ Add line <span class="fop-key">Ins</span></button>') +
        (noStock() ? "" : '<button class="fop-btn fop-btn--ghost fop-btn--sm' + (stockShown() ? " fop-btn--on" : "") + '" data-action="toggle-stock" aria-pressed="' + stockShown() + '">' +
        (stockShown() ? "Hide" : "Show") + ' stock &amp; qty breaks <span class="fop-key">F4</span></button>') +
        "</div>" + '<div class="fop-sum" data-cell="summary" aria-label="Order totals">' + summaryHtml() + "</div></div>" +
        // Order header sits below the lines (user request).
        headerHtml() +
        // Error + action bar: in the side layout they stay in the left column
        // (under the header), so the stock card's column runs the full height.
        (state.placeError ? '<div class="fop-alert fop-alert--error">' + esc(state.placeError) + "</div>" : "") +
        '<div class="fop-bar">' +
        '<div class="fop-bar__totals" data-cell="totals">' + totalsHtml() + "</div>" +
        '<div class="fop-bar__actions">' + lastModifiedHtml() + actionsHtml() + "</div></div>" +
        // Keyboard legend sits under the action bar (moved out of it on request).
        '<div class="fop-legend"><span class="fop-key">↑↓←→</span> move <span class="fop-key">Enter</span> next ' +
        '<span class="fop-key">Ins</span> add <span class="fop-key">Ctrl+Del</span> remove ' +
        (noStock() ? "" : '<span class="fop-key">F4</span> stock &amp; breaks ') + '<span class="fop-key">F2</span> header <span class="fop-key">F3</span> lines</div>' +
        (sideLayout ? "</div>" + (stockShown() ? '<aside class="fop-side" data-cell="side" aria-label="Stock and quantity breaks">' + sideHtml() + "</aside>" : "") + "</div>" : "") +
        (state.confirm ? confirmHtml() : "") +
        (state.cancelAsk ? cancelHtml() : "") +
        (state.ordersModal ? ordersHtml() : "") +
        (state.logModal ? changeLogHtml() : "") +
        "</div>"
      );
    }

    // F9 → fixed Bid. F10 → the rep picks the order status here (it is not
    // in the header); a Bid status from F10 still places a bid.
    function confirmIsBid() {
      return state.confirm.mode === "bid" || state.header.orderStatus === "Bid";
    }

    function statusPickerHtml() {
      var h = state.header;
      return '<div class="fop-field fop-confirm-status"><label class="fop-label" for="fop-confirm-status">Order status ' +
        '<span class="fop-muted">(↑↓ or 1–' + ORDER_STATUSES.length + ")</span></label>" +
        '<select class="fop-input" id="fop-confirm-status" data-head="orderStatus">' +
        ORDER_STATUSES.map(function (o, i) {
          return '<option value="' + esc(o[1]) + '"' + (o[1] === h.orderStatus ? " selected" : "") + ">" + (i + 1) + ". " + esc(o[0]) + "</option>";
        }).join("") + "</select></div>";
    }

    // Keep the dialog title and button in step with the picked status.
    function refreshConfirmText() {
      var isBid = confirmIsBid();
      var title = root.querySelector("#fop-confirm-title");
      var btn = root.querySelector("[data-action=confirm-place]");
      if (title) title.textContent = isBid ? "Place as Bid?" : "Place Order?";
      if (btn && !state.placing) btn.innerHTML = (isBid ? "Place Bid" : "Place Order") + ' <span class="fop-key fop-key--dark">Enter</span>';
    }

    function confirmHtml() {
      if (state.confirm.mode === "update") return updateConfirmHtml();
      var h = state.header;
      var isBid = confirmIsBid();
      var t = orderTotal();
      var rows = filledLines().map(function (l) {
        var p = linePrice(l);
        return "<tr><td>" + esc(l.productId) + "</td><td>" + esc(l.description) + '</td><td class="fop-num">' + esc(l.qty) +
          '</td><td class="fop-num">' + (p == null ? "Eclipse price" : money(p * Number(l.qty))) + "</td></tr>";
      }).join("");
      return (
        '<div class="fop-modal" role="dialog" aria-modal="true" aria-labelledby="fop-confirm-title">' +
        '<div class="fop-modal__box">' +
        '<h2 class="fop-h2" id="fop-confirm-title">' + (isBid ? "Place as Bid?" : "Place Order?") + "</h2>" +
        '<div class="fop-confirm-meta">' +
        "<div><span>Ship-to</span> " + esc(state.shipTo.name) + " (" + esc(state.shipTo.e_customer_id) + ")</div>" +
        "<div><span>Price level</span> " + esc(state.customer.bill_to.price_class || "Unknown") + "</div>" +
        "<div><span>Branch</span> " + esc(h.shipBranch) + "</div>" +
        "<div><span>Ship via</span> " + esc(h.shipVia || "None") + "</div>" +
        "<div><span>Ship / Req</span> " + esc(h.shipDate) + " / " + esc(h.requiredDate) + "</div>" +
        (h.po ? "<div><span>PO</span> " + esc(h.po) + "</div>" : "") +
        "</div>" +
        (state.confirm.mode === "order" ? statusPickerHtml() : "") +
        '<div class="fop-table-wrap"><table class="fop-table"><thead><tr><th>Product</th><th>Description</th>' +
        '<th class="fop-num">Qty</th><th class="fop-num">Ext</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        (freightInValue() ? '<div class="fop-confirm-total fop-confirm-freight">Freight in ' + money(freightInValue()) + "</div>" : "") +
        '<div class="fop-confirm-total">Total ' + money(t.total + freightInValue()) + (t.unknown ? " + Eclipse pricing" : "") + "</div>" +
        (state.placeError ? '<div class="fop-alert fop-alert--error">' + esc(state.placeError) + "</div>" : "") +
        '<div class="fop-row fop-row--end">' +
        '<button class="fop-btn fop-btn--ghost" data-action="cancel-place"' + (state.placing ? " disabled" : "") + ">Back <span class=\"fop-key\">Esc</span></button>" +
        '<button class="fop-btn" data-action="confirm-place"' + (state.placing ? " disabled" : "") + ">" +
        (state.placing ? "Placing…" : (isBid ? "Place Bid" : "Place Order") + ' <span class="fop-key fop-key--dark">Enter</span>') +
        "</button></div></div></div>"
      );
    }

    // Update Bid: each line marked New / Changed (qty or price), plus the
    // lines that will be removed.
    function updateConfirmHtml() {
      var ch = bidChanges();
      var t = orderTotal();
      var rows = filledLines().map(function (l) {
        var p = linePrice(l);
        var tag = !l.orig ? "New"
          : (Number(l.qty) !== l.orig.qty || (p != null && (l.orig.price == null || Math.abs(p - l.orig.price) >= 0.0005))) ? "Changed" : "";
        return "<tr><td>" + esc(l.productId) + "</td><td>" + esc(l.description) + '</td><td class="fop-num">' + esc(l.qty) +
          '</td><td class="fop-num">' + (p == null ? "Eclipse price" : money(p * Number(l.qty))) + '</td><td class="fop-muted">' + tag + "</td></tr>";
      }).join("");
      var kept = {};
      filledLines().forEach(function (l) { if (l.orig) kept[l.orig.lineId] = true; });
      rows += (state.existing.lines || []).filter(function (l) { return !kept[l.line_id]; }).map(function (l) {
        return '<tr class="fop-row--removed"><td>' + esc(l.product_id) + "</td><td>" + esc(l.description) + '</td><td class="fop-num">' + esc(l.qty) +
          '</td><td class="fop-num">-</td><td class="fop-warn-text">Removed</td></tr>';
      }).join("");
      var summary = [ch.added && ch.added + " added", ch.changed && ch.changed + " changed", ch.removed && ch.removed + " removed"]
        .filter(Boolean).join(" · ");
      return (
        '<div class="fop-modal" role="dialog" aria-modal="true" aria-labelledby="fop-confirm-title">' +
        '<div class="fop-modal__box">' +
        '<h2 class="fop-h2" id="fop-confirm-title">Update bid ' + esc(state.existing.e_sorder_id) + "?</h2>" +
        '<div class="fop-muted">' + esc(summary) + ". Only the lines change.</div>" +
        '<div class="fop-table-wrap"><table class="fop-table"><thead><tr><th>Product</th><th>Description</th>' +
        '<th class="fop-num">Qty</th><th class="fop-num">Ext</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        '<div class="fop-confirm-total">Total ' + money(t.total) + (t.unknown ? " + Eclipse pricing" : "") + "</div>" +
        (state.placeError ? '<div class="fop-alert fop-alert--error">' + esc(state.placeError) + "</div>" : "") +
        '<div class="fop-row fop-row--end">' +
        '<button class="fop-btn fop-btn--ghost" data-action="cancel-place"' + (state.placing ? " disabled" : "") + ">Back <span class=\"fop-key\">Esc</span></button>" +
        '<button class="fop-btn" data-action="confirm-place"' + (state.placing ? " disabled" : "") + ">" +
        (state.placing ? "Updating…" : 'Update Bid <span class="fop-key fop-key--dark">Enter</span>') +
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
        '<button class="fop-btn" data-action="new-order">New order, same ship-to <span class="fop-key fop-key--dark">N</span></button>' +
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
      if (!el || !line) return;
      if (sideLayout) refreshSide();
      el.querySelector('[data-cell="desc"]').innerHTML = descHtml(line);
      el.querySelector('[data-cell="cost"]').innerHTML = costHtml(line);
      el.querySelector('[data-cell="ext"]').innerHTML = extHtml(line);
      el.querySelector('[data-cell="avail"]').innerHTML = availHtml(line);
      var totalCell = el.querySelector('[data-cell="total"]');
      if (totalCell) totalCell.innerHTML = totalStockHtml(line);
      var strip = el.querySelector('[data-cell="strip"]');
      strip.hidden = !(state.stockAll && line.productId);
      if (!strip.hidden) strip.innerHTML = stockStripHtml(line);
      var brk = el.querySelector('[data-cell="breaks"]');
      brk.hidden = !(state.breaksAll && line.productId);
      if (!brk.hidden) brk.innerHTML = breaksStripHtml(line);
      var priceIn = el.querySelector('[data-c="2"]');
      if (priceIn && !(opts && opts.keepPrice) && document.activeElement !== priceIn) {
        priceIn.value = priceText(line);
      }
      refreshTotals();
    }

    function refreshTotals() {
      var t = root.querySelector('[data-cell="totals"]');
      if (t) t.innerHTML = totalsHtml();
      // New order: only the total, so the freight input keeps focus.
      var sm = root.querySelector('[data-cell="summary"]');
      var st = sm && sm.querySelector('[data-cell="sum-total"]');
      if (sm && !state.existing && st) st.innerHTML = sumTotalHtml(summary());
      else if (sm) sm.innerHTML = summaryHtml();
      var bid = root.querySelector("[data-action=place-bid]");
      var ord = root.querySelector("[data-action=place-order]");
      var upd = root.querySelector("[data-action=update-bid]");
      if (bid) setDisabled(bid, placeBlockedReason("bid"));
      if (ord) setDisabled(ord, placeBlockedReason("order"));
      if (upd) setDisabled(upd, placeBlockedReason("update"));
    }

    function setDisabled(btn, reason) {
      btn.disabled = !!reason;
      if (reason) btn.title = reason; else btn.removeAttribute("title");
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

    function cellInput(r, c) {
      return root.querySelector('.fop-grid-in[data-r="' + r + '"][data-c="' + c + '"]');
    }

    function focusCell(r, c) {
      r = Math.max(0, Math.min(state.lines.length - 1, r));
      c = Math.max(0, Math.min(COLS.length - 1, c));
      var el = cellInput(r, c);
      if (!el) return;
      state.focus = { r: r, c: c };
      el.focus();
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
        state.focus = { r: Math.min(r, state.lines.length - 1), c: state.focus.c };
      }
      render();
    }

    function setProduct(r, product) {
      var line = state.lines[r];
      line.productId = String(product.e_product_id);
      line.description = product.description || "";
      line.lookingUp = false;
      line.notFound = false;
      line.priceOverride = false;
      line.keepPrice = false;
      line.price = null;
      // A new product on a loaded bid line is a new line; the old one is removed.
      line.orig = null;
      line.orderCost = null;
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
        line.price = null;
      } else if (isFinite(Number(s)) && Number(s) >= 0) {
        line.keepPrice = false;
        var auto = line.priceOverride ? null : linePrice(line);
        var v = Math.round(Number(s) * 1000) / 1000;
        var m = minPrice(line);
        line.priceRaised = m != null && v < m;
        if (line.priceRaised) v = m;
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
      else setProduct(r, item);
    }

    var acSearch = debounce(function (input, kind, r) {
      var q = input.value.trim();
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

    function requestPlace(mode) {
      if (state.placing || placeBlockedReason(mode)) return;
      state.confirm = { mode: mode };
      state.placeError = null;
      render();
    }

    function updateBid() {
      var ex = state.existing;
      state.placing = true;
      state.placeError = null;
      render();
      postJson(API.updateBid, {
        e_sorder_id: ex.e_sorder_id,
        writer: user.e_user_id,
        lines: bidChanges().lines,
      })
        .then(function (data) {
          data.mode = "update";
          state.result = data;
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
          state.cancelAsk = false;
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

    function place() {
      var mode = state.confirm.mode;
      if (mode === "update") { updateBid(); return; }
      var h = state.header;
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
        outside_sales: user.territory || "",
        email: user.email || "",
        lines: filledLines().map(function (l) {
          var line = { productId: l.productId, quantity: Number(l.qty) };
          if (sendsPrice(l)) line.unitPrice = linePrice(l);
          return line;
        }),
      })
        .then(function (data) {
          data.mode = (mode === "bid" || h.orderStatus === "Bid") ? "bid" : "order";
          state.result = data;
          state.ordersList = null;  // the new order belongs in the list
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

    function goToCustomerSearch() {
      leaveExisting();
      state.view = "customer";
      state.customer = null;
      state.shipTo = null;
      setUrlParam("e_customer_id", null);
      render();
    }

    root.addEventListener("click", function (e) {
      var acItem = e.target.closest("[data-ac]");
      if (acItem && ac) { acPick(Number(acItem.getAttribute("data-ac"))); return; }

      var tab = e.target.closest("[data-gen]");
      if (tab && state.view === "order") {
        if (Number(tab.getAttribute("data-gen")) !== state.existing.generation_id) openGen(tab.getAttribute("data-gen"));
        return;
      }
      var oo = e.target.closest("[data-open-order]");
      if (oo) { openOtherOrder(oo.getAttribute("data-open-order")); return; }

      var pick = e.target.closest("[data-shipto]");
      if (pick) { startOrder(state.customer.ship_tos[Number(pick.getAttribute("data-shipto"))]); return; }

      var el = e.target.closest("[data-action]");
      if (!el || el.disabled) return;
      if (el.getAttribute("data-action") === "log-gen-only") { state.logGenOnly = el.checked; render(); return; }
      if (el.getAttribute("data-action") === "orders-shipto-only") { state.ordersShipToOnly = !el.checked; render(); return; }
      var r = Number(el.getAttribute("data-r"));
      switch (el.getAttribute("data-action")) {
        case "retry-customer": loadCustomer(state.customerId); break;
        case "retry-order": loadExistingOrder(state.orderId); break;
        case "change-customer":
          if (state.existing && !confirmLeave()) break;
          goToCustomerSearch();
          break;
        case "add-line": if (!linesLocked()) addLine(); break;
        case "remove-line": if (!linesLocked()) removeLine(r); break;
        case "update-bid": requestPlace("update"); break;
        case "other-orders": openOrdersModal(); break;
        case "new-from-list": newOrderFromList(); break;
        case "change-log": openChangeLog(); break;
        case "close-log": closeChangeLog(); break;
        case "close-orders": closeOrdersModal(); break;
        case "ask-cancel": askCancel(); break;
        case "keep-order": closeCancel(); break;
        case "confirm-cancel": cancelOrder(); break;
        case "reload-order": loadExistingOrder(state.orderId); break;
        case "qty-dec": setQty(r, (Number(state.lines[r].qty) || 1) - 1); cellInput(r, 1).value = state.lines[r].qty; break;
        case "qty-inc": setQty(r, (Number(state.lines[r].qty) || 0) + 1); cellInput(r, 1).value = state.lines[r].qty; break;
        case "place-bid": requestPlace("bid"); break;
        case "place-order": requestPlace("order"); break;
        case "cancel-place": state.confirm = null; state.placeError = null; render(); break;
        case "confirm-place": place(); break;
        case "new-order": leaveExisting(); startOrder(state.shipTo); break;
        case "change-shipto": state.keepOrder = true; state.view = "shipto"; render(); break;
        case "toggle-stock": toggleStock(); break;
        case "close-side": state.sidePanel = false; render(); break;
      }
    });

    root.addEventListener("input", function (e) {
      var t = e.target;
      if (t.id === "fop-customer-search") { acSearch(t, "customer", null); return; }
      if (t.id === "fop-freight-in") { state.header.freightIn = t.value; refreshTotals(); return; }
      if (t.classList.contains("fop-notes")) {
        autosizeNotes(t);
        state.header[t.getAttribute("data-head")] = t.value;
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
        if (key === "shipBranch") refreshAllRows();
        if (key === "shipVia") refreshAllRows();
        if (key === "orderStatus") refreshConfirmText();
        refreshTotals();
        return;
      }
      if (t.classList.contains("fop-grid-in")) {
        var r = Number(t.getAttribute("data-r"));
        var c = Number(t.getAttribute("data-c"));
        if (c === 1) { setQty(r, t.value); t.value = state.lines[r].qty; }
        if (c === 2) { setPrice(r, t.value); t.value = priceText(state.lines[r]); }
      }
    });

    root.addEventListener("focusin", function (e) {
      var t = e.target;
      if (t.classList && t.classList.contains("fop-grid-in")) {
        state.focus = { r: Number(t.getAttribute("data-r")), c: Number(t.getAttribute("data-c")) };
        if (sideLayout && state.focus.r !== sideRow) refreshSide();
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
      if (e.key === "Escape" && (state.stockAll || state.breaksAll || (sideLayout && state.sidePanel))) {
        e.preventDefault(); state.stockAll = false; state.breaksAll = false; if (sideLayout) state.sidePanel = false; render(); return true;
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
          if (r === state.lines.length - 1) addLine(r);
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

      // Other orders dialog: Esc closes, ↑↓ move between orders, Enter opens
      // (native button click), Tab stays in the dialog.
      if (state.view === "order" && state.ordersModal) {
        var rows = Array.prototype.slice.call(root.querySelectorAll(".fop-modal [data-open-order], .fop-modal button[data-action]"));
        var at = rows.indexOf(document.activeElement);
        if (e.key === "Escape") { e.preventDefault(); closeOrdersModal(); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab") {
          if (rows.length) {
            e.preventDefault();
            var back = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey);
            rows[(at + (back ? -1 : 1) + rows.length) % rows.length].focus();
          }
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

      // Confirm dialog owns the keyboard.
      if (state.view === "order" && state.confirm) {
        if (e.key === "Escape" && !state.placing) { e.preventDefault(); state.confirm = null; state.placeError = null; render(); }
        else if (e.key === "Enter" && !state.placing && !(t.getAttribute && t.getAttribute("data-action") === "cancel-place")) {
          e.preventDefault(); place();
        } else if (t.id === "fop-confirm-status" && (e.key === "ArrowDown" || e.key === "ArrowUp" || /^[1-9]$/.test(e.key))) {
          // Pick the status without opening the native list.
          var n = ORDER_STATUSES.length;
          var next = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : t.selectedIndex + (e.key === "ArrowDown" ? 1 : -1);
          if (next >= 0 && next < n) {
            e.preventDefault();
            t.selectedIndex = next;
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
      // (native button click), N starts a new order, Esc changes customer.
      if (state.view === "orders") {
        if (t.type === "checkbox" && e.key !== "Escape") return;
        var items = Array.prototype.slice.call(root.querySelectorAll("[data-action=new-from-list], [data-open-order]"));
        var oi = items.indexOf(document.activeElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (items.length) items[oi < 0 ? 0 : (oi + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
        } else if ((e.key === "n" || e.key === "N") && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
        if ((e.key === "n" || e.key === "N") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); leaveExisting(); startOrder(state.shipTo); }
        return;
      }

      if (state.view !== "order") return;

      // Page-level shortcuts.
      // Existing order: F9 is Update Bid (bids only); F10 does nothing.
      if (e.key === "F9") { e.preventDefault(); requestPlace(state.existing ? "update" : "bid"); return; }
      if (e.key === "F10") { e.preventDefault(); if (!state.existing) requestPlace("order"); return; }
      if (e.key === "F2") {
        e.preventDefault();
        var firstHead = root.querySelector("#fop-head [data-head]");
        if (firstHead) firstHead.focus();
        return;
      }
      if (e.key === "F3") { e.preventDefault(); focusCell(state.focus.r, state.focus.c); return; }
      if (e.key === "F4") { e.preventDefault(); toggleStock(); return; }

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
    document.addEventListener("keydown", function (e) {
      if (root.contains(e.target) || (e.key !== "Escape" && e.key !== "Tab")) return;
      if (state.view === "order" && (state.logModal || state.ordersModal || state.cancelAsk || state.confirm)) onKey(e);
    });

    // Close an open list when clicking elsewhere.
    document.addEventListener("mousedown", function (e) {
      if (ac && !ac.list.contains(e.target) && e.target !== ac.input) acClose();
    });

    // ── Boot ───────────────────────────────────────────────────────────────
    // ?e_sorder_id wins over ?e_customer_id (the order names its customers),
    // and URL products never seed a later "New order" from it.
    if (state.orderId) { urlProducts = []; loadExistingOrder(state.orderId); }
    else if (state.customerId) loadCustomer(state.customerId);
    else render();
  }

  function boot() {
    initApp(document.getElementById("app"));
  }

  // Loaded with defer, so the DOM is ready. Wait for the password gate so
  // FB_USER (writer, branch) is known.
  if (window.FB_USER) boot();
  else window.addEventListener("fb:auth", boot, { once: true });
})();
