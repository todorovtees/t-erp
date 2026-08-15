import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

let companyId = null;
let warehouses = [];

const STATUS_LABEL = { normal: 'Нормална', low: 'Ниска', critical: 'Критична', out: 'Изчерпана' };

async function main() {
  const shell = await renderShell('inventory');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;

  const { data: whs } = await supabase.from('warehouses').select('id, name').eq('company_id', companyId).order('name');
  warehouses = whs || [];

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Наличности</h1><div class="sub">На ниво продукт-вариант, по склад</div></div>
    </div>

    <div class="panel">
      <div class="panel__header" style="gap:10px;">
        <input id="search-box" placeholder="SKU, баркод или продукт…"
               style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px; width:220px;" />
        <select id="wh-filter" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;">
          <option value="">Всички складове</option>
          ${warehouses.map(w => `<option value="${w.id}">${w.name}</option>`).join('')}
        </select>
        <select id="status-filter" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;">
          <option value="">Всички статуси</option>
          <option value="low">Само ниска</option>
          <option value="critical">Само критична</option>
          <option value="out">Само изчерпани</option>
        </select>
        <div class="topbar__spacer"></div>
      </div>
      <div id="inv-table-mount"></div>
    </div>
  `;

  document.getElementById('search-box').addEventListener('input', () => loadInventory());
  document.getElementById('wh-filter').addEventListener('change', () => loadInventory());
  document.getElementById('status-filter').addEventListener('change', () => loadInventory());

  await loadInventory();
}

async function loadInventory() {
  const mount = document.getElementById('inv-table-mount');
  const search = document.getElementById('search-box').value.trim();
  const wh = document.getElementById('wh-filter').value;
  const status = document.getElementById('status-filter').value;

  let query = supabase
    .from('v_inventory_detail')
    .select('product_name, sku, barcode, warehouse_name, warehouse_id, on_hand, reserved, available, min_stock, max_stock, stock_status')
    .eq('company_id', companyId)
    .order('product_name');

  if (search) query = query.or(`sku.ilike.%${search}%,product_name.ilike.%${search}%,barcode.ilike.%${search}%`);
  if (wh) query = query.eq('warehouse_id', wh);
  if (status) query = query.eq('stock_status', status);

  const { data, error } = await query;

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма резултати.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>Продукт</th><th>SKU</th><th>Баркод</th><th>Склад</th>
        <th>На склад</th><th>Резервирано</th><th>Свободно</th><th>Мин / Макс</th><th>Статус</th>
      </tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${r.product_name}</td>
            <td class="mono">${r.sku}</td>
            <td class="mono">${r.barcode || '—'}</td>
            <td>${r.warehouse_name}</td>
            <td class="mono">${r.on_hand}</td>
            <td class="mono">${r.reserved}</td>
            <td class="mono">${r.available}</td>
            <td class="mono">${r.min_stock} / ${r.max_stock ?? '—'}</td>
            <td><span class="stock-dot ${r.stock_status}"></span>${STATUS_LABEL[r.stock_status]}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
