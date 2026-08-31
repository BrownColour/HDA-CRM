/**
 * RETAINR — a lightweight CRM/billing tracker backed by Google Sheets.
 *
 * SETUP
 * 1. Open (or create) the Google Sheet you want to use as the database.
 * 2. Extensions -> Apps Script. Delete any starter code and paste this whole file in.
 * 3. Run the `setup` function once (Run menu -> select "setup" -> Run). It will:
 *      - create the "Projects" and "Invoices" tabs with headers if they don't exist
 *      - create a daily trigger that auto-generates upcoming retainer invoices
 * 4. Deploy -> New deployment -> type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Copy the deployment URL — that's your API_URL for the frontend (config.js).
 * 5. Whenever you edit this file, redeploy (Deploy -> Manage deployments -> edit -> new version).
 *
 * DATA MODEL
 * Projects sheet — one row per client engagement/contract.
 * Invoices sheet — one row per individual invoice/billing event tied to a project.
 * Keeping them separate lets a single retainer contract generate many invoices
 * over time, which is what powers the trend/forecast on the dashboard.
 */

const PROJECTS_SHEET = 'Projects';
const INVOICES_SHEET = 'Invoices';

const PROJECTS_HEADERS = [
  'Project ID',
  'Project',
  'Client / Billing Entity',
  'Contact Email',
  'Contact Phone',
  'Signed Document',
  'Fee Basis',
  'Total Fee (₹)',
  'Recurring Amount (₹)',
  'Billing Cycle',
  'Contract Start Date',
  'Contract End Date',
  'Payment Terms',
  'Payment Trigger (summary)',
  'Project Status',
  'Notes'
];

// Fee Basis values: "Retainer - Monthly", "Retainer - Quarterly", "Retainer - Half-Yearly",
//                    "Fixed Duration", "Project-Based", "Milestone-Based"
// Billing Cycle values: "Monthly", "Quarterly", "Half-Yearly", "One-Time", "Custom"
// Project Status values: "Active", "On Hold", "Completed", "Terminated"

const INVOICES_HEADERS = [
  'Invoice ID',
  'Project ID',
  'Project',
  'Client / Billing Entity',
  'Invoice Number',
  'Billing Period',
  'Amount (₹)',
  'Invoice Date',
  'Due Date',
  'Status',
  'Amount Received (₹)',
  'Payment Date',
  'Notes'
];

// Invoice Status values: "Scheduled", "Sent", "Paid", "Partially Paid", "Overdue", "Cancelled"
// ("Overdue" is computed on read for Sent/Scheduled invoices past their due date, but can
//  also be set manually.)

/* ---------------------------------------------------------------------- */
/* SETUP                                                                  */
/* ---------------------------------------------------------------------- */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, PROJECTS_SHEET, PROJECTS_HEADERS);
  ensureSheet_(ss, INVOICES_SHEET, INVOICES_HEADERS);

  // Remove any existing triggers for generateUpcomingInvoices to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'generateUpcomingInvoices') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('generateUpcomingInvoices')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  SpreadsheetApp.getUi().alert('Setup complete. "Projects" and "Invoices" tabs are ready, and a daily invoice-generation trigger has been created.');
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const hasHeaders = firstRow.join('') !== '';
  if (!hasHeaders) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

/* ---------------------------------------------------------------------- */
/* WEB APP ENTRY POINTS                                                   */
/* ---------------------------------------------------------------------- */

function doGet(e) {
  try {
    const action = e.parameter.action || 'ping';
    let result;
    switch (action) {
      case 'ping':
        result = { ok: true };
        break;
      case 'getProjects':
        result = getProjects_();
        break;
      case 'getInvoices':
        result = getInvoices_();
        break;
      case 'getDashboard':
        result = getDashboardData_();
        break;
      default:
        throw new Error('Unknown action: ' + action);
    }
    return jsonOut_({ success: true, data: result });
  } catch (err) {
    return jsonOut_({ success: false, error: err.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    let result;
    switch (action) {
      case 'addProject':
        result = addProject_(body.payload);
        break;
      case 'updateProject':
        result = updateProject_(body.payload);
        break;
      case 'deleteProject':
        result = deleteProject_(body.payload.projectId);
        break;
      case 'addInvoice':
        result = addInvoice_(body.payload);
        break;
      case 'updateInvoice':
        result = updateInvoice_(body.payload);
        break;
      case 'deleteInvoice':
        result = deleteInvoice_(body.payload.invoiceId);
        break;
      case 'generateUpcomingInvoices':
        result = generateUpcomingInvoices();
        break;
      default:
        throw new Error('Unknown action: ' + action);
    }
    return jsonOut_({ success: true, data: result });
  } catch (err) {
    return jsonOut_({ success: false, error: err.message });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------------------------------------------------- */
/* SHEET <-> OBJECT HELPERS                                               */
/* ---------------------------------------------------------------------- */

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found. Run setup() first.');
  return sheet;
}

function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = values.slice(1);
  return rows
    .filter(r => r.join('') !== '')
    .map((row, i) => {
      const obj = { _row: i + 2 }; // 1-indexed sheet row number
      headers.forEach((h, idx) => {
        obj[h] = row[idx] instanceof Date ? row[idx].toISOString() : row[idx];
      });
      return obj;
    });
}

function findRowById_(sheet, idHeader, idValue) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf(idHeader);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(idValue)) return i + 1;
  }
  return -1;
}

