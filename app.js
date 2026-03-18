/**
 * BillingPro - Application Logic
 * Backend: Supabase
 */

// --- SUPABASE CLIENT ---
const SUPABASE_URL = 'https://lphokjzfjhejeltkcdqp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_EKAZajhaXEoTJ-lSImEF0Q_T3YdLYcl';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- STATE MANAGEMENT ---
const AppState = {
    items: [],       // [{ id, name, price, type }]
    currentBill: [], // [{ id, itemId, name, price, type, qty, total }]
    dailyBills: [],  // Today's bills, filtered from allBills on load
    dues: [],        // [{ id, name, amount, date, type }]
    monthlyRevenue: { month: new Date().toISOString().slice(0, 7), total: 0 },
    staffPayments: [],// [{ id, name, type, amount, date }]
    allBills: [],    // All bills ever, from Supabase 'bills' table

    async init() {
        await this.loadData();
        const dateInput = document.getElementById('billDate');
        if (dateInput) {
            const today = new Date().toISOString().split('T')[0];
            dateInput.value = today;
        }
    },

    async loadData() {
        try {
            // Fetch all tables in parallel
            const [
                itemsRes,
                billsRes,
                duesRes,
                staffRes,
                monthlyRes
            ] = await Promise.all([
                supabase.from('items').select('*'),
                supabase.from('bills').select('*').order('created_at', { ascending: false }),
                supabase.from('dues').select('*'),
                supabase.from('staff_payments').select('*'),
                supabase.from('monthly_revenue').select('*').eq('month', new Date().toISOString().slice(0, 7)).maybeSingle()
            ]);

            if (itemsRes.error) throw itemsRes.error;
            if (billsRes.error) throw billsRes.error;
            if (duesRes.error) throw duesRes.error;
            if (staffRes.error) throw staffRes.error;

            // Map items (snake_case → camelCase)
            this.items = (itemsRes.data || []).map(i => ({
                id: i.id, name: i.name, price: parseFloat(i.price), type: i.type
            }));

            // Map bills
            this.allBills = (billsRes.data || []).map(b => this._mapBillFromDB(b));

            // Derive today's bills
            const today = new Date().toISOString().split('T')[0];
            this.dailyBills = this.allBills.filter(b => b.date === today);

            // Map dues
            this.dues = (duesRes.data || []).map(d => ({
                id: d.id, name: d.name,
                amount: parseFloat(d.amount),
                date: d.date, type: d.type
            }));

            // Map staff
            this.staffPayments = (staffRes.data || []).map(s => ({
                id: s.id, name: s.name, type: s.type,
                amount: parseFloat(s.amount), date: s.date
            }));

            // Monthly revenue
            if (monthlyRes.data) {
                this.monthlyRevenue = { month: monthlyRes.data.month, total: parseFloat(monthlyRes.data.total) };
            }

        } catch (e) {
            console.error('Error loading data from Supabase:', e);
            UI.showToast('Failed to load data from database.', 'error');
        }
    },

    _mapBillFromDB(b) {
        return {
            id: b.id,
            customerName: b.customer_name,
            date: b.date,
            items: b.items || [],
            subtotal: parseFloat(b.subtotal),
            discountPercent: parseFloat(b.discount_percent),
            discountAmount: parseFloat(b.discount_amount),
            grandTotal: parseFloat(b.grand_total),
            transactionType: b.transaction_type
        };
    },

    // --- Items ---
    async updateItem(id, name, price, type) {
        price = parseFloat(price);
        const { error } = await supabase.from('items').update({ name, price, type }).eq('id', id);
        if (error) { UI.showToast('Error updating item.', 'error'); return false; }
        const idx = this.items.findIndex(i => i.id === id);
        if (idx >= 0) { this.items[idx] = { ...this.items[idx], name, price, type }; }
        return true;
    },

    async addItem(name, price, type) {
        price = parseFloat(price);
        const newItem = { id: 'item_' + Date.now(), name, price, type: type || 'fixed' };
        const { error } = await supabase.from('items').insert([newItem]);
        if (error) { UI.showToast('Error saving item.', 'error'); return null; }
        this.items.push(newItem);
        return newItem;
    },

    async deleteItem(itemId) {
        const { error } = await supabase.from('items').delete().eq('id', itemId);
        if (error) { UI.showToast('Error deleting item.', 'error'); return; }
        this.items = this.items.filter(i => i.id !== itemId);
    },

    // --- Bill (current in-progress) ---
    addToCurrentBill(itemId, qty, weight) {
        const item = this.items.find(i => i.id === itemId);
        if (!item) return false;
        const isWeight = item.type === 'weight';
        const finalValue = isWeight ? parseFloat(weight) : parseInt(qty);
        if (isNaN(finalValue) || finalValue <= 0) return false;

        const existingIdx = this.currentBill.findIndex(b => b.itemId === itemId);
        if (existingIdx >= 0) {
            this.currentBill[existingIdx].qty += finalValue;
            this.currentBill[existingIdx].total = this.currentBill[existingIdx].qty * item.price;
        } else {
            this.currentBill.push({
                id: 'b_item_' + Date.now(),
                itemId: item.id, name: item.name,
                price: item.price, type: item.type,
                qty: finalValue, total: item.price * finalValue
            });
        }
        return true;
    },

    removeFromCurrentBill(billItemId) {
        this.currentBill = this.currentBill.filter(b => b.id !== billItemId);
    },

    clearCurrentBill() { this.currentBill = []; },

    getCurrentBillTotal() {
        return this.currentBill.reduce((sum, item) => sum + item.total, 0);
    },

    async saveCurrentBill(customerName, date, discountPercent, finalGrandTotal, txType) {
        if (this.currentBill.length === 0) return false;
        const subtotal = this.getCurrentBillTotal();
        const discountAmount = subtotal - finalGrandTotal;

        const bill = {
            id: 'bill_' + Date.now(),
            customerName: customerName || 'Walk-in Customer',
            date, items: [...this.currentBill],
            subtotal, discountPercent: discountPercent || 0,
            discountAmount, grandTotal: finalGrandTotal,
            transactionType: txType || 'Cash'
        };

        const dbBill = {
            id: bill.id,
            customer_name: bill.customerName,
            date: bill.date,
            items: bill.items,
            subtotal: bill.subtotal,
            discount_percent: bill.discountPercent,
            discount_amount: bill.discountAmount,
            grand_total: bill.grandTotal,
            transaction_type: bill.transactionType
        };

        const { error } = await supabase.from('bills').insert([dbBill]);
        if (error) { UI.showToast('Error saving bill.', 'error'); return false; }

        this.dailyBills.push(bill);
        this.allBills.unshift(bill);

        await this.addToMonthlyRevenue(finalGrandTotal);
        return true;
    },

    clearAllDailyData() {
        // Only clears local display — bills persist in Supabase for reports
        this.dailyBills = [];
    },

    // --- Monthly Revenue ---
    async addToMonthlyRevenue(amount) {
        this.monthlyRevenue.total += amount;
        const { error } = await supabase.from('monthly_revenue').upsert({
            month: this.monthlyRevenue.month,
            total: this.monthlyRevenue.total
        }, { onConflict: 'month' });
        if (error) console.error('Monthly revenue upsert error:', error);
    },

    // --- Dues ---
    async addDue(name, amount, date, type) {
        const newDue = { id: 'due_' + Date.now(), name, amount: parseFloat(amount), date, type };
        const { error } = await supabase.from('dues').insert([newDue]);
        if (error) { UI.showToast('Error saving due.', 'error'); return null; }
        this.dues.push(newDue);
        return newDue;
    },

    async updateDue(id, name, amount, date, type) {
        const { error } = await supabase.from('dues').update({ name, amount: parseFloat(amount), date, type }).eq('id', id);
        if (error) { UI.showToast('Error updating due.', 'error'); return false; }
        const idx = this.dues.findIndex(d => d.id === id);
        if (idx >= 0) this.dues[idx] = { ...this.dues[idx], name, amount: parseFloat(amount), date, type };
        return true;
    },

    async settleDue(dueId) {
        const { error } = await supabase.from('dues').delete().eq('id', dueId);
        if (error) { UI.showToast('Error settling due.', 'error'); return; }
        this.dues = this.dues.filter(d => d.id !== dueId);
    },

    // --- Staff Payments ---
    async addStaffPayment(name, type, amount, date) {
        const newPayment = { id: 'staff_' + Date.now(), name, type, amount: parseFloat(amount), date };
        const { error } = await supabase.from('staff_payments').insert([newPayment]);
        if (error) { UI.showToast('Error saving staff payment.', 'error'); return null; }
        this.staffPayments.push(newPayment);
        return newPayment;
    },

    async updateStaffPayment(id, name, type, amount, date) {
        const { error } = await supabase.from('staff_payments').update({ name, type, amount: parseFloat(amount), date }).eq('id', id);
        if (error) { UI.showToast('Error updating staff payment.', 'error'); return false; }
        const idx = this.staffPayments.findIndex(s => s.id === id);
        if (idx >= 0) this.staffPayments[idx] = { ...this.staffPayments[idx], name, type, amount: parseFloat(amount), date };
        return true;
    },

    async deleteStaffPayment(id) {
        const { error } = await supabase.from('staff_payments').delete().eq('id', id);
        if (error) { UI.showToast('Error deleting staff payment.', 'error'); return; }
        this.staffPayments = this.staffPayments.filter(s => s.id !== id);
    }
};

