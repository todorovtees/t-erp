import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const STATUS_LABEL = { draft: 'Чернова', counting: 'Преброяване', pending_approval: 'За одобрение', approved: 'Одобрена', cancelled: 'Отказана' };
let companyId = null;
let operatorId = null;

async function main() {
  const shell = await renderShell('counts');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;
  operatorId = shell.session.user.id;

  const countId = new URLSearchParams(location.search).get('id');
  if (countId) await renderDetail(content, countId);
  else await renderList(content);
}

let pickerVariants = [];   // all variants available in the chosen warehouse
let selectedIds = new Set();

async function renderList(content) {
  const { data: warehouses } = await supabase.from('warehouses').select('id, name').eq('company_id', companyId).order('name');

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Инвентаризация</h1><div class="sub">Физическо преброяване на наличности</div></div>
      <button class="btn accent" id="new-btn">+ Нова инвентаризация</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нова инвентаризация</div>

      <div class="form-grid-2">
        <div class="field"><label>Склад / обект *</label>
          <select id="wh-select">
            <option value="">— избери —</option>
            ${(warehouses || []).map(w => `<option value="${w.id}">${w.name}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Обхват</label>
          <select id="scope-select">
            <option value="all">Всички продукти в склада</option>
            <option value="pick">Избрани продукти</option>
          </select>
        </div>
      </div>

      <div id="picker" style="display:none; border-top:1px solid var(--gray-100);">
        <div class="panel__header" style="background:var(--gray-50);">
          <input id="picker-search" placeholder="Търси по SKU, продукт или категория…" style="flex:1 1 200px;" />
          <div class="action-row">
            <button class="btn sm" id="pick-all">Избери всички</button>
            <button class="btn sm" id="pick-none">Изчисти</button>
          </div>
        </div>
        <div style="padding:0 var(--sp-4) var(--sp-2); font-size:var(--text-xs); color:var(--gray-700);">
          <span id="pick-count">0 избрани</span>
        </div>
        <div id="picker-list" style="max-height:340px; overflow-y:auto; border-top:1px solid var(--gray-100);"></div>
      </div>

      <div class="modal-actions" style="position:static;">
        <button class="btn primary" id="start-btn">Започни инвентаризация</button>
        <button class="btn" id="cancel-new">Отказ</button>
        <span id="form-error" style="color:var(--bad); font-size:var(--text-xs); flex-basis:100%;"></span>
      </div>
    </div>

    <div class="panel">
      <div class="panel__header">Списък инвентаризации</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => {
    document.getElementById('new-panel').style.display = 'block';
  });
  document.getElementById('cancel-new').addEventListener('click', () => {
    document.getElementById('new-panel').style.display = 'none';
  });

  document.getElementById('scope-select').addEventListener('change', async (e) => {
    const picking = e.target.value === 'pick';
    document.getElementById('picker').style.display = picking ? 'block' : 'none';
    if (picking) await loadPickerVariants();
  });

  document.getElementById('wh-select').addEventListener('change', async () => {
    selectedIds.clear();
    if (document.getElementById('scope-select').value === 'pick') await loadPickerVariants();
  });

  document.getElementById('picker-search').addEventListener('input', renderPicker);
  document.getElementById('pick-all').addEventListener('click', () => {
    visibleVariants().forEach(v => selectedIds.add(v.variant_id));
    renderPicker();
  });
  document.getElementById('pick-none').addEventListener('click', () => { selectedIds.clear(); renderPicker(); });

  document.getElementById('start-btn').addEventListener('click', startCount);

  await loadCountsList();
}

// Pulls every variant that has an inventory row in the chosen warehouse —
// i.e. exactly the set start_inventory_count() would snapshot.
async function loadPickerVariants() {
  const warehouseId = document.getElementById('wh-select').value;
  const listMount = document.getElementById('picker-list');
  if (!warehouseId) {
    pickerVariants = [];
    listMount.innerHTML = `<div class="empty-state">Първо избери склад.</div>`;
    return;
  }

  listMount.innerHTML = `<div class="empty-state">Зареждане…</div>`;
  const { data, error } = await supabase
    .from('v_inventory_detail')
    .select('variant_id, product_name, sku, color, size, on_hand')
    .eq('company_id', companyId)
    .eq('warehouse_id', warehouseId)
    .order('product_name');

  if (error) { listMount.innerHTML = `<div class="empty-state">Грешка: ${error.message}</div>`; return; }
  pickerVariants = data || [];
  renderPicker();
}

function visibleVariants() {
  const term = (document.getElementById('picker-search')?.value || '').trim().toLowerCase();
  if (!term) return pickerVariants;
  return pickerVariants.filter(v =>
    (v.product_name || '').toLowerCase().includes(term) ||
    (v.sku || '').toLowerCase().includes(term) ||
    (v.color || '').toLowerCase().includes(term) ||
    (v.size || '').toLowerCase().includes(term)
  );
}

function renderPicker() {
  const listMount = document.getElementById('picker-list');
  const rows = visibleVariants();

  document.getElementById('pick-count').textContent = `${selectedIds.size} избрани от ${pickerVariants.length}`;

  if (!pickerVariants.length) {
    listMount.innerHTML = `<div class="empty-state">В този склад няма продукти с наличност.</div>`;
    return;
  }
  if (!rows.length) {
    listMount.innerHTML = `<div class="empty-state">Няма съвпадения за търсенето.</div>`;
    return;
  }

  listMount.innerHTML = rows.map(v => `
    <label style="display:flex; align-items:center; gap:12px; padding:10px var(--sp-4); border-bottom:1px solid var(--gray-100); cursor:pointer;">
      <input type="checkbox" data-vid="${v.variant_id}" ${selectedIds.has(v.variant_id) ? 'checked' : ''} />
      <span style="flex:1; min-width:0;">
        <span style="display:block; font-size:var(--text-sm); font-weight:500;">${v.product_name}</span>
        <span class="mono" style="font-size:var(--text-xs); color:var(--gray-700);">
          ${v.sku}${[v.color, v.size].filter(Boolean).length ? ' · ' + [v.color, v.size].filter(Boolean).join('/') : ''}
        </span>
      </span>
      <span class="mono" style="font-size:var(--text-sm); color:var(--gray-700);">${v.on_hand}</span>
    </label>
  `).join('');

  listMount.querySelectorAll('input[data-vid]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(cb.dataset.vid);
      else selectedIds.delete(cb.dataset.vid);
      document.getElementById('pick-count').textContent = `${selectedIds.size} избрани от ${pickerVariants.length}`;
    });
  });
}

async function startCount() {
  const errBox = document.getElementById('form-error');
  errBox.textContent = '';
  const warehouseId = document.getElementById('wh-select').value;
  const scope = document.getElementById('scope-select').value;

  if (!warehouseId) { errBox.textContent = 'Избери склад.'; return; }
  if (scope === 'pick' && selectedIds.size === 0) {
    errBox.textContent = 'Избери поне един продукт, или превключи на "Всички продукти".';
    return;
  }

  const { data, error } = await supabase.rpc('start_inventory_count', {
    p_company_id: companyId,
    p_warehouse_id: warehouseId,
    p_operator_id: operatorId,
    p_variant_ids: scope === 'pick' ? Array.from(selectedIds) : null,
  });

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
  window.location.href = `./counts.html?id=${data}`;
}

async function loadCountsList() {
  const { data, error } = await supabase
    .from('inventory_counts')
    .select('id, status, created_at, approved_at, warehouses(name), app_users!inventory_counts_operator_id_fkey(full_name)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  const mount = document.getElementById('table-mount');
  if (error) { mount.innerHTML = `<div class="empty-state">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div class="empty-state">Няма инвентаризации.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Склад</th><th>Начало</th><th>Оператор</th><th>Статус</th><th>Действия</th></tr></thead>
      <tbody>
        ${data.map(c => `
          <tr>
            <td>${c.warehouses.name}</td>
            <td class="mono">${new Date(c.created_at).toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>${c.app_users?.full_name || '—'}</td>
            <td>${STATUS_LABEL[c.status] || c.status}</td>
            <td><div class="action-row"><a class="btn sm" href="./counts.html?id=${c.id}">Отвори</a></div></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

async function renderDetail(content, countId) {
  const { data: count, error: countErr } = await supabase
    .from('inventory_counts')
    .select('id, status, created_at, warehouses(name)')
    .eq('id', countId)
    .single();

  if (countErr) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Грешка</div><div style="padding:20px;">${countErr.message}</div></div>`;
    return;
  }

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Инвентаризация — ${count.warehouses.name}</h1><div class="sub">Статус: ${STATUS_LABEL[count.status] || count.status}</div></div>
      <a class="btn" href="./counts.html" style="text-decoration:none;">← Към списъка</a>
    </div>

    <div class="panel">
      <div class="panel__header">
        <span>Артикули за преброяване</span>
        ${count.status !== 'approved' && count.status !== 'cancelled' ? `<button class="btn accent" id="approve-btn">Одобри и коригирай наличността</button>` : ''}
      </div>
      <div id="items-mount"></div>
      <div id="approve-error" style="padding:0 16px 16px; color:var(--bad); font-size:12.5px;"></div>
    </div>
  `;

  await loadItems(countId, count.status);

  if (count.status !== 'approved' && count.status !== 'cancelled') {
    document.getElementById('approve-btn').addEventListener('click', async () => {
      if (!confirm('Одобряването ще коригира реалната наличност спрямо преброените количества. Продължи ли?')) return;
      const errBox = document.getElementById('approve-error');
      const { error } = await supabase.rpc('approve_inventory_count', {
        p_company_id: companyId, p_count_id: countId, p_operator_id: operatorId,
      });
      if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
      await renderDetail(content, countId);
    });
  }
}

async function loadItems(countId, status) {
  const mount = document.getElementById('items-mount');
  const editable = status !== 'approved' && status !== 'cancelled';

  const { data, error } = await supabase
    .from('v_inventory_count_items_detail')
    .select('id, product_name, sku, expected_qty, counted_qty, difference')
    .eq('count_id', countId)
    .order('product_name');

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма артикули (складът е бил празен при стартиране).</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Продукт</th><th>SKU</th><th>Очаквано</th><th>Преброено</th><th>Разлика</th></tr></thead>
      <tbody>
        ${data.map(i => `
          <tr>
            <td>${i.product_name}</td>
            <td class="mono">${i.sku}</td>
            <td class="mono">${i.expected_qty}</td>
            <td>
              ${editable
                ? `<input type="number" step="1" value="${i.counted_qty ?? ''}" data-id="${i.id}" style="width:90px; border:1px solid var(--gray-300); border-radius:3px; padding:4px;" />`
                : `<span class="mono">${i.counted_qty ?? '—'}</span>`}
            </td>
            <td class="mono" style="color:${i.difference > 0 ? 'var(--good)' : (i.difference < 0 ? 'var(--bad)' : 'inherit')};">
              ${i.difference !== null ? (i.difference > 0 ? '+' : '') + i.difference : '—'}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  if (editable) {
    mount.querySelectorAll('input[data-id]').forEach(inp => {
      inp.addEventListener('change', async () => {
        const val = inp.value === '' ? null : Number(inp.value);
        const { error } = await supabase.from('inventory_count_items').update({ counted_qty: val }).eq('id', inp.dataset.id);
        if (error) { alert('Грешка: ' + error.message); return; }
        await loadItems(countId, status);
      });
    });
  }
}

main();
