import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

let companyId = null;

async function main() {
  const shell = await renderShell('warehouses');
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
      <div><h1>Складове</h1><div class="sub">Всички складови обекти на компанията</div></div>
      <button class="btn accent" id="new-wh-btn">+ Нов склад</button>
    </div>

    <div class="panel" id="new-wh-panel" style="display:none;">
      <div class="panel__header">Нов склад</div>
      <form id="new-wh-form" class="form-grid-3">
        <div class="field"><label>Код *</label><input name="code" required placeholder="STR-VAR" /></div>
        <div class="field" style="grid-column:span 2;"><label>Име *</label><input name="name" required placeholder="Store Varna" /></div>
        <div class="field" style="grid-column:span 2;"><label>Адрес</label><input name="address" /></div>
        <div class="field"><label>Телефон</label><input name="phone" /></div>
        <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
          <button class="btn primary" type="submit">Запази склад</button>
          <button class="btn" type="button" id="cancel-new-wh">Отказ</button>
          <span id="new-wh-error" style="color:var(--bad); font-size:12.5px;"></span>
        </div>
      </form>
    </div>

    <div class="panel">
      <div class="panel__header">Списък складове</div>
      <div id="wh-table-mount"></div>
    </div>
  `;

  document.getElementById('new-wh-btn').addEventListener('click', () => {
    document.getElementById('new-wh-panel').style.display = 'block';
  });
  document.getElementById('cancel-new-wh').addEventListener('click', () => {
    document.getElementById('new-wh-panel').style.display = 'none';
  });
  document.getElementById('new-wh-form').addEventListener('submit', handleCreate);

  await loadWarehouses();
}

async function handleCreate(e) {
  e.preventDefault();
  const errBox = document.getElementById('new-wh-error');
  errBox.textContent = '';
  const fd = new FormData(e.target);

  const { error } = await supabase.from('warehouses').insert({
    company_id: companyId,
    code: fd.get('code').trim(),
    name: fd.get('name').trim(),
    address: fd.get('address') || null,
    phone: fd.get('phone') || null,
    status: 'active',
  });

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }

  e.target.reset();
  document.getElementById('new-wh-panel').style.display = 'none';
  await loadWarehouses();
}

async function loadWarehouses() {
  const mount = document.getElementById('wh-table-mount');
  const { data, error } = await supabase
    .from('warehouses')
    .select('code, name, address, phone, status')
    .eq('company_id', companyId)
    .order('code');

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма складове.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Код</th><th>Име</th><th>Адрес</th><th>Телефон</th><th>Статус</th></tr></thead>
      <tbody>
        ${data.map(w => `
          <tr>
            <td class="mono">${w.code}</td>
            <td>${w.name}</td>
            <td>${w.address || '—'}</td>
            <td class="mono">${w.phone || '—'}</td>
            <td>${w.status === 'active' ? 'Активен' : 'Неактивен'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
