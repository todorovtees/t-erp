// T-ERP — shared print utility.
//
// Opens a dedicated blank window with its own minimal, print-tuned document
// instead of relying on the browser printing the live app UI (which would
// include the sidebar, buttons, filters, etc.). This is what powers every
// "Печат" button across the app — sale receipts, inventory lists, and any
// future document type — so they all share one consistent, professional
// layout instead of each page reinventing it.
//
// Two ways to print:
//  - printDocument(doc) — the built-in structured layout (title/meta/table/
//    totals), used by most pages.
//  - printCustomTemplate(templateBody, data) — interpolates a user-authored
//    template (from the print_templates table, managed on the Templates
//    page) with {{placeholder}} tokens like {{customer.name}} or
//    {{document.total}} (spec §31), for fully custom document layouts.

/** Reads a dotted path like "customer.name" out of a nested data object. */
function getPath(obj, path) {
  return path.split('.').reduce((v, k) => (v == null ? v : v[k]), obj);
}

/** Replaces every {{a.b.c}} token in a template string with the matching
 *  value from `data`, HTML-escaped. Unknown paths render as empty string
 *  rather than leaving the raw token visible. */
export function interpolateTemplate(templateBody, data) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return templateBody.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => esc(getPath(data, path)));
}

export function printCustomTemplate(documentTitle, templateBody, data) {
  const win = window.open('', '_blank', 'width=850,height=1100');
  if (!win) {
    alert('Браузърът блокира отварянето на прозорец за печат. Разреши popup прозорци за този сайт.');
    return;
  }

  const body = interpolateTemplate(templateBody, data);
  const html = `<!doctype html>
<html lang="bg">
<head>
<meta charset="utf-8" />
<title>${documentTitle}</title>
<style>
  @page { margin: 18mm 16mm; }
  body { font-family: 'IBM Plex Sans', -apple-system, sans-serif; color: #14151A; font-size: 13px; margin: 0; padding: 28px; }
  @media print { body { padding: 0; } .print-btn { display: none; } }
  .print-btn { position: fixed; top: 16px; right: 16px; font-family: 'IBM Plex Sans', sans-serif; font-size: 13px; font-weight: 500;
    padding: 8px 16px; border-radius: 4px; border: 1px solid #14151A; background: #14151A; color: #fff; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 6px 8px; border-bottom: 1px solid #EDEDEF; }
</style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Отпечатай</button>
  ${body}
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
}

/**
 * @param {Object} doc
 * @param {string} doc.documentTitle   e.g. "Продажба POS-1755000000000"
 * @param {string} [doc.subtitle]      small line under the title
 * @param {{label:string, value:string}[]} [doc.meta]   key/value pairs shown top-right
 * @param {{key:string, label:string, align?:'left'|'right'}[]} doc.columns
 * @param {Object[]} doc.rows          row objects, keyed by columns[].key
 * @param {{label:string, value:string, emphasis?:boolean}[]} [doc.totals]
 * @param {string} [doc.footerNote]
 */
export function printDocument(doc) {
  const {
    documentTitle, subtitle = '', meta = [], columns, rows, totals = [], footerNote = '',
  } = doc;

  const win = window.open('', '_blank', 'width=850,height=1100');
  if (!win) {
    alert('Браузърът блокира отварянето на прозорец за печат. Разреши popup прозорци за този сайт.');
    return;
  }

  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const html = `<!doctype html>
<html lang="bg">
<head>
<meta charset="utf-8" />
<title>${esc(documentTitle)}</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'IBM Plex Sans', -apple-system, sans-serif;
    color: #14151A;
    font-size: 13px;
    margin: 0;
    padding: 28px;
  }
  .doc-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #14151A; padding-bottom: 14px; margin-bottom: 18px;
  }
  .doc-header .brand { font-family: monospace; font-weight: 700; font-size: 15px; letter-spacing: 0.02em; }
  .doc-header .brand .sub { font-family: 'IBM Plex Sans', sans-serif; font-weight: 400; font-size: 11px; color: #55575F; display:block; margin-top:2px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .subtitle { color: #55575F; font-size: 12px; margin: 0; }
  .meta-table { text-align: right; font-size: 12px; }
  .meta-table div { margin-bottom: 3px; }
  .meta-table .label { color: #55575F; margin-right: 6px; }
  .meta-table .value { font-family: monospace; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  th {
    text-align: left; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase;
    color: #55575F; border-bottom: 1.5px solid #14151A; padding: 6px 8px;
  }
  td { padding: 8px; border-bottom: 1px solid #EDEDEF; font-size: 12.5px; }
  th.right, td.right { text-align: right; font-family: monospace; }
  .totals { width: 260px; margin-left: auto; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 8px; font-size: 12.5px; }
  .totals .emphasis { font-weight: 700; font-size: 15px; border-top: 1.5px solid #14151A; margin-top: 4px; padding-top: 8px; font-family: monospace; }
  .footer-note { margin-top: 24px; font-size: 11px; color: #55575F; }
  @media print {
    body { padding: 0; }
    .print-btn { display: none; }
  }
  .print-btn {
    position: fixed; top: 16px; right: 16px;
    font-family: 'IBM Plex Sans', sans-serif; font-size: 13px; font-weight: 500;
    padding: 8px 16px; border-radius: 4px; border: 1px solid #14151A;
    background: #14151A; color: #fff; cursor: pointer;
  }
</style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Отпечатай</button>
  <div class="doc-header">
    <div>
      <span class="brand">T-ERP<span class="sub">Todorov Tees</span></span>
      <h1 style="margin-top:14px;">${esc(documentTitle)}</h1>
      ${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}
    </div>
    <div class="meta-table">
      ${meta.map(m => `<div><span class="label">${esc(m.label)}:</span><span class="value">${esc(m.value)}</span></div>`).join('')}
    </div>
  </div>

  <table>
    <thead>
      <tr>${columns.map(c => `<th class="${c.align === 'right' ? 'right' : ''}">${esc(c.label)}</th>`).join('')}</tr>
    </thead>
    <tbody>
      ${rows.map(r => `<tr>${columns.map(c => `<td class="${c.align === 'right' ? 'right' : ''}">${esc(r[c.key])}</td>`).join('')}</tr>`).join('')}
    </tbody>
  </table>

  ${totals.length ? `<div class="totals">
    ${totals.map(t => `<div class="${t.emphasis ? 'emphasis' : ''}"><span>${esc(t.label)}</span><span>${esc(t.value)}</span></div>`).join('')}
  </div>` : ''}

  ${footerNote ? `<div class="footer-note">${esc(footerNote)}</div>` : ''}
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
}
