import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const ROLES = ['super_admin', 'admin', 'manager', 'warehouse_operator', 'sales_operator', 'cashier', 'accountant', 'read_only'];
const ROLE_LABEL = {
  super_admin: 'Super Admin', admin: 'Admin', manager: 'Manager', warehouse_operator: 'Warehouse Operator',
  sales_operator: 'Sales Operator', cashier: 'Cashier', accountant: 'Accountant', read_only: 'Read Only',
};

let companyId = null;

async function main() {
  const shell = await renderShell('users');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Потребители</h1><div class="sub">Роли и достъп на екипа</div></div>
    </div>

    <div class="panel">
      <div class="panel__header">Добавяне на нов потребител</div>
      <div style="padding:16px; font-size:13px; color:var(--gray-700);">
        Нови логин акаунти се създават през Supabase Dashboard → Authentication → Add user
        (изисква администраторски достъп до Supabase, не само до T-ERP). След това вържи новия
        акаунт с фирмата тук — виж README → "Първи потребител" за точния SQL.
      </div>
    </div>

    <div class="panel">
      <div class="panel__header">Екип</div>
      <div id="table-mount"></div>
    </div>
  `;

  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const { data, error } = await supabase
    .from('app_users')
    .select('id, full_name, username, role, status')
    .eq('company_id', companyId)
    .order('full_name');

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма потребители.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Име</th><th>Потребителско име</th><th>Роля</th><th>Статус</th></tr></thead>
      <tbody>
        ${data.map(u => `
          <tr>
            <td>${u.full_name}</td>
            <td class="mono">${u.username}</td>
            <td>
              <select data-role="${u.id}" style="border:1px solid var(--gray-300); border-radius:4px; padding:5px 8px; font-size:12.5px;">
                ${ROLES.map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
              </select>
            </td>
            <td>
              <select data-status="${u.id}" style="border:1px solid var(--gray-300); border-radius:4px; padding:5px 8px; font-size:12.5px;">
                <option value="active" ${u.status === 'active' ? 'selected' : ''}>Активен</option>
                <option value="disabled" ${u.status === 'disabled' ? 'selected' : ''}>Спрян</option>
              </select>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div id="update-error" style="padding:0 16px 16px; color:var(--bad); font-size:12.5px;"></div>
  `;

  mount.querySelectorAll('[data-role]').forEach(sel => {
    sel.addEventListener('change', () => updateField(sel.dataset.role, 'role', sel.value));
  });
  mount.querySelectorAll('[data-status]').forEach(sel => {
    sel.addEventListener('change', () => updateField(sel.dataset.status, 'status', sel.value));
  });
}

async function updateField(userId, field, value) {
  const errBox = document.getElementById('update-error');
  errBox.textContent = '';
  const { error } = await supabase.from('app_users').update({ [field]: value }).eq('id', userId);
  if (error) {
    errBox.textContent = `Промяната не бе запазена (нужни са пълни права над "Потребители"): ${error.message}`;
    await load();
  }
}

main();
