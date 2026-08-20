import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
let companyId = null;
let priceLists = [];
let groups = [];

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

  const [{ data: pls }, { data: grps }] = await Promise.all([
    supabase.from('price_lists').select('id, name').eq('company_id', companyId).order('name'),
    supabase.from('customer_groups').select('id, name').eq('company_id', companyId).order('name'),
  ]);
  priceLists = pls || [];
  groups = grps || [];

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Клиенти</h1><div class="sub">Физически лица и фирми, на които продаваш</div></div>
      <div class="action-row">
        <button class="btn" id="new-group-btn">+ Група</button>
        <button class="btn accent" id="new-btn">+ Нов клиент</button>
      </div>
    </div>

    <div class="panel" id="group-panel" style="display:none;">
      <div class="panel__header">Нова клиентска група</div>
      <form id="group-form" style="padding:16px; display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap;">
        <div class="field" style="margin:0;"><label>Име *</label><input name="name" required placeholder="VIP клиенти" /></div>
        <div class="field" style="margin:0;"><label>Групова ценова листа</label>
          <select name="price_list_id"><option value="">—</option>${priceLists.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select>
        </div>
        <button class="btn primary" type="submit">Запази група</button>
      </form>
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
        <div class="field"><label>Група</label>
          <select name="group_id"><option value="">Без група</option>${groups.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Собствена ценова листа</label>
          <select name="price_list_id"><option value="">По подразбиране / от групата</option>
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

    <div id="modal-mount"></div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'none');
  document.getElementById('new-form').addEventListener('submit', handleCreate);
  document.getElementById('search-box').addEventListener('input', (e) => load(e.target.value));
  document.getElementById('new-group-btn').addEventListener('click', () => document.getElementById('group-panel').style.display = 'block');
  document.getElementById('group-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error } = await supabase.from('customer_groups').insert({
      company_id: companyId, name: fd.get('name').trim(), price_list_id: fd.get('price_list_id') || null,
    });
    if (error) { alert('Грешка: ' + error.message); return; }
    window.location.reload();
  });

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
    group_id: fd.get('group_id') || null,
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
    .select('id, name, company_name, phone, email, credit_limit, customer_groups(name)')
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
      <thead><tr><th>Име</th><th>Фирма</th><th>Група</th><th>Телефон</th><th>Имейл</th><th>Дължимо</th><th></th></tr></thead>
      <tbody>
        ${data.map(c => `
          <tr>
            <td>${c.name}</td>
            <td>${c.company_name || '—'}</td>
            <td>${c.customer_groups?.name || '—'}</td>
            <td class="mono">${c.phone || '—'}</td>
            <td>${c.email || '—'}</td>
            <td class="mono" style="color:${(balanceMap[c.id] || 0) > 0 ? 'var(--accent-ink)' : 'inherit'};">${eur.format(balanceMap[c.id] || 0)}</td>
            <td><button class="btn sm" data-codes="${c.id}" data-name="${c.name}">Кодове</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-codes]').forEach(b => b.addEventListener('click', () => openCodesModal(b.dataset.codes, b.dataset.name)));
}

async function openCodesModal(customerId, customerName) {
  const mount = document.getElementById('modal-mount');
  mount.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card">
        <div class="panel__header"><span>Продуктови кодове — ${customerName}</span><button class="modal-close" id="modal-close">✕</button></div>
        <div style="padding:16px;">
          <div class="field"><label>Търси продукт</label><input id="code-product-search" placeholder="SKU…" /></div>
          <div id="code-search-results" style="max-height:120px; overflow-y:auto; margin-bottom:10px;"></div>
          <table class="data"><thead><tr><th>Продукт</th><th>SKU (наш)</th><th>Код на клиента</th><th></th></tr></thead><tbody id="codes-mount"></tbody></table>
        </div>
      </div>
    </div>`;

  document.getElementById('modal-close').addEventListener('click', () => mount.innerHTML = '');
  document.getElementById('modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') mount.innerHTML = ''; });

  document.getElementById('code-product-search').addEventListener('input', async (e) => {
    const term = e.target.value.trim();
    const resMount = document.getElementById('code-search-results');
    if (!term) { resMount.innerHTML = ''; return; }
    const { data } = await supabase.from('product_variants').select('id, sku, products!inner(name, company_id)').eq('products.company_id', companyId).ilike('sku', `%${term}%`).limit(10);
    resMount.innerHTML = (data || []).map(v => `<div class="nav-link" style="border:1px solid var(--gray-100); color:var(--ink); margin-bottom:4px; cursor:pointer;" data-vid="${v.id}" data-vsku="${v.sku}" data-vname="${v.products.name}">${v.products.name} — ${v.sku}</div>`).join('');
    resMount.querySelectorAll('[data-vid]').forEach(row => row.addEventListener('click', async () => {
      const code = prompt(`Код на клиента "${customerName}" за ${row.dataset.vname}:`);
      if (!code) return;
      const { error } = await supabase.from('customer_product_codes').insert({ customer_id: customerId, variant_id: row.dataset.vid, customer_code: code.trim() });
      if (error) { alert('Грешка: ' + error.message); return; }
      resMount.innerHTML = ''; document.getElementById('code-product-search').value = '';
      await loadCodes(customerId);
    }));
  });

  await loadCodes(customerId);
}

async function loadCodes(customerId) {
  const mount = document.getElementById('codes-mount');
  const { data } = await supabase.from('customer_product_codes').select('id, customer_code, product_variants(sku, products(name))').eq('customer_id', customerId);
  mount.innerHTML = (data || []).map(c => `
    <tr><td>${c.product_variants.products.name}</td><td class="mono">${c.product_variants.sku}</td><td class="mono">${c.customer_code}</td>
    <td><button class="btn sm danger" data-del="${c.id}">Изтрий</button></td></tr>
  `).join('') || '<tr><td colspan="4" style="color:var(--gray-700); font-size:12.5px;">Няма зададени кодове.</td></tr>';
  mount.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    await supabase.from('customer_product_codes').delete().eq('id', b.dataset.del);
    await loadCodes(customerId);
  }));
}

main();
