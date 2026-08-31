/* Retainr frontend — talks to the Apps Script web app defined in config.js */

const state = {
  projects: [],
  invoices: [],
  dashboard: null
};

const money = (n) => '₹' + (Math.round(Number(n) || 0)).toLocaleString('en-IN');
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return '—';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

/* ---------------------------------------------------------------------- */
/* API                                                                    */
/* ---------------------------------------------------------------------- */

async function apiGet(action) {
  const res = await fetch(`${API_URL}?action=${encodeURIComponent(action)}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Request failed');
  return json.data;
}

async function apiPost(action, payload) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight on Apps Script
    body: JSON.stringify({ action, payload })
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Request failed');
  return json.data;
}

/* ---------------------------------------------------------------------- */
/* Bootstrap                                                              */
/* ---------------------------------------------------------------------- */

async function loadAll() {
  setSyncStatus('Loading…');
  try {
    const [projects, invoices, dashboard] = await Promise.all([
      apiGet('getProjects'),
      apiGet('getInvoices'),
      apiGet('getDashboard')
    ]);
    state.projects = projects;
    state.invoices = invoices;
    state.dashboard = dashboard;
    renderDashboard();
    renderProjectsTable();
    renderInvoicesTable();
    setSyncStatus('Updated ' + new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
  } catch (err) {
    console.error(err);
    setSyncStatus('Connection error');
    showToast(String(err.message || err));
  }
}

function setSyncStatus(text) {
  document.getElementById('syncStatus').textContent = text;
}

/* ---------------------------------------------------------------------- */
/* Tabs                                                                    */
/* ---------------------------------------------------------------------- */

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  document.getElementById('view-' + btn.dataset.view).classList.remove('hidden');
});

document.getElementById('syncBtn').addEventListener('click', async () => {
  setSyncStatus('Syncing…');
  try {
    const result = await apiPost('generateUpcomingInvoices', {});
    await loadAll();
    if (result.created > 0) {
      showToast(`Generated ${result.created} new invoice${result.created === 1 ? '' : 's'}`);
    } else {
      showToast('Everything is up to date');
    }
  } catch (err) {
    showToast(String(err.message || err));
    setSyncStatus('Sync failed');
  }
});

/* ---------------------------------------------------------------------- */
/* Dashboard rendering                                                    */
/* ---------------------------------------------------------------------- */

function renderDashboard() {
  const d = state.dashboard;
  if (!d) return;

  document.getElementById('statCollected').textContent = money(d.collectedThisMonth);
  document.getElementById('statInvoicedNote').textContent = `${money(d.invoicedThisMonth)} invoiced this month`;
  document.getElementById('statOutstanding').textContent = money(d.outstandingTotal);
  document.getElementById('statUpcomingCount').textContent = d.upcoming.length;
  document.getElementById('statOverdueCount').textContent = d.overdue.length;
  document.getElementById('statActiveProjects').textContent = d.activeProjects;
  document.getElementById('statMRV').textContent = money(d.monthlyRecurringValue);

  drawTrendChart(document.getElementById('trendChart'), d.trend);

  renderList('upcomingList', d.upcoming, false);
  renderList('overdueList', d.overdue, true);
}

function renderList(elId, items, isOverdue) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  if (!items.length) {
    el.innerHTML = `<div class="list-empty">Nothing here right now.</div>`;
    return;
  }
  items.slice(0, 8).forEach((inv) => {
    const div = document.createElement('div');
    div.className = 'list-item';
    const outstanding = (Number(inv['Amount (₹)']) || 0) - (Number(inv['Amount Received (₹)']) || 0);
    div.innerHTML = `
      <div class="list-item-main">
        <span class="list-item-title">${escapeHtml(inv['Client / Billing Entity'] || inv['Project'] || 'Untitled')}</span>
        <span class="list-item-sub">${escapeHtml(inv['Project'] || '')} · ${isOverdue ? 'was due' : 'due'} ${fmtDate(inv['Due Date'])}</span>
      </div>
      <div class="list-item-amount" style="color:${isOverdue ? 'var(--danger)' : 'var(--text)'}">${money(outstanding)}</div>
    `;
    el.appendChild(div);
  });
}

function drawTrendChart(canvas, trend) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  const height = 220;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.height = height + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 10, right: 10, bottom: 24, left: 10 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = Math.max(1, ...trend.map((t) => Math.max(t.invoiced, t.collected, t.projected)));
  const n = trend.length;
  const slotW = chartW / n;
  const barW = Math.min(28, slotW * 0.4);

  // gridlines
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const y = padding.top + chartH - (chartH * g) / 3;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartW, y);
    ctx.stroke();
  }

  const points = [];

  trend.forEach((t, i) => {
    const cx = padding.left + slotW * i + slotW / 2;
    const barVal = t.invoiced || t.projected;
    const isProjected = t.projected > 0;
    const barH = (barVal / maxVal) * chartH;
    const barY = padding.top + chartH - barH;

    ctx.fillStyle = isProjected ? '#d8d8dc' : '#cfe6ff';
    roundRect(ctx, cx - barW / 2, barY, barW, barH, 4);
    ctx.fill();

    const collectedH = (t.collected / maxVal) * chartH;
    points.push({ x: cx, y: padding.top + chartH - collectedH, has: t.collected > 0 });

    ctx.fillStyle = '#6e6e73';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(t.month, cx, height - 6);
  });

  // collected line
  ctx.strokeStyle = '#1f9d55';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  points.forEach((p) => {
    if (!p.has) { started = false; return; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; }
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();

  ctx.fillStyle = '#1f9d55';
  points.forEach((p) => {
    if (!p.has) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

function roundRect(ctx, x, y, w, h, r) {
  if (h < 0) { y += h; h = Math.abs(h); }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

window.addEventListener('resize', () => {
  if (state.dashboard) drawTrendChart(document.getElementById('trendChart'), state.dashboard.trend);
});

/* ---------------------------------------------------------------------- */
/* Projects table                                                         */
/* ---------------------------------------------------------------------- */

function renderProjectsTable() {
  const tbody = document.querySelector('#projectsTable tbody');
  tbody.innerHTML = '';
  state.projects.forEach((p) => {
    const amount = p['Fee Basis'] && String(p['Fee Basis']).indexOf('Retainer') === 0
      ? `${money(p['Recurring Amount (₹)'])} / ${(p['Fee Basis'].split('-')[1] || '').trim() || p['Billing Cycle'] || 'cycle'}`
      : money(p['Total Fee (₹)']);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(p['Project'] || '')}</td>
      <td>${escapeHtml(p['Client / Billing Entity'] || '')}</td>
      <td>${escapeHtml(p['Fee Basis'] || '')}</td>
      <td>${amount}</td>
      <td>${escapeHtml(p['Billing Cycle'] || '—')}</td>
      <td><span class="pill pill-${slug(p['Project Status'])}">${escapeHtml(p['Project Status'] || '—')}</span></td>
      <td>${fmtDate(p['Contract Start Date'])} → ${p['Contract End Date'] ? fmtDate(p['Contract End Date']) : 'ongoing'}</td>
      <td class="row-actions">
        <button class="btn-text" data-edit-project="${p['Project ID']}">Edit</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.querySelector('#projectsTable tbody').addEventListener('click', (e) => {
  const id = e.target.dataset.editProject;
  if (id) openProjectForm(state.projects.find((p) => p['Project ID'] === id));
});

document.getElementById('newProjectBtn').addEventListener('click', () => openProjectForm(null));

/* ---------------------------------------------------------------------- */
/* Invoices table                                                         */
/* ---------------------------------------------------------------------- */

function renderInvoicesTable() {
  const tbody = document.querySelector('#invoicesTable tbody');
  tbody.innerHTML = '';
  const sorted = [...state.invoices].sort((a, b) => new Date(b['Invoice Date']) - new Date(a['Invoice Date']));
  sorted.forEach((inv) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(inv['Client / Billing Entity'] || '')}</td>
      <td>${escapeHtml(inv['Project'] || '')}</td>
      <td>${escapeHtml(inv['Billing Period'] || '')}</td>
      <td>${money(inv['Amount (₹)'])}</td>
      <td>${fmtDate(inv['Due Date'])}</td>
      <td><span class="pill pill-${slug(inv['Status'])}">${escapeHtml(inv['Status'] || '—')}</span></td>
      <td>${money(inv['Amount Received (₹)'])}</td>
      <td class="row-actions">
        ${inv['Status'] !== 'Paid' ? `<button class="btn-text" data-mark-paid="${inv['Invoice ID']}">Mark paid</button>` : ''}
        <button class="btn-text" data-edit-invoice="${inv['Invoice ID']}">Edit</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.querySelector('#invoicesTable tbody').addEventListener('click', async (e) => {
  const editId = e.target.dataset.editInvoice;
  const payId = e.target.dataset.markPaid;
  if (editId) openInvoiceForm(state.invoices.find((i) => i['Invoice ID'] === editId));
  if (payId) {
    const inv = state.invoices.find((i) => i['Invoice ID'] === payId);
    try {
      await apiPost('updateInvoice', {
        ...inv,
        'Status': 'Paid',
        'Amount Received (₹)': inv['Amount (₹)'],
        'Payment Date': new Date().toISOString()
      });
      showToast('Marked as paid');
      await loadAll();
    } catch (err) {
      showToast(String(err.message || err));
    }
  }
});

document.getElementById('newInvoiceBtn').addEventListener('click', () => openInvoiceForm(null));

/* ---------------------------------------------------------------------- */
/* Side panel — Project form                                              */
/* ---------------------------------------------------------------------- */

const FEE_BASIS_OPTIONS = ['Retainer - Monthly', 'Retainer - Quarterly', 'Retainer - Half-Yearly', 'Fixed Duration', 'Project-Based', 'Milestone-Based'];
const BILLING_CYCLE_OPTIONS = ['Monthly', 'Quarterly', 'Half-Yearly', 'One-Time', 'Custom'];
const PROJECT_STATUS_OPTIONS = ['Active', 'On Hold', 'Completed', 'Terminated'];
const INVOICE_STATUS_OPTIONS = ['Scheduled', 'Sent', 'Paid', 'Partially Paid', 'Overdue', 'Cancelled'];

function openProjectForm(project) {
  const isEdit = !!project;
  const p = project || {};
  setPanelTitle(isEdit ? 'Edit project' : 'New project');
  setPanelBody(`
    <div class="field"><label>Project name</label><input id="f_project" value="${attr(p['Project'])}" /></div>
    <div class="field"><label>Client / Billing entity</label><input id="f_client" value="${attr(p['Client / Billing Entity'])}" /></div>
    <div class="field-row">
      <div class="field"><label>Contact email</label><input id="f_email" value="${attr(p['Contact Email'])}" /></div>
      <div class="field"><label>Contact phone</label><input id="f_phone" value="${attr(p['Contact Phone'])}" /></div>
    </div>
    <div class="field"><label>Signed document (link)</label><input id="f_doc" value="${attr(p['Signed Document'])}" /></div>
    <div class="field"><label>Fee basis</label>
      <select id="f_feebasis">${optionList(FEE_BASIS_OPTIONS, p['Fee Basis'])}</select>
    </div>
    <div class="field-row">
      <div class="field"><label>Total fee (₹)</label><input id="f_totalfee" type="number" value="${attr(p['Total Fee (₹)'])}" /></div>
      <div class="field"><label>Recurring amount (₹)</label><input id="f_recurring" type="number" value="${attr(p['Recurring Amount (₹)'])}" /></div>
    </div>
    <div class="field"><label>Billing cycle</label>
      <select id="f_cycle">${optionList(BILLING_CYCLE_OPTIONS, p['Billing Cycle'])}</select>
    </div>
    <div class="field-row">
      <div class="field"><label>Contract start</label><input id="f_start" type="date" value="${dateVal(p['Contract Start Date'])}" /></div>
      <div class="field"><label>Contract end (optional)</label><input id="f_end" type="date" value="${dateVal(p['Contract End Date'])}" /></div>
    </div>
    <div class="field"><label>Payment terms</label><input id="f_terms" placeholder="e.g. Net 15, Advance" value="${attr(p['Payment Terms'])}" /></div>
    <div class="field"><label>Payment trigger (summary)</label><input id="f_trigger" placeholder="e.g. Monthly on the 1st" value="${attr(p['Payment Trigger (summary)'])}" /></div>
    <div class="field"><label>Project status</label>
      <select id="f_status">${optionList(PROJECT_STATUS_OPTIONS, p['Project Status'] || 'Active')}</select>
    </div>
    <div class="field"><label>Notes</label><textarea id="f_notes" rows="3">${attr(p['Notes'])}</textarea></div>
    <div class="form-actions">
      <div>${isEdit ? `<button class="btn-danger-text" id="deleteProjectBtn">Delete project</button>` : ''}</div>
      <button class="btn btn-primary" id="saveProjectBtn">${isEdit ? 'Save changes' : 'Create project'}</button>
    </div>
  `);

  document.getElementById('saveProjectBtn').addEventListener('click', async () => {
    const payload = {
      'Project ID': p['Project ID'],
      'Project': val('f_project'),
      'Client / Billing Entity': val('f_client'),
      'Contact Email': val('f_email'),
      'Contact Phone': val('f_phone'),
      'Signed Document': val('f_doc'),
      'Fee Basis': val('f_feebasis'),
      'Total Fee (₹)': Number(val('f_totalfee')) || '',
      'Recurring Amount (₹)': Number(val('f_recurring')) || '',
      'Billing Cycle': val('f_cycle'),
      'Contract Start Date': val('f_start') ? new Date(val('f_start')).toISOString() : '',
      'Contract End Date': val('f_end') ? new Date(val('f_end')).toISOString() : '',
      'Payment Terms': val('f_terms'),
      'Payment Trigger (summary)': val('f_trigger'),
      'Project Status': val('f_status'),
      'Notes': val('f_notes')
    };
    try {
      await apiPost(isEdit ? 'updateProject' : 'addProject', payload);
      showToast(isEdit ? 'Project updated' : 'Project created');
      closePanel();
      await loadAll();
    } catch (err) {
      showToast(String(err.message || err));
    }
  });

  if (isEdit) {
    document.getElementById('deleteProjectBtn').addEventListener('click', async () => {
      if (!confirm(`Delete "${p['Project']}"? This won't delete its invoices.`)) return;
      try {
        await apiPost('deleteProject', { projectId: p['Project ID'] });
        showToast('Project deleted');
        closePanel();
        await loadAll();
      } catch (err) {
        showToast(String(err.message || err));
      }
    });
  }

  openPanel();
}

