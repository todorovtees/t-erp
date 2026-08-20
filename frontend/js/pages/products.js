import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });

let companyId = null;
let categories = [];

async function main() {
  const shell = await renderShell('products');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) { content.innerHTML = noProfileNotice(); return; }
  companyId = profile.company_id;

  const { data: cats } = await supabase.from('categories').select('id, name').eq('company_id', companyId);
  categories = cats || [];

  content.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Продукти</h1>
        <div class="sub">Продукти, варианти и обща наличност по всички складове</div>
      </div>
      <button class="btn accent" id="new-product-btn">+ Нов продукт</button>
    </div>

    <div class="panel" id="new-product-panel" style="display:none;">
      <div class="panel__header">Нов продукт</div>
      <form id="new-product-form" class="form-grid-3">
        <div class="field"><label>SKU *</label><input name="sku" required placeholder="TT-CORE" /></div>
        <div class="field" style="grid-column:span 2;"><label>Име *</label><input name="name" required placeholder="Todorov Tees Core T-Shirt" /></div>
        <div class="field">
          <label>Категория</label>
          <select name="category_id">
            <option value="">—</option>
            ${categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Мерна единица</label>
          <select name="unit">
            <option value="pcs">брой</option>
            <option value="kg">килограм</option>
            <option value="l">литър</option>
            <option value="box">кашон</option>
          </select>
        </div>
        <div class="field"><label>ДДС %</label><input name="vat_rate" type="number" step="0.01" value="20.00" /></div>
        <div class="field"><label>Покупна цена</label><input name="purchase_price" type="number" step="0.01" value="0" /></div>
        <div class="field"><label>Продажна цена *</label><input name="sale_price" type="number" step="0.01" required /></div>
        <div class="field"><label>Мин. наличност</label><input name="min_stock" type="number" step="1" value="0" /></div>
        <div class="field" style="display:flex; align-items:center; gap:16px; padding-top:22px;">
          <label style="display:flex; align-items:center; gap:5px; font-weight:400; font-size:13px;">
            <input type="checkbox" name="track_batches" style="width:auto;" /> Партиди/годност
          </label>
          <label style="display:flex; align-items:center; gap:5px; font-weight:400; font-size:13px;">
            <input type="checkbox" name="track_serials" style="width:auto;" /> Сериен номер
          </label>
        </div>
        <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
          <button class="btn primary" type="submit">Запази продукт</button>
          <button class="btn" type="button" id="cancel-new-product">Отказ</button>
          <span id="new-product-error" style="color:var(--bad); font-size:12.5px;"></span>
        </div>
      </form>
    </div>

    <div class="panel">
      <div class="panel__header">
        <span>Списък продукти</span>
        <input id="search-box" placeholder="Търси по SKU или име…" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px; width:240px;" />
      </div>
      <div id="products-table-mount"></div>
    </div>

    <div id="modal-mount"></div>
  `;

  document.getElementById('new-product-btn').addEventListener('click', () => {
    document.getElementById('new-product-panel').style.display = 'block';
  });
  document.getElementById('cancel-new-product').addEventListener('click', () => {
    document.getElementById('new-product-panel').style.display = 'none';
  });
  document.getElementById('new-product-form').addEventListener('submit', handleCreateProduct);
  document.getElementById('search-box').addEventListener('input', (e) => loadProducts(e.target.value));

  await loadProducts('');
}

function noProfileNotice() {
  return `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
    <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
}

async function handleCreateProduct(e) {
  e.preventDefault();
  const errBox = document.getElementById('new-product-error');
  errBox.textContent = '';
  const fd = new FormData(e.target);
  const sku = fd.get('sku').trim();

  const productRow = {
    company_id: companyId,
    sku,
    name: fd.get('name').trim(),
    category_id: fd.get('category_id') || null,
    unit: fd.get('unit'),
    vat_rate: Number(fd.get('vat_rate')),
    purchase_price: Number(fd.get('purchase_price')),
    sale_price: Number(fd.get('sale_price')),
    min_stock: Number(fd.get('min_stock')),
    track_batches: fd.get('track_batches') === 'on',
    track_serials: fd.get('track_serials') === 'on',
  };

  const { data: product, error: prodErr } = await supabase
    .from('products').insert(productRow).select('id').single();

  if (prodErr) {
    errBox.textContent = 'Грешка: ' + prodErr.message;
    return;
  }

  // Every product needs at least one variant so it can be sold / stocked.
  // Products created here start with a single implicit "default" variant;
  // color/size variants can be added from the product detail page later.
  const { error: varErr } = await supabase.from('product_variants').insert({
    product_id: product.id,
    sku,
    is_active: true,
  });

  if (varErr) {
    errBox.textContent = 'Продуктът е създаден, но вариантът не: ' + varErr.message;
    return;
  }

  e.target.reset();
  document.getElementById('new-product-panel').style.display = 'none';
  await loadProducts('');
}

