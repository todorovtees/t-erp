import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
let companyId = null;
let operatorId = null;
let activeTab = 'customer';
let lines = [];

async function main() {
  const shell = await renderShell('returns');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;
  operatorId = shell.session.user.id;

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Връщания</h1><div class="sub">Връщания от клиенти и към доставчици</div></div>
      <button class="btn accent" id="new-btn">+ Ново връщане</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">
        <div class="action-row">
          <button class="btn sm" id="tab-customer" data-active="true">От клиент</button>
          <button class="btn sm" id="tab-supplier">Към доставчик</button>
        </div>
      </div>
      <div id="form-mount" style="padding:16px;"></div>
    </div>

    <div class="panel">
      <div class="panel__header">
        <div class="action-row">
          <button class="btn sm" id="list-tab-customer" data-active="true">От клиенти</button>
          <button class="btn sm" id="list-tab-supplier">Към доставчици</button>
        </div>
      </div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => { document.getElementById('new-panel').style.display = 'block'; renderForm(); });
  document.getElementById('tab-customer').addEventListener('click', () => switchTab('customer'));
  document.getElementById('tab-supplier').addEventListener('click', () => switchTab('supplier'));
  document.getElementById('list-tab-customer').addEventListener('click', () => { activeTab = 'customer'; loadList(); });
  document.getElementById('list-tab-supplier').addEventListener('click', () => { activeTab = 'supplier'; loadList(); });

  await loadList();
}

function switchTab(tab) {
  activeTab = tab;
  lines = [];
  document.getElementById('tab-customer').dataset.active = tab === 'customer' ? 'true' : 'false';
  document.getElementById('tab-supplier').dataset.active = tab === 'supplier' ? 'true' : 'false';
  renderForm();
}

async function renderForm() {
  const mount = document.getElementById('form-mount');
  const isCustomer = activeTab === 'customer';

  const [{ data: warehouses }, { data: parties }] = await Promise.all([
    supabase.from('warehouses').select('id, name').eq('company_id', companyId).order('name'),
    isCustomer
      ? supabase.from('customers').select('id, name').eq('company_id', companyId).order('name')
      : supabase.from('suppliers').select('id, name').eq('company_id', companyId).order('name'),
  ]);

  mount.innerHTML = `
    <div class="form-grid-2" style="padding:0; margin-bottom:14px;">
      <div class="field"><label>${isCustomer ? 'Клиент' : 'Доставчик'}</label>
        <select id="party-select"><option value="">—</option>${(parties || []).map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Склад *</label>
        <select id="wh-select">${(warehouses || []).map(w => `<option value="${w.id}">${w.name}</option>`).join('')}</select>
      </div>
    </div>
    <div class="field"><label>Причина</label><input id="reason-input" placeholder="грешен размер / дефект / друго" /></div>

    <div class="field"><label>Търси продукт по SKU</label><input id="product-search" placeholder="TT-CORE-BLK-M…" /></div>
    <div id="search-results" style="max-height:160px; overflow-y:auto; margin:8px 0;"></div>

    <table class="data" style="margin-top:10px;">
      <thead><tr><th>Продукт</th><th>Количество</th><th>${isCustomer ? 'Цена' : 'Себестойност'}</th>${isCustomer ? '<th>Състояние</th>' : ''}<th></th></tr></thead>
      <tbody id="lines-mount"></tbody>
    </table>

    <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:14px;">
      <button class="btn primary" id="submit-btn" disabled>Запиши връщане</button>
      <button class="btn" id="cancel-btn">Отказ</button>
    </div>
    <div id="form-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
  `;

  document.getElementById('cancel-btn').addEventListener('click', () => { document.getElementById('new-panel').style.display = 'none'; lines = []; });
  document.getElementById('product-search').addEventListener('input', (e) => searchProducts(e.target.value, isCustomer));
  document.getElementById('submit-btn').addEventListener('click', submitReturn);
  renderLines(isCustomer);
}

async function searchProducts(term, isCustomer) {
  const mount = document.getElementById('search-results');
  if (!term) { mount.innerHTML = ''; return; }

  const { data, error } = await supabase
    .from('product_variants')
    .select(`id, sku, color, size, sale_price, products!inner(id, name, company_id, purchase_price)`)
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
      lines.push({
        variant_id: v.id, name: v.products.name, meta: [v.color, v.size].filter(Boolean).join('/') || v.sku,
        quantity: 1, price: isCustomer ? Number(v.sale_price) : Number(v.products.purchase_price || 0), condition: 'resellable',
      });
      renderLines(isCustomer);
      document.getElementById('product-search').value = '';
      mount.innerHTML = '';
    });
  });
}

