import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';
import { printDocument } from '../lib/print.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const STATUS_LABEL = {
  draft: 'Чернова', sent: 'Изпратена', in_transit: 'В път', received: 'Получена',
  confirmed: 'Потвърдена', partially_fulfilled: 'Частично', fulfilled: 'Изпълнена', cancelled: 'Отказана',
};
const CHANNEL_LABEL = { store: 'Магазин', website: 'Сайт', wholesale: 'На едро', pos: 'POS', ambassador: 'Амбасадор' };

let companyId = null;
let operatorId = null;
let currentRows = [];

async function main() {
  const shell = await renderShell('sales');
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
      <div><h1>Продажби</h1><div class="sub">Всички продажбени документи</div></div>
      <a class="btn accent" href="./pos.html" style="text-decoration:none;">+ Нова продажба (POS)</a>
    </div>

    <div class="panel">
      <div class="panel__header" style="gap:10px;">
        <select id="status-filter" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;">
          <option value="">Всички статуси</option>
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <input id="date-from" type="date" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;" />
        <input id="date-to" type="date" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;" />
        <div class="topbar__spacer"></div>
      </div>
      <div id="table-mount"></div>
    </div>

    <div id="modal-mount"></div>
  `;

  document.getElementById('status-filter').addEventListener('change', load);
  document.getElementById('date-from').addEventListener('change', load);
  document.getElementById('date-to').addEventListener('change', load);

  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const status = document.getElementById('status-filter').value;
  const from = document.getElementById('date-from').value;
  const to = document.getElementById('date-to').value;

  let query = supabase
    .from('v_sales_list')
    .select('id, document_no, status, channel, total, currency, created_at, customer_name, warehouse_name, operator_name, item_count')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (status) query = query.eq('status', status);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to + 'T23:59:59');

  const { data, error } = await query;
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  currentRows = data;
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма продажби за избрания филтър.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>Документ</th><th>Дата</th><th>Канал</th><th>Склад</th><th>Клиент</th>
        <th>Оператор</th><th>Артикули</th><th>Статус</th><th>Общо</th><th>Действия</th>
      </tr></thead>
      <tbody>
        ${data.map(s => `
          <tr>
            <td class="mono">${s.document_no}</td>
            <td class="mono">${new Date(s.created_at).toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>${CHANNEL_LABEL[s.channel] || s.channel}</td>
            <td>${s.warehouse_name}</td>
            <td>${s.customer_name || '—'}</td>
            <td>${s.operator_name || '—'}</td>
            <td class="mono">${s.item_count}</td>
            <td>${STATUS_LABEL[s.status] || s.status}</td>
            <td class="mono">${eur.format(s.total)}</td>
            <td>
              <div class="action-row">
                <button class="btn sm" data-view="${s.id}">Преглед</button>
                <button class="btn sm" data-print="${s.id}">Печат</button>
                ${s.status !== 'cancelled' ? `<button class="btn sm danger" data-void="${s.id}">Анулирай</button>` : ''}
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => viewSale(b.dataset.view)));
  mount.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => printSale(b.dataset.print)));
  mount.querySelectorAll('[data-void]').forEach(b => b.addEventListener('click', () => voidSale(b.dataset.void)));
}

async function fetchSaleDetail(saleId) {
  const header = currentRows.find(r => r.id === saleId);
  const { data: items, error } = await supabase
    .from('sale_items')
    .select('quantity, unit_price, discount, vat_rate, line_total, product_variants(sku, color, size, products(name))')
    .eq('sale_id', saleId);
  if (error) throw error;
  return { header, items };
}

async function viewSale(saleId) {
  const mount = document.getElementById('modal-mount');
  const { header, items } = await fetchSaleDetail(saleId);

  mount.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card">
        <div class="panel__header">
          <span>Продажба ${header.document_no}</span>
          <button class="modal-close" id="modal-close">✕</button>
        </div>
        <div style="padding:16px; font-size:13px;">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:14px;">
            <div><span style="color:var(--gray-700);">Дата:</span> ${new Date(header.created_at).toLocaleString('bg-BG')}</div>
            <div><span style="color:var(--gray-700);">Статус:</span> ${STATUS_LABEL[header.status] || header.status}</div>
            <div><span style="color:var(--gray-700);">Склад:</span> ${header.warehouse_name}</div>
            <div><span style="color:var(--gray-700);">Клиент:</span> ${header.customer_name || '—'}</div>
            <div><span style="color:var(--gray-700);">Оператор:</span> ${header.operator_name || '—'}</div>
            <div><span style="color:var(--gray-700);">Канал:</span> ${CHANNEL_LABEL[header.channel] || header.channel}</div>
          </div>
          <table class="data">
            <thead><tr><th>Продукт</th><th>Кол.</th><th>Цена</th><th>Общо</th></tr></thead>
            <tbody>
              ${items.map(i => `
                <tr>
                  <td>${i.product_variants.products.name}<br><span class="mono" style="font-size:11px; color:var(--gray-700);">${i.product_variants.sku}</span></td>
                  <td class="mono">${i.quantity}</td>
                  <td class="mono">${eur.format(i.unit_price)}</td>
                  <td class="mono">${eur.format(i.line_total)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div style="text-align:right; margin-top:12px; font-family:var(--font-mono); font-size:16px; font-weight:600;">
            Общо: ${eur.format(header.total)}
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });
}

function closeModal() { document.getElementById('modal-mount').innerHTML = ''; }

async function printSale(saleId) {
  const { header, items } = await fetchSaleDetail(saleId);

  printDocument({
    documentTitle: `Продажба ${header.document_no}`,
    subtitle: `Канал: ${CHANNEL_LABEL[header.channel] || header.channel}`,
    meta: [
      { label: 'Дата', value: new Date(header.created_at).toLocaleString('bg-BG') },
      { label: 'Склад', value: header.warehouse_name },
      { label: 'Клиент', value: header.customer_name || '—' },
      { label: 'Оператор', value: header.operator_name || '—' },
      { label: 'Статус', value: STATUS_LABEL[header.status] || header.status },
    ],
    columns: [
      { key: 'name', label: 'Продукт' },
      { key: 'sku', label: 'SKU' },
      { key: 'qty', label: 'Количество', align: 'right' },
      { key: 'price', label: 'Ед. цена', align: 'right' },
      { key: 'total', label: 'Общо', align: 'right' },
    ],
    rows: items.map(i => ({
      name: i.product_variants.products.name,
      sku: i.product_variants.sku,
      qty: i.quantity,
      price: eur.format(i.unit_price),
      total: eur.format(i.line_total),
    })),
    totals: [
      { label: 'Общо', value: eur.format(header.total), emphasis: true },
    ],
    footerNote: `Отпечатано на ${new Date().toLocaleString('bg-BG')} от T-ERP · Todorov Tees`,
  });
}

async function voidSale(saleId) {
  if (!confirm('Да анулирам ли тази продажба? Наличността ще бъде върната автоматично.')) return;

  const { error } = await supabase.rpc('void_sale', {
    p_company_id: companyId, p_sale_id: saleId, p_operator_id: operatorId,
  });

  if (error) { alert('Грешка: ' + error.message); return; }
  await load();
}

main();
