import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const STATUS_LABEL = {
  draft: 'Чернова', received: 'Приета', confirmed: 'Потвърдена', partially_fulfilled: 'Частично изпълнена',
  fulfilled: 'Изпълнена', cancelled: 'Отказана',
};
let companyId = null;
let operatorId = null;
let lines = [];

async function main() {
  const shell = await renderShell('customer-orders');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;
  operatorId = shell.session.user.id;

  const orderId = new URLSearchParams(location.search).get('id');
  if (orderId) await renderDetail(content, orderId);
  else await renderList(content);
}

async function renderList(content) {
  const [{ data: customers }, { data: warehouses }] = await Promise.all([
    supabase.from('customers').select('id, name').eq('company_id', companyId).order('name'),
    supabase.from('warehouses').select('id, name').eq('company_id', companyId).order('name'),
  ]);

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Поръчки от клиенти</h1><div class="sub">Приемане и проследяване на клиентски поръчки</div></div>
      <button class="btn accent" id="new-btn">+ Нова поръчка</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нова поръчка</div>
      <div style="padding:16px;">
        <div class="form-grid-2" style="padding:0; margin-bottom:14px;">
          <div class="field"><label>Клиент</label>
            <select id="customer-select"><option value="">—</option>${(customers || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Склад *</label>
            <select id="wh-select">${(warehouses || []).map(w => `<option value="${w.id}">${w.name}</option>`).join('')}</select>
          </div>
        </div>
        <div class="field"><label>Бележка</label><input id="note-input" /></div>

        <div class="field"><label>Търси продукт по SKU</label><input id="product-search" placeholder="TT-CORE-BLK-M…" /></div>
        <div id="search-results" style="max-height:160px; overflow-y:auto; margin:8px 0;"></div>

        <table class="data" style="margin-top:10px;">
          <thead><tr><th>Продукт</th><th>Количество</th><th>Цена</th><th></th></tr></thead>
          <tbody id="lines-mount"></tbody>
        </table>

        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:14px;">
          <button class="btn primary" id="submit-btn" disabled>Създай поръчка</button>
          <button class="btn" id="cancel-btn">Отказ</button>
        </div>
        <div id="form-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__header">Списък поръчки</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => { document.getElementById('new-panel').style.display = 'none'; lines = []; renderLines(); });
  document.getElementById('product-search').addEventListener('input', (e) => searchProducts(e.target.value));
  document.getElementById('submit-btn').addEventListener('click', submitOrder);

  await load();
}

async function searchProducts(term) {
  const mount = document.getElementById('search-results');
  if (!term) { mount.innerHTML = ''; return; }
  const { data, error } = await supabase
    .from('product_variants')
    .select('id, sku, color, size, sale_price, products!inner(id, name, company_id)')
    .eq('products.company_id', companyId)
    .ilike('sku', `%${term}%`)
    .limit(15);

  if (error) { mount.innerHTML = `<div style="font-size:12px; color:var(--bad);">${error.message}</div>`; return; }
  mount.innerHTML = (data || []).map(v => `
    <div class="nav-link" style="border:1px solid var(--gray-100); color:var(--ink); margin-bottom:4px; cursor:pointer;" data-id="${v.id}">
      ${v.products.name} — <span class="mono">${v.sku}</span> ${[v.color, v.size].filter(Boolean).join('/')}
    </div>
  `).join('') || `<div style="font-size:12px; color:var(--gray-700); padding:6px;">Няма съвпадения.</div>`;

  mount.querySelectorAll('[data-id]').forEach(row => {
    row.addEventListener('click', () => {
      const v = data.find(x => x.id === row.dataset.id);
      lines.push({ variant_id: v.id, name: v.products.name, meta: [v.color, v.size].filter(Boolean).join('/') || v.sku, quantity: 1, unit_price: Number(v.sale_price) });
      renderLines();
      document.getElementById('product-search').value = '';
      mount.innerHTML = '';
    });
  });
}

function renderLines() {
  const mount = document.getElementById('lines-mount');
  mount.innerHTML = lines.map((l, i) => `
    <tr>
      <td>${l.name}<br><span class="mono" style="font-size:11px; color:var(--gray-700);">${l.meta}</span></td>
      <td><input type="number" min="1" step="1" value="${l.quantity}" data-i="${i}" data-f="quantity" style="width:70px; border:1px solid var(--gray-300); border-radius:3px; padding:4px;" /></td>
      <td><input type="number" min="0" step="0.01" value="${l.unit_price}" data-i="${i}" data-f="unit_price" style="width:90px; border:1px solid var(--gray-300); border-radius:3px; padding:4px;" /></td>
      <td><button class="btn" data-remove="${i}" style="padding:4px 8px;">✕</button></td>
    </tr>
  `).join('');

  mount.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => { lines[Number(inp.dataset.i)][inp.dataset.f] = Number(inp.value); }));
  mount.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => { lines.splice(Number(btn.dataset.remove), 1); renderLines(); }));
  document.getElementById('submit-btn').disabled = lines.length === 0;
}

