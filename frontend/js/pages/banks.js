import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

let companyId = null;
let operatorId = null;
let accounts = [];

function fmt(amount, currency) {
  return new Intl.NumberFormat('bg-BG', { style: 'currency', currency }).format(amount);
}

async function main() {
  const shell = await renderShell('banks');
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
      <div><h1>Банки</h1><div class="sub">Банкови сметки и движения</div></div>
      <button class="btn accent" id="new-btn">+ Нова сметка</button>
    </div>

    <div class="panel" id="new-panel" style="display:none;">
      <div class="panel__header">Нова банкова сметка</div>
      <form id="new-form" class="form-grid-3">
        <div class="field"><label>Банка *</label><input name="bank_name" required placeholder="UniCredit Bulbank" /></div>
        <div class="field"><label>IBAN *</label><input name="iban" required placeholder="BG00XXXX..." /></div>
        <div class="field"><label>Начално салдо</label><input name="opening_balance" type="number" step="0.01" value="0" /></div>
        <div style="grid-column:1/-1; display:flex; gap:10px; align-items:center;">
          <button class="btn primary" type="submit">Запази сметка</button>
          <button class="btn" type="button" id="cancel-btn">Отказ</button>
          <span id="form-error" style="color:var(--bad); font-size:12.5px;"></span>
        </div>
      </form>
    </div>

    <div class="panel" id="tx-panel" style="display:none;">
      <div class="panel__header">Движение по сметка</div>
      <div style="padding:16px; display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;">
        <div class="field" style="margin:0;"><label>Тип</label>
          <select id="tx-type">
            <option value="deposit">Внасяне</option>
            <option value="withdrawal">Теглене</option>
            <option value="transfer">Превод към друга сметка</option>
          </select>
        </div>
        <div class="field" style="margin:0;" id="target-account-field">
          <label>Към сметка</label>
          <select id="target-account"></select>
        </div>
        <div class="field" style="margin:0;"><label>Сума</label><input id="tx-amount" type="number" step="0.01" min="0.01" /></div>
        <div class="field" style="margin:0;"><label>Бележка</label><input id="tx-note" /></div>
        <button class="btn primary" id="tx-submit">Запиши</button>
      </div>
      <div id="tx-error" style="padding:0 16px 16px; color:var(--bad); font-size:12.5px;"></div>
    </div>

    <div class="panel">
      <div class="panel__header">Сметки</div>
      <div id="accounts-mount"></div>
    </div>
  `;

  document.getElementById('new-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'block');
  document.getElementById('cancel-btn').addEventListener('click', () => document.getElementById('new-panel').style.display = 'none');
  document.getElementById('new-form').addEventListener('submit', handleCreate);
  document.getElementById('tx-type').addEventListener('change', (e) => {
    document.getElementById('target-account-field').style.display = e.target.value === 'transfer' ? 'block' : 'none';
  });
  document.getElementById('tx-submit').addEventListener('click', submitTransaction);

  await load();
}

async function handleCreate(e) {
  e.preventDefault();
  const errBox = document.getElementById('form-error');
  const fd = new FormData(e.target);
  const { error } = await supabase.from('bank_accounts').insert({
    company_id: companyId, bank_name: fd.get('bank_name').trim(), iban: fd.get('iban').trim(),
    opening_balance: Number(fd.get('opening_balance')),
  });
  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
  e.target.reset();
  document.getElementById('new-panel').style.display = 'none';
  await load();
}

let activeAccountId = null;

function openTxPanel(accountId) {
  activeAccountId = accountId;
  document.getElementById('target-account').innerHTML = accounts
    .filter(a => a.id !== accountId)
    .map(a => `<option value="${a.id}">${a.bank_name} (${a.iban})</option>`).join('');
  document.getElementById('tx-panel').style.display = 'block';
  document.getElementById('tx-panel').scrollIntoView({ behavior: 'smooth' });
}

async function submitTransaction() {
  const errBox = document.getElementById('tx-error');
  errBox.textContent = '';
  const type = document.getElementById('tx-type').value;
  const amount = Number(document.getElementById('tx-amount').value);
  const note = document.getElementById('tx-note').value || null;

  if (!amount || amount <= 0) { errBox.textContent = 'Въведи валидна сума.'; return; }

  let error;
  if (type === 'transfer') {
    ({ error } = await supabase.rpc('transfer_between_banks', {
      p_company_id: companyId, p_from_account_id: activeAccountId,
      p_to_account_id: document.getElementById('target-account').value,
      p_amount: amount, p_note: note, p_operator_id: operatorId,
    }));
  } else {
    ({ error } = await supabase.rpc('record_bank_transaction', {
      p_company_id: companyId, p_bank_account_id: activeAccountId, p_type: type,
      p_amount: amount, p_note: note, p_operator_id: operatorId,
    }));
  }

  if (error) { errBox.textContent = 'Грешка: ' + error.message; return; }
  document.getElementById('tx-panel').style.display = 'none';
  document.getElementById('tx-amount').value = '';
  document.getElementById('tx-note').value = '';
  await load();
}

async function load() {
  const mount = document.getElementById('accounts-mount');
  const { data, error } = await supabase
    .from('v_bank_balances')
    .select('id, bank_name, iban, currency, current_balance, is_active')
    .eq('company_id', companyId)
    .order('bank_name');

  accounts = data || [];
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма банкови сметки.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Банка</th><th>IBAN</th><th>Наличност</th><th></th></tr></thead>
      <tbody>
        ${data.map(a => `
          <tr>
            <td>${a.bank_name}</td>
            <td class="mono">${a.iban}</td>
            <td class="mono">${fmt(a.current_balance, a.currency)}</td>
            <td><button class="btn sm" data-tx="${a.id}">Движение</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-tx]').forEach(b => b.addEventListener('click', () => openTxPanel(b.dataset.tx)));
}

main();
