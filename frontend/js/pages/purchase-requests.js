import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

let companyId = null;
let operatorId = null;
let suggestions = [];

async function main() {
  const shell = await renderShell('purchase-requests');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;
  operatorId = shell.session.user.id;

  const [{ data: warehouses }, { data: suppliers }] = await Promise.all([
    supabase.from('warehouses').select('id, name').eq('company_id', companyId).order('name'),
    supabase.from('suppliers').select('id, name').eq('company_id', companyId).order('name'),
  ]);

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Заявки за доставка</h1><div class="sub">Предложения за поръчка при ниска наличност</div></div>
    </div>

    <div class="panel">
      <div class="panel__header" style="gap:10px;">
        <span>Предложения по склад</span>
        <select id="wh-select">${(warehouses || []).map(w => `<option value="${w.id}">${w.name}</option>`).join('')}</select>
        <button class="btn" id="refresh-btn">Провери</button>
      </div>
      <div id="suggestions-mount"></div>
      <div style="padding:0 16px 16px;" id="create-section" style="display:none;"></div>
    </div>

    <div class="panel">
      <div class="panel__header">Списък заявки</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('wh-select').addEventListener('change', loadSuggestions);
  document.getElementById('refresh-btn').addEventListener('click', loadSuggestions);

  await loadSuggestions();
  await loadList();
}

async function loadSuggestions() {
  const mount = document.getElementById('suggestions-mount');
  const warehouseId = document.getElementById('wh-select').value;
  if (!warehouseId) { mount.innerHTML = ''; return; }

  const { data, error } = await supabase.rpc('suggest_purchase_request_items', {
    p_company_id: companyId, p_warehouse_id: warehouseId,
  });

  suggestions = data || [];
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!suggestions.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Всички продукти са над минимума в този склад.</div>`; return; }

  const { data: suppliers } = await supabase.from('suppliers').select('id, name').eq('company_id', companyId).order('name');

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th></th><th>Продукт</th><th>SKU</th><th>На склад</th><th>Минимум</th><th>Препоръчано</th></tr></thead>
      <tbody>
        ${suggestions.map((s, i) => `
          <tr>
            <td><input type="checkbox" class="sugg-check" data-i="${i}" checked style="width:auto;" /></td>
            <td>${s.product_name}</td>
            <td class="mono">${s.sku}</td>
            <td class="mono">${s.on_hand}</td>
            <td class="mono">${s.min_stock}</td>
            <td class="mono"><input type="number" data-i="${i}" class="sugg-qty" value="${s.suggested_quantity}" min="1" step="1" style="width:70px; border:1px solid var(--gray-300); border-radius:3px; padding:4px;" /></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div style="padding:16px; display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap;">
      <div class="field" style="margin:0;"><label>Доставчик</label>
        <select id="supplier-select"><option value="">—</option>${(suppliers || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
      </div>
      <button class="btn primary" id="create-request-btn">Създай заявка от избраните</button>
    </div>
    <div id="create-error" style="padding:0 16px 16px; color:var(--bad); font-size:12.5px;"></div>
  `;

  document.getElementById('create-request-btn').addEventListener('click', createRequest);
}

async function createRequest() {
  const errBox = document.getElementById('create-error');
  errBox.textContent = '';
  const warehouseId = document.getElementById('wh-select').value;
  const supplierId = document.getElementById('supplier-select').value || null;

  const items = Array.from(document.querySelectorAll('.sugg-check:checked')).map(cb => {
    const i = Number(cb.dataset.i);
    const qtyInput = document.querySelector(`.sugg-qty[data-i="${i}"]`);
    return { variant_id: suggestions[i].variant_id, suggested_quantity: suggestions[i].suggested_quantity, requested_quantity: Number(qtyInput.value) };
  });

  if (!items.length) { errBox.textContent = 'Избери поне един продукт.'; return; }

  const { data: req, error: reqErr } = await supabase.from('purchase_requests').insert({
    company_id: companyId, document_no: 'PR-' + Date.now(), warehouse_id: warehouseId,
    supplier_id: supplierId, operator_id: operatorId, status: 'draft',
  }).select('id').single();

  if (reqErr) { errBox.textContent = 'Грешка: ' + reqErr.message; return; }

  const { error: itemsErr } = await supabase.from('purchase_request_items').insert(
    items.map(i => ({ request_id: req.id, variant_id: i.variant_id, suggested_quantity: i.suggested_quantity, requested_quantity: i.requested_quantity }))
  );

  if (itemsErr) { errBox.textContent = 'Заявката е създадена, но артикулите не: ' + itemsErr.message; return; }

  await loadList();
  await loadSuggestions();
}

async function loadList() {
  const mount = document.getElementById('table-mount');
  const { data, error } = await supabase
    .from('v_purchase_requests_list')
    .select('document_no, status, note, created_at, warehouse_name, supplier_name, operator_name, item_count')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма заявки.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Документ</th><th>Дата</th><th>Склад</th><th>Доставчик</th><th>Артикули</th><th>Статус</th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td class="mono">${r.document_no}</td>
            <td class="mono">${new Date(r.created_at).toLocaleDateString('bg-BG')}</td>
            <td>${r.warehouse_name}</td>
            <td>${r.supplier_name || '—'}</td>
            <td class="mono">${r.item_count}</td>
            <td>${r.status}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
