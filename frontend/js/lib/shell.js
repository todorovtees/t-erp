import { supabase, requireSession } from './supabaseClient.js';

const NAV = [
  { group: 'Общ преглед', items: [
    { href: 'index.html', label: 'Dashboard', key: 'dashboard' },
  ]},
  { group: 'Склад', items: [
    { href: 'products.html', label: 'Продукти', key: 'products' },
    { href: 'inventory.html', label: 'Наличности', key: 'inventory' },
    { href: 'warehouses.html', label: 'Складове', key: 'warehouses' },
    { href: 'transfers.html', label: 'Трансфери', key: 'transfers' },
    { href: 'counts.html', label: 'Инвентаризация', key: 'counts' },
    { href: 'batches.html', label: 'Партиди / Годност', key: 'batches' },
    { href: 'serials.html', label: 'Серийни номера', key: 'serials' },
  ]},
  { group: 'Търговия', items: [
    { href: 'sales.html', label: 'Продажби', key: 'sales' },
    { href: 'pos.html', label: 'POS', key: 'pos', tag: 'F10' },
    { href: 'purchases.html', label: 'Покупки', key: 'purchases' },
    { href: 'price-lists.html', label: 'Ценови листи', key: 'price-lists' },
  ]},
  { group: 'Контакти', items: [
    { href: 'customers.html', label: 'Клиенти', key: 'customers' },
    { href: 'suppliers.html', label: 'Доставчици', key: 'suppliers' },
  ]},
  { group: 'Финанси', items: [
    { href: 'payments.html', label: 'Плащания', key: 'payments' },
    { href: 'cash.html', label: 'Каси', key: 'cash' },
    { href: 'expenses.html', label: 'Разходи', key: 'expenses' },
  ]},
  { group: 'Документация', items: [
    { href: 'documents.html', label: 'Документи', key: 'documents' },
  ]},
  { group: 'Система', items: [
    { href: 'reports.html', label: 'Отчети', key: 'reports' },
    { href: 'users.html', label: 'Потребители', key: 'users' },
    { href: 'settings.html', label: 'Настройки', key: 'settings' },
  ]},
];

/** Renders sidebar + topbar into #app-shell and returns the #app-content
 *  element to render page-specific markup into. Redirects to login if the
 *  user has no active session. */
export async function renderShell(activeKey) {
  const session = await requireSession();
  if (!session) return null;

  const { data: profile } = await supabase
    .from('app_users')
    .select('full_name, role, company_id')
    .eq('id', session.user.id)
    .single();

  const initials = (profile?.full_name || session.user.email || '?')
    .split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

  const navHtml = NAV.map(group => `
    <div class="nav-group">
      <div class="nav-group__label">${group.group}</div>
      ${group.items.map(item => `
        <a class="nav-link ${item.key === activeKey ? 'active' : ''}" href="${item.href}">
          <span>${item.label}</span>
          ${item.tag ? `<span class="tag">${item.tag}</span>` : ''}
        </a>
      `).join('')}
    </div>
  `).join('');

  document.getElementById('app-shell').innerHTML = `
    <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar__brand">
        <span class="mark">T-ERP</span>
        <span class="name">Todorov Tees</span>
      </div>
      ${navHtml}
    </aside>
    <div>
      <div class="topbar">
        <button class="hamburger-btn" id="hamburger-btn" aria-label="Меню">
          <span class="bars"><i></i><i></i><i></i></span>
        </button>
        <div class="topbar__search">
          <span>Търсене — SKU, баркод, клиент, поръчка…</span>
          <kbd>F2</kbd>
        </div>
        <div class="topbar__spacer"></div>
        <div class="topbar__user">
          <span>${profile?.full_name || session.user.email}</span>
          <span class="avatar">${initials}</span>
        </div>
        <button class="btn" id="logout-btn">Изход</button>
      </div>
      <main class="content" id="app-content"></main>
    </div>
  `;

  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const openSidebar = () => { sidebar.classList.add('open'); backdrop.classList.add('open'); };
  const closeSidebar = () => { sidebar.classList.remove('open'); backdrop.classList.remove('open'); };
  document.getElementById('hamburger-btn').addEventListener('click', openSidebar);
  backdrop.addEventListener('click', closeSidebar);
  sidebar.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', closeSidebar));

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = './login.html';
  });

  return {
    content: document.getElementById('app-content'),
    session,
    profile,
  };
}