/* ---------------------------------------------------------------------- */
/* Side panel — Invoice form                                              */
/* ---------------------------------------------------------------------- */

function openInvoiceForm(invoice) {
  const isEdit = !!invoice;
  const inv = invoice || {};
  setPanelTitle(isEdit ? 'Edit invoice' : 'New invoice');

  const projectOptions = state.projects.map((p) =>
    `<option value="${attr(p['Project ID'])}" ${inv['Project ID'] === p['Project ID'] ? 'selected' : ''}>${escapeHtml(p['Project'])} — ${escapeHtml(p['Client / Billing Entity'])}</option>`
  ).join('');

  setPanelBody(`
    <div class="field"><label>Project</label><select id="f_project">${projectOptions}</select></div>
    <div class="field-row">
      <div class="field"><label>Billing period label</label><input id="f_period" placeholder="e.g. Sep 2026" value="${attr(inv['Billing Period'])}" /></div>
      <div class="field"><label>Invoice number</label><input id="f_number" value="${attr(inv['Invoice Number'])}" /></div>
    </div>
    <div class="field"><label>Amount (₹)</label><input id="f_amount" type="number" value="${attr(inv['Amount (₹)'])}" /></div>
    <div class="field-row">
      <div class="field"><label>Invoice date</label><input id="f_invdate" type="date" value="${dateVal(inv['Invoice Date']) || todayVal()}" /></div>
      <div class="field"><label>Due date</label><input id="f_duedate" type="date" value="${dateVal(inv['Due Date'])}" /></div>
    </div>
    <div class="field"><label>Status</label><select id="f_status">${optionList(INVOICE_STATUS_OPTIONS, inv['Status'] || 'Scheduled')}</select></div>
    <div class="field-row">
      <div class="field"><label>Amount received (₹)</label><input id="f_received" type="number" value="${attr(inv['Amount Received (₹)'] || 0)}" /></div>
      <div class="field"><label>Payment date</label><input id="f_paydate" type="date" value="${dateVal(inv['Payment Date'])}" /></div>
    </div>
    <div class="field"><label>Notes</label><textarea id="f_notes" rows="3">${attr(inv['Notes'])}</textarea></div>
    <div class="form-actions">
      <div>${isEdit ? `<button class="btn-danger-text" id="deleteInvoiceBtn">Delete invoice</button>` : ''}</div>
      <button class="btn btn-primary" id="saveInvoiceBtn">${isEdit ? 'Save changes' : 'Create invoice'}</button>
    </div>
  `);

  document.getElementById('saveInvoiceBtn').addEventListener('click', async () => {
    const project = state.projects.find((p) => p['Project ID'] === val('f_project'));
    const payload = {
      'Invoice ID': inv['Invoice ID'],
      'Project ID': project ? project['Project ID'] : '',
      'Project': project ? project['Project'] : '',
      'Client / Billing Entity': project ? project['Client / Billing Entity'] : '',
      'Invoice Number': val('f_number'),
      'Billing Period': val('f_period'),
      'Amount (₹)': Number(val('f_amount')) || 0,
      'Invoice Date': val('f_invdate') ? new Date(val('f_invdate')).toISOString() : '',
      'Due Date': val('f_duedate') ? new Date(val('f_duedate')).toISOString() : '',
      'Status': val('f_status'),
      'Amount Received (₹)': Number(val('f_received')) || 0,
      'Payment Date': val('f_paydate') ? new Date(val('f_paydate')).toISOString() : '',
      'Notes': val('f_notes')
    };
    try {
      await apiPost(isEdit ? 'updateInvoice' : 'addInvoice', payload);
      showToast(isEdit ? 'Invoice updated' : 'Invoice created');
      closePanel();
      await loadAll();
    } catch (err) {
      showToast(String(err.message || err));
    }
  });

  if (isEdit) {
    document.getElementById('deleteInvoiceBtn').addEventListener('click', async () => {
      if (!confirm('Delete this invoice?')) return;
      try {
        await apiPost('deleteInvoice', { invoiceId: inv['Invoice ID'] });
        showToast('Invoice deleted');
        closePanel();
        await loadAll();
      } catch (err) {
        showToast(String(err.message || err));
      }
    });
  }

  openPanel();
}

