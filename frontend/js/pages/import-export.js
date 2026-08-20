/* global Papa */
import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

let companyId = null;
let operatorId = null;
let parsedRows = [];
let importEntity = 'products';

function downloadCsv(filename, rows) {
  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function main() {
  const shell = await renderShell('import-export');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;
  operatorId = shell.session.user.id;

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Импорт / Експорт</h1><div class="sub">CSV обмен на данни</div></div>
    </div>

    <div class="panel">
      <div class="panel__header">Експорт</div>
      <div style="padding:16px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn" data-export="products">Продукти → CSV</button>
        <button class="btn" data-export="customers">Клиенти → CSV</button>
        <button class="btn" data-export="suppliers">Доставчици → CSV</button>
        <button class="btn" data-export="inventory">Наличности → CSV</button>
        <button class="btn" data-export="sales">Продажби → CSV</button>
        <button class="btn" data-export="payments">Плащания → CSV</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel__header">Импорт</div>
      <div style="padding:16px;">
        <div class="field" style="max-width:220px;"><label>Тип данни</label>
          <select id="entity-select">
            <option value="products">Продукти</option>
            <option value="customers">Клиенти</option>
            <option value="suppliers">Доставчици</option>
          </select>
        </div>
        <p style="font-size:12px; color:var(--gray-700);">
          Продукти: колони <code class="mono">sku, name, unit, purchase_price, sale_price, vat_rate, min_stock</code>.
          Клиенти/Доставчици: колони <code class="mono">name, email, phone</code> (клиентите приемат и <code class="mono">company_name, eik, credit_limit</code>).
        </p>
        <input type="file" id="file-input" accept=".csv" />
        <div id="preview-mount" style="margin-top:16px;"></div>
      </div>
    </div>
  `;

  content.querySelectorAll('[data-export]').forEach(btn => btn.addEventListener('click', () => runExport(btn.dataset.export)));
  document.getElementById('entity-select').addEventListener('change', (e) => { importEntity = e.target.value; parsedRows = []; document.getElementById('preview-mount').innerHTML = ''; });
  document.getElementById('file-input').addEventListener('change', handleFile);
}

async function runExport(entity) {
  const queries = {
    products: () => supabase.from('products').select('sku, name, unit, purchase_price, sale_price, vat_rate, min_stock, is_active').eq('company_id', companyId),
    customers: () => supabase.from('customers').select('name, company_name, eik, phone, email, credit_limit').eq('company_id', companyId),
    suppliers: () => supabase.from('suppliers').select('name, eik, phone, email').eq('company_id', companyId),
    inventory: () => supabase.from('v_inventory_detail').select('product_name, sku, warehouse_name, on_hand, available, stock_status').eq('company_id', companyId),
    sales: () => supabase.from('v_sales_list').select('document_no, created_at, customer_name, warehouse_name, status, total').eq('company_id', companyId),
    payments: () => supabase.from('payments').select('ref_table, method, amount, currency, created_at').eq('company_id', companyId),
  };

  const { data, error } = await queries[entity]();
  if (error) { alert('Грешка: ' + error.message); return; }
  if (!data.length) { alert('Няма данни за експорт.'); return; }
  downloadCsv(`t-erp-${entity}-${new Date().toISOString().slice(0, 10)}.csv`, data);
}

function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;

  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete: (results) => { parsedRows = results.data; renderPreview(); },
  });
}

function validateRow(row, entity) {
  if (entity === 'products') {
    if (!row.sku || !row.name) return 'Липсва sku или name';
  } else {
    if (!row.name) return 'Липсва name';
  }
  return null;
}

function renderPreview() {
  const mount = document.getElementById('preview-mount');
  const validated = parsedRows.map((row, i) => ({ row, i, error: validateRow(row, importEntity) }));
  const validCount = validated.filter(v => !v.error).length;

  mount.innerHTML = `
    <div style="margin-bottom:10px; font-size:13px;">
      Прочетени редове: ${parsedRows.length} · Валидни: ${validCount} · С грешки: ${parsedRows.length - validCount}
    </div>
    <div style="max-height:300px; overflow:auto; border:1px solid var(--gray-100); border-radius:4px;">
      <table class="data">
        <thead><tr>${Object.keys(parsedRows[0] || {}).map(k => `<th>${k}</th>`).join('')}<th>Статус</th></tr></thead>
        <tbody>
          ${validated.map(v => `
            <tr style="${v.error ? 'background:#fdf2ee;' : ''}">
              ${Object.values(v.row).map(val => `<td class="mono" style="font-size:11.5px;">${val ?? ''}</td>`).join('')}
              <td style="color:${v.error ? 'var(--bad)' : 'var(--good)'}; font-size:11.5px;">${v.error || 'OK'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <button class="btn primary" id="commit-btn" style="margin-top:12px;" ${validCount ? '' : 'disabled'}>Импортирай ${validCount} валидни реда</button>
    <div id="commit-result" style="margin-top:8px; font-size:13px;"></div>
  `;

  document.getElementById('commit-btn').addEventListener('click', () => commitImport(validated.filter(v => !v.error).map(v => v.row)));
}

async function commitImport(validRows) {
  const resultBox = document.getElementById('commit-result');
  resultBox.textContent = 'Импортиране…';

  if (importEntity === 'products') {
    const { data: batch, error: batchErr } = await supabase.from('import_batches').insert({
      company_id: companyId, entity_type: 'products', filename: document.getElementById('file-input').files[0]?.name, operator_id: operatorId,
    }).select('id').single();
    if (batchErr) { resultBox.textContent = 'Грешка: ' + batchErr.message; return; }

    const { error: rowsErr } = await supabase.from('import_rows').insert(
      validRows.map((row, i) => ({ batch_id: batch.id, row_number: i + 1, raw_data: row }))
    );
    if (rowsErr) { resultBox.textContent = 'Грешка: ' + rowsErr.message; return; }

    const { data: result, error: commitErr } = await supabase.rpc('commit_product_import', {
      p_company_id: companyId, p_batch_id: batch.id, p_operator_id: operatorId,
    });
    if (commitErr) { resultBox.textContent = 'Грешка: ' + commitErr.message; return; }
    resultBox.style.color = 'var(--good)';
    resultBox.textContent = `Готово: ${result[0].inserted_count} добавени, ${result[0].skipped_count} пропуснати.`;
    return;
  }

  // Customers/suppliers: simple direct inserts (single table, already
  // RLS-writable, no staging complexity needed).
  const table = importEntity;
  const rows = validRows.map(r => ({
    company_id: companyId, name: r.name,
    ...(importEntity === 'customers' ? { company_name: r.company_name || null, eik: r.eik || null, credit_limit: Number(r.credit_limit) || 0 } : { eik: r.eik || null }),
    phone: r.phone || null, email: r.email || null,
  }));

  const { error } = await supabase.from(table).insert(rows);
  if (error) { resultBox.textContent = 'Грешка: ' + error.message; return; }
  resultBox.style.color = 'var(--good)';
  resultBox.textContent = `Готово: ${rows.length} импортирани.`;
}

main();
