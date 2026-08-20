import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';
import { getFiscalAdapter } from '../lib/fiscal-adapter.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });

let companyId = null;
let operatorId = null;
let warehouseId = null;
let customerId = null;
let cart = []; // [{variant_id, name, meta, quantity, unit_price, vat_rate, available, trackSerials, serials}]

async function main() {
  const shell = await renderShell('pos');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;
  operatorId = shell.session.user.id;

  const [{ data: whs }, { data: customers }] = await Promise.all([
    supabase.from('warehouses').select('id, name').eq('company_id', companyId).order('name'),
    supabase.from('customers').select('id, name').eq('company_id', companyId).order('name'),
  ]);

  if (!whs || !whs.length) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Няма складове</div>
      <div style="padding:20px;">Създай поне един склад от страница "Складове", преди да продаваш.</div></div>`;
    return;
  }
  warehouseId = whs[0].id;

  content.innerHTML = `
    <div class="page-header">
      <div><h1>POS</h1><div class="sub">Продажба на място</div></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <span id="offline-badge" style="display:none; background:var(--accent); color:var(--ink); font-size:11px; padding:4px 8px; border-radius:4px; align-self:center;"></span>
        <select id="customer-select" style="border:1px solid var(--gray-300); border-radius:4px; padding:8px 10px; font-size:13px;">
          <option value="">Без клиент (стандартни цени)</option>
          ${(customers || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
        <select id="wh-select" style="border:1px solid var(--gray-300); border-radius:4px; padding:8px 10px; font-size:13px;">
          ${whs.map(w => `<option value="${w.id}">${w.name}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="pos-layout">
      <div>
        <div class="pos-search">
          <input id="pos-search" placeholder="Сканирай баркод или търси по SKU / име… (F2)" autofocus />
        </div>
        <div class="pos-results" id="pos-results"></div>
      </div>

      <div class="pos-cart">
        <div class="panel__header">Кошница</div>
        <div class="cart-items" id="cart-items">
          <div style="padding:30px 16px; text-align:center; color:var(--gray-700); font-size:13px;">Кошницата е празна</div>
        </div>
        <div class="cart-footer">
          <div class="cart-total"><span>Общо</span><span id="cart-total" class="mono">${eur.format(0)}</span></div>
          <select id="pay-method" style="width:100%; margin-bottom:8px; border:1px solid var(--gray-300); border-radius:4px; padding:8px;">
            <option value="cash">В брой</option>
            <option value="card">Карта</option>
            <option value="bank_transfer">Банков превод</option>
          </select>
          <button class="btn accent" id="checkout-btn" style="width:100%;" disabled>Завърши продажба (F10)</button>
          <div id="checkout-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('wh-select').addEventListener('change', (e) => { warehouseId = e.target.value; runSearch(''); });
  document.getElementById('customer-select').addEventListener('change', async (e) => {
    customerId = e.target.value || null;
    await repriceCart();
  });
  document.getElementById('pos-search').addEventListener('input', (e) => runSearch(e.target.value));
  document.getElementById('checkout-btn').addEventListener('click', checkout);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F2') { e.preventDefault(); document.getElementById('pos-search').focus(); }
    if (e.key === 'F10') { e.preventDefault(); if (cart.length) checkout(); }
  });

  updateOfflineBadge();
  if (navigator.onLine) syncOfflineQueue();

  await runSearch('');
}

async function runSearch(term) {
  const mount = document.getElementById('pos-results');
  let query = supabase
    .from('v_inventory_detail')
    .select('variant_id, product_name, sku, color, size, barcode, sale_price, vat_rate, available, track_serials')
    .eq('company_id', companyId)
    .eq('warehouse_id', warehouseId)
    .gt('available', 0)
    .order('product_name')
    .limit(60);

  if (term) query = query.or(`sku.ilike.%${term}%,product_name.ilike.%${term}%,barcode.eq.${term}`);

  const { data, error } = await query;
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма намерени продукти с наличност.</div>`; return; }

  mount.innerHTML = data.map(v => `
    <div class="pos-tile" data-id="${v.variant_id}">
      <div class="name">${v.product_name}</div>
      <div class="meta">${[v.color, v.size].filter(Boolean).join(' / ') || v.sku} · на склад: ${v.available}${v.track_serials ? ' · 🔖 сериен №' : ''}</div>
      <div class="price">${eur.format(v.sale_price)}</div>
    </div>
  `).join('');

  mount.querySelectorAll('.pos-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const v = data.find(x => x.variant_id === tile.dataset.id);
      addToCart(v);
    });
  });
}