function writeRowFromObject_(sheet, headers, obj) {
  const row = headers.map(h => (obj[h] !== undefined ? obj[h] : ''));
  sheet.appendRow(row);
}

function updateRowFromObject_(sheet, headers, rowNum, obj) {
  const current = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  const updated = headers.map((h, i) => (obj[h] !== undefined ? obj[h] : current[i]));
  sheet.getRange(rowNum, 1, 1, headers.length).setValues([updated]);
}

function newId_(prefix) {
  return prefix + '-' + Utilities.getUuid().split('-')[0].toUpperCase();
}

/* ---------------------------------------------------------------------- */
/* PROJECTS                                                               */
/* ---------------------------------------------------------------------- */

function getProjects_() {
  return sheetToObjects_(getSheet_(PROJECTS_SHEET));
}

function addProject_(payload) {
  const sheet = getSheet_(PROJECTS_SHEET);
  payload['Project ID'] = payload['Project ID'] || newId_('PRJ');
  writeRowFromObject_(sheet, PROJECTS_HEADERS, payload);
  return payload;
}

function updateProject_(payload) {
  const sheet = getSheet_(PROJECTS_SHEET);
  const rowNum = findRowById_(sheet, 'Project ID', payload['Project ID']);
  if (rowNum === -1) throw new Error('Project not found: ' + payload['Project ID']);
  updateRowFromObject_(sheet, PROJECTS_HEADERS, rowNum, payload);
  return payload;
}

function deleteProject_(projectId) {
  const sheet = getSheet_(PROJECTS_SHEET);
  const rowNum = findRowById_(sheet, 'Project ID', projectId);
  if (rowNum === -1) throw new Error('Project not found: ' + projectId);
  sheet.deleteRow(rowNum);
  return { deleted: projectId };
}

/* ---------------------------------------------------------------------- */
/* INVOICES                                                               */
/* ---------------------------------------------------------------------- */

function getInvoices_() {
  const invoices = sheetToObjects_(getSheet_(INVOICES_SHEET));
  const today = new Date();
  invoices.forEach(inv => {
    const due = inv['Due Date'] ? new Date(inv['Due Date']) : null;
    const received = Number(inv['Amount Received (₹)']) || 0;
    const amount = Number(inv['Amount (₹)']) || 0;
    if (due && due < today && received < amount && inv['Status'] !== 'Paid' && inv['Status'] !== 'Cancelled') {
      inv['Status'] = 'Overdue';
    }
  });
  return invoices;
}

function addInvoice_(payload) {
  const sheet = getSheet_(INVOICES_SHEET);
  payload['Invoice ID'] = payload['Invoice ID'] || newId_('INV');
  payload['Status'] = payload['Status'] || 'Scheduled';
  writeRowFromObject_(sheet, INVOICES_HEADERS, payload);
  return payload;
}

function updateInvoice_(payload) {
  const sheet = getSheet_(INVOICES_SHEET);
  const rowNum = findRowById_(sheet, 'Invoice ID', payload['Invoice ID']);
  if (rowNum === -1) throw new Error('Invoice not found: ' + payload['Invoice ID']);
  updateRowFromObject_(sheet, INVOICES_HEADERS, rowNum, payload);
  return payload;
}

function deleteInvoice_(invoiceId) {
  const sheet = getSheet_(INVOICES_SHEET);
  const rowNum = findRowById_(sheet, 'Invoice ID', invoiceId);
  if (rowNum === -1) throw new Error('Invoice not found: ' + invoiceId);
  sheet.deleteRow(rowNum);
  return { deleted: invoiceId };
}

/* ---------------------------------------------------------------------- */
/* AUTO INVOICE GENERATION FOR RETAINERS                                  */
/* ---------------------------------------------------------------------- */

const CYCLE_MONTHS = {
  'Monthly': 1,
  'Quarterly': 3,
  'Half-Yearly': 6
};

function parsePaymentTermDays_(terms) {
  if (!terms) return 0;
  const m = String(terms).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

function addMonths_(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function monthLabel_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone() || 'Etc/UTC', 'MMM yyyy');
}

