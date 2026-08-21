// T-ERP — responsive table labelling.
//
// Below 720px, css/app.css collapses each table row into a stacked card and
// prints the column name next to every value. That needs each <td> to carry
// data-label="Column name".
//
// Rather than hand-editing every table in every page (and having to remember
// it for each new one), this watches the DOM and fills those labels in
// automatically from the table's own <th> cells. Pages render tables exactly
// as before; this makes them phone-friendly for free.

function labelTable(table) {
  const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
  if (!headers.length) return;

  table.querySelectorAll('tbody tr').forEach((row) => {
    let colIndex = 0;
    Array.from(row.children).forEach((cell) => {
      // A cell that spans columns (e.g. the batch/serial sub-rows in
      // Purchases) has no single owning header — skip it and advance.
      const span = parseInt(cell.getAttribute('colspan') || '1', 10);
      if (span === 1 && headers[colIndex] && !cell.hasAttribute('data-label')) {
        cell.setAttribute('data-label', headers[colIndex]);
      }
      colIndex += span;
    });
  });
}

function labelAll(root = document) {
  root.querySelectorAll('table.data').forEach(labelTable);
}

export function initResponsiveTables() {
  labelAll();

  // Pages re-render their tables constantly (filters, search, after saving),
  // so re-label whenever new nodes appear.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.('table.data')) labelTable(node);
        else if (node.querySelectorAll) labelAll(node);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}
