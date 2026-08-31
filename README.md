# Retainr — a retainer/invoice tracker on Google Sheets

A small CRM-style tool built specifically for a retainer-based service business.
Google Sheets is the database, Google Apps Script is the API, and the frontend
is plain HTML/CSS/JS you host for free on GitHub Pages.

It answers one question at a glance: **when is money due, and how much am I
collecting month to month?**

---

## 1. What's in this folder

| File | Purpose |
|---|---|
| `Code.gs` | Apps Script backend — turns your Sheet into a JSON API and auto-generates upcoming retainer invoices |
| `index.html` / `style.css` / `app.js` | The frontend — dashboard, projects, invoices |
| `config.js` | Where you paste your deployed API URL |

---

## 2. The data model

Your original columns are kept, plus the fields needed to actually calculate
due dates and see trends. Two tabs instead of one, because a single retainer
contract produces *many* invoices over time — separating them is what makes
the forecast possible.

### `Projects` tab (one row per contract/engagement)

| Column | Notes |
|---|---|
| Project ID | Auto-generated |
| Project | |
| Client / Billing Entity | |
| Contact Email / Contact Phone | *(new)* for reminders later if you want them |
| Signed Document | link to the file |
| Fee Basis | `Retainer - Monthly`, `Retainer - Quarterly`, `Retainer - Half-Yearly`, `Fixed Duration`, `Project-Based`, or `Milestone-Based` |
| Total Fee (₹) | total contract value — used for Fixed Duration / Project-Based / Milestone-Based |
| Recurring Amount (₹) | *(new)* the per-cycle amount for retainers — this is what drives the forecast |
| Billing Cycle | Monthly / Quarterly / Half-Yearly / One-Time / Custom |
| Contract Start Date | *(new)* |
| Contract End Date | *(new)* leave blank for an open-ended retainer |
| Payment Terms | e.g. `Net 15`, `Advance` — the number of days is parsed automatically for due dates |
| Payment Trigger (summary) | kept as-is, free text |
| Project Status | Active / On Hold / Completed / Terminated — only **Active** retainers get auto-invoiced |
| Notes | |

### `Invoices` tab (one row per actual invoice — new)

| Column | Notes |
|---|---|
| Invoice ID | Auto-generated |
| Project ID / Project / Client / Billing Entity | linked back to the contract |
| Invoice Number | your own numbering, optional |
| Billing Period | e.g. "Sep 2026" |
| Amount (₹) | |
| Invoice Date | |
| Due Date | |
| Status | Scheduled / Sent / Paid / Partially Paid / Overdue / Cancelled |
| Amount Received (₹) | |
| Payment Date | |
| Notes | |

`Status` is auto-flagged **Overdue** whenever `Due Date` has passed and the
invoice isn't fully paid or cancelled — you don't have to set it by hand.

---

## 3. Set up the Google Sheet + backend

1. Create a new Google Sheet (or use your existing one).
2. **Extensions → Apps Script**. Delete the placeholder code and paste in the
   full contents of `Code.gs`.
3. In the Apps Script toolbar, select the function `setup` and click **Run**.
   - First run will ask you to authorize the script — approve it (it's only
     talking to your own Sheet).
   - This creates the `Projects` and `Invoices` tabs with headers, and sets
     up a daily trigger that checks for retainer invoices coming due.
4. If you already have data in the old single-tab format, copy it into the
   new `Projects` tab under the matching headers, and fill in `Recurring
   Amount (₹)`, `Billing Cycle`, and `Contract Start Date` for your retainer
   rows — that's what the auto-invoicing needs.
5. **Deploy → New deployment**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, then copy the web app URL (ends in `/exec`).

Every time you edit `Code.gs`, go to **Deploy → Manage deployments →
Edit → New version** so the live URL picks up your changes.

---

## 4. Set up the frontend

1. Open `config.js` and paste your deployment URL:
   ```js
   const API_URL = "https://script.google.com/macros/s/XXXXX/exec";
   ```
2. Push this folder to a GitHub repo.
3. In the repo, go to **Settings → Pages**, set the source to your default
   branch, and save. GitHub will give you a URL like
   `https://yourname.github.io/your-repo/`.
4. Open it — you should see the dashboard load your Sheet data.

No build step, no dependencies — it's plain HTML/CSS/JS, so this is all you
need.

---

## 5. Using it day to day

- **Add a project** from the Projects tab. For a retainer, set Fee Basis to
  one of the `Retainer - …` options, fill in Recurring Amount, Billing Cycle,
  and Contract Start Date — that's the minimum needed for forecasting to work.
- **Sync** (top right button) manually generates any retainer invoices that
  are due within the next 30 days. It also runs automatically once a day via
  the trigger created in `setup`, so in practice you rarely need to press it —
  it's there for right after you add a new retainer.
- **Fixed Duration / Project-Based / Milestone-Based** engagements don't
  auto-generate invoices — add those manually from the Invoices tab as
  milestones are hit.
- **Mark paid** on an invoice row is a one-click shortcut that sets status to
  Paid, amount received to the full amount, and payment date to today. Use
  "Edit" instead for partial payments.

### The dashboard

- **Collected this month** — actual money received, by payment date.
- **Trend chart** — 6 months back (invoiced, in blue, vs. collected, in
  green) and 6 months forward (projected, in grey) so you can see both
  collection lag and what's coming.
- **Outstanding / Upcoming / Overdue** cards — everything not yet paid,
  split by whether it's due soon or already late.
- **Monthly recurring value** — your active retainers normalized to a
  monthly figure, i.e. what you can rely on next month if nothing changes.

---

## 6. Notes and known limitations

- This uses Apps Script's built-in web app hosting rather than a real
  database, so it's best suited to a single practitioner or small team
  (a handful of concurrent editors) — Sheets isn't built for high write
  concurrency.
- The frontend calls the Apps Script URL directly from the browser. POST
  requests are sent as `text/plain` specifically to avoid a CORS preflight
  that Apps Script doesn't handle — don't change that content type.
- There's no login on the frontend. If your Sheet contains sensitive client
  data, don't make the GitHub Pages URL public — or add a shared-secret
  check in `doGet`/`doPost` (compare a token in `e.parameter`/`payload`
  against a value stored in Script Properties) before trusting requests.
- Currency is hardcoded to ₹ (Indian Rupees) formatting throughout, per the
  original sheet headers — search for `₹` in `app.js`/`Code.gs` to change it.