function renderLines(isCustomer) {
  const mount = document.getElementById('lines-mount');
  mount.innerHTML = lines.map((l, i) => `
    <tr>
      <td>${l.name}<br><span class="mono" style="font-size:11px; color:var(--gray-700);">${l.meta}</span></td>
      <td><input type="number" min="1" step="1" value="${l.quantity}" data-i="${i}" data-f="quantity" style="width:70px; border:1px solid var(--gray-300); border-radius:3px; padding:4px;" /></td>
      <td><input type="number" min="0" step="0.01" value="${l.price}" data-i="${i}" data-f="price" style="width:90px; border:1px solid var(--gray-300); border-radius:3px; padding:4px;" /></td>
      ${isCustomer ? `<td><select data-i="${i}" data-f="condition" style="font-size:12px;"><option value="resellable">За препродажба</option><option value="damaged">Повредена</option></select></td>` : ''}
      <td><button class="btn" data-remove="${i}" style="padding:4px 8px;">✕</button></td>
    </tr>
  `).join('');

  mount.querySelectorAll('input, select').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = Number(inp.dataset.i);
      lines[i][inp.dataset.f] = inp.dataset.f === 'quantity' || inp.dataset.f === 'price' ? Number(inp.value) : inp.value;
    });
  });
  mount.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => { lines.splice(Number(btn.dataset.remove), 1); renderLines(isCustomer); }));
  document.getElementById('submit-btn').disabled = lines.length === 0;
}

async function submitReturn() {
  const errBox = document.getElementById('form-error');
  errBox.textContent = '';
  const isCustomer = activeTab === 'customer';
  const partyId = document.getElementById('party-select').value || null;
  const warehouseId = document.getElementById('wh-select').value;
  const reason = document.getElementById('reason-input').value || null;

  const rpcName = isCustomer ? 'create_customer_return' : 'create_supplier_return';
  const params = isCustomer
    ? {
        p_company_id: companyId, p_warehouse_id: warehouseId, p_customer_id: partyId, p_sale_id: null,
        p_operator_id: operatorId, p_document_no: 'CR-' + Date.now(), p_reason: reason,
        p_items: lines.map(l => ({ variant_id: l.variant_id, quantity: l.quantity, unit_price: l.price, condition: l.condition })),
      }
    : {
        p_company_id: companyId, p_warehouse_id: warehouseId, p_supplier_id: partyId, p_purchase_id: null,
        p_operator_id: operatorId, p_document_no: 'SR-' + Date.now(), p_reason: reason,
        p_items: lines.map(l => ({ variant_id: l.variant_id, quantity: l.quantity, unit_cost: l.price })),
      };

  const { error } = await supabase.rpc(rpcName, params);
  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }

  lines = [];
  document.getElementById('new-panel').style.display = 'none';
  activeTab = isCustomer ? 'customer' : 'supplier';
  await loadList();
}

async function loadList() {
  document.getElementById('list-tab-customer').dataset.active = activeTab === 'customer' ? 'true' : 'false';
  document.getElementById('list-tab-supplier').dataset.active = activeTab === 'supplier' ? 'true' : 'false';

  const mount = document.getElementById('table-mount');
  const isCustomer = activeTab === 'customer';
  const { data, error } = await supabase
    .from(isCustomer ? 'v_customer_returns_list' : 'v_supplier_returns_list')
    .select(isCustomer
      ? 'document_no, reason, created_at, customer_name, warehouse_name, operator_name, total_value'
      : 'document_no, reason, created_at, supplier_name, warehouse_name, operator_name, total_value')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма връщания.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Документ</th><th>Дата</th><th>${isCustomer ? 'Клиент' : 'Доставчик'}</th><th>Склад</th><th>Причина</th><th>Стойност</th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td class="mono">${r.document_no}</td>
            <td class="mono">${new Date(r.created_at).toLocaleDateString('bg-BG')}</td>
            <td>${(isCustomer ? r.customer_name : r.supplier_name) || '—'}</td>
            <td>${r.warehouse_name}</td>
            <td>${r.reason || '—'}</td>
            <td class="mono">${eur.format(r.total_value)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