/**
 * Looks at all Active projects billed on a retainer basis and creates the
 * next scheduled invoice for any project that doesn't already have a future
 * or current-period invoice on file. Safe to run repeatedly (idempotent) —
 * it will not create a duplicate for a period that already exists.
 * Also callable manually from the dashboard ("Sync invoices" button).
 */
function generateUpcomingInvoices() {
  const projects = getProjects_();
  const invoices = getInvoices_();
  const created = [];
  const GENERATION_WINDOW_DAYS = 30; // generate invoices due within the next N days
  const today = new Date();
  const windowEnd = new Date(today.getTime() + GENERATION_WINDOW_DAYS * 86400000);

  projects
    .filter(p => p['Project Status'] === 'Active' && String(p['Fee Basis']).indexOf('Retainer') === 0)
    .forEach(p => {
      const cycleName = Object.keys(CYCLE_MONTHS).find(c => String(p['Fee Basis']).indexOf(c) !== -1) || p['Billing Cycle'];
      const cycleMonths = CYCLE_MONTHS[cycleName] || CYCLE_MONTHS[p['Billing Cycle']] || 1;
      const start = p['Contract Start Date'] ? new Date(p['Contract Start Date']) : null;
      if (!start) return;
      const end = p['Contract End Date'] ? new Date(p['Contract End Date']) : null;

      const projectInvoices = invoices.filter(i => i['Project ID'] === p['Project ID']);
      let nextPeriodStart;
      if (projectInvoices.length === 0) {
        nextPeriodStart = start;
      } else {
        // find the latest invoice date and step forward one cycle
        const latest = projectInvoices.reduce((max, i) => {
          const d = new Date(i['Invoice Date']);
          return d > max ? d : max;
        }, new Date(0));
        nextPeriodStart = addMonths_(latest, cycleMonths);
      }

      // walk forward generating any periods that fall inside the window,
      // in case the script hasn't run in a while
      while (nextPeriodStart <= windowEnd) {
        if (end && nextPeriodStart > end) break;

        const alreadyExists = projectInvoices.some(i => {
          const d = new Date(i['Invoice Date']);
          return Math.abs(d - nextPeriodStart) < 86400000; // same day
        });

        if (!alreadyExists) {
          const dueDate = new Date(nextPeriodStart.getTime() + parsePaymentTermDays_(p['Payment Terms']) * 86400000);
          const payload = {
            'Invoice ID': newId_('INV'),
            'Project ID': p['Project ID'],
            'Project': p['Project'],
            'Client / Billing Entity': p['Client / Billing Entity'],
            'Invoice Number': '',
            'Billing Period': monthLabel_(nextPeriodStart),
            'Amount (₹)': p['Recurring Amount (₹)'] || p['Total Fee (₹)'] || 0,
            'Invoice Date': nextPeriodStart.toISOString(),
            'Due Date': dueDate.toISOString(),
            'Status': 'Scheduled',
            'Amount Received (₹)': 0,
            'Payment Date': '',
            'Notes': 'Auto-generated'
          };
          addInvoice_(payload);
          created.push(payload);
        }
        nextPeriodStart = addMonths_(nextPeriodStart, cycleMonths);
      }
    });

  return { created: created.length, invoices: created };
}

/* ---------------------------------------------------------------------- */
/* DASHBOARD AGGREGATION                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Builds everything the dashboard needs in one call:
 *  - trailing 6 months of actually invoiced & collected amounts (from Invoices sheet)
 *  - forward 6 months forecast: known scheduled invoices PLUS a projection of
 *    recurring retainer income for active contracts, so you can see cashflow
 *    even before every future invoice row has been generated
 *  - upcoming dues (next 30 days), overdue list, and headline totals
 */
