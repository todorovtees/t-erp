import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

let companyId = null;
let operatorId = null;
let types = [];
let customers = [];
let suppliers = [];

async function main() {
  const shell = await renderShell('packaging');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;
  operatorId = shell.session.user.id;

  const [{ data: t }, { data: c }, { data: s }] = await Promise.all([
    supabase.from('packaging_types').select('id, name').eq('company_id', companyId).order('name'),
    supabase.from('customers').select('id, name').eq('company_id', companyId).order('name'),
    supabase.from('suppliers').select('id, name').eq('company_id', companyId).order('name'),
  ]);
  types = t || []; customers = c || []; suppliers = s || [];

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Амбалаж</h1><div class="sub">Даден и върнат амбалаж към клиенти и от доставчици</div></div>
      <button class="btn accent" id="new-type-btn">+ Тип амбалаж</button>
    </div>

    <div class="panel" id="type-panel" style="display:none;">
      <div class="panel__header">Нов тип амбалаж</div>
      <form id="type-form" style="padding:16px; display:flex; gap:10px; align-items:flex-end;">
        <div class="field" style="margin:0;"><label>Име *</label><input name="name" required placeholder="Каси / Палети / Контейнери" /></div>
        <button class="btn primary" type="submit">Запази</button>
      </form>
    </div>

    <div class="panel">
      <div class="panel__header">Ново движение</div>
      <div style="padding:16px; display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
        <div class="field" style="margin:0;"><label>Тип амбалаж</label>
          <select id="pkg-type">${types.map(t2 => `<option value="${t2.id}">${t2.name}</option>`).join('')}</select>
        </div>
        <div class="field" style="margin:0;"><label>Страна</label>
          <select id="party-type"><option value="customer">Клиент</option><option value="supplier">Доставчик</option></select>
        </div>
        <div class="field" style="margin:0;" id="party-select-field">
          <label>Клиент</label>
          <select id="party-select">${customers.map(c2 => `<option value="${c2.id}">${c2.name}</option>`).join('')}</select>
        </div>
        <div class="field" style="margin:0;"><label>Посока</label>
          <select id="direction"><option value="given">Даден</option><option value="returned">Върнат</option></select>
        </div>
        <div class="field" style="margin:0;"><label>Количество</label><input id="qty-input" type="number" min="1" step="1" value="1" /></div>
        <button class="btn primary" id="submit-btn" ${types.length ? '' : 'disabled'}>Запиши</button>
      </div>
      <div id="form-error" style="padding:0 16px 16px; color:var(--bad); font-size:12.5px;"></div>
    </div>

    <div class="panel">
      <div class="panel__header">Неприключени салда (даден − върнат)</div>
      <div id="balances-mount"></div>
    </div>
  `;

  document.getElementById('new-type-btn').addEventListener('click', () => document.getElementById('type-panel').style.display = 'block');
  document.getElementById('type-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error } = await supabase.from('packaging_types').insert({ company_id: companyId, name: fd.get('name').trim() });
    if (error) { alert('Грешка: ' + error.message); return; }
    window.location.reload();
  });

  document.getElementById('party-type').addEventListener('change', (e) => {
    const isCustomer = e.target.value === 'customer';
    document.querySelector('#party-select-field label').textContent = isCustomer ? 'Клиент' : 'Доставчик';
    document.getElementById('party-select').innerHTML = (isCustomer ? customers : suppliers).map(x => `<option value="${x.id}">${x.name}</option>`).join('');
  });

  document.getElementById('submit-btn').addEventListener('click', submitMovement);

  await loadBalances();
}

async function submitMovement() {
  const errBox = document.getElementById('form-error');
  errBox.textContent = '';
  const isCustomer = document.getElementById('party-type').value === 'customer';
  const partyId = document.getElementById('party-select').value;

  if (!partyId) { errBox.textContent = 'Избери клиент/доставчик.'; return; }

  const { error } = await supabase.from('packaging_ledger').insert({
    company_id: companyId,
    packaging_type_id: document.getElementById('pkg-type').value,
    customer_id: isCustomer ? partyId : null,
    supplier_id: isCustomer ? null : partyId,
    direction: document.getElementById('direction').value,
    quantity: Number(document.getElementById('qty-input').value),
    operator_id: operatorId,
  });

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
  await loadBalances();
}

async function loadBalances() {
  const mount = document.getElementById('balances-mount');
  const { data, error } = await supabase
    .from('v_packaging_balances')
    .select('packaging_type, customer_name, supplier_name, outstanding')
    .eq('company_id', companyId)
    .order('outstanding', { ascending: false });

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма неприключени салда.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Тип амбалаж</th><th>Клиент/Доставчик</th><th>Неприключено</th></tr></thead>
      <tbody>
        ${data.map(b => `
          <tr>
            <td>${b.packaging_type}</td>
            <td>${b.customer_name || b.supplier_name} ${b.customer_name ? '(клиент)' : '(доставчик)'}</td>
            <td class="mono" style="color:${b.outstanding > 0 ? 'var(--accent-ink)' : 'var(--good)'};">${b.outstanding}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
