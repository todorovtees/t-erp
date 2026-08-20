import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const ROLES = ['admin', 'manager', 'warehouse_operator', 'sales_operator', 'cashier', 'accountant', 'read_only'];
let companyId = null;
let operatorId = null;

async function main() {
  const shell = await renderShell('admin-queue');
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
      <div><h1>Автоматизация</h1><div class="sub">Планирани отчети и покани за потребители</div></div>
    </div>

    <div class="panel" style="border-left:3px solid var(--accent);">
      <div style="padding:14px 16px; font-size:12.5px; color:var(--gray-700);">
        <strong>Важно:</strong> редовете по-долу се записват веднага, но реалното изпращане на имейл
        изисква deploy-нати Supabase Edge Functions (<code class="mono">send-scheduled-reports</code>,
        <code class="mono">process-user-invites</code> — виж <code class="mono">supabase/functions/</code> и README).
        Без deploy на функциите, заявките просто чакат тук.
      </div>
    </div>

    <div class="panel">
      <div class="panel__header">
        <span>Планирани отчети</span>
        <button class="btn accent sm" id="new-report-btn">+ Нов график</button>
      </div>
      <div id="report-form-mount" style="display:none; padding:16px;"></div>
      <div id="reports-table-mount"></div>
    </div>

    <div class="panel">
      <div class="panel__header">
        <span>Покани за потребители</span>
        <button class="btn accent sm" id="new-invite-btn">+ Покани потребител</button>
      </div>
      <div id="invite-form-mount" style="display:none; padding:16px;"></div>
      <div id="invites-table-mount"></div>
    </div>
  `;

  document.getElementById('new-report-btn').addEventListener('click', () => {
    const mount = document.getElementById('report-form-mount');
    mount.style.display = 'block';
    mount.innerHTML = `
      <div class="form-grid-2" style="padding:0;">
        <div class="field"><label>Тип отчет</label>
          <select id="report-type"><option value="sales_summary">Продажби</option><option value="low_stock">Ниска наличност</option><option value="expenses_summary">Разходи</option></select>
        </div>
        <div class="field"><label>Честота</label>
          <select id="report-cadence"><option value="daily">Дневно</option><option value="weekly">Седмично</option><option value="monthly">Месечно</option></select>
        </div>
        <div class="field"><label>Имейл получател</label><input id="report-email" type="email" required /></div>
      </div>
      <button class="btn primary" id="save-report-btn">Запази график</button>
      <div id="report-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
    `;
    document.getElementById('save-report-btn').addEventListener('click', async () => {
      const errBox = document.getElementById('report-error');
      const email = document.getElementById('report-email').value.trim();
      if (!email) { errBox.textContent = 'Въведи имейл.'; return; }
      const { error } = await supabase.from('scheduled_reports').insert({
        company_id: companyId, report_type: document.getElementById('report-type').value,
        cadence: document.getElementById('report-cadence').value, recipient_email: email, created_by: operatorId,
      });
      if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
      mount.style.display = 'none';
      await loadReports();
    });
  });

  document.getElementById('new-invite-btn').addEventListener('click', () => {
    const mount = document.getElementById('invite-form-mount');
    mount.style.display = 'block';
    mount.innerHTML = `
      <div class="form-grid-3" style="padding:0;">
        <div class="field"><label>Имейл *</label><input id="invite-email" type="email" required /></div>
        <div class="field"><label>Име *</label><input id="invite-name" required /></div>
        <div class="field"><label>Роля</label><select id="invite-role">${ROLES.map(r => `<option value="${r}">${r}</option>`).join('')}</select></div>
      </div>
      <button class="btn primary" id="save-invite-btn">Изпрати заявка за покана</button>
      <div id="invite-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
    `;
    document.getElementById('save-invite-btn').addEventListener('click', async () => {
      const errBox = document.getElementById('invite-error');
      const email = document.getElementById('invite-email').value.trim();
      const name = document.getElementById('invite-name').value.trim();
      if (!email || !name) { errBox.textContent = 'Попълни имейл и име.'; return; }
      const { error } = await supabase.from('user_invites').insert({
        company_id: companyId, email, full_name: name, role: document.getElementById('invite-role').value, requested_by: operatorId,
      });
      if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
      mount.style.display = 'none';
      await loadInvites();
    });
  });

  await Promise.all([loadReports(), loadInvites()]);
}

async function loadReports() {
  const mount = document.getElementById('reports-table-mount');
  const { data, error } = await supabase.from('scheduled_reports').select('id, report_type, cadence, recipient_email, is_active, last_sent_at').eq('company_id', companyId).order('created_at', { ascending: false });
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма планирани отчети.</div>`; return; }
  mount.innerHTML = `<table class="data"><thead><tr><th>Тип</th><th>Честота</th><th>Получател</th><th>Последно изпратен</th><th>Статус</th></tr></thead><tbody>
    ${data.map(r => `<tr><td>${r.report_type}</td><td>${r.cadence}</td><td class="mono">${r.recipient_email}</td><td class="mono">${r.last_sent_at ? new Date(r.last_sent_at).toLocaleString('bg-BG') : 'Никога (чака функция)'}</td><td>${r.is_active ? 'Активен' : 'Спрян'}</td></tr>`).join('')}
    </tbody></table>`;
}

async function loadInvites() {
  const mount = document.getElementById('invites-table-mount');
  const { data, error } = await supabase.from('user_invites').select('id, email, full_name, role, status, error_message, created_at').eq('company_id', companyId).order('created_at', { ascending: false });
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма заявки за покани.</div>`; return; }
  mount.innerHTML = `<table class="data"><thead><tr><th>Имейл</th><th>Име</th><th>Роля</th><th>Статус</th><th>Дата</th></tr></thead><tbody>
    ${data.map(i => `<tr><td class="mono">${i.email}</td><td>${i.full_name}</td><td>${i.role}</td><td>${i.status}${i.error_message ? ' — ' + i.error_message : ''}</td><td class="mono">${new Date(i.created_at).toLocaleDateString('bg-BG')}</td></tr>`).join('')}
    </tbody></table>`;
}

main();
