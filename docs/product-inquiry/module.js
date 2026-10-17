/* ============================================================
   Fairbank — Product Inquiry Module JS
   All IDs match the fbi-* prefixes used in module.html.
   Functions are namespaced with fbi* to avoid collisions
   if multiple modules exist on the same page.
   ============================================================ */

(function () {

  // ── Config ──────────────────────────────────────────────────
  var HS_BASE     = 'https://app.hubspot.com/contacts/43793456/record/0-2/';
  var WEBHOOK_URL = 'https://n8n.fairbankequipment.com/webhook/fairbank-product-inquiry';
  var isAdmin = true;


  // ── Shared utility ───────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtCurrency(val) {
    if (isNaN(val)) return '—';
    var parts = val.toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '$' + parts.join('.');
  }

  function makeAutocomplete(opts) {
    /*
      opts = {
        inputEl,        // visible text input
        clearBtnEl,     // × button on the text input
        wrapEl,         // .product-search-wrap div
        dropdownEl,     // .product-dropdown div
        selectedBoxEl,  // .selected-product overlay div
        selectedLabelEl,// element showing the "badge" (ID)
        selectedDescEl, // element showing the name/description
        clearOverlayEl, // × button inside the overlay
        onSelect,       // function(item) called when user picks one
        onClear,        // function() called when selection is cleared
        fetchFn,        // async function(query) → array of items
        renderItem,     // function(item) → { label: string, badge: string }
      }
    */
    var debounceTimer  = null;
    var activeIndex    = -1;
    var currentResults = [];

    function openDropdown()  { opts.dropdownEl.classList.add('open'); }
    function closeDropdown() { opts.dropdownEl.classList.remove('open'); activeIndex = -1; }

    function setDropdownContent(html) {
      opts.dropdownEl.innerHTML = html;
      openDropdown();
    }

    function showSelected(item) {
      var parts = opts.renderItem(item);
      opts.selectedLabelEl.textContent = parts.badge;
      opts.selectedDescEl.textContent  = parts.label;
      opts.selectedBoxEl.classList.add('visible');
      opts.wrapEl.classList.add('has-selection');
    }

    function clearSelected() {
      opts.selectedBoxEl.classList.remove('visible');
      opts.wrapEl.classList.remove('has-selection');
      opts.selectedLabelEl.textContent = '';
      opts.selectedDescEl.textContent  = '';
    }

    function selectItem(item) {
      showSelected(item);
      opts.inputEl.value = '';
      opts.clearBtnEl.classList.remove('visible');
      closeDropdown();
      if (opts.onSelect) opts.onSelect(item);
    }

    function clearSelection() {
      clearSelected();
      opts.inputEl.value = '';
      closeDropdown();
      opts.inputEl.focus();
      if (opts.onClear) opts.onClear();
    }

    function renderResults(items) {
      currentResults = items;
      if (!items.length) {
        setDropdownContent('<div class="dropdown-status">No results found.</div>');
        return;
      }
      var frag = document.createDocumentFragment();
      items.forEach(function (item, i) {
        var parts  = opts.renderItem(item);
        var el     = document.createElement('div');
        el.className     = 'product-item';
        el.dataset.index = i;

        var descEl = document.createElement('div');
        descEl.className   = 'product-item-desc';
        descEl.textContent = parts.label;

        var idEl = document.createElement('div');
        idEl.className   = 'product-item-id';
        idEl.textContent = parts.badge;

        el.appendChild(descEl);
        el.appendChild(idEl);
        el.addEventListener('mousedown', function (e) {
          e.preventDefault();
          selectItem(item);
        });
        frag.appendChild(el);
      });
      opts.dropdownEl.innerHTML = '';
      opts.dropdownEl.appendChild(frag);
      openDropdown();
    }

    async function runFetch(query) {
      setDropdownContent(
        '<div class="dropdown-status"><div class="dd-spinner"></div>Searching…</div>'
      );
      try {
        var items = await opts.fetchFn(query);
        renderResults(items);
      } catch (err) {
        setDropdownContent('<div class="dropdown-status">Error: ' + escHtml(err.message) + '</div>');
      }
    }

    // ── Event listeners ──
    opts.selectedBoxEl.addEventListener('click', clearSelection);
    opts.clearOverlayEl.addEventListener('click', function (e) {
      e.stopPropagation();
      clearSelection();
    });

    opts.clearBtnEl.addEventListener('click', function () {
      opts.inputEl.value = '';
      opts.clearBtnEl.classList.remove('visible');
      closeDropdown();
      opts.inputEl.focus();
    });

    opts.inputEl.addEventListener('input', function () {
      opts.clearBtnEl.classList.toggle('visible', opts.inputEl.value.length > 0);
      var q = opts.inputEl.value.trim();
      clearTimeout(debounceTimer);
      if (!q) { closeDropdown(); return; }
      debounceTimer = setTimeout(function () { runFetch(q); }, 400);
    });

    opts.inputEl.addEventListener('keydown', function (e) {
      var items = opts.dropdownEl.querySelectorAll('.product-item');
      if (!opts.dropdownEl.classList.contains('open') || !items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
      } else if (e.key === 'Enter' && activeIndex >= 0) {
        e.preventDefault();
        selectItem(currentResults[activeIndex]);
        return;
      } else if (e.key === 'Escape') {
        closeDropdown();
        return;
      }
      items.forEach(function (el, i) { el.classList.toggle('active', i === activeIndex); });
      if (activeIndex >= 0) items[activeIndex].scrollIntoView({ block: 'nearest' });
    });

    opts.inputEl.addEventListener('focus', function () {
      if (opts.inputEl.value.trim() && currentResults.length) openDropdown();
    });

    document.addEventListener('mousedown', function (e) {
      if (!opts.dropdownEl.contains(e.target) && e.target !== opts.inputEl) closeDropdown();
    });
  }

  // ── HubSpot link ────────────────────────────────────────────
  var elHsLinkWrap = document.getElementById('fbi-hs-link-wrap');
  var elHsLink     = document.getElementById('fbi-hs-link');

  function updateHsLink(customerId) {
    if (customerId) {
      elHsLink.href = HS_BASE + customerId;
      elHsLinkWrap.classList.add('visible');
    } else {
      elHsLink.href = '#';
      elHsLinkWrap.classList.remove('visible');
    }
  }

  // ── Customer autocomplete ────────────────────────────────────
  var elCustomerId      = document.getElementById('fbi-customer-id');
  var selectedPriceClass = '';

  makeAutocomplete({
    inputEl:        document.getElementById('fbi-customer-search'),
    clearBtnEl:     document.getElementById('fbi-customer-clear'),
    wrapEl:         document.getElementById('fbi-customer-wrap'),
    dropdownEl:     document.getElementById('fbi-customer-dropdown'),
    selectedBoxEl:  document.getElementById('fbi-selected-customer'),
    selectedLabelEl:document.getElementById('fbi-selected-customer-id'),
    selectedDescEl: document.getElementById('fbi-selected-customer-name'),
    clearOverlayEl: document.getElementById('fbi-selected-customer-clear'),

    renderItem: function (c) {
      return { badge: c.e_customer_id, label: c.name };
    },

    onSelect: function (c) {
      elCustomerId.value = c.e_customer_id;
      updateHsLink(c.hs_customer_id);
      selectedPriceClass = c.price_class || '';
    },

    onClear: function () {
      elCustomerId.value = '';
      updateHsLink('');
      selectedPriceClass = '';
    },

    fetchFn: async function (query) {
      if (query.length < 2) return [];
      var url = new URL(WEBHOOK_URL);
      url.searchParams.set('e_customer_name', query);
      var res = await fetch(url.toString(), { headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      return Array.isArray(data.e_customers) ? data.e_customers : [];
    },
  });

  // ── Product autocomplete ─────────────────────────────────────
  var elProductId = document.getElementById('fbi-product-id');

  makeAutocomplete({
    inputEl:        document.getElementById('fbi-product-search'),
    clearBtnEl:     document.getElementById('fbi-search-clear'),
    wrapEl:         document.getElementById('fbi-search-wrap'),
    dropdownEl:     document.getElementById('fbi-product-dropdown'),
    selectedBoxEl:  document.getElementById('fbi-selected-product'),
    selectedLabelEl:document.getElementById('fbi-selected-id'),
    selectedDescEl: document.getElementById('fbi-selected-desc'),
    clearOverlayEl: document.getElementById('fbi-selected-clear'),

    renderItem: function (p) {
      return { badge: p.e_product_id, label: p.description || '—' };
    },

    onSelect: function (p) {
      elProductId.value = p.e_product_id;
    },

    onClear: function () {
      elProductId.value = '';
    },

    fetchFn: async function (query) {
      if (query.length < 2) return [];
      var url = new URL(WEBHOOK_URL);
      var cid = elCustomerId.value.trim();
      if (cid) url.searchParams.set('e_customer_id', cid);
      url.searchParams.set('e_product_name', query);
      var res = await fetch(url.toString(), { headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      return Array.isArray(data.e_products) ? data.e_products : [];
    },
  });

  // ── Search / results ─────────────────────────────────────────
  var elSearchBtn  = document.getElementById('fbi-search-btn');
  var elSpinner    = document.getElementById('fbi-spinner');
  var elBtnLabel   = document.getElementById('fbi-btn-label');
  var elErrorBox   = document.getElementById('fbi-error-box');
  var elErrorMsg   = document.getElementById('fbi-error-msg');
  var elResults    = document.getElementById('fbi-results');
  var elStockRows  = document.getElementById('fbi-stock-rows');
  var elTotalStock = document.getElementById('fbi-total-stock');
  var elPriceStats      = document.getElementById('fbi-price-stats');
  var elUnitCost        = document.getElementById('fbi-unit-cost');
  var elListPrice       = document.getElementById('fbi-list-price');
  var elMargin          = document.getElementById('fbi-margin');
  var elResPriceClass   = document.getElementById('fbi-res-price-class');
  var elPriceBreakRows  = document.getElementById('fbi-price-break-rows');

  var adminVisible = false;
  if (isAdmin) {
    var elAdminToggleRow = document.getElementById('fbi-admin-toggle-row');
    var elAdminToggle    = document.getElementById('fbi-admin-toggle');
    elAdminToggleRow.classList.add('show');
    elAdminToggle.addEventListener('change', function () {
      adminVisible = this.checked;
      applyAdminVisible();
    });
  }

  function applyAdminVisible() {
    elPriceStats.classList.toggle('admin-visible', adminVisible);
  }

  function setLoading(on) {
    elSearchBtn.disabled    = on;
    elSpinner.style.display = on ? 'block' : 'none';
    elBtnLabel.textContent  = on ? 'Searching…' : 'Search';
  }

  function showError(msg) {
    elErrorMsg.textContent  = msg;
    elErrorBox.classList.add('show');
    elResults.style.display = 'none';
  }

  function hideError() {
    elErrorBox.classList.remove('show');
  }

  window.fbiDoSearch = async function () {
    var cid = elCustomerId.value.trim();
    var pid = elProductId.value.trim();

    hideError();

    if (!cid) { showError('Please select a customer before searching.'); return; }
    if (!pid) { showError('Please select a product before searching.');  return; }

    setLoading(true);
    try {
      var url = new URL(WEBHOOK_URL);
      url.searchParams.set('e_customer_id', cid);
      url.searchParams.set('e_product_id',  pid);

      var res = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        var text = await res.text();
        throw new Error('Server returned ' + res.status + ': ' + text);
      }

      renderResults(await res.json());
    } catch (err) {
      showError(err.message || 'Unexpected error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  function renderResults(data) {
    if (data.error_message || data.unit_price === 'error' || data.stock_info === 'error') {
      var friendlyMsg = 'An unknown error was returned by the server.';
      if (data.error_message) {
        try {
          var parsed     = JSON.parse(data.error_message);
          var firstError = parsed && parsed.errors && parsed.errors[0];
          if (firstError && firstError.message) {
            friendlyMsg = firstError.code
              ? '[' + firstError.code + '] ' + firstError.message
              : firstError.message;
          }
        } catch (_) { friendlyMsg = String(data.error_message); }
      }
      showError(friendlyMsg);
      return;
    }

    var price = parseFloat(data.unit_price);

    if (isAdmin) {
      var cost   = parseFloat(data.unit_cost);
      var list   = parseFloat(data.list_price);
      var margin = (!isNaN(price) && !isNaN(cost) && price > 0)
        ? ((price - cost) / price * 100)
        : NaN;
      elUnitCost.textContent  = fmtCurrency(cost);
      elListPrice.textContent = (isNaN(list) || list === 0) ? '—' : fmtCurrency(list);
      elMargin.textContent    = isNaN(margin)              ? '—' : margin.toFixed(1) + '%';
    }
    elResPriceClass.textContent = selectedPriceClass || '—';
    applyAdminVisible();

    elPriceBreakRows.innerHTML = '';
    var breaks = Array.isArray(data.quantity_breaks) ? data.quantity_breaks : [];
    if (!breaks.length) {
      var fallbackRow = document.createElement('div');
      fallbackRow.className = 'price-break-row';
      fallbackRow.innerHTML =
        '<span class="pb-qty">1+</span>' +
        '<span class="pb-price pb-price-base">' + fmtCurrency(price) + '</span>';
      elPriceBreakRows.appendChild(fallbackRow);
    } else {
      breaks.forEach(function (brk, i) {
        var row = document.createElement('div');
        row.className = 'price-break-row' + (i === 0 ? ' pb-row-base' : '');
        var qty = brk.startQuantity === 0 ? '1' : String(brk.startQuantity);
        row.innerHTML =
          '<span class="pb-qty">' + escHtml(qty) + '+</span>' +
          '<span class="pb-price' + (i === 0 ? ' pb-price-base' : '') + '">' +
            fmtCurrency(parseFloat(brk.unitPrice)) +
          '</span>';
        elPriceBreakRows.appendChild(row);
      });
    }

    elStockRows.innerHTML = '';
    var total = 0;
    var stock = Array.isArray(data.stock_info) ? data.stock_info : [];

    if (!stock.length) {
      elStockRows.innerHTML =
        '<div class="stock-row">' +
        '<span class="warehouse-name" style="color:var(--muted)">No stock information available</span>' +
        '<span class="qty-badge qty-zero">0</span></div>';
    } else {
      stock.forEach(function (item, i) {
        var qty      = parseInt(item.warehouseQty) || 0;
        total       += qty;
        var qtyClass = qty > 5 ? 'qty-good' : qty > 0 ? 'qty-low' : 'qty-zero';
        var row      = document.createElement('div');
        row.className            = 'stock-row';
        row.style.animationDelay = (0.12 + i * 0.04) + 's';
        row.innerHTML =
          '<span class="warehouse-name">' + escHtml(item.warehouse || '—') + '</span>' +
          '<span class="qty-badge ' + qtyClass + '">' + qty + '</span>';
        elStockRows.appendChild(row);
      });
    }

    elTotalStock.textContent = total;
    elResults.style.display  = 'block';

    elResults.querySelectorAll('.animate-in').forEach(function (el) {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    });
  }
  
  // ── URL param pre-fill ───────────────────────────────────────
  (function bootstrapFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var custId = params.get('e_customer_id');
    var prodId = params.get('e_product_id');
    if (!custId && !prodId) return;

    function prefill(inputId, dropdownId, value, onDone) {
      var input    = document.getElementById(inputId);
      var dropdown = document.getElementById(dropdownId);
      var observer = new MutationObserver(function () {
        var first = dropdown.querySelector('.product-item');
        if (first) {
          observer.disconnect();
          first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          if (onDone) setTimeout(onDone, 0);
        }
      });
      observer.observe(dropdown, { childList: true });
      input.value = '.' + value;
      input.dispatchEvent(new Event('input'));
    }

    setTimeout(function () {
      var needed = (custId ? 1 : 0) + (prodId ? 1 : 0);
      var done   = 0;
      function onOne() {
        if (++done === needed && custId && prodId) setTimeout(fbiDoSearch, 0);
      }
      if (custId) prefill('fbi-customer-search', 'fbi-customer-dropdown', custId, onOne);
      if (prodId) prefill('fbi-product-search',  'fbi-product-dropdown',  prodId, onOne);
    }, 3);
  })();

})();