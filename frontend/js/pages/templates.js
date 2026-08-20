import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';
import { printCustomTemplate } from '../lib/print.js';

const DOC_TYPES = { invoice: 'Фактура', proforma: 'Проформа', warranty: 'Гаранционна карта', protocol: 'Протокол', delivery_note: 'Стокова разписка', receipt: 'Касова бележка' };

const SAMPLE_DATA = {
  document: { number: 'INV-000123', date: new Date().toLocaleDateString('bg-BG'), total: '120.00 €' },
  customer: { name: 'Иван Петров', address: 'ул. Примерна 1, София', eik: '123456789' },
  company: { name: 'Todorov Tees Ltd', address: 'София', eik: '111111113' },
};

const DEFAULT_TEMPLATE = `<div style="border-bottom:2px solid #14151A; padding-bottom:14px; margin-bottom:18px;">
  <h1>{{document.number}}</h1>
  <p>Дата: {{document.date}}</p>
</div>
<table>
  <tr><td><strong>Доставчик</strong></td><td><strong>Клиент</strong></td></tr>
  <tr><td>{{company.name}}<br>{{company.address}}<br>ЕИК: {{company.eik}}</td>
      <td>{{customer.name}}<br>{{customer.address}}<br>ЕИК: {{customer.eik}}</td></tr>
</table>
<h2 style="text-align:right; margin-top:24px;">Общо: {{document.total}}</h2>`;

let companyId = null;

async function main() {
  const shell = await renderShell('templates');
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
      <div><h1>Шаблони за печат</h1><div class="sub">Персонализирани документи с placeholder-и — {{customer.name}}, {{document.total}} и т.н.</div></div>
      <button class="btn accent" id="new-btn">+ Нов шаблон</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нов шаблон</div>
      <div style="padding:16px;">
        <div class="form-grid-2" style="padding:0; margin-bottom:14px;">
          <div class="field"><label>Тип документ</label>
            <select id="doc-type-select">${Object.entries(DOC_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Име на шаблона</label><input id="name-input" placeholder="Стандартна фактура" /></div>
        </div>
        <div class="field"><label>HTML съдържание (използвай {{path.to.value}} за динамични данни)</label>
          <textarea id="body-input" rows="12" style="width:100%; font-family:var(--font-mono); font-size:12px; border:1px solid var(--gray-300); border-radius:4px; padding:10px;">${DEFAULT_TEMPLATE}</textarea>
        </div>
        <div style="font-size:11.5px; color:var(--gray-700); margin:8px 0;">
          Налични: {{document.number}}, {{document.date}}, {{document.total}}, {{customer.name}}, {{customer.address}}, {{customer.eik}}, {{company.name}}, {{company.address}}, {{company.eik}}
        </div>
        <div style="display:flex; gap:10px;">
          <button class="btn primary" id="save-btn">Запази шаблон</button>
          <button class="btn" id="preview-btn">Преглед с примерни данни</button>
          <button class="btn" id="cancel-btn">Отказ</button>
        </div>
        <div id="form-error" style="color:var(--bad); font-size:12.5px; margin-top:8px;"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__header">Списък шаблони</div>
      <div id="table-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'none');
  document.getElementById('preview-btn').addEventListener('click', () => {
    printCustomTemplate('Преглед на шаблон', document.getElementById('body-input').value, SAMPLE_DATA);
  });
  document.getElementById('save-btn').addEventListener('click', async () => {
    const errBox = document.getElementById('form-error');
    const { error } = await supabase.from('print_templates').insert({
      company_id: companyId,
      doc_type: document.getElementById('doc-type-select').value,
      name: document.getElementById('name-input').value.trim() || 'Без име',
      body: document.getElementById('body-input').value,
    });
    if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
    document.getElementById('new-panel').style.display = 'none';
    await load();
  });

  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const { data, error } = await supabase
    .from('print_templates')
    .select('id, doc_type, name, body, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма създадени шаблони — Продажби/Покупки използват вградения формат по подразбиране.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Име</th><th>Тип</th><th>Създаден</th><th></th></tr></thead>
      <tbody>
        ${data.map(t => `
          <tr>
            <td>${t.name}</td>
            <td>${DOC_TYPES[t.doc_type] || t.doc_type}</td>
            <td class="mono">${new Date(t.created_at).toLocaleDateString('bg-BG')}</td>
            <td>
              <div class="action-row">
                <button class="btn sm" data-preview="${t.id}">Преглед</button>
                <button class="btn sm danger" data-delete="${t.id}">Изтрий</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-preview]').forEach(b => b.addEventListener('click', () => {
    const t = data.find(x => x.id === b.dataset.preview);
    printCustomTemplate(t.name, t.body, SAMPLE_DATA);
  }));
  mount.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Да изтрия ли шаблона?')) return;
    const { error } = await supabase.from('print_templates').delete().eq('id', b.dataset.delete);
    if (error) { alert('Грешка: ' + error.message); return; }
    await load();
  }));
}

main();
