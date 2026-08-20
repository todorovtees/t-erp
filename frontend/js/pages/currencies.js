import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

let companyId = null;
let baseCurrency = 'EUR';

async function main() {
  const shell = await renderShell('currencies');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }
  companyId = profile.company_id;

  const { data: company } = await supabase.from('companies').select('base_currency').eq('id', companyId).single();
  baseCurrency = company?.base_currency || 'EUR';

  const { data: currencies } = await supabase.from('currencies').select('code, name, symbol').order('code');

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Валути</h1><div class="sub">Основна валута: ${baseCurrency} · Курсове спрямо нея</div></div>
      <button class="btn accent" id="new-btn">+ Нов курс</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нов курс</div>
      <form id="new-form" class="form-grid-3">
        <div class="field"><label>Валута</label>
          <select name="currency_code">${(currencies || []).filter(c => c.code !== baseCurrency).map(c => `<option value="${c.code}">${c.code} — ${c.name}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Курс към ${baseCurrency} (1 единица = ? ${baseCurrency})</label><input name="rate_to_base" type="number" step="0.000001" min="0.000001" required /></div>
        <div class="field"><label>Дата</label><input name="rate_date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
        <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
          <button class="btn primary" type="submit">Запази курс</button>
          <button class="btn" type="button" id="cancel-btn">Отказ</button>
          <span id="form-error" style="color:var(--bad); font-size:12.5px;"></span>
        </div>
      </form>
    </div>

    <div class="panel">
      <div class="panel__header">История на курсовете</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'none');
  document.getElementById('new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('form-error');
    const fd = new FormData(e.target);
    const { error } = await supabase.from('exchange_rates').insert({
      company_id: companyId, currency_code: fd.get('currency_code'),
      rate_to_base: Number(fd.get('rate_to_base')), rate_date: fd.get('rate_date'),
    });
    if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
    e.target.reset();
    document.getElementById('new-panel').style.display = 'none';
    await load();
  });

  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const { data, error } = await supabase
    .from('exchange_rates')
    .select('currency_code, rate_to_base, rate_date, currencies(name, symbol)')
    .eq('company_id', companyId)
    .order('rate_date', { ascending: false });

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма въведени курсове. Всичко се третира като ${baseCurrency}.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Валута</th><th>Дата</th><th>Курс към ${baseCurrency}</th></tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td>${r.currency_code} (${r.currencies?.name || ''})</td>
            <td class="mono">${r.rate_date}</td>
            <td class="mono">1 ${r.currency_code} = ${r.rate_to_base} ${baseCurrency}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

main();
