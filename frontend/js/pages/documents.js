import { supabase } from '../lib/supabaseClient.js';
import { renderShell } from '../lib/shell.js';

const CATEGORIES = ['Фактура', 'Договор', 'Сертификат', 'Друго'];
const MAX_SIZE = 25 * 1024 * 1024; // 25MB

let companyId = null;
let operatorId = null;

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function main() {
  const shell = await renderShell('documents');
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
      <div><h1>Документи</h1><div class="sub">Фирмена документация — фактури, договори, сертификати</div></div>
    </div>

    <div class="panel">
      <div class="panel__header">Качване на файл</div>
      <div style="padding:16px;">
        <div class="field" style="max-width:220px; margin-bottom:12px;">
          <label>Категория за качване</label>
          <select id="upload-category">${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
        </div>
        <div class="dropzone" id="dropzone">
          Провлачи файл тук или кликни, за да избереш (до 25MB)
          <input type="file" id="file-input" style="display:none;" />
        </div>
        <div id="upload-status" style="font-size:12.5px; margin-top:8px;"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__header" style="gap:10px;">
        <select id="category-filter" style="border:1px solid var(--gray-300); border-radius:4px; padding:6px 10px; font-size:13px;">
          <option value="">Всички категории</option>
          ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <div class="topbar__spacer"></div>
      </div>
      <div id="table-mount"></div>
    </div>
  `;

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });
  ['dragenter', 'dragover'].forEach(evt => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); });

  document.getElementById('category-filter').addEventListener('change', load);

  await load();
}

async function uploadFile(file) {
  const status = document.getElementById('upload-status');
  status.style.color = 'var(--gray-700)';

  if (file.size > MAX_SIZE) {
    status.style.color = 'var(--bad)';
    status.textContent = 'Файлът е твърде голям (макс. 25MB).';
    return;
  }

  status.textContent = `Качвам ${file.name}…`;
  const category = document.getElementById('upload-category').value;
  const safeName = file.name.replace(/[^\w.\-]/g, '_');
  const storagePath = `${companyId}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadErr } = await supabase.storage.from('documents').upload(storagePath, file);
  if (uploadErr) {
    status.style.color = 'var(--bad)';
    status.textContent = 'Грешка при качване: ' + uploadErr.message;
    return;
  }

  const { error: metaErr } = await supabase.from('document_files').insert({
    company_id: companyId,
    storage_path: storagePath,
    filename: file.name,
    category,
    size_bytes: file.size,
    uploaded_by: operatorId,
  });

  if (metaErr) {
    status.style.color = 'var(--bad)';
    status.textContent = 'Файлът се качи, но записът не бе запазен: ' + metaErr.message;
    return;
  }

  status.style.color = 'var(--good)';
  status.textContent = `${file.name} качен успешно.`;
  document.getElementById('file-input').value = '';
  await load();
}

async function load() {
  const mount = document.getElementById('table-mount');
  const category = document.getElementById('category-filter').value;

  let query = supabase
    .from('document_files')
    .select('id, filename, category, size_bytes, storage_path, created_at, app_users(full_name)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (category) query = query.eq('category', category);

  const { data, error } = await query;
  if (error) { mount.innerHTML = `<div style="padding:20px;">Грешка: ${error.message}</div>`; return; }
  if (!data.length) { mount.innerHTML = `<div style="padding:20px; color:var(--gray-700); font-size:13px;">Няма качени документи.</div>`; return; }

  mount.innerHTML = `
    <table class="data">
      <thead><tr><th>Файл</th><th>Категория</th><th>Размер</th><th>Качен от</th><th>Дата</th><th></th></tr></thead>
      <tbody>
        ${data.map(d => `
          <tr>
            <td>${d.filename}</td>
            <td>${d.category}</td>
            <td class="mono">${formatSize(d.size_bytes)}</td>
            <td>${d.app_users?.full_name || '—'}</td>
            <td class="mono">${new Date(d.created_at).toLocaleDateString('bg-BG')}</td>
            <td>
              <div class="action-row">
                <button class="btn sm" data-download="${d.storage_path}">Изтегли</button>
                <button class="btn sm danger" data-delete="${d.id}" data-path="${d.storage_path}">Изтрий</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  mount.querySelectorAll('[data-download]').forEach(b => b.addEventListener('click', () => downloadFile(b.dataset.download)));
  mount.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', () => deleteFile(b.dataset.delete, b.dataset.path)));
}

async function downloadFile(path) {
  const { data, error } = await supabase.storage.from('documents').createSignedUrl(path, 60);
  if (error) { alert('Грешка: ' + error.message); return; }
  window.open(data.signedUrl, '_blank');
}

async function deleteFile(id, path) {
  if (!confirm('Да изтрия ли този документ?')) return;
  const { error: storageErr } = await supabase.storage.from('documents').remove([path]);
  if (storageErr) { alert('Грешка при изтриване на файла: ' + storageErr.message); return; }
  const { error: metaErr } = await supabase.from('document_files').delete().eq('id', id);
  if (metaErr) { alert('Грешка при изтриване на записа: ' + metaErr.message); return; }
  await load();
}

main();
