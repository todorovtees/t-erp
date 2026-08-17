import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';
import { printDocument } from '../lib/print.js';

const REASON_LABEL = { damaged: 'Повредена стока', expired: 'Изтекъл срок', lost: 'Липса', internal_use: 'За вътрешна употреба', other: 'Друго' };
let companyId = null;
let operatorId = null;
let warehouses = [];
let lines = [];

async function main() {
  const shell = await renderShell('write-offs');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;
  operatorId = shell.session.user.id;

  const { data: whs } = await supabase.from('warehouses').select('id, name').eq('company_id', companyId).order('name');
  warehouses = whs || [];

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Брак / Изписване</h1><div class="sub">Изваждане на стока от наличност с посочена причина</div></div>
      <button class="btn accent" id="new-btn">+ Нов документ</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нов документ за брак</div>
      <div style="padding:16px;">
        <div class="form-grid-2" style="padding:0; margin-bottom:14px;">
          <div class="field"><label>Склад *</label>
            <select id="wh-select">${warehouses.map(w => `<option value="${w.id}">${w.name}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Причина *</label>
            <select id="reason-select">${Object.entries(REASON_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          </div>
        </div>
        <div class="field"><label>Бележка</label><input id="note-input" placeholder="По желание" /></div>

        <div class="field"><label>Търси продукт по SKU или име</label>
          <input id="product-search" placeholder="TT-CORE-BLK-M…" />
        </div>
        <div id="search-results" style="max-height:160px; overflow-y:auto; margin:8px 0;"></div>

        <table class="data" style="margin-top:10px;">
          <thead><tr><th>Продукт</th><th>Количество</th><th></th></tr></thead>
          <tbody id="lines-mount"></tbody>
        </table>

        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:14px;">
          <button class="btn primary" id="submit-btn" disabled>Запиши брак</button>
          <button class="btn" id="cancel-btn">Отказ</button>
        </div>
        <div id="form-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__header">Списък документи</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => { document.getElementById('new-panel').style.display = 'none'; lines = []; renderLines(); });
  document.getElementById('product-search').addEventListener('input', (e) => searchProducts(e.target.value));
  document.getElementById('submit-btn').addEventListener('click', submitWriteOff);

  await load();
}

async function searchProducts(term) {
  const mount = document.getElementById('search-results');
  if (!term) { mount.innerHTML = ''; return; }

  const { data, error } = await supabase
    .from('product_variants')
    .select('id, sku, color, size, products!inner(id, name, company_id)')
    .eq('products.company_id', companyId)
    .ilike('sku', `%${term}%`)
    .limit(15);

  if (error) { mount.innerHTML = `<div style="font-size:12px; color:var(--bad);">${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="font-size:12px; color:var(--gray-700); padding:6px;">Няма съвпадения.</div>`; return; }

  mount.innerHTML = data.map(v => `
    <div class="nav-link" style="border:1px solid var(--gray-100); color:var(--ink); margin-bottom:4px; cursor:pointer;" data-id="${v.id}">
      ${v.products.name} — <span class="mono">${v.sku}</span> ${[v.color, v.size].filter(Boolean).join('/')}
    </div>
  `).join('');

  mount.querySelectorAll('[data-id]').forEach(row => {
    row.addEventListener('click', () => {
      const v = data.find(x => x.id === row.dataset.id);
      addLine(v);
      document.getElementById('product-search').value = '';
      mount.innerHTML = '';
    });
  });
}

function addLine(v) {
  const existing = lines.find(l => l.variant_id === v.id);
  if (existing) { existing.quantity += 1; }
  else { lines.push({ variant_id: v.id, name: v.products.name, meta: [v.color, v.size].filter(Boolean).join('/') || v.sku, quantity: 1 }); }
  renderLines();
}

function renderLines() {
  const mount = document.getElementById('lines-mount');
  mount.innerHTML = lines.map((l, i) => `
    <tr>
      <td>${l.name}<br><span class="mono" style="font-size:11px; color:var(--gray-700);">${l.meta}</span></td>
      <td><input type="number" min="1" step="1" value="${l.quantity}" data-i="${i}" style="width:80px; border:1px solid var(--gray-300); border-radius:3px; padding:4px;" /></td>
      <td><button class="btn" data-remove="${i}" style="padding:4px 8px;">✕</button></td>
    </tr>
  `).join('');

  mount.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => { lines[Number(inp.dataset.i)].quantity = Number(inp.value); }));
  mount.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => { lines.splice(Number(btn.dataset.remove), 1); renderLines(); }));

  document.getElementById('submit-btn').disabled = lines.length === 0;
}

async function submitWriteOff() {
  const errBox = document.getElementById('form-error');
  errBox.textContent = '';

  const { error } = await supabase.rpc('create_write_off', {
    p_company_id: companyId,
    p_warehouse_id: document.getElementById('wh-select').value,
    p_operator_id: operatorId,
    p_document_no: 'WO-' + Date.now(),
    p_reason: document.getElementById('reason-select').value,
    p_note: document.getElementById('note-input').value || null,
    p_items: lines.map(l => ({ variant_id: l.variant_id, quantity: l.quantity })),
  });

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }

  lines = [];
  renderLines();
  document.getElementById('new-panel').style.display = 'none';
  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const { data, error } = await supabase
    .from('v_write_offs_list')
    .select('id, document_no, reason, note, created_at, warehouse_name, operator_name, item_count')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма документи за брак.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Документ</th><th>Дата</th><th>Склад</th><th>Причина</th><th>Оператор</th><th>Артикули</th><th></th></tr></thead>
      <tbody>
        ${data.map(w => `
          <tr>
            <td class="mono">${w.document_no}</td>
            <td class="mono">${new Date(w.created_at).toLocaleDateString('bg-BG')}</td>
            <td>${w.warehouse_name}</td>
            <td>${REASON_LABEL[w.reason] || w.reason}</td>
            <td>${w.operator_name || '—'}</td>
            <td class="mono">${w.item_count}</td>
            <td><button class="btn sm" data-print="${w.id}">Печат</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => printWriteOff(b.dataset.print, data)));
}

async function printWriteOff(id, rows) {
  const w = rows.find(r => r.id === id);
  const { data: items } = await supabase
    .from('write_off_items')
    .select('quantity, product_variants(sku, color, size, products(name))')
    .eq('write_off_id', id);

  printDocument({
    documentTitle: `Брак ${w.document_no}`,
    subtitle: REASON_LABEL[w.reason] || w.reason,
    meta: [
      { label: 'Дата', value: new Date(w.created_at).toLocaleDateString('bg-BG') },
      { label: 'Склад', value: w.warehouse_name },
      { label: 'Оператор', value: w.operator_name || '—' },
    ],
    columns: [{ key: 'name', label: 'Продукт' }, { key: 'sku', label: 'SKU' }, { key: 'qty', label: 'Количество', align: 'right' }],
    rows: (items || []).map(i => ({ name: i.product_variants.products.name, sku: i.product_variants.sku, qty: i.quantity })),
    footerNote: `Отпечатано на ${new Date().toLocaleString('bg-BG')} от T-ERP · Todorov Tees`,
  });
}

main();
