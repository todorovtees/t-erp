import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
let companyId = null;

async function main() {
  const shell = await renderShell('suppliers');
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
      <div><h1>Доставчици</h1><div class="sub">Фирми, от които купуваш стока</div></div>
      <button class="btn accent" id="new-btn">+ Нов доставчик</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нов доставчик</div>
      <form id="new-form" style="padding:16px; display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">
        <div class="field" style="grid-column:span 2;"><label>Име *</label><input name="name" required /></div>
        <div class="field"><label>ЕИК</label><input name="eik" /></div>
        <div class="field"><label>Телефон</label><input name="phone" /></div>
        <div class="field"><label>Имейл</label><input name="email" type="email" /></div>
        <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
          <button class="btn primary" type="submit">Запази доставчик</button>
          <button class="btn" type="button" id="cancel-btn">Отказ</button>
          <span id="form-error" style="color:var(--bad); font-size:12.5px;"></span>
        </div>
      </form>
    </div>

    <div class="panel">
      <div class="panel__header">
        <span>Списък доставчици</span>
        <input id="search-box" placeholder="Търси по име или имейл…"
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

  const { error } = await supabase.from('suppliers').insert({
    company_id: companyId,
    name: fd.get('name').trim(),
    eik: fd.get('eik') || null,
    phone: fd.get('phone') || null,
    email: fd.get('email') || null,
  });

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }

  e.target.reset();
  document.getElementById('new-panel').style.display = 'none';
  await load('');
}

async function load(search) {
  const mount = document.getElementById('table-mount');
  let query = supabase
    .from('suppliers')
    .select('name, eik, phone, email, balance')
    .eq('company_id', companyId)
    .order('name');

  if (search) query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);

  const { data, error } = await query;
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма доставчици.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Име</th><th>ЕИК</th><th>Телефон</th><th>Имейл</th><th>Баланс</th></tr></thead>
      <tbody>
        ${data.map(s => `
          <tr>
            <td>${s.name}</td>
            <td class="mono">${s.eik || '—'}</td>
            <td class="mono">${s.phone || '—'}</td>
            <td>${s.email || '—'}</td>
            <td class="mono">${eur.format(s.balance)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