// --- DOM & UI MANAGEMENT ---
const UI = {
    elements: {
        // Nav
        navUser: document.getElementById('navUser'),
        navAdmin: document.getElementById('navAdmin'),
        generatePdfBtn: document.getElementById('generatePdfBtn'),
        generateWeeklyBtn: document.getElementById('generateWeeklyBtn'),
        generateMonthlyBtn: document.getElementById('generateMonthlyBtn'),
        
        // Panels
        userPanel: document.getElementById('userPanel'),
        adminPanel: document.getElementById('adminPanel'),
        
        // Admin
        adminPasswordScreen: document.getElementById('adminPasswordScreen'),
        adminContentWrapper: document.getElementById('adminContentWrapper'),
        adminPasswordInput: document.getElementById('adminPasswordInput'),
        adminLoginBtn: document.getElementById('adminLoginBtn'),
        adminItemForm: document.getElementById('adminItemForm'),
        adminItemName: document.getElementById('adminItemName'),
        adminItemDataList: document.getElementById('adminItemDataList'),
        adminItemPrice: document.getElementById('adminItemPrice'),
        adminItemType: document.getElementById('adminItemType'),
        adminSaveBtn: document.getElementById('adminSaveBtn'),
        adminCancelEditBtn: document.getElementById('adminCancelEditBtn'),
        adminDeleteBtn: document.getElementById('adminDeleteBtn'),
        adminDueForm: document.getElementById('adminDueForm'),
        dueName: document.getElementById('dueName'),
        dueType: document.getElementById('dueType'),
        dueAmount: document.getElementById('dueAmount'),
        dueDate: document.getElementById('dueDate'),
        saveDueBtn: document.getElementById('saveDueBtn'),
        cancelDueEditBtn: document.getElementById('cancelDueEditBtn'),
        adminDuesBody: document.getElementById('adminDuesBody'),

        // Staff Panel
        adminStaffForm: document.getElementById('adminStaffForm'),
        staffName: document.getElementById('staffName'),
        staffPaymentType: document.getElementById('staffPaymentType'),
        staffAmount: document.getElementById('staffAmount'),
        staffDate: document.getElementById('staffDate'),
        saveStaffBtn: document.getElementById('saveStaffBtn'),
        cancelStaffEditBtn: document.getElementById('cancelStaffEditBtn'),
        adminStaffBody: document.getElementById('adminStaffBody'),

        clearDataBtn: document.getElementById('clearDataBtn'),
        
        // User (Billing)
        customerName: document.getElementById('customerName'),
        billDate: document.getElementById('billDate'),
        itemSelect: document.getElementById('itemSelect'),
        itemQty: document.getElementById('itemQty'),
        itemWeight: document.getElementById('itemWeight'),
        addItemBtn: document.getElementById('addItemBtn'),
        billItemsBody: document.getElementById('billItemsBody'),
        subTotal: document.getElementById('subTotal'),
        billDiscount: document.getElementById('billDiscount'),
        transactionType: document.getElementById('transactionType'),
        grandTotal: document.getElementById('grandTotal'),
        clearBillBtn: document.getElementById('clearBillBtn'),
        saveBillBtn: document.getElementById('saveBillBtn'),
        recentBillsList: document.getElementById('recentBillsList'),
        dailyRevenueTotal: document.getElementById('dailyRevenueTotal'),
        monthlyRevenueTotal: document.getElementById('monthlyRevenueTotal'),

        // Toasts
        toastContainer: document.getElementById('toastContainer')
    },

    init() {
        this.bindEvents();
        this.populateItemSearch();
        this.updateItemSelect();
        this.renderCurrentBill();
        this.renderRecentBills();
        this.renderStaffPayments();
        
        // Setup Date inputs
        const today = new Date().toISOString().split('T')[0];
        if (this.elements.dueDate) this.elements.dueDate.value = today;
        if (this.elements.staffDate) this.elements.staffDate.value = today;
    },

    bindEvents() {
        // Navigation
        this.elements.navUser.addEventListener('click', () => this.switchTab('user'));
        this.elements.navAdmin.addEventListener('click', () => this.switchTab('admin'));
        
        // Admin Password
        this.elements.adminLoginBtn.addEventListener('click', () => this.handleAdminLogin());
        this.elements.adminPasswordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleAdminLogin();
        });

        // Admin Form
        this.elements.adminItemForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleAdminItemSubmit();
        });

        // Search Autocomplete Trigger
        this.elements.adminItemName.addEventListener('input', (e) => {
            const val = e.target.value.trim().toLowerCase();
            const matchedItem = AppState.items.find(i => i.name.toLowerCase() === val);
            if (matchedItem && !this.currentEditItemId) {
                this.editAdminItem(matchedItem.id);
            }
        });

        this.elements.adminCancelEditBtn.addEventListener('click', () => {
            this.resetAdminForm();
        });

        this.elements.adminDeleteBtn.addEventListener('click', () => {
            if (this.currentEditItemId) {
                this.deleteAdminItem(this.currentEditItemId);
            }
        });

        // Dues Management
        this.elements.adminDueForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleDueSubmit();
        });
        
        this.elements.cancelDueEditBtn.addEventListener('click', () => {
            this.resetDueForm();
        });

        // Staff Management
        this.elements.adminStaffForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleStaffSubmit();
        });

        this.elements.cancelStaffEditBtn.addEventListener('click', () => {
            this.resetStaffForm();
        });

        // Admin Data Management
        this.elements.clearDataBtn.addEventListener('click', () => {
            if (confirm("Are you sure you want to clear all bills and revenue for today? This cannot be undone.")) {
                AppState.clearAllDailyData();
                this.renderRecentBills();
                this.showToast('All daily data cleared.', 'success');
            }
        });

        // Billing
        this.elements.addItemBtn.addEventListener('click', () => this.handleAddToBill());
        this.elements.clearBillBtn.addEventListener('click', () => {
            if (AppState.currentBill.length > 0 && confirm("Clear current bill?")) {
                AppState.clearCurrentBill();
                this.renderCurrentBill();
            }
        });

        this.elements.saveBillBtn.addEventListener('click', () => this.handleSaveBill());
        this.elements.billDiscount.addEventListener('input', () => this.handleDiscountChange());
        this.elements.grandTotal.addEventListener('input', () => this.handleGrandTotalChange());

        // PDF Generation
        this.elements.generatePdfBtn.addEventListener('click', () => generateEODReport());
        this.elements.generateWeeklyBtn.addEventListener('click', () => generateWeeklyReport());
        this.elements.generateMonthlyBtn.addEventListener('click', () => generateMonthlyReport());
    },

    switchTab(tab) {
        if (tab === 'user') {
            this.elements.navUser.classList.add('active');
            this.elements.navAdmin.classList.remove('active');
            this.elements.userPanel.classList.remove('hidden');
            this.elements.userPanel.classList.add('active');
            this.elements.adminPanel.classList.add('hidden');
            this.elements.adminPanel.classList.remove('active');
            
            // Refresh select when switching to user panel
            this.updateItemSelect();
        } else {
            this.elements.navAdmin.classList.add('active');
            this.elements.navUser.classList.remove('active');
            this.elements.adminPanel.classList.remove('hidden');
            this.elements.adminPanel.classList.add('active');
            this.elements.userPanel.classList.add('hidden');
            this.elements.userPanel.classList.remove('active');
            
            // Password checked internally by CSS and handleAdminLogin
            if(!this.isAdminUnlocked) {
                this.elements.adminPasswordInput.focus();
            } else {
                this.renderDues(); 
            }
        }
    },

    isAdminUnlocked: false,

    handleAdminLogin() {
        const pwd = this.elements.adminPasswordInput.value;
        if (pwd === 'admin123') {
            this.isAdminUnlocked = true;
            this.elements.adminPasswordScreen.classList.remove('active');
            this.elements.adminContentWrapper.classList.remove('hidden');
            this.renderDues();
            this.showToast('Authentication successful.', 'success');
        } else {
            this.elements.adminPasswordInput.value = '';
            this.showToast('Incorrect password.', 'error');
        }
    },

    formatCurrency(amount) {
        return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount);
    },

    showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        // Set icon based on type
        let icon = '';
        if (type === 'success') {
            icon = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
        } else if (type === 'error') {
            icon = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
        } else {
            icon = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
        }

        toast.innerHTML = `${icon} <span>${message}</span>`;
        this.elements.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('hiding');
            toast.addEventListener('animationend', () => toast.remove());
        }, 3000);
    },

    // --- Admin Views ---
    currentEditItemId: null,

    handleAdminItemSubmit() {
        const name = this.elements.adminItemName.value.trim();
        const price = this.elements.adminItemPrice.value;
        const type = this.elements.adminItemType.value;

        if (!name || !price) {
            this.showToast('Please provide both name and price.', 'error');
            return;
        }

        if (this.currentEditItemId) {
            AppState.updateItem(this.currentEditItemId, name, price, type);
            this.showToast('Item successfully updated.');
        } else {
            AppState.addItem(name, price, type);
            this.showToast('New item added gracefully.');
        }
        
        this.resetAdminForm();
        this.populateItemSearch();
        this.updateItemSelect();
    },

    resetAdminForm() {
        this.currentEditItemId = null;
        this.elements.adminItemName.value = '';
        this.elements.adminItemPrice.value = '';
        this.elements.adminItemType.value = 'fixed';
        this.elements.adminSaveBtn.textContent = 'Save Item';
        this.elements.adminCancelEditBtn.classList.add('hidden');
        this.elements.adminDeleteBtn.classList.add('hidden');
        this.elements.adminItemName.focus();
    },

    editAdminItem(id) {
        const item = AppState.items.find(i => i.id === id);
        if (!item) return;

        this.currentEditItemId = item.id;
        this.elements.adminItemName.value = item.name;
        this.elements.adminItemPrice.value = item.price;
        this.elements.adminItemType.value = item.type || 'fixed';
        
        this.elements.adminSaveBtn.textContent = 'Update Item';
        this.elements.adminCancelEditBtn.classList.remove('hidden');
        this.elements.adminDeleteBtn.classList.remove('hidden');
        
        // Scroll to form smoothly if it's out of view
        this.elements.adminItemName.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.elements.adminItemName.focus();
    },

    populateItemSearch() {
        const datalist = this.elements.adminItemDataList;
        if (!datalist) return;
        
        datalist.innerHTML = '';

        if (AppState.items.length === 0) return;

        // Sort items alphabetically
        const sortedItems = [...AppState.items].sort((a, b) => a.name.localeCompare(b.name));

        sortedItems.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.name;
            datalist.appendChild(opt);
        });
    },

    deleteAdminItem(id) {
        if(confirm('Are you sure you want to remove this item?')) {
            AppState.deleteItem(id);
            if (this.currentEditItemId === id) this.resetAdminForm();
            this.populateItemSearch();
            this.updateItemSelect();
            this.showToast('Item deleted.', 'success');
        }
    },

    // --- Dues & Payables ---
    currentEditDueId: null,

    handleDueSubmit() {
        const name = this.elements.dueName.value.trim();
        const type = this.elements.dueType.value;
        const amount = this.elements.dueAmount.value;
        const date = this.elements.dueDate.value;

        if (!name || !amount) return;

        if (this.currentEditDueId) {
            AppState.updateDue(this.currentEditDueId, name, amount, date, type);
            this.showToast('Ledger entry updated.', 'success');
        } else {
            AppState.addDue(name, amount, date, type);
            this.showToast('Entry saved to ledger.', 'success');
        }
        
        this.resetDueForm();
        this.renderDues();
    },

    resetDueForm() {
        this.currentEditDueId = null;
        this.elements.dueName.value = '';
        this.elements.dueAmount.value = '';
        const today = new Date().toISOString().split('T')[0];
        this.elements.dueDate.value = today;
        this.elements.dueType.value = 'receive';
        
        this.elements.saveDueBtn.textContent = 'Save Entry';
        this.elements.cancelDueEditBtn.classList.add('hidden');
        this.elements.dueName.focus();
    },

    editDue(id) {
        const due = AppState.dues.find(d => d.id === id);
        if (!due) return;

        this.currentEditDueId = due.id;
        this.elements.dueName.value = due.name;
        this.elements.dueType.value = due.type;
        this.elements.dueAmount.value = due.amount;
        this.elements.dueDate.value = due.date;

        this.elements.saveDueBtn.textContent = 'Update Entry';
        this.elements.cancelDueEditBtn.classList.remove('hidden');
        
        this.elements.dueName.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.elements.dueName.focus();
    },

    renderDues() {
        if(!this.elements.adminDuesBody) return;
        const tbody = this.elements.adminDuesBody;
        tbody.innerHTML = '';

        if (AppState.dues.length === 0) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="5" class="text-center">No active dues or payables.</td></tr>';
            return;
        }

        const sortedDues = [...AppState.dues].sort((a, b) => new Date(b.date) - new Date(a.date));

        sortedDues.forEach(due => {
            const tr = document.createElement('tr');
            
            const typeLabel = due.type === 'receive' 
                ? '<span style="color: var(--success); font-weight: 500;">Owed by Customer (+)</span>' 
                : '<span style="color: var(--danger); font-weight: 500;">Payable to Vendor (-)</span>';

            tr.innerHTML = `
                <td>${due.name}</td>
                <td class="text-center text-sm">${typeLabel}</td>
                <td class="text-center text-muted">${due.date}</td>
                <td class="text-right font-medium">${this.formatCurrency(due.amount)}</td>
                <td class="text-center" style="white-space: nowrap;">
                    <button class="icon-btn" onclick="UI.editDue('${due.id}')" title="Edit">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="action-btn" style="padding: 6px 10px; font-size: 12px; margin-left: 4px;" onclick="UI.settleDue('${due.id}')" title="Settle">
                        Settle
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    },

    settleDue(id) {
        if(confirm('Mark this entry as settled/paid?')) {
            AppState.settleDue(id);
            this.renderDues();
            this.showToast('Entry marked as settled.', 'success');
        }
    },

    // --- Staff Management ---
    currentEditStaffId: null,

    handleStaffSubmit() {
        const name = this.elements.staffName.value.trim();
        const type = this.elements.staffPaymentType.value;
        const amount = this.elements.staffAmount.value;
        const date = this.elements.staffDate.value;

        if (!name || !amount) return;

        if (this.currentEditStaffId) {
            AppState.updateStaffPayment(this.currentEditStaffId, name, type, amount, date);
            this.showToast('Staff payment updated.', 'success');
        } else {
            AppState.addStaffPayment(name, type, amount, date);
            this.showToast('Payment saved to Staff Ledger.', 'success');
        }
        
        this.resetStaffForm();
        this.renderStaffPayments();
    },

    resetStaffForm() {
        this.currentEditStaffId = null;
        this.elements.staffName.value = '';
        this.elements.staffAmount.value = '';
        const today = new Date().toISOString().split('T')[0];
        this.elements.staffDate.value = today;
        this.elements.staffPaymentType.value = 'salary';
        
        this.elements.saveStaffBtn.textContent = 'Save Payment';
        this.elements.cancelStaffEditBtn.classList.add('hidden');
        this.elements.staffName.focus();
    },

    editStaffPayment(id) {
        const staff = AppState.staffPayments.find(s => s.id === id);
        if (!staff) return;

        this.currentEditStaffId = staff.id;
        this.elements.staffName.value = staff.name;
        this.elements.staffPaymentType.value = staff.type;
        this.elements.staffAmount.value = staff.amount;
        this.elements.staffDate.value = staff.date;

        this.elements.saveStaffBtn.textContent = 'Update Payment';
        this.elements.cancelStaffEditBtn.classList.remove('hidden');
        
        this.elements.staffName.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.elements.staffName.focus();
    },

    deleteStaffPayment(id) {
        if(confirm('Are you sure you want to delete this payment record?')) {
            AppState.deleteStaffPayment(id);
            if (this.currentEditStaffId === id) this.resetStaffForm();
            this.renderStaffPayments();
            this.showToast('Payment record deleted.', 'success');
        }
    },

    renderStaffPayments() {
        const tbody = this.elements.adminStaffBody;
        if (!tbody) return;
        tbody.innerHTML = '';

        if (AppState.staffPayments.length === 0) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="5" class="text-center">No staff payments recorded.</td></tr>';
            return;
        }

        const sortedStaff = [...AppState.staffPayments].sort((a, b) => new Date(b.date) - new Date(a.date));

        sortedStaff.forEach(staff => {
            const tr = document.createElement('tr');
            const typeLabel = staff.type === 'salary' ? 'Salary' : 'Advance';
            const typeColor = staff.type === 'salary' ? 'var(--success)' : 'var(--warning)';
            
            tr.innerHTML = `
                <td class="font-medium">${staff.name}</td>
                <td class="text-center text-sm" style="color: ${typeColor}">${typeLabel}</td>
                <td class="text-center text-muted">${staff.date}</td>
                <td class="text-right font-medium">${this.formatCurrency(staff.amount)}</td>
                <td class="text-center" style="white-space: nowrap;">
                    <button class="icon-btn" onclick="UI.editStaffPayment('${staff.id}')" title="Edit">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="icon-btn" onclick="UI.deleteStaffPayment('${staff.id}')" title="Delete">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    },

    // --- User (Billing) Views ---
    updateItemSelect() {
        const select = this.elements.itemSelect;
        select.innerHTML = '<option value="" disabled selected>Select an item...</option>';
        
        const sortedItems = [...AppState.items].sort((a, b) => a.name.localeCompare(b.name));
        
        sortedItems.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.id;
            const typeLabel = item.type === 'weight' ? '/kg' : '/unit';
            opt.textContent = `${item.name} - ${this.formatCurrency(item.price)} ${typeLabel}`;
            select.appendChild(opt);
        });
        
        // Listen for change to update qty/weight inputs
        select.addEventListener('change', () => {
            const selectedItem = AppState.items.find(i => i.id === select.value);
            if (selectedItem) {
                if (selectedItem.type === 'weight') {
                    this.elements.itemQty.disabled = true;
                    this.elements.itemWeight.disabled = false;
                    this.elements.itemWeight.focus();
                } else {
                    this.elements.itemQty.disabled = false;
                    this.elements.itemQty.value = 1;
                    this.elements.itemWeight.disabled = true;
                    this.elements.itemQty.focus();
                }
            }
        });
    },

    handleAddToBill() {
        const itemId = this.elements.itemSelect.value;
        const qty = this.elements.itemQty.value;
        const weight = this.elements.itemWeight.value;

        if (!itemId) {
            this.showToast('Please select an item first.', 'warning');
            return;
        }

        if (AppState.addToCurrentBill(itemId, qty, weight)) {
            this.renderCurrentBill();
            // Reset selection to make multiple additions easier
            this.elements.itemSelect.value = '';
            this.elements.itemQty.value = '1';
            this.elements.itemQty.disabled = false;
            this.elements.itemWeight.value = '1';
            this.elements.itemWeight.disabled = true;
        } else {
            this.showToast('Invalid quantity or weight.', 'error');
        }
    },

    renderCurrentBill() {
        const tbody = this.elements.billItemsBody;
        tbody.innerHTML = '';

        if (AppState.currentBill.length === 0) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="5" class="text-center">No items added yet.</td></tr>';
            this.elements.subTotal.textContent = '₹0.00';
            this.elements.grandTotal.value = '0.00';
            this.elements.grandTotal.disabled = true;
            this.elements.billDiscount.value = 0;
            this.elements.billDiscount.disabled = true;
            this.elements.saveBillBtn.disabled = true;
            return;
        }

        AppState.currentBill.forEach((bItem, index) => {
            const tr = document.createElement('tr');
            // Adding a sligth animation delay for rows
            tr.style.animation = `fadeIn 0.3s ease forwards ${(index * 0.05)}s`;
            tr.style.opacity = '0';
            
            const qtyLabel = bItem.type === 'weight' ? `${bItem.qty} kg` : bItem.qty;
            const priceLabel = bItem.type === 'weight' ? `${this.formatCurrency(bItem.price)}/kg` : this.formatCurrency(bItem.price);

            tr.innerHTML = `
                <td>${bItem.name}</td>
                <td class="text-right text-sm">${priceLabel}</td>
                <td class="text-center">${qtyLabel}</td>
                <td class="text-right font-medium">${this.formatCurrency(bItem.total)}</td>
                <td class="text-center">
                    <button class="icon-btn" onclick="UI.removeBillItem('${bItem.id}')" title="Remove">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        this.elements.billDiscount.disabled = false;
        this.elements.grandTotal.disabled = false;
        const subtotal = AppState.getCurrentBillTotal();
        let discount = parseFloat(this.elements.billDiscount.value) || 0;
        if (discount < 0) discount = 0;
        if (discount > 100) discount = 100;

        const grandTotal = subtotal - (subtotal * (discount / 100));

        this.elements.subTotal.textContent = this.formatCurrency(subtotal);
        this.elements.grandTotal.value = grandTotal.toFixed(2);
        this.elements.saveBillBtn.disabled = false;
    },

    handleDiscountChange() {
        if (AppState.currentBill.length === 0) return;
        const subtotal = AppState.getCurrentBillTotal();
        let discount = parseFloat(this.elements.billDiscount.value) || 0;
        if (discount < 0) {
            discount = 0;
            this.elements.billDiscount.value = 0;
        }
        
        const grandTotal = subtotal - (subtotal * (discount / 100));
        this.elements.grandTotal.value = grandTotal.toFixed(2);
    },

    handleGrandTotalChange() {
        if (AppState.currentBill.length === 0) return;
        const subtotal = AppState.getCurrentBillTotal();
        let grandTotal = parseFloat(this.elements.grandTotal.value) || 0;
        
        if (grandTotal < 0) {
            grandTotal = 0;
            this.elements.grandTotal.value = 0;
        }

        let discount = 0;
        if (subtotal > 0) {
            discount = ((subtotal - grandTotal) / subtotal) * 100;
        }
        
        // If discount is very small or negative (sur-charge), formatting to 2 decimal places
        this.elements.billDiscount.value = discount.toFixed(2);
    },

    removeBillItem(id) {
        AppState.removeFromCurrentBill(id);
        this.renderCurrentBill();
    },

    handleSaveBill() {
        const customerName = this.elements.customerName.value.trim();
        const date = this.elements.billDate.value;
        const discount = parseFloat(this.elements.billDiscount.value) || 0;
        const finalGrandTotal = parseFloat(this.elements.grandTotal.value) || 0;
        const txType = this.elements.transactionType.value;

        if (AppState.saveCurrentBill(customerName, date, discount, finalGrandTotal, txType)) {
            this.showToast('Bill completely saved!', 'success');
            
            // Reset User Form
            AppState.clearCurrentBill();
            this.elements.billDiscount.value = 0;
            this.elements.transactionType.value = 'Cash';
            this.renderCurrentBill();
            this.renderRecentBills();
            this.elements.customerName.value = '';
            // keep the date as it was
        }
    },

    renderRecentBills() {
        const container = this.elements.recentBillsList;
        const totalElem = this.elements.dailyRevenueTotal;
        const monthlyTotalElem = this.elements.monthlyRevenueTotal;
        container.innerHTML = '';
        
        let dailyRevenue = 0;

        if (AppState.dailyBills.length === 0) {
            container.innerHTML = '<div class="empty-state text-center text-muted text-sm mt-24">No bills processed yet today.</div>';
            totalElem.textContent = '₹0.00';
            if (monthlyTotalElem) {
                monthlyTotalElem.textContent = this.formatCurrency(AppState.monthlyRevenue.total);
            }
            return;
        }

        // Calculate Revenue
        dailyRevenue = AppState.dailyBills.reduce((sum, bill) => sum + bill.grandTotal, 0);
        totalElem.textContent = this.formatCurrency(dailyRevenue);

        // Display in reverse chronological
        const reversedBills = [...AppState.dailyBills].reverse();

        reversedBills.forEach(bill => {
            const card = document.createElement('div');
            card.className = 'bill-card fade-in';
            card.innerHTML = `
                <div class="bill-card-header" style="justify-content: space-between; align-items: center; margin-bottom: 0;">
                    <span style="font-size: 15px; font-weight: 600; color: var(--text-primary); text-shadow: 0 0 10px rgba(255, 255, 255, 0.1);">${this.formatCurrency(bill.grandTotal)}</span>
                    <span class="bill-tx-badge" style="font-size: 12px; padding: 4px 8px;">${bill.transactionType}</span>
                </div>
            `;
            container.appendChild(card);
        });
    }
};

// --- PDF Generation Logic via jsPDF ---
function generateEODReport() {
    if (AppState.dailyBills.length === 0) {
        UI.showToast("No bills recorded for today.", "warning");
        return;
    }

    // Try to destructure the loaded library
    const { jsPDF } = window.jspdf;
    if (!jsPDF) {
        UI.showToast("PDF Library failed to load.", "error");
        return;
    }

    try {
        const doc = new jsPDF();
        const dateStr = new Date().toLocaleDateString();
        
        // Header
        doc.setFontSize(22);
        doc.setTextColor(30, 41, 59); // Slate 800
        doc.text("Mira Basanloy-Bills", 14, 20);
        
        doc.setFontSize(11);
        doc.setTextColor(100, 116, 139); // Slate 500
        doc.text(`Generated on: ${dateStr}`, 14, 28);
        doc.text(`Total Transactions: ${AppState.dailyBills.length}`, 14, 34);

        let totalRevenue = 0;
        let startY = 45;

        // Loop over each bill to draw tables
        AppState.dailyBills.forEach((bill, bIndex) => {
            totalRevenue += bill.grandTotal;
            
            // Check if we need a new page before drawing a section
            if (startY > 250) {
                doc.addPage();
                startY = 20;
            }

            // Bill Context
            doc.setFontSize(12);
            doc.setTextColor(15, 23, 42);
            doc.text(`Bill #${bIndex + 1} | Customer: ${bill.customerName} | Tx: ${bill.transactionType || 'Cash'} | Date: ${bill.date}`, 14, startY);
            
            startY += 5;

            // Prepare table data for the bill items
            const heads = [['Item Name', 'Price', 'Qty/Wt', 'Total']];
            const body = bill.items.map(item => {
                const priceLabel = item.type === 'weight' ? `Rs. ${item.price.toFixed(2)}/kg` : `Rs. ${item.price.toFixed(2)}`;
                const qtyLabel = item.type === 'weight' ? `${item.qty} kg` : item.qty.toString();

                return [
                    item.name, 
                    priceLabel, 
                    qtyLabel, 
                    `Rs. ${item.total.toFixed(2)}`
                ]
            });
            
            // Add grand total row for this specific bill
            if (bill.discountAmount > 0.01 || bill.discountAmount < -0.01) {
                body.push([
                    { content: 'Subtotal', colSpan: 3, styles: { halign: 'right' } }, 
                    { content: `Rs. ${bill.subtotal.toFixed(2)}` }
                ]);
                const titleStr = bill.discountAmount > 0 ? `Discount (${bill.discountPercent}%)` : `Surcharge`;
                const valStr = bill.discountAmount > 0 ? `-Rs. ${bill.discountAmount.toFixed(2)}` : `+Rs. ${Math.abs(bill.discountAmount).toFixed(2)}`;
                const highlightColor = bill.discountAmount > 0 ? [220, 38, 38] : [59, 130, 246];

                body.push([
                    { content: titleStr, colSpan: 3, styles: { halign: 'right', textColor: highlightColor } }, 
                    { content: valStr, styles: { textColor: highlightColor } }
                ]);
            }

            body.push([
                { content: 'Grand Total', colSpan: 3, styles: { halign: 'right', fontStyle: 'bold' } }, 
                { content: `Rs. ${bill.grandTotal.toFixed(2)}`, styles: { fontStyle: 'bold' } }
            ]);

            // Draw AutoTable
            doc.autoTable({
                startY: startY,
                head: heads,
                body: body,
                theme: 'striped',
                headStyles: { fillColor: [59, 130, 246] }, // accent primary
                styles: { fontSize: 10 },
                margin: { left: 14, right: 14 }
            });

            // Update startY for next bill
            startY = doc.lastAutoTable.finalY + 15;
        });

        // Final Summary Block
        if (startY > 240) {
            doc.addPage();
            startY = 20;
        }

        // Draw Summary Box
        doc.setFillColor(241, 245, 249); // slate 100
        doc.roundedRect(14, startY, 182, 30, 3, 3, 'F');
        
        doc.setFontSize(16);
        doc.setTextColor(15, 23, 42); // slate 900
        doc.text("End of Day Summary", 20, startY + 12);
        
        doc.setFontSize(12);
        doc.text(`Daily Revenue (Grand Total): Rs. ${totalRevenue.toFixed(2)}`, 20, startY + 22);

        // Save the generated PDF
        doc.save(`Store_Revenue_Report_${dateStr.replace(/\//g, '-')}.pdf`);
        UI.showToast("PDF Report Downloaded Successfully!");

    } catch (e) {
        console.error("PDF Generation Error", e);
        UI.showToast("Error generating PDF. Check console.", "error");
    }
}

