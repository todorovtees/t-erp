import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const eur = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' });
let companyId = null;

function isoDate(d) { return d.toISOString().slice(0, 10); }

async function main() {
  const shell = await renderShell('reports');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;

  const { data: warehouses } = await supabase.from('warehouses').select('id, name').eq('company_id', companyId).order('name');

  const today = new Date();
  const monthAgo = new Date(today); monthAgo.setDate(monthAgo.getDate() - 29);

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Отчети</h1><div class="sub">Продажби по период, склад и категория</div></div>
    </div>

    <div class="panel">
      <div class="panel__header" style="gap:10px;">
        <input id="date-from" type="date" value="${isoDate(monthAgo)}" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;" />
        <input id="date-to" type="date" value="${isoDate(today)}" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;" />
        <select id="wh-filter" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;">
          <option value="">Всички складове</option>
          ${(warehouses || []).map(w => `<option value="${w.id}">${w.name}</option>`).join('')}
        </select>
        <button class="btn primary" id="run-btn">Приложи</button>
      </div>
    </div>

    <div class="kpi-grid" id="kpi-mount"></div>

    <div class="panel">
      <div class="panel__header">Оборот по дни</div>
      <div id="chart-mount" style="padding:16px;"></div>
    </div>

    <div class="panel">
      <div class="panel__header">Оборот по категория</div>
      <div id="category-mount"></div>
    </div>
  `;

  document.getElementById('run-btn').addEventListener('click', runReport);
  await runReport();
}

async function runReport() {
  const from = document.getElementById('date-from').value;
  const to = document.getElementById('date-to').value;
  const warehouseId = document.getElementById('wh-filter').value || null;

  const { data, error } = await supabase.rpc('get_sales_report', {
    p_company_id: companyId, p_date_from: from, p_date_to: to, p_warehouse_id: warehouseId,
  });

  if (error) {
    document.getElementById('kpi-mount').innerHTML = `<div class="kpi-card">Грешка: ${error.message}</div>`;
    return;
  }

  document.getElementById('kpi-mount').innerHTML = `
    <div class="kpi-card"><div class="label">Оборот за периода</div><div class="value mono">${eur.format(data.total_revenue)}</div></div>
    <div class="kpi-card"><div class="label">Брой продажби</div><div class="value mono">${data.order_count}</div></div>
    <div class="kpi-card"><div class="label">Среден бон</div><div class="value mono">${eur.format(data.order_count ? data.total_revenue / data.order_count : 0)}</div></div>
  `;

  const max = Math.max(1, ...data.by_day.map(d => Number(d.total)));
  document.getElementById('chart-mount').innerHTML = `
    <div style="display:flex; gap:3px; align-items:flex-end; overflow-x:auto;">
      ${data.by_day.map(d => {
        const h = Math.round((Number(d.total) / max) * 100);
        const label = new Date(d.day).toLocaleDateString('bg-BG', { day: '2-digit', month: '2-digit' });
        return `<div style="display:flex; flex-direction:column; align-items:center; gap:4px; min-width:22px;">
          <div style="width:100%; height:120px; display:flex; align-items:flex-end;">
            <div title="${label}: ${eur.format(d.total)}" style="width:100%; height:${Math.max(h, 2)}%; background:var(--accent); border-radius:2px 2px 0 0;"></div>
          </div>
          <div class="mono" style="font-size:9px; color:var(--gray-700); writing-mode:vertical-rl;">${label}</div>
        </div>`;
      }).join('')}
    </div>`;

  const catMount = document.getElementById('category-mount');
  if (!data.by_category.length) {
    catMount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма продажби за периода.</div>`;
  } else {
    catMount.innerHTML = `
      <table class="data">
        <thead><tr><th>Категория</th><th>Оборот</th></tr></thead>
        <tbody>${data.by_category.map(c => `<tr><td>${c.category}</td><td class="mono">${eur.format(c.revenue)}</td></tr>`).join('')}</tbody>
      </table>`;
  }
}

main();
