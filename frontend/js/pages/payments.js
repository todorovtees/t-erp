import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const METHOD_LABEL = { cash: 'В брой', card: 'Карта', bank_transfer: 'Банков превод', cheque: 'Чек', voucher: 'Ваучер', coupon: 'Купон', mixed: 'Комбинирано' };
const REF_LABEL = { sales: 'Продажба', purchases: 'Покупка' };

let companyId = null;

async function main() {
  const shell = await renderShell('payments');
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
      <div><h1>Плащания</h1><div class="sub">Всички получени и извършени плащания</div></div>
    </div>
    <div class="panel">
      <div class="panel__header">
        <span>Списък плащания</span>
        <select id="method-filter" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;">
          <option value="">Всички начини</option>
          ${Object.entries(METHOD_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
      </div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('method-filter').addEventListener('change', load);
  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const method = document.getElementById('method-filter').value;

  let query = supabase
    .from('payments')
    .select('ref_table, method, amount, currency, created_at, app_users(full_name)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (method) query = query.eq('method', method);

  const { data, error } = await query;
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма плащания.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Дата</th><th>Тип документ</th><th>Начин</th><th>Оператор</th><th>Сума</th></tr></thead>
      <tbody>
        ${data.map(p => `
          <tr>
            <td class="mono">${new Date(p.created_at).toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>${REF_LABEL[p.ref_table] || p.ref_table}</td>
            <td>${METHOD_LABEL[p.method] || p.method}</td>
            <td>${p.app_users?.full_name || '—'}</td>
            <td class="mono">${eur.format(p.amount)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
