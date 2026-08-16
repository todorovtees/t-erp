import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

async function main() {
  const shell = await renderShell('settings');
  if (!shell) return;
  const { content, profile } = shell;
  if (!profile) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Профилът не е свързан</div>
      <div style="padding:20px;">Виж README → "Първи потребител".</div></div>`;
    return;
  }

  const { data: company, error: loadErr } = await supabase
    .from('companies').select('name, eik, vat_number, address, base_currency').eq('id', profile.company_id).single();

  if (loadErr) {
    content.innerHTML = `<div class="panel"><div class="panel__header">Настройки</div>
      <div style="padding:20px;">Грешка: ${loadErr.message}</div></div>`;
    return;
  }

  content.innerHTML = `
    <div class="page-header">
      <div><h1>Настройки</h1><div class="sub">Профил на фирмата</div></div>
    </div>

    <div class="panel">
      <div class="panel__header">Фирмени данни</div>
      <form id="company-form" class="form-grid-2" style="max-width:640px;">
        <div class="field"><label>Име на фирмата</label><input name="name" value="${company.name || ''}" required /></div>
        <div class="field"><label>ЕИК</label><input name="eik" value="${company.eik || ''}" /></div>
        <div class="field"><label>ДДС номер</label><input name="vat_number" value="${company.vat_number || ''}" /></div>
        <div class="field"><label>Основна валута</label>
          <select name="base_currency">
            <option value="EUR" ${company.base_currency === 'EUR' ? 'selected' : ''}>EUR</option>
            <option value="USD" ${company.base_currency === 'USD' ? 'selected' : ''}>USD</option>
            <option value="GBP" ${company.base_currency === 'GBP' ? 'selected' : ''}>GBP</option>
          </select>
        </div>
        <div class="field" style="grid-column:1/-1;"><label>Адрес</label><input name="address" value="${company.address || ''}" /></div>
        <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
          <button class="btn primary" type="submit">Запази</button>
          <span id="form-msg" style="font-size:12.5px;"></span>
        </div>
      </form>
    </div>

    <div class="panel">
      <div class="panel__header">Твоят достъп</div>
      <div style="padding:16px; font-size:13px;">
        Роля: <strong>${profile.role}</strong> — за промяна на роли на потребители виж страница "Потребители".
      </div>
    </div>
  `;

  document.getElementById('company-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('form-msg');
    msg.textContent = ''; msg.style.color = 'var(--bad)';
    const fd = new FormData(e.target);

    const { error } = await supabase.from('companies').update({
      name: fd.get('name').trim(),
      eik: fd.get('eik') || null,
      vat_number: fd.get('vat_number') || null,
      address: fd.get('address') || null,
      base_currency: fd.get('base_currency'),
    }).eq('id', profile.company_id);

    if (error) { msg.textContent = 'Грешка: ' + error.message; return; }
    msg.style.color = 'var(--good)';
    msg.textContent = 'Запазено.';
    setTimeout(() => msg.textContent = '', 3000);
  });
}

main();