/* ---------------------------------------------------------------------- */
/* Side panel plumbing                                                    */
/* ---------------------------------------------------------------------- */

function setPanelTitle(t) { document.getElementById('sidePanelTitle').textContent = t; }
function setPanelBody(html) { document.getElementById('sidePanelBody').innerHTML = html; }
function openPanel() {
  document.getElementById('overlay').classList.add('open');
  document.getElementById('sidePanel').classList.add('open');
}
function closePanel() {
  document.getElementById('overlay').classList.remove('open');
  document.getElementById('sidePanel').classList.remove('open');
}
document.getElementById('overlay').addEventListener('click', closePanel);
document.getElementById('closePanelBtn').addEventListener('click', closePanel);

/* ---------------------------------------------------------------------- */
/* Small helpers                                                          */
/* ---------------------------------------------------------------------- */

function val(id) { return document.getElementById(id).value; }
function attr(v) { return v === undefined || v === null ? '' : String(v).replace(/"/g, '&quot;'); }
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function optionList(options, selected) {
  return options.map((o) => `<option value="${o}" ${o === selected ? 'selected' : ''}>${o}</option>`).join('');
}
function dateVal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toISOString().slice(0, 10);
}
function todayVal() { return new Date().toISOString().slice(0, 10); }

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ---------------------------------------------------------------------- */

loadAll();