async function loadProducts(search) {
  const mount = document.getElementById('products-table-mount');
  let query = supabase
    .from('v_product_summary')
    .select('id, sku, name, category_name, unit, sale_price, min_stock, variant_count, total_on_hand, is_active')
    .eq('company_id', companyId)
    .order('name');

  if (search) query = query.or(`sku.ilike.%${search}%,name.ilike.%${search}%`);

  const { data, error } = await query;

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма продукти.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>SKU</th><th>Продукт</th><th>Категория</th><th>Варианти</th>
        <th>Наличност (общо)</th><th>Продажна цена</th><th>Статус</th><th>Действия</th>
      </tr></thead>
      <tbody>
        ${data.map(p => `
          <tr>
            <td class="mono">${p.sku}</td>
            <td>${p.name}</td>
            <td>${p.category_name || '—'}</td>
            <td class="mono">${p.variant_count}</td>
            <td class="mono">
              <span class="stock-dot ${p.total_on_hand <= 0 ? 'out' : (p.total_on_hand <= p.min_stock ? 'low' : 'normal')}"></span>
              ${p.total_on_hand} ${p.unit}
            </td>
            <td class="mono">${eur.format(p.sale_price)}</td>
            <td>${p.is_active ? 'Активен' : 'Неактивен'}</td>
            <td>
              <div class="action-row">
                <button class="btn sm" data-edit="${p.id}">Редактирай</button>
                <button class="btn sm danger" data-delete="${p.id}">Изтрий</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditModal(b.dataset.edit)));
  mount.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', () => deleteProduct(b.dataset.delete)));
}

async function openEditModal(productId) {
  const { data: p, error } = await supabase
    .from('products')
    .select('id, sku, name, category_id, unit, vat_rate, purchase_price, sale_price, min_stock, is_active, track_batches, track_serials')
    .eq('id', productId).single();
  if (error) { alert('Грешка: ' + error.message); return; }

  const mount = document.getElementById('modal-mount');
  mount.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card">
        <div class="panel__header"><span>Редактирай продукт</span><button class="modal-close" id="modal-close">✕</button></div>
        <form id="edit-form" class="form-grid-3">
          <div class="field"><label>SKU *</label><input name="sku" value="${p.sku}" required /></div>
          <div class="field" style="grid-column:span 2;"><label>Име *</label><input name="name" value="${p.name}" required /></div>
          <div class="field"><label>Категория</label>
            <select name="category_id"><option value="">—</option>${categories.map(c => `<option value="${c.id}" ${c.id === p.category_id ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Мерна единица</label>
            <select name="unit">
              ${['pcs', 'kg', 'l', 'box'].map(u => `<option value="${u}" ${u === p.unit ? 'selected' : ''}>${u}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>ДДС %</label><input name="vat_rate" type="number" step="0.01" value="${p.vat_rate}" /></div>
          <div class="field"><label>Покупна цена</label><input name="purchase_price" type="number" step="0.01" value="${p.purchase_price}" /></div>
          <div class="field"><label>Продажна цена *</label><input name="sale_price" type="number" step="0.01" value="${p.sale_price}" required /></div>
          <div class="field"><label>Мин. наличност</label><input name="min_stock" type="number" step="1" value="${p.min_stock}" /></div>
          <div class="field"><label>Статус</label>
            <select name="is_active"><option value="true" ${p.is_active ? 'selected' : ''}>Активен</option><option value="false" ${!p.is_active ? 'selected' : ''}>Неактивен</option></select>
          </div>
          <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
            <button class="btn primary" type="submit">Запази промените</button>
            <span id="edit-error" style="color:var(--bad); font-size:12.5px;"></span>
          </div>
        </form>
      </div>
    </div>`;

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });
  document.getElementById('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('edit-error');
    const fd = new FormData(e.target);
    const { error: updErr } = await supabase.from('products').update({
      sku: fd.get('sku').trim(), name: fd.get('name').trim(), category_id: fd.get('category_id') || null,
      unit: fd.get('unit'), vat_rate: Number(fd.get('vat_rate')), purchase_price: Number(fd.get('purchase_price')),
      sale_price: Number(fd.get('sale_price')), min_stock: Number(fd.get('min_stock')), is_active: fd.get('is_active') === 'true',
    }).eq('id', productId);
    if (updErr) { errBox.textContent = 'Грешка: ' + updErr.message; return; }
    closeModal();
    await loadProducts(document.getElementById('search-box').value);
  });
}

function closeModal() { document.getElementById('modal-mount').innerHTML = ''; }

async function deleteProduct(productId) {
  if (!confirm('Да изтрия ли този продукт? (изисква пълни права)')) return;
  const { error } = await supabase.from('products').delete().eq('id', productId);
  if (error) { alert('Грешка: ' + error.message); return; }
  await loadProducts(document.getElementById('search-box').value);
}

main();
