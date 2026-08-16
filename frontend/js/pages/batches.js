import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const STATUS_LABEL = { expired: 'Изтекла', expiring_soon: 'Изтича скоро', ok: 'Добра', none: 'Без срок' };
const STATUS_DOT = { expired: 'out', expiring_soon: 'low', ok: 'normal', none: 'normal' };
let companyId = null;

async function main() {
  const shell = await renderShell('batches');
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
      <div><h1>Партиди / Срок на годност</h1><div class="sub">Активни партиди по всички складове</div></div>
    </div>

    <div class="panel">
      <div class="panel__header" style="gap:10px;">
        <input id="search-box" placeholder="SKU или продукт…" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px; width:220px;" />
        <select id="status-filter" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;">
          <option value="">Всички статуси</option>
          <option value="expired">Само изтекли</option>
          <option value="expiring_soon">Само изтичащи скоро</option>
        </select>
        <div class="topbar__spacer"></div>
      </div>
      <div id="table-mount"></div>
    </div>

    <div style="font-size:12px; color:var(--gray-700); padding:0 4px;">
      Партидите се създават автоматично при приемане на доставка с попълнено поле "Партиден номер" (страница "Покупки").
      Продажбите изписват автоматично по FEFO — най-близката до изтичане партида първо.
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
    .from('v_batch_status')
    .select('batch_no, quantity, expiry_date, received_date, product_name, sku, warehouse_name, expiry_status')
    .eq('company_id', companyId)
    .order('expiry_date', { ascending: true, nullsFirst: false });

  if (search) query = query.or(`sku.ilike.%${search}%,product_name.ilike.%${search}%`);
  if (status) query = query.eq('expiry_status', status);

  const { data, error } = await query;
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма партиди за избрания филтър.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Продукт</th><th>SKU</th><th>Партида №</th><th>Склад</th><th>Количество</th><th>Приета на</th><th>Годна до</th><th>Статус</th></tr></thead>
      <tbody>
        ${data.map(b => `
          <tr>
            <td>${b.product_name}</td>
            <td class="mono">${b.sku}</td>
            <td class="mono">${b.batch_no}</td>
            <td>${b.warehouse_name}</td>
            <td class="mono">${b.quantity}</td>
            <td class="mono">${b.received_date}</td>
            <td class="mono">${b.expiry_date || '—'}</td>
            <td><span class="stock-dot ${STATUS_DOT[b.expiry_status]}"></span>${STATUS_LABEL[b.expiry_status]}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
