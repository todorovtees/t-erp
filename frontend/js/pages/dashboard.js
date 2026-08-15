import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const bgn = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'BGN' });
const fmt = (n) => bgn.format(Number(n || 0));

async function main() {
  const shell = await renderShell('dashboard');
  if (!shell) return; // redirected to login
  const { content, profile } = shell;

  if (!profile) {
    content.innerHTML = `
      <div class="panel">
        <div class="panel__header">Профилът не е свързан</div>
        <div style="padding:20px;">
          Влязохте успешно, но за този акаунт все още няма запис в <code class="mono">app_users</code>
          (таблицата, която свързва login-а с компания и роля). Виж README → "Първи потребител"
          за едноредовия SQL, който трябва да изпълниш веднъж в Supabase SQL editor-а.
        </div>
      </div>`;
    return;
  }

  content.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Dashboard</h1>
        <div class="sub">Todorov Tees · ${new Date().toLocaleDateString('bg-BG', { day: '2-digit', month: 'long', year: 'numeric' })}</div>
      </div>
    </div>
    <div id="kpi-mount" class="kpi-grid"></div>
    <div class="panel">
      <div class="panel__header">Продажби — последните 14 дни</div>
      <div id="chart-mount" style="padding:16px;"></div>
    </div>
    <div style="display:grid; grid-template-columns:1.3fr 1fr; gap:20px; align-items:start;">
      <div class="panel">
        <div class="panel__header">Критично ниски наличности</div>
        <div id="low-stock-mount"></div>
      </div>
      <div class="panel">
        <div class="panel__header">Топ продукти — този месец</div>
        <div id="top-products-mount"></div>
      </div>
    </div>
  `;

  const { data: kpis, error } = await supabase.rpc('get_dashboard_kpis', { p_company_id: profile.company_id });

  if (error) {
    document.getElementById('kpi-mount').innerHTML =
      `<div class="kpi-card">Грешка при зареждане на KPI: ${error.message}</div>`;
    return;
  }

  renderKpis(kpis);
  renderChart(kpis.sales_by_day);
  renderTopProducts(kpis.top_products_month);
  await renderLowStock(profile.company_id);
}

function renderKpis(k) {
  const cards = [
    { label: 'Оборот днес', value: fmt(k.revenue_today) },
    { label: 'Оборот този месец', value: fmt(k.revenue_month) },
    { label: 'Поръчки днес', value: k.orders_today },
    { label: 'Покупки този месец', value: fmt(k.purchases_month) },
    { label: 'Ниска наличност', value: k.low_stock_count, alert: k.low_stock_count > 0 },
  ];
  document.getElementById('kpi-mount').innerHTML = cards.map(c => `
    <div class="kpi-card ${c.alert ? 'alert' : ''}">
      <div class="label">${c.label}</div>
      <div class="value mono">${c.value}</div>
    </div>
  `).join('');
}

function renderChart(days) {
  const max = Math.max(1, ...days.map(d => Number(d.total)));
  const bars = days.map(d => {
    const h = Math.round((Number(d.total) / max) * 100);
    const label = new Date(d.day).toLocaleDateString('bg-BG', { day: '2-digit', month: '2-digit' });
    return `
      <div style="display:flex; flex-direction:column; align-items:center; gap:6px; flex:1;">
        <div style="width:100%; height:110px; display:flex; align-items:flex-end;">
          <div title="${fmt(d.total)}" style="width:100%; height:${Math.max(h, 2)}%; background:var(--accent); border-radius:2px 2px 0 0;"></div>
        </div>
        <div class="mono" style="font-size:10px; color:var(--gray-700);">${label}</div>
      </div>`;
  }).join('');
  document.getElementById('chart-mount').innerHTML =
    `<div style="display:flex; gap:6px; align-items:flex-end;">${bars}</div>`;
}

function renderTopProducts(products) {
  const mount = document.getElementById('top-products-mount');
  if (!products.length) {
    mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Все още няма продажби този месец.</div>`;
    return;
  }
  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Продукт</th><th>Бр.</th><th>Оборот</th></tr></thead>
      <tbody>
        ${products.map(p => `
          <tr><td>${p.name}</td><td class="mono">${p.qty}</td><td class="mono">${fmt(p.revenue)}</td></tr>
        `).join('')}
      </tbody>
    </table>`;
}

async function renderLowStock(companyId) {
  const mount = document.getElementById('low-stock-mount');
  const { data, error } = await supabase
    .from('v_inventory_detail')
    .select('product_name, sku, warehouse_name, on_hand, min_stock, stock_status')
    .eq('company_id', companyId)
    .neq('stock_status', 'normal')
    .order('on_hand', { ascending: true })
    .limit(8);

  if (error) {
    mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`;
    return;
  }
  if (!data.length) {
    mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Всички наличности са над минимума. ✓</div>`;
    return;
  }
  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Продукт / SKU</th><th>Склад</th><th>Наличност</th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${r.product_name}<br><span class="mono" style="color:var(--gray-700); font-size:11px;">${r.sku}</span></td>
            <td>${r.warehouse_name}</td>
            <td class="mono"><span class="stock-dot ${r.stock_status}"></span>${r.on_hand} / min ${r.min_stock}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
