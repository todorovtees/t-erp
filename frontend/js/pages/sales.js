import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const STATUS_LABEL = {
  draft: 'Чернова', sent: 'Изпратена', in_transit: 'В път', received: 'Получена',
  confirmed: 'Потвърдена', partially_fulfilled: 'Частично', fulfilled: 'Изпълнена', cancelled: 'Отказана',
};
const CHANNEL_LABEL = { store: 'Магазин', website: 'Сайт', wholesale: 'На едро', pos: 'POS', ambassador: 'Амбасадор' };

let companyId = null;

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
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма продажби за избрания филтър.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>Документ</th><th>Дата</th><th>Канал</th><th>Склад</th><th>Клиент</th>
        <th>Оператор</th><th>Артикули</th><th>Статус</th><th>Общо</th>
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
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
