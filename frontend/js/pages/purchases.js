import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
let companyId = null;
let operatorId = null;
let lines = []; // [{variant_id, name, meta, quantity, unit_cost}]

async function main() {
  const shell = await renderShell('purchases');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;
  operatorId = shell.session.user.id;

  const [{ data: suppliers }, { data: warehouses }] = await Promise.all([
    supabase.from('suppliers').select('id, name').eq('company_id', companyId).order('name'),
    supabase.from('warehouses').select('id, name').eq('company_id', companyId).order('name'),
  ]);

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Покупки</h1><div class="sub">Доставки от доставчици — приемане на стока в склад</div></div>
      <button class="btn accent" id="new-btn">+ Приемане на стока</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нова доставка</div>
      <div style="padding:16px;">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px;">
          <div class="field"><label>Доставчик</label>
            <select id="supplier-select"><option value="">—</option>
              ${(suppliers || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Склад *</label>
            <select id="warehouse-select">
              ${(warehouses || []).map(w => `<option value="${w.id}">${w.name}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="field"><label>Търси продукт по SKU или име</label>
          <input id="product-search" placeholder="TT-CORE-BLK-M…" />
        </div>
        <div id="search-results" style="max-height:160px; overflow-y:auto; margin:8px 0;"></div>

        <table class="data" style="margin-top:10px;">
          <thead><tr><th>Продукт</th><th>Количество</th><th>Ед. цена</th><th>Общо</th><th></th></tr></thead>
          <tbody id="lines-mount"></tbody>
        </table>

        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px;">
          <div class="mono" style="font-size:16px; font-weight:600;">Общо: <span id="lines-total">${eur.format(0)}</span></div>
          <div>
            <button class="btn primary" id="submit-btn" disabled>Запиши доставка</button>
            <button class="btn" id="cancel-btn" type="button">Отказ</button>
          </div>
        </div>
        <div id="form-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__header">Списък доставки</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => { document.getElementById('new-panel').style.display = 'none'; lines = []; renderLines(); });
  document.getElementById('product-search').addEventListener('input', (e) => searchProducts(e.target.value));
  document.getElementById('submit-btn').addEventListener('click', submitPurchase);

  await loadList();
}

async function searchProducts(term) {
  const mount = document.getElementById('search-results');
  if (!term) { mount.innerHTML = ''; return; }

  const { data, error } = await supabase
    .from('product_variants')
    .select('id, sku, color, size, sale_price, products!inner(id, name, company_id, purchase_price)')
    .eq('products.company_id', companyId)
    .or(`sku.ilike.%${term}%`)
    .limit(15);

  if (error) { mount.innerHTML = `<div style="font-size:12px; color:var(--bad);">${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="font-size:12px; color:var(--gray-700); padding:6px;">Няма съвпадения.</div>`; return; }

  mount.innerHTML = data.map(v => `
    <div class="nav-link" style="border:1px solid var(--gray-100); color:var(--ink); margin-bottom:4px; cursor:pointer;" data-id="${v.id}">
      ${v.products.name} — <span class="mono">${v.sku}</span> ${[v.color, v.size].filter(Boolean).join('/')}
    </div>
  `).join('');

  mount.querySelectorAll('[data-id]').forEach(row => {
    row.addEventListener('click', () => {
      const v = data.find(x => x.id === row.dataset.id);
      addLine(v);
      document.getElementById('product-search').value = '';
      mount.innerHTML = '';
    });
  });
}

function addLine(v) {
  const existing = lines.find(l => l.variant_id === v.id);
  if (existing) { existing.quantity += 1; }
  else {
    lines.push({
      variant_id: v.id,
      name: v.products.name,
      meta: [v.color, v.size].filter(Boolean).join('/') || v.sku,
      quantity: 1,
      unit_cost: Number(v.products.purchase_price || 0),
    });
  }
  renderLines();
}

function renderLines() {
  const mount = document.getElementById('lines-mount');
  const submitBtn = document.getElementById('submit-btn');
  mount.innerHTML = lines.map((l, i) => `
    <tr>
      <td>${l.name}<br><span class="mono" style="font-size:11px; color:var(--gray-700);">${l.meta}</span></td>
      <td><input type="number" min="1" step="1" value="${l.quantity}" data-i="${i}" data-f="quantity" style="width:70px; border:1px solid var(--gray-300); border-radius:3px; padding:4px;" /></td>
      <td><input type="number" min="0" step="0.01" value="${l.unit_cost}" data-i="${i}" data-f="unit_cost" style="width:90px; border:1px solid var(--gray-300); border-radius:3px; padding:4px;" /></td>
      <td class="mono">${eur.format(l.quantity * l.unit_cost)}</td>
      <td><button class="btn" data-remove="${i}" style="padding:4px 8px;">✕</button></td>
    </tr>
  `).join('');

  mount.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', () => {
      lines[Number(inp.dataset.i)][inp.dataset.f] = Number(inp.value);
      renderLines();
    });
  });
  mount.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => { lines.splice(Number(btn.dataset.remove), 1); renderLines(); });
  });

  const total = lines.reduce((s, l) => s + l.quantity * l.unit_cost, 0);
  document.getElementById('lines-total').textContent = eur.format(total);
  submitBtn.disabled = lines.length === 0;
}

async function submitPurchase() {
  const errBox = document.getElementById('form-error');
  errBox.textContent = '';
  const warehouseId = document.getElementById('warehouse-select').value;
  const supplierId = document.getElementById('supplier-select').value || null;

  if (!warehouseId) { errBox.textContent = 'Избери склад.'; return; }

  const { error } = await supabase.rpc('receive_purchase', {
    p_company_id: companyId,
    p_warehouse_id: warehouseId,
    p_supplier_id: supplierId,
    p_operator_id: operatorId,
    p_document_no: 'PO-' + Date.now(),
    p_items: lines.map(l => ({ variant_id: l.variant_id, quantity: l.quantity, unit_cost: l.unit_cost })),
  });

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }

  lines = [];
  renderLines();
  document.getElementById('new-panel').style.display = 'none';
  await loadList();
}

async function loadList() {
  const mount = document.getElementById('table-mount');
  const { data, error } = await supabase
    .from('v_purchases_list')
    .select('document_no, status, total, currency, created_at, supplier_name, warehouse_name, operator_name, item_count')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Все още няма приети доставки.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Документ</th><th>Дата</th><th>Доставчик</th><th>Склад</th><th>Оператор</th><th>Артикули</th><th>Общо</th></tr></thead>
      <tbody>
        ${data.map(p => `
          <tr>
            <td class="mono">${p.document_no}</td>
            <td class="mono">${new Date(p.created_at).toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>${p.supplier_name || '—'}</td>
            <td>${p.warehouse_name}</td>
            <td>${p.operator_name || '—'}</td>
            <td class="mono">${p.item_count}</td>
            <td class="mono">${eur.format(p.total)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
