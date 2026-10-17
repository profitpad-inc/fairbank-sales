// ===========================================================================
// Fairbank Order Placement, module.js
// ===========================================================================
//
// Web (Design Manager) port of the Eclipse Branch Fulfillment app card
// (BranchFulfillmentCard.jsx). Same 3-step flow:
//
//   Step 1: Select Option, Recommended Option (minimum branch combo) or
//           Custom Branch Selection (per-item branch/qty splits, each split
//           with its own required date / ship date / ship status, plus an
//           "Apply to all items" bulk control).
//   Step 2: Review & Confirm, per-split review table (Custom) or branch +
//           routing summary with order-level shipment details (Recommended).
//   Step 3: Order Submitted, per-generation breakdown + "View deals" link.
//
// Differences from the app card, all forced by the surface change:
//   • Deal context comes from the page URL (?dealId=...) instead of the CRM
//     record; a small picker renders when the parameter is absent.
//   • Backend calls go over fetch() to the n8n webhooks
//     (e-order-placement/v1/inventory-lookup and /v1/place-order, see
//     n8n-flows/) instead of runServerless(). Payloads and responses are
//     identical to the old app functions.
//   • Dates are plain YYYY-MM-DD strings from native <input type="date">
//     elements, exactly the format Eclipse expects, so no DateInput
//     {year, month, date} conversion layer is needed.
//   • Rendering is plain DOM re-render on state change with one delegated
//     listener per event type; inputs commit on the change event.
//
// The placement algorithm, gates, gating messages, and idempotency
// guarantees all live server-side and are unchanged from the app card.
// ===========================================================================