async function submitOrder() {
  const errBox = document.getElementById('form-error');
  errBox.textContent = '';

  const { error } = await supabase.rpc('create_customer_order', {
    p_company_id: companyId,
    p_customer_id: document.getElementById('customer-select').value || null,
    p_warehouse_id: document.getElementById('wh-select').value,
    p_operator_id: operatorId,
    p_document_no: 'ORD-' + Date.now(),
    p_note: document.getElementById('note-input').value || null,
    p_items: lines.map(l => ({ variant_id: l.variant_id, quantity: l.quantity, unit_price: l.unit_price, vat_rate: 20 })),
  });

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
  lines = []; renderLines();
  document.getElementById('new-panel').style.display = 'none';
  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const { data, error } = await supabase
    .from('v_customer_orders_list')
    .select('id, document_no, status, created_at, customer_name, warehouse_name, operator_name, total_ordered, total_fulfilled')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма поръчки.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Документ</th><th>Дата</th><th>Клиент</th><th>Склад</th><th>Изпълнено</th><th>Статус</th><th></th></tr></thead>
      <tbody>
        ${data.map(o => `
          <tr>
            <td class="mono">${o.document_no}</td>
            <td class="mono">${new Date(o.created_at).toLocaleDateString('bg-BG')}</td>
            <td>${o.customer_name || '—'}</td>
            <td>${o.warehouse_name}</td>
            <td class="mono">${o.total_fulfilled} / ${o.total_ordered}</td>
            <td>${STATUS_LABEL[o.status] || o.status}</td>
            <td><a class="btn sm" href="./customer-orders.html?id=${o.id}" style="text-decoration:none;">Отвори</a></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

async function renderDetail(content, orderId) {
  const { data: order, error } = await supabase
    .from('customer_orders')
    .select('id, document_no, status, warehouse_id, customers(name), warehouses(name)')
    .eq('id', orderId)
    .single();

  if (error) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Грешка</div><div style="padding:20px;">${error.message}</div></div>`;
    return;
  }

  const { data: items } = await supabase
    .from('customer_order_items')
    .select('variant_id, quantity_ordered, quantity_fulfilled, unit_price, product_variants(sku, products(name))')
    .eq('order_id', orderId);

  const fulfillable = (items || []).filter(i => i.quantity_fulfilled < i.quantity_ordered);

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Поръчка ${order.document_no}</h1><div class="sub">${order.customers?.name || 'Без клиент'} · ${order.warehouses.name} · ${STATUS_LABEL[order.status] || order.status}</div></div>
      <a class="btn" href="./customer-orders.html" style="text-decoration:none;">← Към списъка</a>
    </div>

    <div class="panel">
      <div class="panel__header">Артикули</div>
      <table class="data">
        <thead><tr><th>Продукт</th><th>SKU</th><th>Поръчано</th><th>Изпълнено</th><th>Остава</th><th>Цена</th></tr></thead>
        <tbody>
          ${(items || []).map(i => `
            <tr>
              <td>${i.product_variants.products.name}</td>
              <td class="mono">${i.product_variants.sku}</td>
              <td class="mono">${i.quantity_ordered}</td>
              <td class="mono">${i.quantity_fulfilled}</td>
              <td class="mono">${i.quantity_ordered - i.quantity_fulfilled}</td>
              <td class="mono">${eur.format(i.unit_price)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    ${fulfillable.length && order.status !== 'cancelled' ? `
    <div class="panel">
      <div class="panel__header">Изпълни поръчката (пълно или частично)</div>
      <div style="padding:16px;">
        ${fulfillable.map(i => `
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; font-size:13px;">
            <span style="flex:1;">${i.product_variants.products.name} (${i.product_variants.sku}) — остава ${i.quantity_ordered - i.quantity_fulfilled}</span>
            <input type="number" min="0" max="${i.quantity_ordered - i.quantity_fulfilled}" step="1" value="0"
              data-variant="${i.variant_id}" data-price="${i.unit_price}" style="width:80px; border:1px solid var(--gray-300); border-radius:3px; padding:4px;" />
          </div>
        `).join('')}
        <div class="field" style="max-width:200px;"><label>Начин на плащане</label>
          <select id="pay-method"><option value="cash">В брой</option><option value="card">Карта</option><option value="bank_transfer">Банков превод</option></select>
        </div>
        <button class="btn accent" id="fulfill-btn">Изпълни избраните количества</button>
        <div id="fulfill-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
      </div>
    </div>` : ''}
  `;

  if (fulfillable.length && order.status !== 'cancelled') {
    document.getElementById('fulfill-btn').addEventListener('click', async () => {
      const errBox = document.getElementById('fulfill-error');
      errBox.textContent = '';

      const toFulfill = Array.from(document.querySelectorAll('[data-variant]'))
        .map(inp => ({ variant_id: inp.dataset.variant, quantity: Number(inp.value), price: Number(inp.dataset.price) }))
        .filter(x => x.quantity > 0);

      if (!toFulfill.length) { errBox.textContent = 'Въведи количество за поне един артикул.'; return; }

      const total = toFulfill.reduce((s, x) => s + x.quantity * x.price * 1.20, 0); // vat_rate assumed 20 for the payment total preview

      const { error: fErr } = await supabase.rpc('fulfill_customer_order', {
        p_company_id: companyId, p_order_id: orderId, p_operator_id: operatorId,
        p_items: toFulfill.map(x => ({ variant_id: x.variant_id, quantity: x.quantity })),
        p_payments: [{ method: document.getElementById('pay-method').value, amount: Math.round(total * 100) / 100 }],
      });

      if (fErr) { errBox.textContent = 'Грешка: ' + fErr.message; return; }
      await renderDetail(content, orderId);
    });
  }
}

main();
