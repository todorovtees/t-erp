import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
let companyId = null;
let operatorId = null;
let warehouses = [];

async function main() {
  const shell = await renderShell('cash');
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
      <div><h1>Каси</h1><div class="sub">Касови апарати и смени</div></div>
      <button class="btn accent" id="new-btn">+ Нова каса</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нова каса</div>
      <form id="new-form" class="form-grid-2">
        <div class="field"><label>Име *</label><input name="name" required placeholder="Каса 1 — Store Sofia" /></div>
        <div class="field"><label>Склад</label>
          <select name="warehouse_id"><option value="">—</option>
            ${warehouses.map(w => `<option value="${w.id}">${w.name}</option>`).join('')}
          </select>
        </div>
        <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
          <button class="btn primary" type="submit">Запази каса</button>
          <button class="btn" type="button" id="cancel-btn">Отказ</button>
          <span id="form-error" style="color:var(--bad); font-size:12.5px;"></span>
        </div>
      </form>
    </div>

    <div class="panel">
      <div class="panel__header">Списък каси</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'none');
  document.getElementById('new-form').addEventListener('submit', handleCreate);

  await load();
}

async function handleCreate(e) {
  e.preventDefault();
  const errBox = document.getElementById('form-error');
  errBox.textContent = '';
  const fd = new FormData(e.target);

  const { error } = await supabase.from('cash_registers').insert({
    company_id: companyId,
    name: fd.get('name').trim(),
    warehouse_id: fd.get('warehouse_id') || null,
  });

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
  e.target.reset();
  document.getElementById('new-panel').style.display = 'none';
  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const { data: registers, error } = await supabase
    .from('cash_registers')
    .select('id, name, warehouses(name)')
    .eq('company_id', companyId)
    .order('name');

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!registers.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма каси.</div>`; return; }

  const { data: openSessions } = await supabase
    .from('cash_sessions')
    .select('id, cash_register_id, opening_balance, opened_at')
    .is('closed_at', null)
    .in('cash_register_id', registers.map(r => r.id));

  const sessionByRegister = Object.fromEntries((openSessions || []).map(s => [s.cash_register_id, s]));

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Каса</th><th>Склад</th><th>Статус</th><th>Отворена от</th><th>Начална наличност</th><th></th></tr></thead>
      <tbody>
        ${registers.map(r => {
          const session = sessionByRegister[r.id];
          return `
            <tr>
              <td>${r.name}</td>
              <td>${r.warehouses?.name || '—'}</td>
              <td>${session ? '<span class="stock-dot normal"></span>Отворена' : '<span class="stock-dot out"></span>Затворена'}</td>
              <td class="mono">${session ? new Date(session.opened_at).toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
              <td class="mono">${session ? eur.format(session.opening_balance) : '—'}</td>
              <td>${session
                ? `<button class="btn" data-close="${session.id}">Затвори</button>`
                : `<button class="btn accent" data-open="${r.id}">Отвори</button>`}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-open]').forEach(btn => btn.addEventListener('click', () => openSession(btn.dataset.open)));
  mount.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => closeSession(btn.dataset.close)));
}

async function openSession(registerId) {
  const input = prompt('Начална наличност в касата (€):', '0');
  if (input === null) return;
  const opening = Number(input);
  if (Number.isNaN(opening)) { alert('Невалидна сума.'); return; }

  const { error } = await supabase.from('cash_sessions').insert({
    cash_register_id: registerId, operator_id: operatorId, opening_balance: opening,
  });
  if (error) { alert('Грешка: ' + error.message); return; }
  await load();
}

async function closeSession(sessionId) {
  const input = prompt('Реално преброена сума в касата (€):', '0');
  if (input === null) return;
  const closing = Number(input);
  if (Number.isNaN(closing)) { alert('Невалидна сума.'); return; }

  const { error } = await supabase.from('cash_sessions')
    .update({ closing_balance_actual: closing, closed_at: new Date().toISOString() })
    .eq('id', sessionId);
  if (error) { alert('Грешка: ' + error.message); return; }
  await load();
}

main();