(function () {
  "use strict";

  // ── Shared constants (mirrors the app card) ─────────────────────────────

  var SHIP_STATUS_OPTIONS = [
    { label: "Bid",                 value: "Bid" },
    { label: "Call When Available", value: "CallWhenAvailable" },
    { label: "Ship When Available", value: "ShipWhenAvailable" },
    { label: "Call When Complete",  value: "CallWhenComplete" },
    { label: "Ship When Complete",  value: "ShipWhenComplete" },
    { label: "Ship Item Complete",  value: "ShipItemComplete" },
    { label: "Pick Up Now",         value: "PickUpNow" },
    { label: "Ship When Specified", value: "ShipWhenSpecified" },
    { label: "Call When Specified", value: "CallWhenSpecified" },
    { label: "Direct",              value: "Direct" },
    { label: "Ship Ticket",         value: "ShipTicket" },
  ];

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Local today as YYYY-MM-DD (NOT toISOString, Eclipse runs US Central
  // and a UTC-anchored date can be "yesterday" there).
  function todayIso() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }

  function formatDistance(km) {
    if (km === null || km === undefined || km >= 9999) return "Unknown";
    return (km * 0.621371).toFixed(1) + " mi";
  }

  // Fixed-width YYYY-MM-DD strings, so string compare is date compare.
  function requiredBeforeShip(requiredIso, shipIso) {
    if (!requiredIso || !shipIso) return false;
    return requiredIso < shipIso;
  }

  function newAssignmentRow(quantity) {
    return {
      branchId: "",
      quantity: quantity,
      requiredDate: todayIso(),
      shipDate: todayIso(),
      shipStatus: "Bid",
    };
  }

  function shortName(name) {
    return String(name || "").split("\n")[0].substring(0, 30);
  }

  // ── App instance ─────────────────────────────────────────────────────────

  function initApp(root) {
    var cfg = {
      title: root.getAttribute("data-title") || "Branch Fulfillment",
      apiBase: (root.getAttribute("data-api-base") ||
        "https://n8n.fairbankequipment.com/webhook/e-order-placement/v1").replace(/\/+$/, ""),
      dealParam: root.getAttribute("data-deal-param") || "dealId",
      portalId: root.getAttribute("data-portal-id") || "",
      viewId: root.getAttribute("data-view-id") || "",
    };

    var state = {
      dealId: new URLSearchParams(window.location.search).get(cfg.dealParam) || "",
      loading: false,
      error: null,
      lineItems: [],
      fulfillmentData: null,
      selectedOption: null,
      itemBranchAssignments: {}, // { [pid]: [{branchId, quantity, requiredDate, shipDate, shipStatus}] }
      step: 0,
      placing: false,
      placeError: null,
      placeResult: null,
      // Order-level shipment details (Recommended Option only).
      shipStatus: "Bid",
      requiredDate: todayIso(),
      shipDate: todayIso(),
      // "Apply to all items" bulk controls (Custom mode).
      bulkBranchId: "",
      bulkRequiredDate: todayIso(),
      bulkShipDate: todayIso(),
      bulkShipStatus: "Bid",
    };

    // ── Backend calls ──────────────────────────────────────────────────────

    function callApi(endpoint, payload) {
      return fetch(cfg.apiBase + "/" + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function (res) {
        return res
          .json()
          .catch(function () { return {}; })
          .then(function (data) { return { status: res.status, data: data }; });
      });
    }

    function fetchData() {
      state.loading = true;
      state.error = null;
      render();

      callApi("inventory-lookup", { dealId: String(state.dealId) })
        .then(function (res) {
          var data = res.data || {};
          // The endpoint returns errors in-band as { error }; a `blocked`
          // payload is a valid (non-error) response.
          if (data.error && !data.blocked) {
            state.error = data.error;
            return;
          }
          if (res.status >= 400 && !data.blocked) {
            state.error = data.error || data.message || ("Server error (status " + res.status + ")");
            return;
          }
          state.lineItems = data.lineItems || [];
          state.fulfillmentData = data;
          state.step = state.lineItems.length ? 1 : 0;
          seedAssignments();
        })
        .catch(function (err) {
          state.error = "Error: " + err.message;
        })
        .then(function () {
          state.loading = false;
          render();
        });
    }

    // Seed Custom mode with one full-qty row per orderable item, so the rep
    // only has to pick a branch. Only seeds pids with no rows yet, safe to
    // re-run, user-edited rows aren't touched.
    function seedAssignments() {
      for (var i = 0; i < state.lineItems.length; i++) {
        var li = state.lineItems[i];
        var pid = li.eclipseProductId;
        if (!pid) continue;
        if (!state.itemBranchAssignments[pid] || !state.itemBranchAssignments[pid].length) {
          state.itemBranchAssignments[pid] = [newAssignmentRow(li.quantity || 1)];
        }
      }
    }

    function eclipseOrderId() {
      return (state.fulfillmentData && state.fulfillmentData.deal &&
        state.fulfillmentData.deal.eclipseOrderId) || "";
    }

    // Group the selected option's splits into generations keyed by
    // (branch, requiredDate, shipDate, shipStatus) and post to the
    // place-order endpoint. Same grouping as the app card: Custom splits
    // carry their own shipment details; Recommended splits fall back to the
    // order-level pickers.
    function placeOrder() {
      var sel = state.selectedOption;
      if (!sel || !sel.assignments) {
        state.placeError = "No option selected.";
        render();
        return;
      }
      state.placing = true;
      state.placeError = null;
      state.placeResult = null;
      render();

      var genMap = {};
      for (var i = 0; i < state.lineItems.length; i++) {
        var item = state.lineItems[i];
        var pid = item.eclipseProductId;
        if (!pid) continue;
        var splits = sel.assignments[pid];
        if (!Array.isArray(splits) || !splits.length) continue;
        for (var j = 0; j < splits.length; j++) {
          var split = splits[j];
          if (!split.branchId || !split.quantity) continue;
          var reqIso = split.requiredDate || state.requiredDate || undefined;
          var shipIso = split.shipDate || state.shipDate || undefined;
          var rowStatus = split.shipStatus || state.shipStatus;
          var key = split.branchId + "|" + reqIso + "|" + shipIso + "|" + rowStatus;
          if (!genMap[key]) {
            genMap[key] = {
              branchId: split.branchId,
              lineItems: [],
              shipStatus: rowStatus,
              requiredDate: reqIso,
              shipDate: shipIso,
            };
          }
          genMap[key].lineItems.push({
            eclipseProductId: pid,
            quantity: split.quantity,
          });
        }
      }
      var generations = Object.keys(genMap).map(function (k) { return genMap[k]; });

      callApi("place-order", {
        dealId: String(state.dealId),
        eclipseOrderId: String(eclipseOrderId()),
        generations: generations,
      })
        .then(function (res) {
          var data = res.data || {};
          if (data.success) {
            state.placeResult = data;
            state.step = 3;
          } else {
            state.placeError =
              (data.error || "Unknown error") + (data.step ? " (step: " + data.step + ")" : "");
          }
        })
        .catch(function (err) {
          state.placeError = "Error: " + err.message;
        })
        .then(function () {
          state.placing = false;
          render();
        });
    }

    // ── Derived data ───────────────────────────────────────────────────────

    // Duplicate-product detection: same Eclipse product on two separate
    // HubSpot line items → assignments would collide. Surface a blocking
    // warning; the rep should combine them on the deal.
    function duplicateProducts() {
      var seen = {};
      for (var i = 0; i < state.lineItems.length; i++) {
        var li = state.lineItems[i];
        var pid = li.eclipseProductId;
        if (!pid) continue;
        if (!seen[pid]) seen[pid] = [];
        seen[pid].push({ name: li.name || ("Product " + pid), quantity: li.quantity });
      }
      var out = [];
      for (var k in seen) {
        if (seen[k].length > 1) out.push({ eclipseProductId: k, rows: seen[k] });
      }
      return out;
    }

    function branchMap() {
      var map = {};
      var arr = (state.fulfillmentData && state.fulfillmentData.branchMatrix) || [];
      for (var i = 0; i < arr.length; i++) map[arr[i].branchId] = arr[i];
      return map;
    }

    function orderableItems() {
      var unavailableIds = unavailableIdSet();
      return state.lineItems
        .filter(function (i) { return i.eclipseProductId; })
        .slice()
        .sort(function (a, b) {
          var au = unavailableIds.has(String(a.eclipseProductId)) ? 1 : 0;
          var bu = unavailableIds.has(String(b.eclipseProductId)) ? 1 : 0;
          return au - bu;
        });
    }

    function unavailableIdSet() {
      var list = (state.fulfillmentData && state.fulfillmentData.unavailableProducts) || [];
      return new Set(list.map(function (p) { return String(p.productId); }));
    }

    // First failing condition gating "Review Selection", or null when the
    // custom picker is fully and validly assigned.
    function reviewDisabledReason() {
      var items = orderableItems();
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var pid = item.eclipseProductId;
        var needed = item.quantity || 1;
        var rows = state.itemBranchAssignments[pid] || [];
        var label = pid || item.name || "an item";
        if (!rows.length) return "Assign at least one branch for " + label + ".";
        var allBranches = rows.every(function (r) { return r.branchId; });
        if (!allBranches) return "Pick a branch for every row on " + label + ".";
        var sum = rows.reduce(function (n, r) { return n + (Number(r.quantity) || 0); }, 0);
        if (sum !== needed) {
          return label + ": assigned " + sum + " of " + needed + ", totals must match.";
        }
        var badDate = rows.some(function (r) {
          return requiredBeforeShip(r.requiredDate, r.shipDate);
        });
        if (badDate) return label + ": required date cannot be before ship date.";
      }
      return null;
    }

    // ── HTML fragments ─────────────────────────────────────────────────────

    function alertHtml(variant, title, bodyHtml) {
      return (
        '<div class="fob-alert fob-alert--' + variant + '">' +
        '<span class="fob-alert__title">' + esc(title) + "</span>" +
        (bodyHtml || "") +
        "</div>"
      );
    }

    function stepIndicatorHtml(current) {
      var names = ["Select Option", "Review & Confirm"];
      var html = '<div class="fob-steps">';
      for (var i = 0; i < names.length; i++) {
        html +=
          '<div class="fob-steps__step' + (i === current ? " fob-steps__step--active" : "") + '">' +
          '<span class="fob-steps__num">' + (i + 1) + "</span>" +
          "<span>" + esc(names[i]) + "</span></div>";
      }
      return html + "</div>";
    }

    function duplicateBannerHtml() {
      var dups = duplicateProducts();
      if (!dups.length) return "";
      var list = dups
        .map(function (d) {
          return (
            "<div><span class='fob-bold'>" + esc(d.rows[0].name) + "</span> (Product ID " +
            esc(d.eclipseProductId) + "), appears " + d.rows.length + " times</div>"
          );
        })
        .join("");
      return alertHtml(
        "error",
        "Duplicate line items detected",
        "<div>This deal has the same Eclipse product listed on more than one line item. " +
          "Quantities cannot be split across branches when the same product appears twice, " +
          "combine them into a single line item (with the summed quantity) on the deal " +
          "before placing the order.</div>" + list
      );
    }

    function selectHtml(attrs, options, selected, placeholder) {
      var html = "<select " + attrs + ">";
      if (placeholder) {
        html += '<option value=""' + (selected ? "" : " selected") + ">" + esc(placeholder) + "</option>";
      }
      for (var i = 0; i < options.length; i++) {
        var o = options[i];
        html +=
          '<option value="' + esc(o.value) + '"' +
          (String(o.value) === String(selected) ? " selected" : "") + ">" +
          esc(o.label) + "</option>";
      }
      return html + "</select>";
    }

    function shipStatusSelectHtml(attrs, selected) {
      return selectHtml(attrs, SHIP_STATUS_OPTIONS, selected || "Bid", null);
    }

    // "Which branch ships which item" summary table (Recommended tile +
    // Recommended review).
    function assignmentTableHtml(assignments) {
      var fd = state.fulfillmentData;
      if (!fd || !fd.productIds || !fd.productIds.length || !assignments) return "";
      var bMap = branchMap();
      var itemByPid = {};
      state.lineItems.forEach(function (it) {
        if (it.eclipseProductId) itemByPid[it.eclipseProductId] = it;
      });
      var rows = fd.productIds
        .map(function (pid) {
          var item = itemByPid[pid];
          var splits = assignments[pid];
          var totalQty = Array.isArray(splits)
            ? splits.reduce(function (s, x) { return s + (x.quantity || 0); }, 0)
            : 0;
          var ships;
          if (Array.isArray(splits) && splits.length) {
            ships =
              '<span class="fob-inline-tags">' +
              splits
                .map(function (s) {
                  var b = bMap[s.branchId];
                  var lbl = b ? b.branchName : "Branch " + s.branchId;
                  return (
                    '<span class="fob-tag">' + esc(lbl) +
                    (splits.length > 1 ? " (" + s.quantity + ")" : "") + "</span>"
                  );
                })
                .join("") +
              "</span>";
          } else {
            ships = '<span class="fob-tag fob-tag--error">Unassigned</span>';
          }
          return (
            "<tr><td>" + esc(item ? shortName(item.name) : "PID " + pid) + "</td>" +
            "<td>" + (totalQty || (item ? item.quantity || 1 : "-")) + "</td>" +
            "<td>" + ships + "</td></tr>"
          );
        })
        .join("");
      return (
        '<div class="fob-table-wrap"><table class="fob-table">' +
        "<thead><tr><th>Item</th><th>Qty</th><th>Ships From</th></tr></thead>" +
        "<tbody>" + rows + "</tbody></table></div>"
      );
    }

    // "Line Items on this Deal" summary table shown at the top of step 1.
    // The app card dropped this tile (build #81) because HubSpot's native
    // line-items panel sits right next to the CRM card; the website page
    // has no such panel, so the web version brings it back.
    function lineItemsTableHtml() {
      if (!state.lineItems.length) return "";
      var rows = state.lineItems
        .map(function (li) {
          var price = Number(li.price) || 0;
          return (
            "<tr><td>" + esc(shortName(li.name)) + "</td>" +
            "<td>" + esc(li.eclipseProductId || "—") + "</td>" +
            "<td>" + (li.quantity || 1) + "</td>" +
            "<td>$" + price.toFixed(2) + "</td></tr>"
          );
        })
        .join("");
      return (
        '<div class="fob-tile">' +
        '<div class="fob-bold">Line Items on this Deal</div>' +
        '<div class="fob-table-wrap"><table class="fob-table">' +
        "<thead><tr><th>Item</th><th>Product ID</th><th>Qty</th><th>Unit Price</th></tr></thead>" +
        "<tbody>" + rows + "</tbody></table></div></div>"
      );
    }

    // Branch × product stock grid (Custom mode reference table).
    function branchProductTableHtml(branches, productIds) {
      if (!branches || !branches.length || !productIds || !productIds.length) return "";
      var nameMap = {};
      var qtyMap = {};
      state.lineItems.forEach(function (item) {
        nameMap[item.eclipseProductId] = shortName(item.name);
        qtyMap[item.eclipseProductId] = item.quantity || 1;
      });
      var head =
        "<tr><th>Branch</th><th>Dist.</th>" +
        productIds
          .map(function (pid) {
            return (
              "<th>" + esc(nameMap[pid] || "PID " + pid) +
              (qtyMap[pid] > 1 ? " (need " + qtyMap[pid] + ")" : "") + "</th>"
            );
          })
          .join("") +
        "</tr>";
      var body = branches
        .map(function (b) {
          var cells = productIds
            .map(function (pid) {
              var qty = b.products[pid] || 0;
              var needed = qtyMap[pid] || 1;
              var variant = qty >= needed ? "success" : qty > 0 ? "warning" : "error";
              return '<td><span class="fob-tag fob-tag--' + variant + '">' + qty + "</span></td>";
            })
            .join("");
          return (
            "<tr><td>" + esc(b.branchName) + "</td><td>" +
            esc(formatDistance(b.distanceKm)) + "</td>" + cells + "</tr>"
          );
        })
        .join("");
      return (
        '<div class="fob-table-wrap"><table class="fob-table">' +
        "<thead>" + head + "</thead><tbody>" + body + "</tbody></table></div>"
      );
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function viewDealPicker() {
      return (
        '<div class="fob-stack">' +
        '<h1 class="fob-h1">' + esc(cfg.title) + "</h1>" +
        '<div class="fob-tile"><div class="fob-bold">Enter a HubSpot deal ID</div>' +
        "<div>This page was opened without a <code>?" + esc(cfg.dealParam) +
        "=</code> parameter in the URL. Enter the deal ID to load its line items " +
        "and Eclipse inventory.</div>" +
        '<div class="fob-row-flex"><div class="fob-field fob-grow-2">' +
        '<label for="fob-deal-input">Deal ID</label>' +
        '<input type="text" id="fob-deal-input" inputmode="numeric" placeholder="e.g. 26989612345" />' +
        "</div>" +
        '<button class="fob-btn fob-btn--primary" data-action="load-deal">Load deal</button>' +
        "</div></div></div>"
      );
    }

    function viewLoading() {
      return (
        '<div class="fob-loading"><div class="fob-spinner"></div>' +
        "<div>Checking Eclipse inventory across branches...</div></div>"
      );
    }

    function viewError() {
      return (
        '<div class="fob-stack">' +
        alertHtml("error", "Eclipse API Error", "<div>" + esc(state.error) + "</div>") +
        '<div><button class="fob-btn fob-btn--secondary" data-action="retry-load">Retry</button></div>' +
        "</div>"
      );
    }

    function viewBlocked() {
      var blocked = state.fulfillmentData.blocked;
      var title =
        blocked.reason === "stage"
          ? "Order locked by deal stage"
          : blocked.reason === "missing_product_ids"
          ? "Missing Eclipse Product IDs"
          : "Eclipse Order ID missing";
      var missing = Array.isArray(blocked.missingItems) ? blocked.missingItems : [];
      var missingHtml = "";
      if (missing.length) {
        missingHtml =
          '<div class="fob-tile"><div class="fob-bold">Line items missing an Eclipse Product ID:</div>' +
          missing
            .map(function (name, idx) { return "<div>" + (idx + 1) + ". " + esc(name) + "</div>"; })
            .join("") +
          "</div>";
      }
      return (
        '<div class="fob-stack">' +
        alertHtml("warning", title, "<div>" + esc(blocked.message) + "</div>") +
        missingHtml +
        "</div>"
      );
    }

    function viewEmpty() {
      return (
        '<div class="fob-empty"><div class="fob-h2">No Line Items</div>' +
        "<p>Add line items with Eclipse Product IDs to this deal to check branch availability.</p></div>"
      );
    }

    // ── Step 1 ──
    function viewStep1() {
      var fd = state.fulfillmentData;
      var opts = fd.fulfillmentOptions || {};
      var unavailable = fd.unavailableProducts || [];
      var failed = fd.failedProducts || [];
      var hasUnavailable = unavailable.length > 0;
      var bMap = branchMap();

      var html = '<div class="fob-stack">';
      html += '<h1 class="fob-h1">Branch Fulfillment Options</h1>';
      if (fd.deal && fd.deal.dealName) {
        html +=
          '<div class="fob-muted">Deal: ' + esc(fd.deal.dealName) +
          " (ID " + esc(state.dealId) + ")</div>";
      }
      html += duplicateBannerHtml();
      html += lineItemsTableHtml();
      html += stepIndicatorHtml(0);

      if (failed.length) {
        html += alertHtml(
          "error",
          "Eclipse API Errors",
          "<div>The following products could not be checked, they may have inventory but the Eclipse query failed:</div>" +
            failed
              .map(function (p) {
                return "<div>• Product ID: " + esc(p.productId) + ", " + esc(p.error) + "</div>";
              })
              .join("")
        );
      }

      // ── Recommended Option tile ──
      var combo = opts.closestCombo;
      html += '<div class="fob-tile">';
      html +=
        '<div class="fob-space-between"><span class="fob-bold">Recommended Option</span>' +
        (combo && !hasUnavailable
          ? '<span class="fob-tag fob-tag--success">Available</span>'
          : '<span class="fob-tag fob-tag--warning">Not Available</span>') +
        "</div>";
      if (combo && !hasUnavailable) {
        var comboLine =
          combo.branches.length === 1
            ? "1 branch (" + esc(combo.branches[0].branchName) + "), " + esc(formatDistance(combo.maxDistance))
            : combo.branches.length + " branches, farthest at " + esc(formatDistance(combo.maxDistance));
        html += "<div>" + comboLine + "</div>";
        html += '<div class="fob-bold">Per-Item Routing</div>';
        html += assignmentTableHtml(combo.assignments || {});
        html +=
          '<div><button class="fob-btn fob-btn--primary" data-action="select-recommended">Select This Option</button></div>';
      } else if (hasUnavailable) {
        html +=
          "<div>Some items have no stock at any branch, use Custom Branch Selection below to manually assign branches.</div>";
      } else {
        html += "<div>Could not find a combination of branches covering all items.</div>";
      }
      html += "</div>";

      // ── Custom Branch Selection tile ──
      html += '<div class="fob-tile">';
      html += '<div class="fob-bold">Custom Branch Selection</div>';
      html += "<div>Review stock levels, then choose which branch to order each item from.</div>";

      if (opts.allBranchesWithStock && opts.allBranchesWithStock.length) {
        html += branchProductTableHtml(opts.allBranchesWithStock, fd.productIds);
      }

      html += '<hr class="fob-divider" />';

      // "Apply to all items" bulk tile.
      var allBranchesArr = fd.branchMatrix || [];
      var bulkOptions = allBranchesArr.map(function (b) {
        return { label: b.branchName + " (" + formatDistance(b.distanceKm) + ")", value: b.branchId };
      });
      var bulkDateError = requiredBeforeShip(state.bulkRequiredDate, state.bulkShipDate);
      html += '<div class="fob-tile fob-tile--inner">';
      html += '<div class="fob-bold">Apply to all items</div>';
      html +=
        "<div>Pick a branch and shipment details, then apply them to every item at once. " +
        "This replaces any branch splits you have set; you can still fine-tune individual items " +
        "afterward. Items the branch does not stock become special orders.</div>";
      html +=
        '<div class="fob-field"><label>Fulfill all items from</label>' +
        selectHtml('data-action="bulk-branch"', bulkOptions, state.bulkBranchId, "Select a branch...") +
        "</div>";
      html +=
        '<div class="fob-row-flex">' +
        '<div class="fob-field fob-grow-1"><label>Required date</label>' +
        '<input type="date" data-action="bulk-reqdate" value="' + esc(state.bulkRequiredDate) + '" /></div>' +
        '<div class="fob-field fob-grow-1"><label>Ship date</label>' +
        '<input type="date" data-action="bulk-shipdate" value="' + esc(state.bulkShipDate) + '" /></div>' +
        '<div class="fob-field fob-grow-2"><label>Ship status</label>' +
        shipStatusSelectHtml('data-action="bulk-shipstatus"', state.bulkShipStatus) +
        "</div></div>";
      if (bulkDateError) {
        html += '<div class="fob-error-text">Required date cannot be before ship date.</div>';
      }
      html +=
        '<div><button class="fob-btn fob-btn--secondary fob-btn--sm" data-action="apply-bulk"' +
        (!state.bulkBranchId || bulkDateError ? " disabled" : "") + ">Apply to all items</button>" +
        (!state.bulkBranchId
          ? '<div class="fob-gate-reason">Pick a branch to apply to every item.</div>'
          : "") +
        "</div>";
      html += "</div>"; // end bulk tile

      html += '<hr class="fob-divider" />';
      html += '<div class="fob-bold">Assign each item to a branch:</div>';

      // Per-item split editors.
      var unavailableIds = unavailableIdSet();
      var items = orderableItems();
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var pid = item.eclipseProductId;
        var isUnavailable = unavailableIds.has(String(pid));
        var needed = item.quantity || 1;
        var rows = state.itemBranchAssignments[pid] || [];
        var assigned = rows.reduce(function (n, r) { return n + (Number(r.quantity) || 0); }, 0);
        var overAssigned = assigned > needed;
        var fullyAssigned = assigned === needed && rows.every(function (r) { return r.branchId; });

        var branchOptions = allBranchesArr.map(function (b) {
          var qty = b.products[pid] || 0;
          return {
            label: b.branchName + ", " + qty + " in stock (" + formatDistance(b.distanceKm) + ")",
            value: b.branchId,
          };
        });

        html += '<div class="fob-tile fob-tile--inner">';
        html += '<div class="fob-bold">' + esc(shortName(item.name)) + "</div>";
        html += "<div>Need: " + needed + " | Product ID: " + esc(pid) + "</div>";
        if (isUnavailable) {
          html +=
            '<div><span class="fob-tag fob-tag--error">Not available anywhere, assign branch for special order</span></div>';
        }

        for (var r = 0; r < rows.length; r++) {
          var row = rows[r];
          var otherSum = rows.reduce(function (n, rr, ii) {
            return ii === r ? n : n + (Number(rr.quantity) || 0);
          }, 0);
          var rowMax = Math.max(1, needed - otherSum);
          var rowDateError = requiredBeforeShip(row.requiredDate, row.shipDate);
          var pidAttr = ' data-pid="' + esc(pid) + '" data-idx="' + r + '"';

          html += '<div class="fob-row-flex">';
          html +=
            '<div class="fob-field fob-grow-3"><label>Fulfill from</label>' +
            selectHtml('data-action="row-branch"' + pidAttr, branchOptions, row.branchId || "", "Select a branch...") +
            "</div>";
          html +=
            '<div class="fob-field fob-grow-1"><label>Quantity</label>' +
            '<input type="number" data-action="row-qty"' + pidAttr +
            ' min="1" max="' + rowMax + '" step="1" value="' + esc(row.quantity) + '" /></div>';
          html +=
            '<div><button class="fob-btn fob-btn--destructive fob-btn--sm" data-action="remove-row"' +
            pidAttr + (rows.length <= 1 ? " disabled" : "") + ">Remove</button></div>";
          html += "</div>";

          html += '<div class="fob-row-flex">';
          html +=
            '<div class="fob-field fob-grow-1"><label>Required date</label>' +
            '<input type="date" data-action="row-reqdate"' + pidAttr +
            ' value="' + esc(row.requiredDate) + '" /></div>';
          html +=
            '<div class="fob-field fob-grow-1"><label>Ship date</label>' +
            '<input type="date" data-action="row-shipdate"' + pidAttr +
            ' value="' + esc(row.shipDate) + '" /></div>';
          html +=
            '<div class="fob-field fob-grow-2"><label>Ship status</label>' +
            shipStatusSelectHtml('data-action="row-shipstatus"' + pidAttr, row.shipStatus) +
            "</div>";
          html += "</div>";

          if (rowDateError) {
            html += '<div class="fob-error-text">Required date cannot be before ship date.</div>';
          }
          if (r < rows.length - 1) html += '<hr class="fob-divider fob-divider--light" />';
        }

        html += '<div class="fob-space-between">';
        var addDisabled = rows.length >= needed;
        html +=
          '<div><button class="fob-btn fob-btn--secondary fob-btn--sm" data-action="add-row" data-pid="' +
          esc(pid) + '"' + (addDisabled ? " disabled" : "") + ">+ Add branch</button>" +
          (addDisabled
            ? '<div class="fob-gate-reason">' +
              (needed === 1
                ? "Cannot split, only 1 unit needed for this item."
                : "Already split across " + needed + " branches (max for this item, since each branch needs at least 1 unit).") +
              "</div>"
            : "") +
          "</div>";
        html +=
          '<span class="' +
          (fullyAssigned ? "fob-success-text" : overAssigned ? "fob-error-text" : "fob-bold") +
          '">Assigned: ' + assigned + " / " + needed + (overAssigned ? " (over)" : "") + "</span>";
        html += "</div>";
        html += "</div>"; // end item tile
      }

      // Review Selection button, gated with an inline reason.
      var reason = reviewDisabledReason();
      html +=
        '<div><button class="fob-btn fob-btn--primary" data-action="review-selection"' +
        (reason ? " disabled" : "") + ">Review Selection</button>" +
        (reason ? '<div class="fob-gate-reason">' + esc(reason) + "</div>" : "") +
        "</div>";

      html += "</div>"; // end custom tile

      html += '<hr class="fob-divider" />';
      html +=
        '<div><button class="fob-btn fob-btn--secondary fob-btn--sm" data-action="refresh">Refresh Inventory</button></div>';
      html += "</div>";
      return html;
    }

    // ── Step 2 ──
    function viewStep2() {
      var sel = state.selectedOption;
      var assignments = sel.assignments || {};
      var isCustom = sel.type === "custom" && Object.keys(assignments).length > 0;
      var fd = state.fulfillmentData;
      var bMap = branchMap();

      var shipmentDateError = isCustom
        ? Object.keys(assignments).some(function (pid) {
            return (assignments[pid] || []).some(function (s) {
              return requiredBeforeShip(s.requiredDate, s.shipDate);
            });
          })
        : requiredBeforeShip(state.requiredDate, state.shipDate);

      var allCovered = true;
      if (isCustom) {
        var orderable = state.lineItems.filter(function (i) { return i.eclipseProductId; });
        allCovered = orderable.every(function (item) {
          var splits = assignments[item.eclipseProductId];
          return Array.isArray(splits) && splits.length > 0;
        });
      }

      var html = '<div class="fob-stack">';
      html += '<h1 class="fob-h1">Review Selection</h1>';
      html += duplicateBannerHtml();
      html += stepIndicatorHtml(1);

      if (!allCovered) {
        html += alertHtml("warning", "Incomplete Coverage",
          "<div>Some items have not been assigned to a branch.</div>");
      }

      html += '<div class="fob-tile">';
      html +=
        '<div class="fob-bold">Selected: ' +
        (sel.type === "closestCombo" ? "Recommended Option" : "Custom Branch Selection") +
        "</div>";

      if (isCustom) {
        var unavailSet = unavailableIdSet();
        var rowsHtml = state.lineItems
          .filter(function (item) { return item.eclipseProductId; })
          .map(function (item) {
            var pid = item.eclipseProductId;
            var isUnavail = unavailSet.has(String(pid));
            var splits = Array.isArray(assignments[pid]) ? assignments[pid] : [];

            if (!splits.length) {
              return (
                "<tr><td>" + esc(shortName(item.name)) +
                (isUnavail ? ' <span class="fob-tag fob-tag--warning">Special order</span>' : "") +
                "</td><td>" + (item.quantity || 1) + "</td>" +
                '<td><span class="fob-tag fob-tag--error">Not assigned</span></td>' +
                '<td><span class="fob-tag fob-tag--error">-</span></td><td>-</td></tr>'
              );
            }

            return splits
              .map(function (split) {
                var branch = bMap[split.branchId];
                var stockQty = branch ? branch.products[pid] || 0 : 0;
                var splitQty = Number(split.quantity) || 0;
                var stockVariant =
                  stockQty >= splitQty ? "success" : stockQty > 0 ? "warning" : "error";
                // Any split whose chosen branch has zero stock is a special
                // order, whether the product is unavailable everywhere or
                // the rep deliberately picked a 0-stock branch.
                var isSpecialOrder = stockQty === 0;
                var dateErr = requiredBeforeShip(split.requiredDate, split.shipDate);
                return (
                  "<tr><td>" + esc(shortName(item.name)) +
                  (isSpecialOrder ? ' <span class="fob-tag fob-tag--warning">Special order</span>' : "") +
                  "</td><td>" + splitQty + "</td><td>" +
                  (branch
                    ? '<span class="fob-tag">' + esc(branch.branchName) + "</span>"
                    : '<span class="fob-tag fob-tag--error">Not assigned</span>') +
                  '<div class="fob-italic">Req ' + esc(split.requiredDate || "-") +
                  " · Ship " + esc(split.shipDate || "-") + "</div>" +
                  (split.shipStatus ? '<div><span class="fob-tag">' + esc(split.shipStatus) + "</span></div>" : "") +
                  (dateErr ? '<div class="fob-error-text">Required before ship date</div>' : "") +
                  '</td><td><span class="fob-tag fob-tag--' + stockVariant + '">' + stockQty + "</span></td>" +
                  "<td>" + (branch ? esc(formatDistance(branch.distanceKm)) : "-") + "</td></tr>"
                );
              })
              .join("");
          })
          .join("");
        html +=
          '<div class="fob-table-wrap"><table class="fob-table">' +
          "<thead><tr><th>Item</th><th>Qty Needed</th><th>Fulfill From</th><th>In Stock</th><th>Distance</th></tr></thead>" +
          "<tbody>" + rowsHtml + "</tbody></table></div>";
      } else {
        html += sel.branches
          .map(function (b) {
            return (
              '<div class="fob-inline-tags"><span class="fob-tag">' + esc(b.branchName) +
              "</span><span>" + esc(formatDistance(b.distanceKm)) + "</span></div>"
            );
          })
          .join("");
        if (sel.assignments) {
          html += '<div class="fob-bold">Per-Item Routing</div>';
          html += assignmentTableHtml(sel.assignments);
        }
      }
      html += "</div>"; // end selected tile

      // Order-level shipment details, Recommended Option only (Custom set
      // these per split row in step 1).
      if (!isCustom) {
        html += '<div class="fob-tile">';
        html += '<div class="fob-h2">Shipment Details</div>';
        html += '<div class="fob-italic">Applied to every shipment/generation created by this order.</div>';
        html +=
          '<div class="fob-field"><label>Ship status</label>' +
          shipStatusSelectHtml('data-action="order-shipstatus"', state.shipStatus) +
          "</div>";
        html +=
          '<div class="fob-row-flex">' +
          '<div class="fob-field fob-grow-1"><label>Required date</label>' +
          '<input type="date" data-action="order-reqdate" value="' + esc(state.requiredDate) + '" /></div>' +
          '<div class="fob-field fob-grow-1"><label>Ship date</label>' +
          '<input type="date" data-action="order-shipdate" value="' + esc(state.shipDate) + '" /></div>' +
          "</div>";
        if (shipmentDateError) {
          html += '<div class="fob-error-text">Required date cannot be before ship date.</div>';
        }
        html += "</div>";
      }

      if (state.placeError) {
        html += alertHtml("error", "Failed to Place Order", "<div>" + esc(state.placeError) + "</div>");
      }

      if (!eclipseOrderId()) {
        html += alertHtml(
          "warning",
          "Missing Eclipse Order ID",
          "<div>This deal has no [E] Order ID (e_sorder_id) set. Add the Eclipse Sales Order ID to the deal before placing the order.</div>"
        );
      }

      var placeDisabled = !allCovered || !eclipseOrderId() || shipmentDateError || state.placing;
      var placeReason = state.placing
        ? "Order is being placed, please wait."
        : !eclipseOrderId()
        ? "This deal has no [E] Order ID (e_sorder_id). Set it on the deal before placing the order."
        : shipmentDateError
        ? "A shipment has its required date before its ship date. Fix the highlighted row before placing the order."
        : !allCovered
        ? "Some items are not fully assigned to a branch. Go back and finish the selection."
        : null;

      html += '<div class="fob-row-flex">';
      html +=
        '<button class="fob-btn fob-btn--secondary" data-action="back-to-options"' +
        (state.placing ? " disabled" : "") + ">Back to Options</button>";
      html +=
        '<button class="fob-btn fob-btn--primary" data-action="place-order"' +
        (placeDisabled ? " disabled" : "") + ">" +
        (state.placing ? "Placing Order…" : "Confirm & Place Order") + "</button>";
      html += "</div>";
      if (placeReason) html += '<div class="fob-gate-reason">' + esc(placeReason) + "</div>";

      html += "</div>";
      return html;
    }

    // ── Step 3 ──
    function viewStep3() {
      var bMap = branchMap();
      var productMap = {};
      state.lineItems.forEach(function (li) {
        if (li.eclipseProductId != null) productMap[li.eclipseProductId] = li;
      });

      var gens = (state.placeResult && state.placeResult.createdGenerations) || [];
      var totalLines = gens.reduce(function (n, g) {
        return n + (Array.isArray(g.lineItems) ? g.lineItems.length : 0);
      }, 0);
      var oid = eclipseOrderId();
      // The rep cares about the base order number, strip the gen suffix.
      var baseOid = oid ? String(oid).split(".")[0] : "";

      var html = '<div class="fob-stack">';
      html += '<h1 class="fob-h1">Order Submitted</h1>';
      html += alertHtml(
        "success",
        "Order placed in Eclipse",
        "<div>Sales Order " +
          (baseOid ? '<span class="fob-bold">' + esc(baseOid) + "</span>" : "(unknown ID)") +
          ", " + gens.length + " generation" + (gens.length === 1 ? "" : "s") +
          ", " + totalLines + " line item" + (totalLines === 1 ? "" : "s") + ".</div>"
      );

      html += gens
        .map(function (g) {
          var branch = bMap[g.branchId];
          var branchLabel = branch ? branch.branchName : "Branch " + g.branchId;
          var rows = (Array.isArray(g.lineItems) ? g.lineItems : [])
            .map(function (li) {
              var prod = productMap[li.eclipseProductId];
              var productName = (prod && prod.name) || "Product " + li.eclipseProductId;
              return (
                "<tr><td>" + esc(shortName(productName)) + "</td><td>" +
                esc(li.eclipseProductId) + "</td><td>" + li.quantity + "</td></tr>"
              );
            })
            .join("");
          return (
            '<div class="fob-tile">' +
            '<div class="fob-space-between"><span class="fob-bold">Generation ' +
            esc(g.generationId) + ", " + esc(branchLabel) + "</span>" +
            '<span class="fob-inline-tags">' +
            (g.reused
              ? '<span class="fob-tag fob-tag--warning">Reused existing</span>'
              : '<span class="fob-tag fob-tag--success">Newly created</span>') +
            (g.shipStatus ? '<span class="fob-tag">' + esc(g.shipStatus) + "</span>" : "") +
            "</span></div>" +
            '<div class="fob-inline-tags">' +
            '<span><span class="fob-bold">Required:</span> ' + esc(g.requiredDate || "-") + "</span>" +
            '<span><span class="fob-bold">Ship:</span> ' + esc(g.shipDate || "-") + "</span></div>" +
            (rows
              ? '<div class="fob-table-wrap"><table class="fob-table">' +
                "<thead><tr><th>Product</th><th>Product ID</th><th>Qty</th></tr></thead>" +
                "<tbody>" + rows + "</tbody></table></div>"
              : "") +
            "</div>"
          );
        })
        .join("");

      // Deep link to the deals board view filtered by the base order number.
      // Portal id and view id come from module fields (Fairbank defaults).
      if (baseOid && cfg.portalId && cfg.viewId) {
        var href =
          "https://app.hubspot.com/contacts/" + encodeURIComponent(cfg.portalId) +
          "/objects/0-3/views/" + encodeURIComponent(cfg.viewId) + "/board" +
          "?query=" + encodeURIComponent(baseOid);
        html +=
          '<div class="fob-tile"><div class="fob-bold">View deals</div>' +
          '<a class="fob-link" href="' + esc(href) + '" target="_blank" rel="noopener">' +
          "Open board view for " + esc(baseOid) + " ↗</a></div>";
      }

      html += "</div>";
      return html;
    }

    // ── Render dispatch ────────────────────────────────────────────────────

    function render() {
      var html;
      if (!state.dealId) {
        html = viewDealPicker();
      } else if (state.step === 3) {
        html = viewStep3();
      } else if (state.loading) {
        html = viewLoading();
      } else if (state.error) {
        html = viewError();
      } else if (state.fulfillmentData && state.fulfillmentData.blocked) {
        html = viewBlocked();
      } else if (!state.lineItems.length && state.fulfillmentData) {
        html = viewEmpty();
      } else if (state.step === 1 && state.fulfillmentData) {
        html = viewStep1();
      } else if (state.step === 2 && state.selectedOption) {
        html = viewStep2();
      } else {
        html =
          '<div class="fob-stack"><div>Something went wrong. Please refresh.</div>' +
          '<div><button class="fob-btn fob-btn--secondary" data-action="retry-load">Retry</button></div></div>';
      }
      root.innerHTML = html;
    }

    // ── Row mutators (Custom mode) ─────────────────────────────────────────

    function setRow(pid, idx, patch) {
      var rows = state.itemBranchAssignments[pid] || [];
      state.itemBranchAssignments[pid] = rows.map(function (r, i) {
        if (i !== idx) return r;
        var next = {};
        for (var k in r) next[k] = r[k];
        for (var p in patch) next[p] = patch[p];
        return next;
      });
    }

    // "+ Add branch": claim any slack first; with no slack, steal 1 from the
    // largest row so the running total stays at exactly `needed`.
    function addRow(pid) {
      var item = state.lineItems.find(function (li) {
        return String(li.eclipseProductId) === String(pid);
      });
      var needed = (item && item.quantity) || 1;
      var rows = state.itemBranchAssignments[pid] || [];
      var assigned = rows.reduce(function (n, r) { return n + (Number(r.quantity) || 0); }, 0);
      var remaining = Math.max(0, needed - assigned);

      var nextRows;
      if (remaining > 0) {
        nextRows = rows.concat([newAssignmentRow(remaining)]);
      } else {
        var donorIdx = -1;
        var donorQty = 0;
        rows.forEach(function (r, i) {
          var q = Number(r.quantity) || 0;
          if (q > donorQty) {
            donorIdx = i;
            donorQty = q;
          }
        });
        if (donorIdx >= 0 && donorQty > 1) {
          nextRows = rows
            .map(function (r, i) {
              if (i !== donorIdx) return r;
              var copy = {};
              for (var k in r) copy[k] = r[k];
              copy.quantity = donorQty - 1;
              return copy;
            })
            .concat([newAssignmentRow(1)]);
        } else {
          nextRows = rows.concat([newAssignmentRow(1)]);
        }
      }
      state.itemBranchAssignments[pid] = nextRows;
    }

    function removeRow(pid, idx) {
      var rows = state.itemBranchAssignments[pid] || [];
      state.itemBranchAssignments[pid] = rows.filter(function (_, i) { return i !== idx; });
    }

    // Overwrite every orderable item with a single full-qty row pointing at
    // the bulk-selected branch with the bulk shipment details.
    function applyBulk() {
      var next = {};
      for (var i = 0; i < state.lineItems.length; i++) {
        var li = state.lineItems[i];
        var pid = li.eclipseProductId;
        if (!pid) continue;
        next[pid] = [
          {
            branchId: state.bulkBranchId,
            quantity: li.quantity || 1,
            requiredDate: state.bulkRequiredDate,
            shipDate: state.bulkShipDate,
            shipStatus: state.bulkShipStatus,
          },
        ];
      }
      state.itemBranchAssignments = next;
    }

    function selectRecommended() {
      var opts = (state.fulfillmentData && state.fulfillmentData.fulfillmentOptions) || {};
      if (!opts.closestCombo) return;
      state.selectedOption = {
        type: "closestCombo",
        branches: opts.closestCombo.branches,
        assignments: opts.closestCombo.assignments || {},
      };
      state.placeError = null;
      state.step = 2;
    }

    function reviewSelection() {
      if (reviewDisabledReason()) return;
      var allRows = [];
      for (var pid in state.itemBranchAssignments) {
        allRows = allRows.concat(state.itemBranchAssignments[pid]);
      }
      var branchIds = [];
      allRows.forEach(function (r) {
        if (r.branchId && branchIds.indexOf(r.branchId) === -1) branchIds.push(r.branchId);
      });
      var allBranches = (state.fulfillmentData && state.fulfillmentData.branchMatrix) || [];
      var chosen = allBranches.filter(function (b) { return branchIds.indexOf(b.branchId) !== -1; });

      // Filter out residual rows with no branch or zero qty.
      var splitAssignments = {};
      for (var p in state.itemBranchAssignments) {
        var cleaned = state.itemBranchAssignments[p].filter(function (r) {
          return r.branchId && Number(r.quantity) > 0;
        });
        if (cleaned.length) splitAssignments[p] = cleaned;
      }
      state.selectedOption = {
        type: "custom",
        branches: chosen,
        assignments: splitAssignments,
      };
      state.placeError = null;
      state.step = 2;
    }

    // ── Event delegation ───────────────────────────────────────────────────

    root.addEventListener("click", function (e) {
      var el = e.target.closest("[data-action]");
      if (!el || el.disabled || !root.contains(el)) return;
      var action = el.getAttribute("data-action");
      var pid = el.getAttribute("data-pid");
      var idx = parseInt(el.getAttribute("data-idx"), 10);

      switch (action) {
        case "load-deal": {
          var input = root.querySelector("#fob-deal-input");
          var val = input && input.value.trim();
          if (!val) return;
          state.dealId = val;
          fetchData();
          return;
        }
        case "retry-load":
        case "refresh":
          fetchData();
          return;
        case "select-recommended":
          selectRecommended();
          break;
        case "apply-bulk":
          applyBulk();
          break;
        case "add-row":
          addRow(pid);
          break;
        case "remove-row":
          removeRow(pid, idx);
          break;
        case "review-selection":
          reviewSelection();
          break;
        case "back-to-options":
          state.placeError = null;
          state.step = 1;
          break;
        case "place-order":
          placeOrder();
          return; // placeOrder renders itself
        default:
          return;
      }
      render();
    });

    root.addEventListener("change", function (e) {
      var el = e.target.closest("[data-action]");
      if (!el || !root.contains(el)) return;
      var action = el.getAttribute("data-action");
      var pid = el.getAttribute("data-pid");
      var idx = parseInt(el.getAttribute("data-idx"), 10);
      var val = el.value;

      switch (action) {
        case "bulk-branch":      state.bulkBranchId = val; break;
        case "bulk-reqdate":     state.bulkRequiredDate = val; break;
        case "bulk-shipdate":    state.bulkShipDate = val; break;
        case "bulk-shipstatus":  state.bulkShipStatus = val; break;
        case "order-shipstatus": state.shipStatus = val; break;
        case "order-reqdate":    state.requiredDate = val; break;
        case "order-shipdate":   state.shipDate = val; break;
        case "row-branch":
          setRow(pid, idx, { branchId: val });
          break;
        case "row-qty": {
          // Coerce to an integer in [1, rowMax]; the input's min/max don't
          // stop pasted or typed out-of-range values.
          var item = state.lineItems.find(function (li) {
            return String(li.eclipseProductId) === String(pid);
          });
          var needed = (item && item.quantity) || 1;
          var rows = state.itemBranchAssignments[pid] || [];
          var otherSum = rows.reduce(function (n, r, i) {
            return i === idx ? n : n + (Number(r.quantity) || 0);
          }, 0);
          var rowMax = Math.max(1, needed - otherSum);
          var n = Number(val);
          var intN = isFinite(n) ? Math.round(n) : 0;
          var clamped = Math.min(rowMax, Math.max(1, intN));
          setRow(pid, idx, { quantity: clamped });
          break;
        }
        case "row-reqdate":
          setRow(pid, idx, { requiredDate: val });
          break;
        case "row-shipdate":
          setRow(pid, idx, { shipDate: val });
          break;
        case "row-shipstatus":
          setRow(pid, idx, { shipStatus: val });
          break;
        default:
          return;
      }
      render();
    });

    // Enter key in the deal-ID input triggers the load.
    root.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target && e.target.id === "fob-deal-input") {
        e.preventDefault();
        var val = e.target.value.trim();
        if (!val) return;
        state.dealId = val;
        fetchData();
      }
    });

    // ── Boot ───────────────────────────────────────────────────────────────
    if (state.dealId) {
      fetchData();
    } else {
      render();
    }
  }

  function boot() {
    var apps = document.querySelectorAll("[data-fob-app]");
    for (var i = 0; i < apps.length; i++) initApp(apps[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
