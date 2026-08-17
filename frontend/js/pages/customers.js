import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
let companyId = null;
let priceLists = [];

async function main() {
  const shell = await renderShell('customers');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;

  const { data: pls } = await supabase.from('price_lists').select('id, name').eq('company_id', companyId).order('name');
  priceLists = pls || [];

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Клиенти</h1><div class="sub">Физически лица и фирми, на които продаваш</div></div>
      <button class="btn accent" id="new-btn">+ Нов клиент</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нов клиент</div>
      <form id="new-form" class="form-grid-3">
        <div class="field"><label>Име *</label><input name="name" required /></div>
        <div class="field"><label>Фирма</label><input name="company_name" /></div>
        <div class="field"><label>ЕИК</label><input name="eik" /></div>
        <div class="field"><label>Телефон</label><input name="phone" /></div>
        <div class="field"><label>Имейл</label><input name="email" type="email" /></div>
        <div class="field"><label>Кредитен лимит</label><input name="credit_limit" type="number" step="0.01" value="0" /></div>
        <div class="field"><label>Ценова листа</label>
          <select name="price_list_id"><option value="">По подразбиране</option>
            ${priceLists.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
        </div>
        <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
          <button class="btn primary" type="submit">Запази клиент</button>
          <button class="btn" type="button" id="cancel-btn">Отказ</button>
          <span id="form-error" style="color:var(--bad); font-size:12.5px;"></span>
        </div>
      </form>
    </div>

    <div class="panel">
      <div class="panel__header">
        <span>Списък клиенти</span>
        <input id="search-box" placeholder="Търси по име, фирма или имейл…"
               style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px; width:240px;" />
      </div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'none');
  document.getElementById('new-form').addEventListener('submit', handleCreate);
  document.getElementById('search-box').addEventListener('input', (e) => load(e.target.value));

  await load('');
}

async function handleCreate(e) {
  e.preventDefault();
  const errBox = document.getElementById('form-error');
  errBox.textContent = '';
  const fd = new FormData(e.target);

  const { error } = await supabase.from('customers').insert({
    company_id: companyId,
    name: fd.get('name').trim(),
    company_name: fd.get('company_name') || null,
    eik: fd.get('eik') || null,
    phone: fd.get('phone') || null,
    email: fd.get('email') || null,
    credit_limit: Number(fd.get('credit_limit')),
    price_list_id: fd.get('price_list_id') || null,
  });

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }

  e.target.reset();
  document.getElementById('new-panel').style.display = 'none';
  await load('');
}

async function load(search) {
  const mount = document.getElementById('table-mount');
  let query = supabase
    .from('customers')
    .select('id, name, company_name, phone, email, credit_limit')
    .eq('company_id', companyId)
    .order('name');

  if (search) query = query.or(`name.ilike.%${search}%,company_name.ilike.%${search}%,email.ilike.%${search}%`);

  const { data, error } = await query;
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма клиенти.</div>`; return; }

  const { data: balances } = await supabase
    .from('v_customer_balances')
    .select('customer_id, balance')
    .eq('company_id', companyId);
  const balanceMap = Object.fromEntries((balances || []).map(b => [b.customer_id, b.balance]));

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Име</th><th>Фирма</th><th>Телефон</th><th>Имейл</th><th>Кредитен лимит</th><th>Баланс (дължимо)</th></tr></thead>
      <tbody>
        ${data.map(c => `
          <tr>
            <td>${c.name}</td>
            <td>${c.company_name || '—'}</td>
            <td class="mono">${c.phone || '—'}</td>
            <td>${c.email || '—'}</td>
            <td class="mono">${eur.format(c.credit_limit)}</td>
            <td class="mono" style="color:${(balanceMap[c.id] || 0) > 0 ? 'var(--accent-ink)' : 'inherit'};">${eur.format(balanceMap[c.id] || 0)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
