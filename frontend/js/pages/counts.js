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

async function renderList(content) {
  const { data: warehouses } = await supabase.from('warehouses').select('id, name').eq('company_id', companyId).order('name');

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Инвентаризация</h1><div class="sub">Физическо преброяване на наличности</div></div>
      <button class="btn accent" id="new-btn">+ Нова инвентаризация</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нова инвентаризация</div>
      <div style="padding:16px; display:flex; gap:10px; align-items:flex-end;">
        <div class="field" style="margin:0;"><label>Склад *</label>
          <select id="wh-select">${(warehouses || []).map(w => `<option value="${w.id}">${w.name}</option>`).join('')}</select>
        </div>
        <button class="btn primary" id="start-btn">Започни (всички продукти в склада)</button>
      </div>
      <div id="form-error" style="padding:0 16px 16px; color:var(--bad); font-size:12.5px;"></div>
    </div>

    <div class="panel">
      <div class="panel__header">Списък инвентаризации</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('start-btn').addEventListener('click', async () => {
    const errBox = document.getElementById('form-error');
    const { data, error } = await supabase.rpc('start_inventory_count', {
      p_company_id: companyId, p_warehouse_id: document.getElementById('wh-select').value,
      p_operator_id: operatorId, p_variant_ids: null,
    });
    if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
    window.location.href = `./counts.html?id=${data}`;
  });

  const { data, error } = await supabase
    .from('inventory_counts')
    .select('id, status, created_at, approved_at, warehouses(name), app_users!inventory_counts_operator_id_fkey(full_name)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  const mount = document.getElementById('table-mount');
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма инвентаризации.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Склад</th><th>Начало</th><th>Оператор</th><th>Статус</th><th></th></tr></thead>
      <tbody>
        ${data.map(c => `
          <tr>
            <td>${c.warehouses.name}</td>
            <td class="mono">${new Date(c.created_at).toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>${c.app_users?.full_name || '—'}</td>
            <td>${STATUS_LABEL[c.status] || c.status}</td>
            <td><a class="btn sm" href="./counts.html?id=${c.id}" style="text-decoration:none;">Отвори</a></td>
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
