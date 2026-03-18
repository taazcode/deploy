

/* ============================================================
   StoreBill — app.js
   Vanilla JS, no frameworks. Requires style.css + index.html
   ============================================================ */

"use strict";

// ── CONFIG ────────────────────────────────────────────────────────────────
// Replace the process.env lines with your actual keys
const SUPABASE_URL  = "https://wkbvamcmusaolmxdurhk.supabase.co"; // Your Supabase URL
const SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndrYnZhbWNtdXNhb2xteGR1cmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NTE3ODksImV4cCI6MjA4OTQyNzc4OX0.dp3WHwlUhLCKbNDf0zELzM3ocFrWvzGJiaIYVhR14xo"; // Use the full key from your .env
const ADMIN_PASSWORD = "admin123";
// ── SUPABASE API ──────────────────────────────────────────────────────────
async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
     "apikey": SUPABASE_KEY,
     "Authorization": `Bearer ${SUPABASE_KEY}`,
     "Content-Type": "application/json",
     ...(options.prefer ? { "Prefer": options.prefer } : {}), // Only send Prefer if needed
     ...(options.extraHeaders || {})
    },
    method:  options.method || "GET",
    body:    options.body   || undefined
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.hint || `HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

const api = {
  getItems:       ()        => sbFetch("items?order=name.asc"),
  addItem:        (d)       => sbFetch("items",                { method: "POST",  body: JSON.stringify(d) }),
  updateItem:     (id, d)   => sbFetch(`items?id=eq.${id}`,    { method: "PATCH", body: JSON.stringify(d) }),
  deleteItem:     (id)      => sbFetch(`items?id=eq.${id}`,    { method: "DELETE",prefer: "return=minimal", extraHeaders: { Prefer: "return=minimal" } }),

  getTransactions: ()       => sbFetch("transactions?order=created_at.desc&limit=500"),
  addTransaction:  (d)      => sbFetch("transactions",         { method: "POST",  body: JSON.stringify(d) }),

  getDues:        ()        => sbFetch("dues?order=created_at.desc"),
  addDue:         (d)       => sbFetch("dues",                 { method: "POST",  body: JSON.stringify(d) }),
  updateDue:      (id, d)   => sbFetch(`dues?id=eq.${id}`,     { method: "PATCH", body: JSON.stringify(d), extraHeaders: { Prefer: "return=representation" } }),
  deleteDue:      (id)      => sbFetch(`dues?id=eq.${id}`,     { method: "DELETE",extraHeaders: { Prefer: "return=minimal" } }),

  getStaff:       ()        => sbFetch("staff?order=created_at.desc"),
  addStaff:       (d)       => sbFetch("staff",                { method: "POST",  body: JSON.stringify(d) }),
  updateStaff:    (id, d)   => sbFetch(`staff?id=eq.${id}`,    { method: "PATCH", body: JSON.stringify(d), extraHeaders: { Prefer: "return=representation" } }),
};

// ── APP STATE ─────────────────────────────────────────────────────────────
const state = {
  panel:        "user",   // "user" | "admin"
  adminTab:     "items",  // "items" | "activity" | "dues" | "staff" | "reports"
  adminUnlocked: false,
  dbReady:      null,     // null | true | false
  items:        [],
  transactions: [],
  dues:         [],
  staff:        [],
  billItems:    [],
  overrideAmt:  "",
  editingItemId: null,
  editingDueId:  null,
  editingStaffId: null,
  reportType:   "eod",
};

// ── HELPERS ───────────────────────────────────────────────────────────────
const fmt     = n  => "₹" + Number(n || 0).toFixed(2);
const fmtDate = d  => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const today   = () => new Date().toISOString().split("T")[0];
const thisMonth = () => new Date().toISOString().slice(0, 7);
const uid     = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

function el(id)  { return document.getElementById(id); }
function val(id) { return el(id) ? el(id).value.trim() : ""; }
function setHTML(id, html) { if (el(id)) el(id).innerHTML = html; }
function show(id) { if (el(id)) el(id).classList.remove("hidden"); }
function hide(id) { if (el(id)) el(id).classList.add("hidden"); }
function showToast(msg, ok = true) {
  const t = el("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = "toast " + (ok ? "ok" : "error");
  show("toast");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => hide("toast"), 3000);
}

// ── INIT ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  el("btn-panel-user").addEventListener("click",  () => switchPanel("user"));
  el("btn-panel-admin").addEventListener("click", () => switchPanel("admin"));
  el("btn-refresh").addEventListener("click", loadAll);

  // Admin tabs
  ["items","activity","dues","staff","reports"].forEach(tab => {
    el(`tab-${tab}`).addEventListener("click", () => switchAdminTab(tab));
  });

  // Admin login
  el("btn-admin-login").addEventListener("click", adminLogin);
  el("admin-pw-input").addEventListener("keydown", e => { if (e.key === "Enter") adminLogin(); });
  el("btn-admin-lock").addEventListener("click",  () => { state.adminUnlocked = false; renderAdmin(); });

  // DB setup modal
  el("btn-setup-db").addEventListener("click",  () => show("modal-setup"));
  el("btn-setup-db2").addEventListener("click", () => show("modal-setup"));
  el("btn-modal-close").addEventListener("click", () => hide("modal-setup"));
  el("btn-copy-sql").addEventListener("click",  copySQL);
  el("btn-modal-done").addEventListener("click", () => { hide("modal-setup"); loadAll(); });

  // Billing form
  el("bill-item-select").addEventListener("change", onItemSelect);
  el("btn-add-bill-item").addEventListener("click", addBillItem);
  el("bill-discount").addEventListener("input", updateBillSummary);
  el("bill-override-amt").addEventListener("input", updateBillSummary);
  el("btn-save-bill").addEventListener("click", saveBill);

  // Admin - items
  el("btn-add-item").addEventListener("click", addItem);

  // Admin - dues
  el("btn-add-due").addEventListener("click", addDue);

  // Admin - staff
  el("btn-add-staff").addEventListener("click", addStaff);

  // Reports
  ["rpt-eod","rpt-weekly","rpt-monthly"].forEach(id => {
    el(id).addEventListener("click", () => {
      state.reportType = id.replace("rpt-","");
      renderReportControls();
      renderReportTable();
    });
  });
  ["rpt-date","rpt-week-date","rpt-month"].forEach(id => {
    el(id).addEventListener("change", renderReportTable);
  });
  el("btn-dl-txt").addEventListener("click", () => downloadReport("txt"));
  el("btn-dl-csv").addEventListener("click", () => downloadReport("csv"));

  // Set default dates
  el("bill-date").value    = today();
  el("rpt-date").value     = today();
  el("rpt-week-date").value = today();
  el("rpt-month").value    = thisMonth();
  el("staff-month").value  = thisMonth();

  loadAll();
});

// ── DATA LOADING ──────────────────────────────────────────────────────────
async function loadAll() {
  show("spinner");
  hide("db-error");
  hide("app-content");
  setHTML("header-status", "CONNECTING…");
  el("header-status").className = "header-status status-loading";

  try {
    const [items, txns, dues, staff] = await Promise.all([
      api.getItems(), api.getTransactions(), api.getDues(), api.getStaff()
    ]);
    state.items        = items;
    state.transactions = txns;
    state.dues         = dues;
    state.staff        = staff;
    state.dbReady      = true;

    setHTML("header-status", "● SUPABASE LIVE");
    el("header-status").className = "header-status status-live";
    hide("btn-setup-db");
    hide("spinner");
    show("app-content");
    renderAll();
  } catch (e) {
    state.dbReady = false;
    setHTML("header-status", "⚠ DB SETUP NEEDED");
    el("header-status").className = "header-status status-error";
    show("btn-setup-db");
    hide("spinner");
    show("db-error");
  }
}

// ── PANEL SWITCHING ───────────────────────────────────────────────────────
function switchPanel(p) {
  state.panel = p;
  el("btn-panel-user").classList.toggle("active", p === "user");
  el("btn-panel-admin").classList.toggle("active", p === "admin");
  hide("panel-user");
  hide("panel-admin");
  show(`panel-${p}`);
  if (p === "admin") renderAdmin();
  if (p === "user")  renderUserPanel();
}

function switchAdminTab(tab) {
  state.adminTab = tab;
  ["items","activity","dues","staff","reports"].forEach(t => {
    el(`tab-${t}`).classList.toggle("active", t === tab);
  });
  ["items","activity","dues","staff","reports"].forEach(t => {
    const s = el(`admin-section-${t}`); if (s) s.classList.toggle("hidden", t !== tab);
  });
  renderAdminTab(tab);
}

// ── RENDER ALL ────────────────────────────────────────────────────────────
function renderAll() {
  renderUserPanel();
  populateItemSelect();
  renderAdmin();
}

// ── USER PANEL ────────────────────────────────────────────────────────────
function renderUserPanel() {
  populateItemSelect();
  renderBillTable();
  renderBillSummary();
  renderRecentTransactions();
}

function populateItemSelect() {
  const sel = el("bill-item-select");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">-- Select Item --</option>';
  state.items.forEach(item => {
    const opt = document.createElement("option");
    opt.value       = item.id;
    opt.textContent = `${item.name} (${item.type === "kg" ? "per kg" : "fixed"})`;
    sel.appendChild(opt);
  });
  sel.value = cur;
}

function onItemSelect() {
  const id = val("bill-item-select");
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  el("bill-unit-price").value = item.price;
  // Toggle qty / kg field
  if (item.type === "kg") {
    el("field-qty").classList.add("hidden");
    el("field-kg").classList.remove("hidden");
  } else {
    el("field-kg").classList.add("hidden");
    el("field-qty").classList.remove("hidden");
  }
  updateLineTotal();
}

function updateLineTotal() {
  const id   = val("bill-item-select");
  const item = state.items.find(i => i.id === id);
  const price = parseFloat(el("bill-unit-price").value) || 0;
  let lt = 0;
  if (item && item.type === "kg") {
    lt = price * (parseFloat(val("bill-kg")) || 0);
  } else {
    lt = price * (parseFloat(val("bill-qty")) || 1);
  }
  setHTML("bill-line-total", fmt(lt));
}

// Add event listeners for live line total update
document.addEventListener("DOMContentLoaded", () => {
  ["bill-unit-price","bill-qty","bill-kg"].forEach(id => {
    const e = el(id); if (e) e.addEventListener("input", updateLineTotal);
  });
});

function addBillItem() {
  const id   = val("bill-item-select");
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  const price = parseFloat(el("bill-unit-price").value) || 0;
  const qty   = parseFloat(val("bill-qty")) || 1;
  const kg    = parseFloat(val("bill-kg"))  || 0;
  const lt    = item.type === "kg" ? price * kg : price * qty;
  const desc  = item.type === "kg" ? `${item.name} ×${kg}kg` : `${item.name} ×${qty}`;

  state.billItems.push({ id: uid(), name: item.name, type: item.type, price, qty, kg, lt, desc });

  // Reset item fields
  el("bill-item-select").value = "";
  el("bill-unit-price").value  = "";
  el("bill-qty").value         = "";
  el("bill-kg").value          = "";
  el("field-kg").classList.add("hidden");
  el("field-qty").classList.remove("hidden");
  setHTML("bill-line-total", "₹0.00");

  renderBillTable();
  updateBillSummary();
}

function removeBillItem(uid) {
  state.billItems = state.billItems.filter(b => b.id !== uid);
  renderBillTable();
  updateBillSummary();
}

function renderBillTable() {
  const wrap = el("bill-items-wrap");
  if (!wrap) return;
  if (!state.billItems.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  setHTML("bill-items-body", state.billItems.map(b => `
    <tr>
      <td>${b.name}</td>
      <td>${fmt(b.price)}</td>
      <td>${b.type === "kg" ? b.kg + "kg" : "×" + (b.qty||1)}</td>
      <td class="amount">${fmt(b.lt)}</td>
      <td><button class="btn-outline-red" onclick="removeBillItem('${b.id}')">✕</button></td>
    </tr>`).join(""));
}

function updateBillSummary() {
  const sub       = state.billItems.reduce((s, b) => s + b.lt, 0);
  const discPct   = parseFloat(el("bill-discount").value) || 0;
  const discAmt   = sub * discPct / 100;
  const override  = el("bill-override-amt").value;
  const finalAmt  = override !== "" ? parseFloat(override) : sub - discAmt;

  window._billCalc = { sub, discAmt, discPct, finalAmt };
  renderBillSummary();
}

function renderBillSummary() {
  const calc    = window._billCalc || { sub: 0, discAmt: 0, discPct: 0, finalAmt: 0 };
  const customer = val("bill-customer");
  const date     = val("bill-date");
  const txType   = val("bill-tx-type");

  setHTML("summary-customer", customer || "—");
  setHTML("summary-date",     date);
  setHTML("summary-items",    state.billItems.length);
  setHTML("summary-subtotal", fmt(calc.sub));
  setHTML("summary-discount", `-${fmt(calc.discAmt)} (${calc.discPct || 0}%)`);
  setHTML("summary-payment",  (txType || "cash").toUpperCase());
  setHTML("summary-final",    fmt(calc.finalAmt));
}

async function saveBill() {
  const customer = val("bill-customer");
  if (!customer || !state.billItems.length) {
    showToast("Enter customer name and add at least one item.", false); return;
  }
  const calc   = window._billCalc || {};
  const payload = {
    customer,
    date:             val("bill-date"),
    items:            state.billItems,
    subtotal:         calc.sub || 0,
    discount:         parseFloat(el("bill-discount").value) || 0,
    discount_amt:     calc.discAmt || 0,
    final_amount:     calc.finalAmt || 0,
    transaction_type: val("bill-tx-type"),
    note:             val("bill-note")
  };

  el("btn-save-bill").disabled   = true;
  el("btn-save-bill").textContent = "⏳ Saving…";

  try {
    const [saved] = await api.addTransaction(payload);
    state.transactions.unshift(saved);

    // Show saved bill
    setHTML("saved-id",     "#" + (saved.id || "").slice(-6).toUpperCase());
    setHTML("saved-name",   saved.customer);
    setHTML("saved-date",   fmtDate(saved.date));
    setHTML("saved-amount", fmt(saved.final_amount));
    show("saved-bill-card");

    // Reset
    state.billItems = [];
    state.overrideAmt = "";
    el("bill-customer").value = "";
    el("bill-date").value     = today();
    el("bill-discount").value = "0";
    el("bill-override-amt").value = "";
    el("bill-note").value     = "";
    window._billCalc = {};
    renderBillTable();
    renderBillSummary();
    renderRecentTransactions();
    showToast("Bill saved to Supabase ✓");
  } catch (e) {
    showToast("Error: " + e.message, false);
  } finally {
    el("btn-save-bill").disabled    = false;
    el("btn-save-bill").textContent = "💾 Save Bill";
  }
}

function renderRecentTransactions() {
  const wrap = el("recent-list");
  if (!wrap) return;
  const rows = state.transactions.slice(0, 6);
  if (!rows.length) { setHTML("recent-list", '<p class="text-muted" style="font-size:13px">No transactions yet</p>'); return; }
  setHTML("recent-list", rows.map(t => `
    <div class="recent-row">
      <div>
        <div class="recent-name">${t.customer}</div>
        <div class="recent-meta">${fmtDate(t.date)} · ${(t.transaction_type || "cash").toUpperCase()}</div>
      </div>
      <div class="recent-amt">${fmt(t.final_amount)}</div>
    </div>`).join(""));
}

// ── ADMIN ─────────────────────────────────────────────────────────────────
function renderAdmin() {
  if (!state.adminUnlocked) {
    show("admin-login-box");
    hide("admin-content");
    hide("btn-admin-lock");
  } else {
    hide("admin-login-box");
    show("admin-content");
    show("btn-admin-lock");
    renderAdminTab(state.adminTab);
  }
}

function adminLogin() {
  if (el("admin-pw-input").value === ADMIN_PASSWORD) {
    state.adminUnlocked = true;
    el("admin-pw-input").value = "";
    hide("admin-pw-error");
    renderAdmin();
  } else {
    show("admin-pw-error");
  }
}

function renderAdminTab(tab) {
  if (tab === "items")    renderItemsManager();
  if (tab === "activity") renderActivity();
  if (tab === "dues")     renderDues();
  if (tab === "staff")    renderStaff();
  if (tab === "reports")  { renderReportControls(); renderReportTable(); }
}

// ── ITEMS MANAGER ─────────────────────────────────────────────────────────
function renderItemsManager() {
  const list = el("items-list");
  if (!list) return;
  if (!state.items.length) { setHTML("items-list", '<p class="text-muted" style="font-size:13px">No items yet.</p>'); return; }

  setHTML("items-list", state.items.map(item => {
    if (state.editingItemId === item.id) {
      return `
        <div class="item-row">
          <div class="flex-row gap-8">
            <input id="ei-name"  value="${esc(item.name)}"  style="flex:2;min-width:90px">
            <select id="ei-type" style="flex:1">
              <option value="fixed" ${item.type==="fixed"?"selected":""}>Fixed</option>
              <option value="kg"    ${item.type==="kg"   ?"selected":""}>Per Kg</option>
            </select>
            <input id="ei-price" type="number" value="${item.price}" style="flex:1;min-width:70px">
            <button class="btn-sm-confirm" onclick="saveItemEdit('${item.id}')">✓</button>
            <button class="btn-sm-cancel"  onclick="cancelItemEdit()">✕</button>
          </div>
        </div>`;
    }
    return `
      <div class="item-row">
        <div class="item-row-inner">
          <div>
            <span class="item-name">${esc(item.name)}</span>
            <span class="badge-type">${item.type === "kg" ? "per kg" : "fixed"}</span>
          </div>
          <div class="item-actions">
            <span class="item-price">${fmt(item.price)}</span>
            <button class="btn-outline-muted" onclick="startItemEdit('${item.id}')">Edit</button>
            <button class="btn-outline-red"   onclick="deleteItem('${item.id}')">✕</button>
          </div>
        </div>
      </div>`;
  }).join(""));
}

async function addItem() {
  const name  = val("new-item-name");
  const type  = val("new-item-type");
  const price = parseFloat(val("new-item-price"));
  if (!name || isNaN(price)) { showToast("Name and price are required.", false); return; }
  try {
    const [r] = await api.addItem({ name, type, price });
    state.items.push(r);
    state.items.sort((a,b) => a.name.localeCompare(b.name));
    el("new-item-name").value  = "";
    el("new-item-price").value = "";
    renderItemsManager();
    populateItemSelect();
    setHTML("items-count", state.items.length);
    showToast("Item added!");
  } catch (e) { showToast(e.message, false); }
}

function startItemEdit(id) { state.editingItemId = id; renderItemsManager(); }
function cancelItemEdit()   { state.editingItemId = null; renderItemsManager(); }

async function saveItemEdit(id) {
  const name  = el("ei-name")  ? el("ei-name").value.trim()  : "";
  const type  = el("ei-type")  ? el("ei-type").value         : "fixed";
  const price = el("ei-price") ? parseFloat(el("ei-price").value) : 0;
  if (!name) { showToast("Name required.", false); return; }
  try {
    const [r] = await api.updateItem(id, { name, type, price });
    state.items = state.items.map(i => i.id === id ? r : i);
    state.items.sort((a,b) => a.name.localeCompare(b.name));
    state.editingItemId = null;
    renderItemsManager();
    populateItemSelect();
    showToast("Item updated!");
  } catch (e) { showToast(e.message, false); }
}

async function deleteItem(id) {
  if (!confirm("Delete this item?")) return;
  try {
    await api.deleteItem(id);
    state.items = state.items.filter(i => i.id !== id);
    renderItemsManager();
    populateItemSelect();
    setHTML("items-count", state.items.length);
    showToast("Item deleted.");
  } catch (e) { showToast(e.message, false); }
}

// ── ACTIVITY ──────────────────────────────────────────────────────────────
function renderActivity() {
  const view  = el("activity-view") ? el("activity-view").value : "daily";
  const date  = el("activity-date")  ? el("activity-date").value  : today();
  const month = el("activity-month") ? el("activity-month").value : thisMonth();

  const data = state.transactions.filter(t =>
    view === "daily" ? t.date === date : t.date && t.date.startsWith(month)
  );
  const total = data.reduce((s,t) => s + Number(t.final_amount||0), 0);

  setHTML("act-count",   data.length);
  setHTML("act-revenue", fmt(total));
  setHTML("act-avg",     data.length ? fmt(total / data.length) : "₹0");

  if (!data.length) {
    setHTML("activity-tbody", `<tr><td colspan="6" class="text-muted" style="text-align:center;padding:24px">No transactions found</td></tr>`);
    return;
  }
  setHTML("activity-tbody", data.map(t => `
    <tr>
      <td>${esc(t.customer)}</td>
      <td>${fmtDate(t.date)}</td>
      <td>${Array.isArray(t.items) ? t.items.length : 0}</td>
      <td><span class="badge">${(t.transaction_type||"cash").toUpperCase()}</span></td>
      <td>${t.discount||0}%</td>
      <td class="amount">${fmt(t.final_amount)}</td>
    </tr>`).join(""));
  setHTML("act-total", fmt(total));
}

document.addEventListener("DOMContentLoaded", () => {
  const av = el("activity-view");
  if (av) av.addEventListener("change", () => {
    if (av.value === "daily") { show("activity-date-wrap"); hide("activity-month-wrap"); }
    else                      { hide("activity-date-wrap"); show("activity-month-wrap"); }
    renderActivity();
  });
  const ad = el("activity-date");  if (ad) ad.addEventListener("change", renderActivity);
  const am = el("activity-month"); if (am) am.addEventListener("change", renderActivity);

  if (el("activity-date"))  el("activity-date").value  = today();
  if (el("activity-month")) el("activity-month").value = thisMonth();
});

// ── DUES ──────────────────────────────────────────────────────────────────
function renderDues() {
  const cust = state.dues.filter(d => d.type === "customer");
  const vend = state.dues.filter(d => d.type === "vendor");

  setHTML("dues-cust-total", fmt(cust.reduce((s,d)=>s+d.amount,0)));
  setHTML("dues-vend-total", fmt(vend.reduce((s,d)=>s+d.amount,0)));

  renderDueList("dues-cust-list", cust);
  renderDueList("dues-vend-list", vend);
}

function renderDueList(containerId, data) {
  if (!data.length) {
    setHTML(containerId, '<p class="text-muted" style="font-size:13px">No entries</p>');
    return;
  }
  setHTML(containerId, data.map(d => {
    if (state.editingDueId === d.id) {
      return `
        <div class="due-row">
          <div>
            <div class="due-name">${esc(d.name)}</div>
            <div class="due-meta">${esc(d.note||"")} · ${fmtDate(d.created_at)}</div>
          </div>
          <div class="flex-row gap-8">
            <input id="de-amt" type="number" value="${d.amount}" style="width:100px">
            <button class="btn-sm-confirm" onclick="saveDueEdit('${d.id}')">✓</button>
            <button class="btn-sm-cancel"  onclick="cancelDueEdit()">✕</button>
          </div>
        </div>`;
    }
    return `
      <div class="due-row">
        <div>
          <div class="due-name">${esc(d.name)}</div>
          <div class="due-meta">${esc(d.note||"")} · ${fmtDate(d.created_at)}</div>
        </div>
        <div class="flex-row gap-8">
          <span class="text-gold text-bold">${fmt(d.amount)}</span>
          <button class="btn-outline-muted" onclick="startDueEdit('${d.id}')">Edit</button>
          <button class="btn-outline-red"   onclick="deleteDue('${d.id}')">✕</button>
        </div>
      </div>`;
  }).join(""));
}

async function addDue() {
  const name   = val("due-name");
  const type   = val("due-type");
  const amount = parseFloat(val("due-amount"));
  const note   = val("due-note");
  if (!name || isNaN(amount)) { showToast("Name and amount required.", false); return; }
  try {
    const [r] = await api.addDue({ name, type, amount, note });
    state.dues.unshift(r);
    el("due-name").value = ""; el("due-amount").value = ""; el("due-note").value = "";
    renderDues();
    showToast("Due entry added!");
  } catch (e) { showToast(e.message, false); }
}

function startDueEdit(id) { state.editingDueId = id; renderDues(); }
function cancelDueEdit()   { state.editingDueId = null; renderDues(); }

async function saveDueEdit(id) {
  const amt = parseFloat(el("de-amt") ? el("de-amt").value : 0);
  try {
    const [r] = await api.updateDue(id, { amount: amt });
    state.dues = state.dues.map(d => d.id === id ? r : d);
    state.editingDueId = null;
    renderDues();
    showToast("Amount updated!");
  } catch (e) { showToast(e.message, false); }
}

async function deleteDue(id) {
  if (!confirm("Remove this due entry?")) return;
  try {
    await api.deleteDue(id);
    state.dues = state.dues.filter(d => d.id !== id);
    renderDues();
    showToast("Entry removed.");
  } catch (e) { showToast(e.message, false); }
}

// ── STAFF ─────────────────────────────────────────────────────────────────
function renderStaff() {
  const list = el("staff-list");
  if (!list) return;
  setHTML("staff-count", state.staff.length);
  if (!state.staff.length) {
    setHTML("staff-tbody", `<tr><td colspan="7" class="text-muted" style="text-align:center;padding:24px">No staff added</td></tr>`);
    return;
  }
  setHTML("staff-tbody", state.staff.map(s => {
    const bal = s.salary - s.paid;
    if (state.editingStaffId === s.id) {
      return `
        <tr>
          <td><input id="se-name"   value="${esc(s.name)}"  style="width:100px"></td>
          <td><input id="se-role"   value="${esc(s.role||"")}" style="width:90px"></td>
          <td><input id="se-month"  type="month" value="${s.month||""}" style="width:110px"></td>
          <td><input id="se-sal"    type="number" value="${s.salary}" style="width:90px"></td>
          <td><input id="se-paid"   type="number" value="${s.paid}"   style="width:90px"></td>
          <td></td>
          <td>
            <button class="btn-sm-confirm" onclick="saveStaffEdit('${s.id}')" style="margin-right:4px">✓</button>
            <button class="btn-sm-cancel"  onclick="cancelStaffEdit()">✕</button>
          </td>
        </tr>`;
    }
    return `
      <tr>
        <td><b>${esc(s.name)}</b></td>
        <td>${esc(s.role||"—")}</td>
        <td>${s.month||"—"}</td>
        <td>${fmt(s.salary)}</td>
        <td class="text-green">${fmt(s.paid)}</td>
        <td class="${bal > 0 ? "text-red" : "text-green"}">${fmt(bal)}</td>
        <td><button class="btn-outline-muted" onclick="startStaffEdit('${s.id}')">Edit</button></td>
      </tr>`;
  }).join(""));
}

async function addStaff() {
  const name   = val("staff-name");
  const role   = val("staff-role");
  const salary = parseFloat(val("staff-salary"));
  const paid   = parseFloat(val("staff-paid")) || 0;
  const month  = val("staff-month");
  if (!name || isNaN(salary)) { showToast("Name and salary required.", false); return; }
  try {
    const [r] = await api.addStaff({ name, role, salary, paid, month });
    state.staff.unshift(r);
    el("staff-name").value = ""; el("staff-role").value = ""; el("staff-salary").value = ""; el("staff-paid").value = "";
    renderStaff();
    showToast("Staff added!");
  } catch (e) { showToast(e.message, false); }
}

function startStaffEdit(id) { state.editingStaffId = id; renderStaff(); }
function cancelStaffEdit()   { state.editingStaffId = null; renderStaff(); }

async function saveStaffEdit(id) {
  const g = id => el(id) ? el(id).value : "";
  try {
    const [r] = await api.updateStaff(id, {
      name:   g("se-name"), role: g("se-role"), month: g("se-month"),
      salary: parseFloat(g("se-sal"))  || 0,
      paid:   parseFloat(g("se-paid")) || 0
    });
    state.staff = state.staff.map(s => s.id === id ? r : s);
    state.editingStaffId = null;
    renderStaff();
    showToast("Staff updated!");
  } catch (e) { showToast(e.message, false); }
}

// ── REPORTS ───────────────────────────────────────────────────────────────
function renderReportControls() {
  const rt = state.reportType;
  ["eod","weekly","monthly"].forEach(r => {
    el(`rpt-${r}`).classList.toggle("active", r === rt);
  });
  el("rpt-date-wrap").classList.toggle("hidden",    rt !== "eod");
  el("rpt-week-wrap").classList.toggle("hidden",    rt !== "weekly");
  el("rpt-month-wrap").classList.toggle("hidden",   rt !== "monthly");
}

function getReportData() {
  const rt = state.reportType;
  const date  = val("rpt-date");
  const wk    = val("rpt-week-date");
  const month = val("rpt-month");
  if (rt === "eod")     return state.transactions.filter(t => t.date === date);
  if (rt === "weekly")  {
    const s = new Date(wk), e = new Date(wk); e.setDate(e.getDate() + 6);
    return state.transactions.filter(t => { const d = new Date(t.date); return d >= s && d <= e; });
  }
  return state.transactions.filter(t => t.date && t.date.startsWith(month));
}

function renderReportTable() {
  const data  = getReportData();
  const total = data.reduce((s,t) => s + Number(t.final_amount||0), 0);

  setHTML("rpt-count",   data.length);
  setHTML("rpt-revenue", fmt(total));
  setHTML("rpt-avg",     data.length ? fmt(total / data.length) : "₹0");

  if (!data.length) {
    setHTML("rpt-tbody", `<tr><td colspan="6" style="text-align:center;padding:36px;color:var(--muted3)">No transactions in this period</td></tr>`);
    setHTML("rpt-total", "₹0.00");
    return;
  }
  setHTML("rpt-tbody", data.map(t => `
    <tr>
      <td>${esc(t.customer)}</td>
      <td>${fmtDate(t.date)}</td>
      <td>${Array.isArray(t.items) ? t.items.length : 0}</td>
      <td><span class="badge">${(t.transaction_type||"cash").toUpperCase()}</span></td>
      <td>${t.discount||0}%</td>
      <td class="amount">${fmt(t.final_amount)}</td>
    </tr>`).join(""));
  setHTML("rpt-total", fmt(total));
}

function downloadReport(type) {
  const data  = getReportData();
  const total = data.reduce((s,t) => s + Number(t.final_amount||0), 0);
  const rt    = state.reportType;
  const label = rt === "eod" ? `EOD-${val("rpt-date")}` : rt === "weekly" ? `Weekly-${val("rpt-week-date")}` : `Monthly-${val("rpt-month")}`;

  let content = "", mime = "", ext = "";

  if (type === "txt") {
    const sep = "=".repeat(56);
    const lines = [sep, "             STOREBILL REPORT", `  ${label}`, sep,
      `Generated: ${new Date().toLocaleString("en-IN")}`,
      `Transactions: ${data.length}  |  Revenue: ${fmt(total)}`,
      "-".repeat(56)];
    data.forEach((t,i) => {
      lines.push(`${i+1}. ${t.customer} | ${fmtDate(t.date)} | ${(t.transaction_type||"").toUpperCase()} | ${fmt(t.final_amount)}`);
      (Array.isArray(t.items) ? t.items : []).forEach(x => lines.push(`   - ${x.desc||x.name}: ${fmt(x.lt||x.lineTotal||0)}`));
      if (t.discount > 0) lines.push(`   Discount: ${t.discount}% (-${fmt(t.discount_amt)})`);
    });
    lines.push(sep, `TOTAL: ${fmt(total)}`, sep);
    content = lines.join("\n"); mime = "text/plain"; ext = "txt";
  } else {
    const rows = [["#","Customer","Date","Items","Payment","Subtotal","Discount%","Final Amount"]];
    data.forEach((t,i) => rows.push([i+1, t.customer, t.date, Array.isArray(t.items)?t.items.length:0,
      t.transaction_type||"", Number(t.subtotal||0).toFixed(2), t.discount||0, Number(t.final_amount||0).toFixed(2)]));
    content = rows.map(r => r.join(",")).join("\n"); mime = "text/csv"; ext = "csv";
  }

  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([content], { type: mime })),
    download: `${label}.${ext}`
  });
  a.click();
}

// ── COPY SQL ──────────────────────────────────────────────────────────────
const SETUP_SQL = `create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'fixed',
  price numeric not null default 0,
  created_at timestamptz default now()
);
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  customer text not null,
  date date not null,
  items jsonb,
  subtotal numeric,
  discount numeric default 0,
  discount_amt numeric default 0,
  final_amount numeric,
  transaction_type text,
  note text,
  created_at timestamptz default now()
);
create table if not exists dues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null,
  amount numeric not null default 0,
  note text,
  created_at timestamptz default now()
);
create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text,
  salary numeric default 0,
  paid numeric default 0,
  month text,
  created_at timestamptz default now()
);`;

function copySQL() {
  navigator.clipboard.writeText(SETUP_SQL).then(() => {
    el("btn-copy-sql").textContent = "✓ Copied!";
    setTimeout(() => { el("btn-copy-sql").textContent = "📋 Copy SQL"; }, 2000);
  });
}

// ── ESCAPE HTML ───────────────────────────────────────────────────────────
function esc(str) {
  return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── EXPOSE TO HTML onclick ────────────────────────────────────────────────
window.removeBillItem  = removeBillItem;
window.startItemEdit   = startItemEdit;
window.cancelItemEdit  = cancelItemEdit;
window.saveItemEdit    = saveItemEdit;
window.deleteItem      = deleteItem;
window.startDueEdit    = startDueEdit;
window.cancelDueEdit   = cancelDueEdit;
window.saveDueEdit     = saveDueEdit;
window.deleteDue       = deleteDue;
window.startStaffEdit  = startStaffEdit;
window.cancelStaffEdit = cancelStaffEdit;
window.saveStaffEdit   = saveStaffEdit;