function getDashboardData_() {
  const projects = getProjects_();
  const invoices = getInvoices_();
  const today = new Date();
  const tz = Session.getScriptTimeZone() || 'Etc/UTC';

  const months = []; // array of {key, label, date}
  for (let i = -5; i <= 5; i++) {
    const d = addMonths_(new Date(today.getFullYear(), today.getMonth(), 1), i);
    months.push({
      key: Utilities.formatDate(d, tz, 'yyyy-MM'),
      label: Utilities.formatDate(d, tz, 'MMM yy'),
      date: d,
      isFuture: i > 0
    });
  }

  const invoicedByMonth = {};
  const collectedByMonth = {};
  months.forEach(m => { invoicedByMonth[m.key] = 0; collectedByMonth[m.key] = 0; });

  invoices.forEach(inv => {
    const amount = Number(inv['Amount (₹)']) || 0;
    const received = Number(inv['Amount Received (₹)']) || 0;
    if (inv['Invoice Date']) {
      const key = Utilities.formatDate(new Date(inv['Invoice Date']), tz, 'yyyy-MM');
      if (invoicedByMonth[key] !== undefined) invoicedByMonth[key] += amount;
    }
    if (inv['Payment Date'] && received > 0) {
      const key = Utilities.formatDate(new Date(inv['Payment Date']), tz, 'yyyy-MM');
      if (collectedByMonth[key] !== undefined) collectedByMonth[key] += received;
    }
  });

  // Forecast: for months in the future, add projected recurring income from
  // active retainer projects that don't already have a scheduled invoice
  // counted for that month (avoids double counting once generateUpcomingInvoices runs).
  const projectedByMonth = {};
  months.forEach(m => { projectedByMonth[m.key] = 0; });

  projects
    .filter(p => p['Project Status'] === 'Active' && String(p['Fee Basis']).indexOf('Retainer') === 0)
    .forEach(p => {
      const cycleName = Object.keys(CYCLE_MONTHS).find(c => String(p['Fee Basis']).indexOf(c) !== -1) || p['Billing Cycle'];
      const cycleMonths = CYCLE_MONTHS[cycleName] || CYCLE_MONTHS[p['Billing Cycle']] || 1;
      const amount = Number(p['Recurring Amount (₹)']) || 0;
      const end = p['Contract End Date'] ? new Date(p['Contract End Date']) : null;
      months.filter(m => m.isFuture).forEach(m => {
        if (end && m.date > end) return;
        // does an actual invoice already exist for this project in this month?
        const hasActual = invoices.some(i => i['Project ID'] === p['Project ID'] && i['Invoice Date'] &&
          Utilities.formatDate(new Date(i['Invoice Date']), tz, 'yyyy-MM') === m.key);
        if (hasActual) return;
        // does this month align with the billing cycle from contract start?
        const start = p['Contract Start Date'] ? new Date(p['Contract Start Date']) : null;
        if (!start) return;
        const monthsSinceStart = (m.date.getFullYear() - start.getFullYear()) * 12 + (m.date.getMonth() - start.getMonth());
        if (monthsSinceStart >= 0 && monthsSinceStart % cycleMonths === 0) {
          projectedByMonth[m.key] += amount;
        }
      });
    });

  const trend = months.map(m => ({
    month: m.label,
    invoiced: m.isFuture ? 0 : Math.round(invoicedByMonth[m.key]),
    collected: m.isFuture ? 0 : Math.round(collectedByMonth[m.key]),
    projected: m.isFuture ? Math.round(invoicedByMonth[m.key] + projectedByMonth[m.key]) : 0
  }));

  const in30 = new Date(today.getTime() + 30 * 86400000);
  const upcoming = invoices
    .filter(i => i['Due Date'] && i['Status'] !== 'Paid' && i['Status'] !== 'Cancelled')
    .filter(i => new Date(i['Due Date']) >= today && new Date(i['Due Date']) <= in30)
    .sort((a, b) => new Date(a['Due Date']) - new Date(b['Due Date']));

  const overdue = invoices
    .filter(i => i['Due Date'] && i['Status'] !== 'Paid' && i['Status'] !== 'Cancelled')
    .filter(i => new Date(i['Due Date']) < today)
    .sort((a, b) => new Date(a['Due Date']) - new Date(b['Due Date']));

  const outstandingTotal = invoices
    .filter(i => i['Status'] !== 'Paid' && i['Status'] !== 'Cancelled')
    .reduce((sum, i) => sum + ((Number(i['Amount (₹)']) || 0) - (Number(i['Amount Received (₹)']) || 0)), 0);

  const thisMonthKey = Utilities.formatDate(today, tz, 'yyyy-MM');
  const collectedThisMonth = Math.round(collectedByMonth[thisMonthKey] || 0);
  const invoicedThisMonth = Math.round(invoicedByMonth[thisMonthKey] || 0);

  const activeProjects = projects.filter(p => p['Project Status'] === 'Active').length;
  const monthlyRecurringValue = projects
    .filter(p => p['Project Status'] === 'Active' && String(p['Fee Basis']).indexOf('Retainer') === 0)
    .reduce((sum, p) => {
      const cycleName = Object.keys(CYCLE_MONTHS).find(c => String(p['Fee Basis']).indexOf(c) !== -1) || p['Billing Cycle'];
      const cycleMonths = CYCLE_MONTHS[cycleName] || CYCLE_MONTHS[p['Billing Cycle']] || 1;
      const amount = Number(p['Recurring Amount (₹)']) || 0;
      return sum + amount / cycleMonths;
    }, 0);

  return {
    trend,
    upcoming,
    overdue,
    outstandingTotal: Math.round(outstandingTotal),
    collectedThisMonth,
    invoicedThisMonth,
    activeProjects,
    monthlyRecurringValue: Math.round(monthlyRecurringValue)
  };
}
