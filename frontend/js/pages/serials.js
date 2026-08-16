import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const STATUS_LABEL = { in_stock: 'На склад', sold: 'Продаден', returned: 'Върнат', defective: 'Дефектен' };
const STATUS_DOT = { in_stock: 'normal', sold: 'low', returned: 'critical', defective: 'out' };
let companyId = null;

async function main() {
  const shell = await renderShell('serials');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Серийни номера</h1><div class="sub">Проследяване по конкретен физически артикул</div></div>
    </div>

    <div class="panel">
      <div class="panel__header" style="gap:10px;">
        <input id="search-box" placeholder="Сериен номер или SKU…" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px; width:220px;" />
        <select id="status-filter" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;">
          <option value="">Всички статуси</option>
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <div class="topbar__spacer"></div>
      </div>
      <div id="table-mount"></div>
    </div>

    <div style="font-size:12px; color:var(--gray-700); padding:0 4px;">
      Серийните номера се въвеждат при приемане на доставка (страница "Покупки") и при продажба в POS,
      за продукти маркирани като "изисква сериен номер".
    </div>
  `;

  document.getElementById('search-box').addEventListener('input', load);
  document.getElementById('status-filter').addEventListener('change', load);

  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const search = document.getElementById('search-box').value.trim();
  const status = document.getElementById('status-filter').value;

  let query = supabase
    .from('serial_numbers')
    .select('serial, status, received_date, sold_date, warranty_until, product_variants(sku, products(name)), customers(name), warehouses(name)')
    .eq('company_id', companyId)
    .order('received_date', { ascending: false })
    .limit(300);

  if (status) query = query.eq('status', status);
  if (search) query = query.or(`serial.ilike.%${search}%`);

  const { data, error } = await query;
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма резултати.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Сериен №</th><th>Продукт</th><th>SKU</th><th>Склад</th><th>Статус</th><th>Приет на</th><th>Продаден на</th><th>Клиент</th></tr></thead>
      <tbody>
        ${data.map(s => `
          <tr>
            <td class="mono">${s.serial}</td>
            <td>${s.product_variants.products.name}</td>
            <td class="mono">${s.product_variants.sku}</td>
            <td>${s.warehouses?.name || '—'}</td>
            <td><span class="stock-dot ${STATUS_DOT[s.status]}"></span>${STATUS_LABEL[s.status]}</td>
            <td class="mono">${s.received_date || '—'}</td>
            <td class="mono">${s.sold_date || '—'}</td>
            <td>${s.customers?.name || '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
