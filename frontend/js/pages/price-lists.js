import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
let companyId = null;

async function main() {
  const shell = await renderShell('price-lists');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;

  const listId = new URLSearchParams(location.search).get('id');
  if (listId) await renderDetail(content, listId);
  else await renderList(content);
}

async function renderList(content) {
  content.innerHTML = `
    <div class="page-header">
      <div><h1>Ценови листи</h1><div class="sub">Търговски/облекчени цени по клиентска група или количество</div></div>
      <button class="btn accent" id="new-btn">+ Нова ценова листа</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нова ценова листа</div>
      <form id="new-form" class="form-grid-2">
        <div class="field"><label>Име *</label><input name="name" required placeholder="Wholesale" /></div>
        <div class="field"><label>Валута</label>
          <select name="currency"><option value="EUR">EUR</option><option value="USD">USD</option><option value="GBP">GBP</option></select>
        </div>
        <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
          <button class="btn primary" type="submit">Запази</button>
          <button class="btn" type="button" id="cancel-btn">Отказ</button>
          <span id="form-error" style="color:var(--bad); font-size:12.5px;"></span>
        </div>
      </form>
    </div>

    <div class="panel">
      <div class="panel__header">Списък ценови листи</div>
      <div id="table-mount"></div>
    </div>

    <p style="font-size:12px; color:var(--gray-700); padding:0 4px;">
      За да приложиш ценова листа към клиент, я избери от формата за клиента в страница "Клиенти".
    </p>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'none');
  document.getElementById('new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('form-error');
    const fd = new FormData(e.target);
    const { error } = await supabase.from('price_lists').insert({
      company_id: companyId, name: fd.get('name').trim(), currency: fd.get('currency'),
    });
    if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
    await load();
    document.getElementById('new-panel').style.display = 'none';
    e.target.reset();
  });

  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const { data, error } = await supabase
    .from('price_lists')
    .select('id, name, currency, price_list_items(count)')
    .eq('company_id', companyId)
    .order('name');

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма ценови листи.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Име</th><th>Валута</th><th>Артикули</th><th></th></tr></thead>
      <tbody>
        ${data.map(p => `
          <tr>
            <td>${p.name}</td>
            <td class="mono">${p.currency}</td>
            <td class="mono">${p.price_list_items[0]?.count ?? 0}</td>
            <td><a class="btn sm" href="./price-lists.html?id=${p.id}" style="text-decoration:none;">Управлявай цени</a></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

async function renderDetail(content, listId) {
  const { data: list, error: listErr } = await supabase.from('price_lists').select('id, name, currency').eq('id', listId).single();
  if (listErr) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Грешка</div><div style="padding:20px;">${listErr.message}</div></div>`;
    return;
  }

  content.innerHTML = `
    <div class="page-header">
      <div><h1>${list.name}</h1><div class="sub">Ценови нива по продукт и количество</div></div>
      <a class="btn" href="./price-lists.html" style="text-decoration:none;">← Към списъка</a>
    </div>

    <div class="panel">
      <div class="panel__header">Добави цена</div>
      <div style="padding:16px;">
        <div class="field"><label>Търси продукт по SKU</label><input id="product-search" placeholder="TT-CORE-BLK-M…" /></div>
        <div id="search-results" style="max-height:140px; overflow-y:auto; margin:8px 0;"></div>
        <div id="selected-variant" style="font-size:13px; margin-bottom:10px;"></div>
        <div class="form-grid-2" style="padding:0;">
          <div class="field"><label>Цена (${list.currency})</label><input id="price-input" type="number" step="0.01" min="0" /></div>
          <div class="field"><label>Мин. количество</label><input id="min-qty-input" type="number" step="1" min="1" value="1" /></div>
        </div>
        <button class="btn primary" id="add-price-btn" disabled>Добави ред</button>
        <div id="add-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__header">Цени в тази листа</div>
      <div id="items-mount"></div>
    </div>
  `;

  let selectedVariant = null;

  document.getElementById('product-search').addEventListener('input', async (e) => {
    const term = e.target.value.trim();
    const resultsMount = document.getElementById('search-results');
    if (!term) { resultsMount.innerHTML = ''; return; }

    const { data } = await supabase
      .from('product_variants')
      .select('id, sku, color, size, products!inner(name, company_id)')
      .eq('products.company_id', companyId)
      .ilike('sku', `%${term}%`)
      .limit(10);

    resultsMount.innerHTML = (data || []).map(v => `
      <div class="nav-link" style="border:1px solid var(--gray-100); color:var(--ink); margin-bottom:4px; cursor:pointer;" data-id="${v.id}">
        ${v.products.name} — <span class="mono">${v.sku}</span>
      </div>
    `).join('');

    resultsMount.querySelectorAll('[data-id]').forEach(row => {
      row.addEventListener('click', () => {
        selectedVariant = data.find(x => x.id === row.dataset.id);
        document.getElementById('selected-variant').textContent = `Избран: ${selectedVariant.products.name} (${selectedVariant.sku})`;
        document.getElementById('add-price-btn').disabled = false;
        resultsMount.innerHTML = '';
        document.getElementById('product-search').value = '';
      });
    });
  });

  document.getElementById('add-price-btn').addEventListener('click', async () => {
    const errBox = document.getElementById('add-error');
    const price = Number(document.getElementById('price-input').value);
    const minQty = Number(document.getElementById('min-qty-input').value);

    if (!selectedVariant || !price) { errBox.textContent = 'Избери продукт и въведи цена.'; return; }

    const { error } = await supabase.from('price_list_items').insert({
      price_list_id: listId, variant_id: selectedVariant.id, price, min_quantity: minQty,
    });
    if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }

    selectedVariant = null;
    document.getElementById('selected-variant').textContent = '';
    document.getElementById('price-input').value = '';
    document.getElementById('add-price-btn').disabled = true;
    await loadItems(listId, list.currency);
  });

  await loadItems(listId, list.currency);
}

async function loadItems(listId, currency) {
  const mount = document.getElementById('items-mount');
  const { data, error } = await supabase
    .from('price_list_items')
    .select('id, price, min_quantity, valid_from, valid_to, product_variants(sku, products(name))')
    .eq('price_list_id', listId)
    .order('min_quantity');

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Все още няма добавени цени.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Продукт</th><th>SKU</th><th>Мин. кол.</th><th>Цена</th><th></th></tr></thead>
      <tbody>
        ${data.map(i => `
          <tr>
            <td>${i.product_variants.products.name}</td>
            <td class="mono">${i.product_variants.sku}</td>
            <td class="mono">${i.min_quantity}</td>
            <td class="mono">${new Intl.NumberFormat('bg-BG', { style: 'currency', currency }).format(i.price)}</td>
            <td><button class="btn sm danger" data-remove="${i.id}">Изтрий</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Да изтрия ли този ценови ред?')) return;
    const { error } = await supabase.from('price_list_items').delete().eq('id', b.dataset.remove);
    if (error) { alert('Грешка: ' + error.message); return; }
    await loadItems(listId, currency);
  }));
}

main();