async function addToCart(v) {
  if (v.track_serials) {
    const serial = prompt(`Сериен номер за ${v.product_name} (${v.sku}):`);
    if (!serial || !serial.trim()) return;

    const existing = cart.find(c => c.variant_id === v.variant_id);
    const price = customerId ? await fetchResolvedPrice(v.variant_id, (existing?.quantity || 0) + 1) : Number(v.sale_price);

    if (existing) {
      existing.quantity += 1;
      existing.serials.push(serial.trim());
      existing.unit_price = price;
    } else {
      cart.push({
        variant_id: v.variant_id, name: v.product_name,
        meta: [v.color, v.size].filter(Boolean).join(' / ') || v.sku,
        quantity: 1, unit_price: price, vat_rate: Number(v.vat_rate), available: v.available,
        trackSerials: true, serials: [serial.trim()],
      });
    }
    renderCart();
    return;
  }

  const existing = cart.find(c => c.variant_id === v.variant_id);
  if (existing) {
    if (existing.quantity < v.available) {
      existing.quantity += 1;
      if (customerId) existing.unit_price = await fetchResolvedPrice(v.variant_id, existing.quantity);
    }
  } else {
    const price = customerId ? await fetchResolvedPrice(v.variant_id, 1) : Number(v.sale_price);
    cart.push({
      variant_id: v.variant_id, name: v.product_name,
      meta: [v.color, v.size].filter(Boolean).join(' / ') || v.sku,
      quantity: 1, unit_price: price, vat_rate: Number(v.vat_rate), available: v.available,
      trackSerials: false, serials: [],
    });
  }
  renderCart();
}

async function fetchResolvedPrice(variantId, quantity) {
  const { data, error } = await supabase.rpc('resolve_price', {
    p_variant_id: variantId, p_customer_id: customerId, p_quantity: quantity,
  });
  return error ? null : Number(data);
}

async function repriceCart() {
  for (const line of cart) {
    if (customerId) {
      const price = await fetchResolvedPrice(line.variant_id, line.quantity);
      if (price !== null) line.unit_price = price;
    }
  }
  renderCart();
}

function renderCart() {
  const mount = document.getElementById('cart-items');
  const checkoutBtn = document.getElementById('checkout-btn');

  if (!cart.length) {
    mount.innerHTML = `<div style="padding:30px 16px; text-align:center; color:var(--gray-700); font-size:13px;">Кошницата е празна</div>`;
    document.getElementById('cart-total').textContent = eur.format(0);
    checkoutBtn.disabled = true;
    return;
  }

  mount.innerHTML = cart.map((c, i) => `
    <div class="cart-line">
      <div style="flex:1;">
        <div>${c.name}</div>
        <div class="mono" style="color:var(--gray-700); font-size:11px;">${c.meta} · ${eur.format(c.unit_price)}</div>
        ${c.trackSerials ? `<div class="mono" style="color:var(--gray-700); font-size:10px;">SN: ${c.serials.join(', ')}</div>` : ''}
      </div>
      ${c.trackSerials
        ? '' /* quantity for serialized items is driven by how many serials were scanned, not +/- */
        : `<button class="qty-btn" data-i="${i}" data-d="-1">−</button><span class="mono">${c.quantity}</span><button class="qty-btn" data-i="${i}" data-d="1">+</button>`}
      <button class="qty-btn" data-i="${i}" data-remove="1">✕</button>
    </div>
  `).join('');

  mount.querySelectorAll('[data-d]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.i);
      const d = Number(btn.dataset.d);
      const line = cart[i];
      const next = line.quantity + d;
      if (next <= 0) { cart.splice(i, 1); }
      else if (next <= line.available) {
        line.quantity = next;
        if (customerId) line.unit_price = await fetchResolvedPrice(line.variant_id, next);
      }
      renderCart();
    });
  });
  mount.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => { cart.splice(Number(btn.dataset.i), 1); renderCart(); });
  });

  const total = cart.reduce((sum, c) => {
    const line = c.quantity * c.unit_price;
    return sum + line + (line * c.vat_rate / 100);
  }, 0);
  document.getElementById('cart-total').textContent = eur.format(total);
  checkoutBtn.disabled = false;
}