// --- Helper: generate a grouped summary report PDF ---
function generateGroupedReport({ title, filename, bills }) {
    const { jsPDF } = window.jspdf;
    if (!jsPDF) {
        UI.showToast("PDF Library failed to load.", "error");
        return;
    }
    if (bills.length === 0) {
        UI.showToast(`No bills found for ${title}.`, "warning");
        return;
    }

    try {
        const doc = new jsPDF();
        const dateStr = new Date().toLocaleDateString();

        // Header
        doc.setFontSize(22);
        doc.setTextColor(30, 41, 59);
        doc.text("Mira Basanloy-Bills", 14, 20);

        doc.setFontSize(13);
        doc.setTextColor(59, 130, 246);
        doc.text(title, 14, 28);

        doc.setFontSize(10);
        doc.setTextColor(100, 116, 139);
        doc.text(`Generated: ${dateStr}  |  Total Transactions: ${bills.length}`, 14, 35);

        let totalRevenue = bills.reduce((s, b) => s + b.grandTotal, 0);

        // Group bills by date
        const grouped = {};
        bills.forEach(b => {
            if (!grouped[b.date]) grouped[b.date] = [];
            grouped[b.date].push(b);
        });

        let startY = 44;

        // Day-by-day breakdown
        const sortedDays = Object.keys(grouped).sort();
        sortedDays.forEach(day => {
            const dayBills = grouped[day];
            const dayTotal = dayBills.reduce((s, b) => s + b.grandTotal, 0);

            if (startY > 250) { doc.addPage(); startY = 20; }

            // Day header
            doc.setFontSize(12);
            doc.setTextColor(15, 23, 42);
            doc.text(`Date: ${day}  (${dayBills.length} bill${dayBills.length > 1 ? 's' : ''})`, 14, startY);
            startY += 4;

            const body = dayBills.map((bill, i) => [
                `#${i+1} ${bill.customerName}`,
                bill.transactionType || 'Cash',
                `Rs. ${bill.grandTotal.toFixed(2)}`
            ]);

            // Day total row
            body.push([
                { content: `Day Total`, colSpan: 2, styles: { halign: 'right', fontStyle: 'bold' } },
                { content: `Rs. ${dayTotal.toFixed(2)}`, styles: { fontStyle: 'bold', textColor: [16, 185, 129] } }
            ]);

            doc.autoTable({
                startY: startY,
                head: [['Customer', 'Tx Type', 'Grand Total']],
                body: body,
                theme: 'striped',
                headStyles: { fillColor: [59, 130, 246] },
                styles: { fontSize: 10 },
                margin: { left: 14, right: 14 }
            });

            startY = doc.lastAutoTable.finalY + 12;
        });

        // Final Summary
        if (startY > 240) { doc.addPage(); startY = 20; }
        doc.setFillColor(241, 245, 249);
        doc.roundedRect(14, startY, 182, 32, 3, 3, 'F');
        doc.setFontSize(14);
        doc.setTextColor(15, 23, 42);
        doc.text(`${title} Summary`, 20, startY + 12);
        doc.setFontSize(11);
        doc.text(`Total Revenue: Rs. ${totalRevenue.toFixed(2)}`, 20, startY + 23);

        doc.save(`${filename}_${dateStr.replace(/\//g, '-')}.pdf`);
        UI.showToast("PDF Report Downloaded!");

    } catch (e) {
        console.error("PDF Generation Error", e);
        UI.showToast("Error generating PDF. Check console.", "error");
    }
}

function generateWeeklyReport() {
    const now = new Date();
    // Find start of current week (Sunday)
    const dayOfWeek = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dayOfWeek);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const weekBills = AppState.allBills.filter(b => {
        const d = new Date(b.date);
        return d >= weekStart && d <= weekEnd;
    });

    const label = `Weekly Report  |  ${weekStart.toLocaleDateString()} – ${weekEnd.toLocaleDateString()}`;
    generateGroupedReport({ title: label, filename: 'Weekly_Revenue_Report', bills: weekBills });
}

function generateMonthlyReport() {
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();

    const monthBills = AppState.allBills.filter(b => {
        const d = new Date(b.date);
        return d.getMonth() === month && d.getFullYear() === year;
    });

    const monthName = now.toLocaleString('default', { month: 'long' });
    const label = `Monthly Report  |  ${monthName} ${year}`;
    generateGroupedReport({ title: label, filename: `Monthly_Revenue_Report_${monthName}_${year}`, bills: monthBills });
}

// Bootstrap Application
document.addEventListener('DOMContentLoaded', () => {
    AppState.init();
    UI.init();
});
