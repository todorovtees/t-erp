import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';
import { printDocument } from '../lib/print.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
const PRESET_CATEGORIES = ['Опаковки', 'Канцеларски материали', 'Печат/Реклама', 'Наем', 'Комунални', 'Транспорт', 'Софтуер/Абонаменти', 'Друго'];

let companyId = null;
let operatorId = null;

function isoDate(d) { return d.toISOString().slice(0, 10); }

async function main() {
  const shell = await renderShell('expenses');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;
  operatorId = shell.session.user.id;

  const { data: suppliers } = await supabase.from('suppliers').select('id, name').eq('company_id', companyId).order('name');

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Разходи</h1><div class="sub">Всички разходи на фирмата — опаковки, консумативи и т.н.</div></div>
      <button class="btn accent" id="new-btn">+ Нов разход</button>
    </div>

    <div class="kpi-grid" id="kpi-mount"></div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нов разход</div>
      <form id="new-form" class="form-grid-3">
        <div class="field"><label>Категория *</label>
          <select name="category" id="category-select">
            ${PRESET_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="grid-column:span 2;"><label>Описание</label><input name="description" placeholder="Кутии 20x20x10, 500 бр." /></div>
        <div class="field"><label>Сума (€) *</label><input name="amount" type="number" step="0.01" min="0" required /></div>
        <div class="field"><label>Дата *</label><input name="expense_date" type="date" value="${isoDate(today)}" required /></div>
        <div class="field"><label>Доставчик</label>
          <select name="supplier_id"><option value="">—</option>
            ${(suppliers || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
          </select>
        </div>
        <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
          <button class="btn primary" type="submit">Запази разход</button>
          <button class="btn" type="button" id="cancel-btn">Отказ</button>
          <span id="form-error" style="color:var(--bad); font-size:12.5px;"></span>
        </div>
      </form>
    </div>

    <div class="panel">
      <div class="panel__header" style="gap:10px;">
        <input id="date-from" type="date" value="${isoDate(monthStart)}" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;" />
        <input id="date-to" type="date" value="${isoDate(today)}" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;" />
        <select id="category-filter" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;">
          <option value="">Всички категории</option>
          ${PRESET_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <div class="topbar__spacer"></div>
        <button class="btn" id="print-btn">🖨 Печат</button>
      </div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'none');
  document.getElementById('new-form').addEventListener('submit', handleCreate);
  document.getElementById('date-from').addEventListener('change', refresh);
  document.getElementById('date-to').addEventListener('change', refresh);
  document.getElementById('category-filter').addEventListener('change', load);
  document.getElementById('print-btn').addEventListener('click', printExpenses);

  await refresh();
}

async function refresh() {
  await Promise.all([loadSummary(), load()]);
}

async function loadSummary() {
  const from = document.getElementById('date-from').value;
  const to = document.getElementById('date-to').value;
  const { data, error } = await supabase.rpc('get_expenses_summary', {
    p_company_id: companyId, p_date_from: from, p_date_to: to,
  });
  const mount = document.getElementById('kpi-mount');
  if (error) { mount.innerHTML = `<div class="kpi-card">Грешка: ${error.message}</div>`; return; }

  const top3 = data.by_category.slice(0, 3);
  mount.innerHTML = `
    <div class="kpi-card"><div class="label">Общо за периода</div><div class="value mono">${eur.format(data.total)}</div></div>
    ${top3.map(c => `<div class="kpi-card"><div class="label">${c.category}</div><div class="value mono">${eur.format(c.total)}</div></div>`).join('')}
  `;
}

let currentRows = [];

async function handleCreate(e) {
  e.preventDefault();
  const errBox = document.getElementById('form-error');
  errBox.textContent = '';
  const fd = new FormData(e.target);

  const { error } = await supabase.from('expenses').insert({
    company_id: companyId,
    category: fd.get('category'),
    description: fd.get('description') || null,
    amount: Number(fd.get('amount')),
    expense_date: fd.get('expense_date'),
    supplier_id: fd.get('supplier_id') || null,
    operator_id: operatorId,
  });

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }

  e.target.reset();
  document.getElementById('new-panel').style.display = 'none';
  await refresh();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const from = document.getElementById('date-from').value;
  const to = document.getElementById('date-to').value;
  const category = document.getElementById('category-filter').value;

  let query = supabase
    .from('expenses')
    .select('id, category, description, amount, expense_date, suppliers(name)')
    .eq('company_id', companyId)
    .gte('expense_date', from)
    .lte('expense_date', to)
    .order('expense_date', { ascending: false });

  if (category) query = query.eq('category', category);

  const { data, error } = await query;
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  currentRows = data;
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма разходи за избрания филтър.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Дата</th><th>Категория</th><th>Описание</th><th>Доставчик</th><th>Сума</th><th></th></tr></thead>
      <tbody>
        ${data.map(e => `
          <tr>
            <td class="mono">${e.expense_date}</td>
            <td>${e.category}</td>
            <td>${e.description || '—'}</td>
            <td>${e.suppliers?.name || '—'}</td>
            <td class="mono">${eur.format(e.amount)}</td>
            <td><button class="btn sm danger" data-delete="${e.id}">Изтрий</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', () => deleteExpense(b.dataset.delete)));
}

async function deleteExpense(id) {
  if (!confirm('Да изтрия ли този разход?')) return;
  const { error } = await supabase.from('expenses').delete().eq('id', id);
  if (error) { alert('Грешка: ' + error.message); return; }
  await refresh();
}

function printExpenses() {
  const from = document.getElementById('date-from').value;
  const to = document.getElementById('date-to').value;
  const total = currentRows.reduce((s, r) => s + Number(r.amount), 0);

  printDocument({
    documentTitle: 'Справка разходи',
    subtitle: `${from} — ${to}`,
    meta: [{ label: 'Генерирано на', value: new Date().toLocaleString('bg-BG') }],
    columns: [
      { key: 'date', label: 'Дата' },
      { key: 'category', label: 'Категория' },
      { key: 'description', label: 'Описание' },
      { key: 'amount', label: 'Сума', align: 'right' },
    ],
    rows: currentRows.map(r => ({
      date: r.expense_date, category: r.category, description: r.description || '—', amount: eur.format(r.amount),
    })),
    totals: [{ label: 'Общо', value: eur.format(total), emphasis: true }],
    footerNote: `Отпечатано на ${new Date().toLocaleString('bg-BG')} от T-ERP · Todorov Tees`,
  });
}

main();