// ---- Offline queue (spec §44-45) --------------------------------------
// A queued sale is retried with the SAME document_no every attempt. Since
// complete_sale() enforces a unique (company_id, document_no) constraint
// and is fully atomic, a retry after a partial network failure can never
// create a duplicate sale — it either hasn't landed yet (retry proceeds) or
// it already fully landed (retry gets a harmless unique-constraint error,
// treated as success and removed from the queue).

const QUEUE_KEY = 'terp_offline_sales_queue';

function getOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function queueOfflineSale(saleParams) {
  const queue = getOfflineQueue();
  queue.push({ id: crypto.randomUUID(), queuedAt: new Date().toISOString(), saleParams });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

function updateOfflineBadge() {
  const badge = document.getElementById('offline-badge');
  if (!badge) return;
  const count = getOfflineQueue().length;
  badge.style.display = count ? 'inline-block' : 'none';
  badge.textContent = `${count} чакаща продажба извън мрежата`;
}

async function syncOfflineQueue() {
  const queue = getOfflineQueue();
  if (!queue.length) return;

  const remaining = [];
  for (const entry of queue) {
    try {
      const { error } = await supabase.rpc('complete_sale', entry.saleParams);
      if (error && !/duplicate key|unique constraint/i.test(error.message)) {
        remaining.push(entry); // real business error (e.g. now out of stock) - keep for manual review
      }
    } catch {
      remaining.push(entry); // still offline, try again next time
    }
  }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  updateOfflineBadge();
}

window.addEventListener('online', syncOfflineQueue);

async function checkout() {
  const errBox = document.getElementById('checkout-error');
  const btn = document.getElementById('checkout-btn');
  errBox.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Обработка…';

  const total = cart.reduce((sum, c) => {
    const line = c.quantity * c.unit_price;
    return sum + line + (line * c.vat_rate / 100);
  }, 0);

  const items = cart.map(c => ({
    variant_id: c.variant_id, quantity: c.quantity, unit_price: c.unit_price, discount: 0, vat_rate: c.vat_rate,
    ...(c.trackSerials ? { serials: c.serials } : {}),
  }));
  const payments = [{ method: document.getElementById('pay-method').value, amount: Math.round(total * 100) / 100 }];
  const documentNo = 'POS-' + Date.now();

  const saleParams = {
    p_company_id: companyId, p_warehouse_id: warehouseId, p_customer_id: customerId,
    p_operator_id: operatorId, p_channel: 'pos', p_document_no: documentNo, p_items: items, p_payments: payments,
  };

  let error;
  try {
    ({ error } = await supabase.rpc('complete_sale', saleParams));
  } catch (networkErr) {
    // A thrown exception (not a returned {error}) means the request never
    // reached the server at all — genuine offline, not a business-logic
    // rejection. Queue it instead of losing the sale (spec §44-45).
    queueOfflineSale(saleParams);
    cart = [];
    renderCart();
    btn.disabled = false;
    btn.textContent = 'Завърши продажба (F10)';
    errBox.style.color = 'var(--accent-ink)';
    errBox.textContent = `Няма връзка — продажба ${documentNo} е запазена локално и ще се синхронизира автоматично.`;
    updateOfflineBadge();
    return;
  }

  if (error) {
    errBox.textContent = 'Грешка: ' + error.message;
    btn.disabled = false;
    btn.textContent = 'Завърши продажба (F10)';
    return;
  }

  // Fiscal receipt — see js/lib/fiscal-adapter.js for why this is a mock
  // driver (no real device to test against) rather than a live integration.
  const fiscal = getFiscalAdapter();
  const receipt = await fiscal.issueReceipt({ documentNo, items, total, paymentMethod: payments[0].method });
  await supabase.rpc('record_fiscal_receipt', {
    p_company_id: companyId, p_sale_id: null, p_device_serial: 'MOCK-DEV-001',
    p_fiscal_number: receipt.fiscalNumber || null, p_status: receipt.status,
    p_raw_response: receipt.raw || { error: receipt.error }, p_operator_id: operatorId,
  });

  cart = [];
  renderCart();
  btn.textContent = 'Завърши продажба (F10)';
  await runSearch(document.getElementById('pos-search').value);
  errBox.style.color = 'var(--good)';
  errBox.textContent = `Продажба ${documentNo} завършена успешно.`;
  setTimeout(() => { errBox.textContent = ''; errBox.style.color = 'var(--bad)'; }, 4000);
}

main();
