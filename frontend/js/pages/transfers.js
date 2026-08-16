import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';
import { printDocument } from '../lib/print.js';

const STATUS_LABEL = { draft: 'Чернова', sent: 'Изпратен', received: 'Получен', cancelled: 'Отказан' };
let companyId = null;
let operatorId = null;
let warehouses = [];
let lines = [];

async function main() {
  const shell = await renderShell('transfers');
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
      <div><h1>Складови трансфери</h1><div class="sub">Прехвърляне на стока между складове</div></div>
      <button class="btn accent" id="new-btn">+ Нов трансфер</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нов трансфер</div>
      <div style="padding:16px;">
        <div class="form-grid-2" style="padding:0; margin-bottom:14px;">
          <div class="field"><label>От склад *</label>
            <select id="from-wh">${warehouses.map(w => `<option value="${w.id}">${w.name}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Към склад *</label>
            <select id="to-wh">${warehouses.map(w => `<option value="${w.id}">${w.name}</option>`).join('')}</select>
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
          <button class="btn primary" id="submit-btn" disabled>Създай трансфер (чернова)</button>
          <button class="btn" id="cancel-btn">Отказ</button>
        </div>
        <div id="form-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__header">Списък трансфери</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => { document.getElementById('new-panel').style.display = 'none'; lines = []; renderLines(); });
  document.getElementById('product-search').addEventListener('input', (e) => searchProducts(e.target.value));
  document.getElementById('submit-btn').addEventListener('click', submitTransfer);

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
  else {
    lines.push({ variant_id: v.id, name: v.products.name, meta: [v.color, v.size].filter(Boolean).join('/') || v.sku, quantity: 1 });
  }
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

async function submitTransfer() {
  const errBox = document.getElementById('form-error');
  errBox.textContent = '';
  const fromWh = document.getElementById('from-wh').value;
  const toWh = document.getElementById('to-wh').value;

  if (fromWh === toWh) { errBox.textContent = 'Складовете трябва да са различни.'; return; }

  const { error } = await supabase.rpc('create_transfer', {
    p_company_id: companyId,
    p_from_warehouse_id: fromWh,
    p_to_warehouse_id: toWh,
    p_operator_id: operatorId,
    p_document_no: 'TRF-' + Date.now(),
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
    .from('v_transfers_list')
    .select('id, document_no, status, note, created_at, from_warehouse_name, to_warehouse_name, operator_name, item_count')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма трансфери.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Документ</th><th>Дата</th><th>От</th><th>Към</th><th>Оператор</th><th>Артикули</th><th>Статус</th><th>Действия</th></tr></thead>
      <tbody>
        ${data.map(t => `
          <tr>
            <td class="mono">${t.document_no}</td>
            <td class="mono">${new Date(t.created_at).toLocaleDateString('bg-BG')}</td>
            <td>${t.from_warehouse_name}</td>
            <td>${t.to_warehouse_name}</td>
            <td>${t.operator_name || '—'}</td>
            <td class="mono">${t.item_count}</td>
            <td>${STATUS_LABEL[t.status] || t.status}</td>
            <td>
              <div class="action-row">
                ${t.status === 'draft' ? `<button class="btn sm" data-send="${t.id}">Изпрати</button><button class="btn sm danger" data-cancel="${t.id}">Отказ</button>` : ''}
                ${t.status === 'sent' ? `<button class="btn sm accent" data-receive="${t.id}">Получи</button>` : ''}
                <button class="btn sm" data-print="${t.id}">Печат</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-send]').forEach(b => b.addEventListener('click', () => doAction('send_transfer', b.dataset.send)));
  mount.querySelectorAll('[data-receive]').forEach(b => b.addEventListener('click', () => doAction('receive_transfer', b.dataset.receive)));
  mount.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => doCancel(b.dataset.cancel)));
  mount.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => printTransfer(b.dataset.print, data)));
}

async function doAction(rpcName, transferId) {
  const { error } = await supabase.rpc(rpcName, { p_company_id: companyId, p_transfer_id: transferId, p_operator_id: operatorId });
  if (error) { alert('Грешка: ' + error.message); return; }
  await load();
}

async function doCancel(transferId) {
  if (!confirm('Да отменя ли този трансфер?')) return;
  const { error } = await supabase.rpc('cancel_transfer', { p_company_id: companyId, p_transfer_id: transferId });
  if (error) { alert('Грешка: ' + error.message); return; }
  await load();
}

async function printTransfer(transferId, rows) {
  const t = rows.find(r => r.id === transferId);
  const { data: items } = await supabase
    .from('transfer_items')
    .select('quantity, product_variants(sku, color, size, products(name))')
    .eq('transfer_id', transferId);

  printDocument({
    documentTitle: `Трансфер ${t.document_no}`,
    subtitle: `${t.from_warehouse_name} → ${t.to_warehouse_name}`,
    meta: [
      { label: 'Дата', value: new Date(t.created_at).toLocaleDateString('bg-BG') },
      { label: 'Статус', value: STATUS_LABEL[t.status] || t.status },
      { label: 'Оператор', value: t.operator_name || '—' },
    ],
    columns: [
      { key: 'name', label: 'Продукт' }, { key: 'sku', label: 'SKU' }, { key: 'qty', label: 'Количество', align: 'right' },
    ],
    rows: (items || []).map(i => ({ name: i.product_variants.products.name, sku: i.product_variants.sku, qty: i.quantity })),
    footerNote: `Отпечатано на ${new Date().toLocaleString('bg-BG')} от T-ERP · Todorov Tees`,
  });
}

main();
