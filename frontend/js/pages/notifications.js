import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const TYPE_LABEL = { low_stock: 'Ниска наличност', overdue_payment: 'Просрочено плащане', new_order: 'Нова поръчка', count_pending_approval: 'Чака одобрение' };
let companyId = null;

async function main() {
  const shell = await renderShell('notifications');
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
      <div><h1>Известия</h1><div class="sub">Автоматични сигнали от системата</div></div>
      <button class="btn" id="mark-all-btn">Маркирай всички като прочетени</button>
    </div>
    <div class="panel">
      <div class="panel__header">Всички известия</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('mark-all-btn').addEventListener('click', markAllRead);
  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, title, body, is_read, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма известия.</div>`; return; }

  mount.innerHTML = data.map(n => `
    <div style="display:flex; gap:12px; padding:14px 16px; border-bottom:1px solid var(--gray-50); ${n.is_read ? 'opacity:0.55;' : ''}">
      <span class="stock-dot ${n.is_read ? 'normal' : 'critical'}" style="margin-top:6px;"></span>
      <div style="flex:1;">
        <div style="font-weight:${n.is_read ? '400' : '600'}; font-size:13.5px;">${n.title}</div>
        ${n.body ? `<div style="font-size:12.5px; color:var(--gray-700); margin-top:2px;">${n.body}</div>` : ''}
        <div class="mono" style="font-size:11px; color:var(--gray-700); margin-top:4px;">${TYPE_LABEL[n.type] || n.type} · ${new Date(n.created_at).toLocaleString('bg-BG')}</div>
      </div>
      ${!n.is_read ? `<button class="btn sm" data-read="${n.id}">Прочетено</button>` : ''}
    </div>
  `).join('');

  mount.querySelectorAll('[data-read]').forEach(b => b.addEventListener('click', () => markRead(b.dataset.read)));
}

async function markRead(id) {
  await supabase.from('notifications').update({ is_read: true }).eq('id', id);
  await load();
}

async function markAllRead() {
  await supabase.from('notifications').update({ is_read: true }).eq('company_id', companyId).eq('is_read', false);
  await load();
}

main();
