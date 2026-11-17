'use strict';

// ======================================================================
//  Constants & state
// ======================================================================
const API_BASE = '/api';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const TABS = ['dashboard', 'tickets', 'companies', 'users'];
const STATUS = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting', resolved: 'Resolved', closed: 'Closed' };
const DONE = ['resolved', 'closed'];
const PRIORITY = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const CATEGORY = { hardware: 'Hardware', software: 'Software', network: 'Network', access_security: 'Access & security', other: 'Other' };

const state = {
    me: null,
    companies: [],
    users: [],          // includes inactive users
    tickets: [],
    total: 0,
    page: 1,
    pageSize: 25,
    sort: 'updated_at',
    order: 'desc',
    selected: new Set(),
    ticket: null,       // ticket open in the drawer
    tab: null,
};

// localStorage can throw (private mode, blocked storage) — never let that break the app.
const tokenStore = {
    get() { try { return localStorage.getItem('ticket_token'); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem('ticket_token', v) : localStorage.removeItem('ticket_token'); } catch { /* ignore */ } },
};
let token = tokenStore.get();

const isAdmin = () => state.me?.role === 'admin';
const activeUsers = () => state.users.filter(u => u.is_active);
const activeStaff = () => activeUsers().filter(u => u.role !== 'user');  // can be assigned tickets
const isStaff = (u) => u?.role === 'admin' || u?.role === 'technician';

// ======================================================================
//  API
// ======================================================================
async function api(endpoint, { body, raw, ...options } = {}) {
    const headers = { ...options.headers };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && !endpoint.startsWith('/auth/login')) {
        signedOut();
        throw new Error('Your session has ended. Please sign in again.');
    }
    if (raw) {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return res;
    }
    if (res.status === 204) return null;

    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(formatApiError(data, res));
    return data;
}

function formatApiError(data, res) {
    const detail = data?.detail;
    if (Array.isArray(detail)) {
        return detail.map(d => `${d.loc?.slice(1).join('.') || 'field'}: ${d.msg}`).join('\n');
    }
    return detail || `Request failed (${res.status})`;
}

// ======================================================================
//  Small helpers
// ======================================================================
let toastTimer;
function toast(message, type = 'success') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast show toast-${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const formatDate = (s) => (s ? dateFmt.format(new Date(s)) : '—');

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function formatRelative(s) {
    if (!s) return '—';
    const sec = (new Date(s) - Date.now()) / 1000;
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800],
                   ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, size] of units) {
        if (Math.abs(sec) >= size) return rtf.format(Math.round(sec / size), unit);
    }
    return rtf.format(Math.round(sec), 'second');
}

function formatHours(h) {
    if (h == null) return '–';
    if (h < 1) return `${Math.round(h * 60)}m`;
    if (h < 48) return `${h.toFixed(1)}h`;
    return `${(h / 24).toFixed(1)}d`;
}

const options = (entries, selected) => entries
    .map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(l)}</option>`)
    .join('');

const statusBadge = (s) => `<span class="badge badge-${s}">${STATUS[s] || s}</span>`;
const priorityBadge = (p) => (p
    ? `<span class="badge badge-${p}">${PRIORITY[p] || p}</span>`
    : '<span class="badge badge-none" title="Waiting for a technician to set it">Not set</span>');
const emptyRow = (cols, text) => `<tr><td colspan="${cols}" class="empty">${text}</td></tr>`;

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Disable the submit button while the handler runs and show errors as a toast. */
function onSubmit(form, handler) {
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        try { await handler(e); } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
    });
}

function openModal(modal) {
    modal.classList.add('active');
    modal.querySelector('input:not([type="hidden"]), textarea, select')?.focus();
}
const closeModal = (modal) => modal.classList.remove('active');

// ======================================================================
//  Auth
// ======================================================================
let authMode = 'login';

async function showAuth() {
    $('#app-view').hidden = true;
    $('#auth-view').hidden = false;
    let needsSetup = false, needsCode = false;
    try {
        const status = await api('/auth/setup-status');
        needsSetup = status.needs_setup;
        needsCode = needsSetup && status.setup_token_required;
    } catch { /* show login */ }
    authMode = needsSetup ? 'setup' : 'login';
    $('#auth-name-group').hidden = !needsSetup;
    $('#auth-name').required = needsSetup;
    $('#auth-setup-group').hidden = !needsCode;
    $('#auth-setup-code').required = needsCode;
    $('#auth-password').autocomplete = needsSetup ? 'new-password' : 'current-password';
    $('#auth-subtitle').textContent = needsSetup
        ? 'Welcome! Create the first admin account to get started.'
        : 'Sign in to continue';
    $('#auth-submit').textContent = needsSetup ? 'Create admin account' : 'Sign in';
    (needsSetup ? $('#auth-name') : $('#auth-email')).focus();
}

function signedOut() {
    token = null;
    tokenStore.set(null);
    state.me = null;
    state.tab = null;
    closeDrawer(false);
    $$('.modal.active').forEach(closeModal);
    showAuth();
}

async function enterApp() {
    if (!isStaff(state.me)) {  // end users open and follow tickets in the DeskPulse portal, not here
        await logout();
        toast('This console is for technicians and administrators.', 'error');
        return;
    }
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
    $('#me-name').textContent = state.me.name;
    $('#me-role').textContent = state.me.role;
    $('#me-role').className = `badge badge-role-${state.me.role}`;
    document.body.classList.toggle('is-admin', isAdmin());
    await Promise.all([loadCompanies(), loadUsers()]);
    state.tab = null;
    route();
}

onSubmit($('#auth-form'), async () => {
    const body = { email: $('#auth-email').value.trim(), password: $('#auth-password').value };
    const otp = $('#auth-otp').value.trim();
    if (authMode === 'login' && otp) body.otp = otp;
    const options = { method: 'POST', body };
    if (authMode === 'setup') {
        body.name = $('#auth-name').value.trim();
        const code = $('#auth-setup-code').value;
        if (code) options.headers = { 'X-Setup-Token': code };
    }
    let res;
    try {
        res = await api(authMode === 'setup' ? '/auth/setup' : '/auth/login', options);
    } catch (err) {
        if (err.message === 'Two-factor code required') {  // password was right; ask for the code
            $('#auth-otp-group').hidden = false;
            $('#auth-otp').required = true;
            $('#auth-otp').focus();
        }
        throw err;
    }
    token = res.token;
    tokenStore.set(token);
    state.me = res.user;
    $('#auth-form').reset();
    $('#auth-otp-group').hidden = true;
    $('#auth-otp').required = false;
    await enterApp();
});

async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* already signed out */ }
    signedOut();
}

// ======================================================================
//  Routing (#dashboard, #tickets, #tickets/12, #companies, #users)
// ======================================================================
const loaders = {
    dashboard: () => loadDashboard(),
    // Refresh companies/users too, so dropdowns include ones added by other people.
    tickets: () => Promise.all([loadCompanies(), loadUsers(), loadTickets()]),
    companies: () => loadCompanies(),
    users: () => loadUsers(),
};

function showTab(tab, force = false) {
    if (tab === 'users' && !isAdmin()) tab = 'dashboard';
    const changed = tab !== state.tab;
    state.tab = tab;
    $$('.tab-btn').forEach(b => {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on);
    });
    $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === `${tab}-tab`));
    if (changed || force) loaders[tab]();
}

function route() {
    if (!state.me) return;
    const [tab, id] = location.hash.slice(1).split('/');
    showTab(TABS.includes(tab) ? tab : 'dashboard');
    if (tab === 'tickets' && id) openTicket(Number(id));
    else closeDrawer(false);
}

function go(hash) {
    if (location.hash === `#${hash}`) route();
    else location.hash = hash;
}

// ======================================================================
//  Dashboard
// ======================================================================
const EVENT_TEXT = {
    created: () => 'created the ticket',
    comment: (e) => (e.new_value === 'internal' ? 'added an internal note' : 'replied'),
    status: (e) => `changed status <b>${esc(STATUS[e.old_value] || e.old_value)}</b> → <b>${esc(STATUS[e.new_value] || e.new_value)}</b>`,
    priority: (e) => `set priority ${e.old_value ? `<b>${esc(PRIORITY[e.old_value] || e.old_value)}</b> →` : 'to'} <b>${esc(PRIORITY[e.new_value] || e.new_value)}</b>`,
    category: (e) => `changed category <b>${esc(CATEGORY[e.old_value] || e.old_value)}</b> → <b>${esc(CATEGORY[e.new_value] || e.new_value)}</b>`,
    requester: (e) => (e.new_value ? `set the requester to <b>${esc(e.new_value)}</b>` : `cleared the requester`),
    asset: (e) => (e.new_value ? `linked asset <b>${esc(e.new_value)}</b>` : `unlinked asset <b>${esc(e.old_value)}</b>`),
    assignee: (e) => (e.new_value ? `assigned it to <b>${esc(e.new_value)}</b>` : `unassigned <b>${esc(e.old_value)}</b>`),
    company: (e) => `moved it to <b>${esc(e.new_value)}</b>`,
    title: (e) => `renamed it to <b>${esc(e.new_value)}</b>`,
};
const describeEvent = (e) => (EVENT_TEXT[e.field] || (() => `updated ${esc(e.field)}`))(e);

async function loadDashboard() {
    try {
        const s = await api('/stats');
        const set = (id, v) => { $(id).textContent = v; };
        set('#stat-active', s.active_tickets);
        set('#stat-open', s.by_status.open);
        set('#stat-in-progress', s.by_status.in_progress);
        set('#stat-waiting', s.by_status.waiting);
        set('#stat-overdue', s.overdue);
        set('#stat-unassigned', s.unassigned);
        set('#stat-mine', s.mine);
        set('#stat-untriaged', s.unprioritized);
        set('#stat-avg', formatHours(s.avg_resolution_hours));

        const max = Math.max(1, ...Object.values(s.by_priority));
        $('#priority-bars').innerHTML = Object.keys(PRIORITY).map(p => `
            <button class="bar-row" data-go='{"status":"active","priority":"${p}"}'>
                <span class="bar-label">${PRIORITY[p]}</span>
                <span class="bar-track"><span class="bar-fill bar-${p}" style="width:${(s.by_priority[p] / max) * 100}%"></span></span>
                <span class="bar-value">${s.by_priority[p]}</span>
            </button>`).join('');

        $('#activity-list').innerHTML = s.recent_activity.length
            ? s.recent_activity.map(e => `
                <li>
                    <b>${esc(e.actor_name || 'Someone')}</b> ${describeEvent(e)}
                    on <a href="#tickets/${e.ticket_id}">${esc(e.ticket_code)} ${esc(e.ticket_title)}</a>
                    <span class="muted small" title="${formatDate(e.created_at)}">· ${formatRelative(e.created_at)}</span>
                </li>`).join('')
            : '<li class="muted">No activity yet.</li>';
    } catch (err) {
        toast(`Failed to load dashboard: ${err.message}`, 'error');
    }
}

/** Jump to the ticket list with a given set of filters. */
function goToTickets(filters) {
    $('#filter-q').value = filters.q || '';
    $('#filter-status').value = filters.status ?? '';
    $('#filter-priority').value = filters.priority || '';
    $('#filter-company').value = filters.company_id || '';
    $('#filter-assignee').value = filters.assignee || '';
    $('#filter-overdue').checked = !!filters.overdue;
    state.page = 1;
    state.selected.clear();
    if (state.tab === 'tickets') loadTickets();
    go('tickets');
}

// ======================================================================
//  Users (also feeds every "assignee" dropdown)
// ======================================================================
async function loadUsers() {
    try {
        state.users = await api('/users?include_inactive=true');
        renderUsers();
        updateUserSelects();
    } catch (err) {
        toast(`Failed to load users: ${err.message}`, 'error');
    }
}

function updateUserSelects() {
    const people = activeStaff().map(u => [u.id, u.id === state.me.id ? `${u.name} (me)` : u.name]);
    const keep = (sel, html) => { const v = sel.value; sel.innerHTML = html; sel.value = v; if (sel.selectedIndex < 0) sel.selectedIndex = 0; };
    keep($('#filter-assignee'), options([['', 'Anyone'], ['me', 'Assigned to me'], ['none', 'Unassigned'], ...people]));
    keep($('#bulk-assignee'), options([['', 'Assignee…'], ['none', 'Unassign'], ...people]));
    $('#ticket-assignee').innerHTML = options([['', 'Unassigned'], ...people]);
}

function renderUsers() {
    const tbody = $('#users-table tbody');
    tbody.innerHTML = state.users.length ? state.users.map(u => `
        <tr class="${u.is_active ? '' : 'inactive'}">
            <td>${esc(u.name)}${u.id === state.me.id ? ' <span class="muted small">(you)</span>' : ''}</td>
            <td>${esc(u.email)}</td>
            <td><span class="badge badge-role-${u.role}">${u.role}</span></td>
            <td>${u.is_active ? 'Active' : '<span class="muted">Deactivated</span>'}</td>
            <td>${formatDate(u.created_at)}</td>
            <td><button class="btn btn-secondary btn-sm" data-action="edit-user" data-id="${u.id}">Edit</button></td>
        </tr>`).join('') : emptyRow(6, 'No users.');
}

function openUserModal(id = null) {
    const form = $('#user-form');
    form.reset();
    const u = id ? state.users.find(x => x.id === id) : null;
    $('#user-id').value = u?.id ?? '';
    $('#user-modal-title').textContent = u ? 'Edit User' : 'New User';
    $('#user-active-group').hidden = !u;
    $('#user-password').required = !u;
    $('#user-password-label').textContent = u ? 'New password (leave blank to keep)' : 'Password *';
    if (u) {
        $('#user-name').value = u.name;
        $('#user-email').value = u.email;
        $('#user-role').value = u.role;
        $('#user-active').value = String(u.is_active);
    }
    $('#user-company').innerHTML = options([['', 'No company'], ...state.companies.map(c => [c.id, c.name])], u?.company_id);
    openModal($('#user-modal'));
}

onSubmit($('#user-form'), async () => {
    const id = $('#user-id').value;
    const body = {
        name: $('#user-name').value.trim(),
        email: $('#user-email').value.trim(),
        role: $('#user-role').value,
        company_id: $('#user-company').value ? Number($('#user-company').value) : null,
    };
    const password = $('#user-password').value;
    if (password) body.password = password;
    if (id) body.is_active = $('#user-active').value === 'true';

    if (id) await api(`/users/${id}`, { method: 'PATCH', body });
    else await api('/users', { method: 'POST', body });
    closeModal($('#user-modal'));
    toast(id ? 'User updated' : 'User created');
    await loadUsers();
});

// ======================================================================
//  Profile
// ======================================================================
function openProfileModal() {
    $('#profile-form').reset();
    $('#profile-name').value = state.me.name;
    openModal($('#profile-modal'));
}

onSubmit($('#profile-form'), async () => {
    const body = { name: $('#profile-name').value.trim() };
    const current = $('#profile-current').value;
    const next = $('#profile-new').value;
    if (current || next) {
        if (!current || !next) throw new Error('Fill in both password fields to change your password.');
        body.current_password = current;
        body.new_password = next;
    }
    state.me = await api('/auth/me', { method: 'PATCH', body });
    $('#me-name').textContent = state.me.name;
    closeModal($('#profile-modal'));
    toast('Profile saved');
    await loadUsers();
});

// ======================================================================
//  Companies
// ======================================================================
async function loadCompanies() {
    try {
        state.companies = await api('/companies');
        renderCompanies();
        updateCompanySelects();
    } catch (err) {
        toast(`Failed to load companies: ${err.message}`, 'error');
    }
}

function renderCompanies() {
    const tbody = $('#companies-table tbody');
    if (!state.companies.length) {
        tbody.innerHTML = emptyRow(7, 'No companies yet. Create one to start adding tickets.');
        return;
    }
    tbody.innerHTML = state.companies.map(c => `
        <tr>
            <td>${c.id}</td>
            <td>${esc(c.name)}</td>
            <td>${esc(c.email || '—')}</td>
            <td>${esc(c.phone || '—')}</td>
            <td><button class="link" data-action="company-tickets" data-id="${c.id}">${c.open_ticket_count} / ${c.ticket_count}</button></td>
            <td>${formatDate(c.created_at)}</td>
            <td>
                <div class="actions">
                    <button class="btn btn-secondary btn-sm" data-action="edit-company" data-id="${c.id}">Edit</button>
                    <button class="btn btn-danger btn-sm admin-only" data-action="delete-company" data-id="${c.id}">Delete</button>
                </div>
            </td>
        </tr>`).join('');
}

function updateCompanySelects() {
    const list = state.companies.map(c => [c.id, c.name]);
    const filter = $('#filter-company');
    const v = filter.value;
    filter.innerHTML = options([['', 'All companies'], ...list]);
    filter.value = state.companies.some(c => String(c.id) === v) ? v : '';
    $('#ticket-company').innerHTML =
        `<option value="" disabled selected>Select a company…</option>${options(list)}`;
}

function openCompanyModal(id = null) {
    $('#company-form').reset();
    const c = id ? state.companies.find(x => x.id === id) : null;
    $('#company-id').value = c?.id ?? '';
    $('#company-modal-title').textContent = c ? 'Edit Company' : 'New Company';
    if (c) {
        $('#company-name').value = c.name;
        $('#company-email').value = c.email || '';
        $('#company-phone').value = c.phone || '';
        $('#company-address').value = c.address || '';
    }
    openModal($('#company-modal'));
}

async function deleteCompany(id) {
    const c = state.companies.find(x => x.id === id);
    const msg = `Delete "${c?.name ?? 'this company'}"?` +
        (c?.ticket_count ? `\nThis also permanently deletes its ${c.ticket_count} ticket(s).` : '');
    if (!confirm(msg)) return;
    try {
        await api(`/companies/${id}`, { method: 'DELETE' });
        toast('Company deleted');
        await loadCompanies();
    } catch (err) {
        toast(err.message, 'error');
    }
}

onSubmit($('#company-form'), async () => {
    const id = $('#company-id').value;
    const body = {
        name: $('#company-name').value.trim(),
        email: $('#company-email').value.trim() || null,
        phone: $('#company-phone').value.trim() || null,
        address: $('#company-address').value.trim() || null,
    };
    if (id) await api(`/companies/${id}`, { method: 'PATCH', body });
    else await api('/companies', { method: 'POST', body });
    closeModal($('#company-modal'));
    toast(id ? 'Company updated' : 'Company created');
    await loadCompanies();
});

// ======================================================================
//  Tickets list
// ======================================================================
function filterParams() {
    const p = new URLSearchParams();
    const add = (k, v) => { if (v) p.set(k, v); };
    add('q', $('#filter-q').value.trim());
    add('status', $('#filter-status').value);
    add('priority', $('#filter-priority').value);
    add('company_id', $('#filter-company').value);
    add('assignee', $('#filter-assignee').value);
    if ($('#filter-overdue').checked) p.set('overdue', 'true');
    return p;
}

async function loadTickets() {
    const p = filterParams();
    p.set('page', state.page);
    p.set('page_size', state.pageSize);
    p.set('sort', state.sort);
    p.set('order', state.order);
    try {
        const data = await api(`/tickets?${p}`);
        const lastPage = Math.max(1, Math.ceil(data.total / state.pageSize));
        if (state.page > lastPage) { state.page = lastPage; return loadTickets(); }
        state.tickets = data.items;
        state.total = data.total;
        renderTickets();
    } catch (err) {
        toast(`Failed to load tickets: ${err.message}`, 'error');
    }
}

function dueCell(t) {
    if (DONE.includes(t.status) || !t.due_at) return '<span class="muted">—</span>';
    const title = `Due ${formatDate(t.due_at)}`;
    return t.is_overdue
        ? `<span class="badge badge-overdue" title="${title}">Overdue · ${formatRelative(t.due_at)}</span>`
        : `<span title="${title}">${formatRelative(t.due_at)}</span>`;
}

function renderTickets() {
    const tbody = $('#tickets-table tbody');
    tbody.innerHTML = state.tickets.length ? state.tickets.map(t => `
        <tr class="clickable${state.selected.has(t.id) ? ' selected' : ''}" data-open-ticket="${t.id}">
            <td class="col-check"><input type="checkbox" data-select="${t.id}" aria-label="Select ticket ${esc(t.code)}"${state.selected.has(t.id) ? ' checked' : ''}></td>
            <td class="muted">${esc(t.code)}</td>
            <td class="col-title">${esc(t.title)}</td>
            <td>${esc(t.company.name)}</td>
            <td>${t.assignee ? esc(t.assignee.name) : '<span class="muted">Unassigned</span>'}</td>
            <td>${statusBadge(t.status)}</td>
            <td>${priorityBadge(t.priority)}</td>
            <td>${dueCell(t)}</td>
            <td title="${formatDate(t.updated_at)}">${formatRelative(t.updated_at)}</td>
        </tr>`).join('') : emptyRow(9, 'No tickets match these filters.');

    $$('#tickets-table th[data-sort]').forEach(th => {
        th.classList.toggle('sorted', th.dataset.sort === state.sort);
        th.dataset.order = th.dataset.sort === state.sort ? state.order : '';
    });

    const start = state.total ? (state.page - 1) * state.pageSize + 1 : 0;
    const end = Math.min(state.page * state.pageSize, state.total);
    $('#pager-info').textContent = `Showing ${start}–${end} of ${state.total}`;
    $('#prev-page').disabled = state.page <= 1;
    $('#next-page').disabled = end >= state.total;
    updateBulkBar();
}

function updateBulkBar() {
    const n = state.selected.size;
    $('#bulk-bar').hidden = n === 0;
    $('#bulk-count').textContent = `${n} selected`;
    const onPage = state.tickets.map(t => t.id);
    const all = $('#select-all');
    all.checked = onPage.length > 0 && onPage.every(id => state.selected.has(id));
    all.indeterminate = !all.checked && onPage.some(id => state.selected.has(id));
}

function resetAndLoadTickets() {
    state.page = 1;
    state.selected.clear();
    loadTickets();
}

async function applyBulk() {
    const body = { ids: [...state.selected] };
    const status = $('#bulk-status').value;
    const priority = $('#bulk-priority').value;
    const assignee = $('#bulk-assignee').value;
    if (status) body.status = status;
    if (priority) body.priority = priority;
    if (assignee) body.assignee_id = assignee === 'none' ? null : Number(assignee);
    if (Object.keys(body).length === 1) return toast('Pick a status, priority or assignee to apply.', 'error');

    try {
        const { updated } = await api('/tickets/bulk', { method: 'POST', body });
        toast(`Updated ${updated} ticket(s)`);
        ['#bulk-status', '#bulk-priority', '#bulk-assignee'].forEach(s => { $(s).value = ''; });
        state.selected.clear();
        await loadTickets();
    } catch (err) {
        toast(err.message, 'error');
    }
}

async function exportCsv() {
    try {
        const res = await api(`/tickets/export.csv?${filterParams()}`, { raw: true });
        const url = URL.createObjectURL(await res.blob());
        const a = Object.assign(document.createElement('a'), {
            href: url, download: `tickets-${new Date().toISOString().slice(0, 10)}.csv`,
        });
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ======================================================================
//  Ticket drawer (detail view)
// ======================================================================
async function openTicket(id) {
    try {
        state.ticket = await api(`/tickets/${id}`);
        renderDrawer();
        $('#ticket-drawer').classList.add('open');
        $('#drawer-backdrop').classList.add('open');
    } catch (err) {
        toast(err.message, 'error');
        history.replaceState(null, '', '#tickets');
    }
}

function closeDrawer(updateHash = true) {
    $('#ticket-drawer').classList.remove('open');
    $('#drawer-backdrop').classList.remove('open');
    state.ticket = null;
    if (updateHash && location.hash.startsWith('#tickets/')) history.replaceState(null, '', '#tickets');
}

function timeline(t) {
    const items = [
        ...t.comments.map(c => ({ kind: 'comment', at: c.created_at, id: c.id, c })),
        ...t.events.filter(e => e.field !== 'comment').map(e => ({ kind: 'event', at: e.created_at, id: e.id, e })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at) || (a.kind === b.kind ? a.id - b.id : 0));

    if (!items.length) return '<p class="muted">No activity yet.</p>';
    return `<ol class="timeline">${items.map(item => {
        if (item.kind === 'comment') {
            const c = item.c;
            return `<li class="tl-comment${c.is_internal ? ' internal' : ''}">
                <div class="tl-head"><b>${esc(c.author?.name || 'Someone')}</b>
                    ${c.is_internal ? '<span class="badge badge-internal">Internal note</span>' : ''}
                    <span class="muted small" title="${formatDate(c.created_at)}">${formatRelative(c.created_at)}</span></div>
                <div class="tl-body">${esc(c.body)}</div>
            </li>`;
        }
        const e = item.e;
        return `<li class="tl-event"><b>${esc(e.actor?.name || 'Someone')}</b> ${describeEvent(e)}
            <span class="muted small" title="${formatDate(e.created_at)}">· ${formatRelative(e.created_at)}</span></li>`;
    }).join('')}</ol>`;
}

function renderDrawer() {
    const t = state.ticket;
    const people = activeStaff().map(u => [u.id, u.name]);
    // Keep showing a deactivated assignee rather than silently blanking the field
    if (t.assignee && !people.some(([id]) => id === t.assignee.id)) people.push([t.assignee.id, `${t.assignee.name} (inactive)`]);

    $('#drawer-body').innerHTML = `
        <div class="drawer-head">
            <div>
                <span class="muted">${esc(t.code)} · ${esc(t.company.name)}</span>
                <h3>${esc(t.title)}</h3>
            </div>
            <button class="icon-btn" data-close-drawer aria-label="Close">✕</button>
        </div>

        <div class="drawer-fields">
            <label>Status<select data-field="status">${options(Object.entries(STATUS), t.status)}</select></label>
            <label>Priority<select data-field="priority">${options([['', 'Not set'], ...Object.entries(PRIORITY)], t.priority)}</select></label>
            <label>Category<select data-field="category">${options(Object.entries(CATEGORY), t.category)}</select></label>
            <label>Assignee<select data-field="assignee_id">${options([['', 'Unassigned'], ...people], t.assignee_id)}</select></label>
            <label>Company<select data-field="company_id">${options(state.companies.map(c => [c.id, c.name]), t.company_id)}</select></label>
        </div>

        <dl class="meta">
            <dt>Due</dt><dd>${DONE.includes(t.status) || !t.due_at ? '—' : `${dueCell(t)} <span class="muted small">(${formatDate(t.due_at)})</span>`}</dd>
            <dt>Requester</dt><dd>${t.requester ? esc(t.requester.name) : '<span class="muted">—</span>'}</dd>
            <dt>Asset</dt><dd>${t.asset ? `${esc(t.asset.code)} · ${esc(t.asset.name)}` : '<span class="muted">—</span>'}</dd>
            <dt>Created</dt><dd>${formatDate(t.created_at)}${t.created_by ? ` by ${esc(t.created_by.name)}` : ''}</dd>
            ${t.resolved_at ? `<dt>Resolved</dt><dd>${formatDate(t.resolved_at)}</dd>` : ''}
        </dl>

        <div class="drawer-actions">
            <button class="btn btn-secondary btn-sm" data-action="edit-ticket" data-id="${t.id}">Edit details</button>
            <button class="btn btn-danger btn-sm admin-only" data-action="delete-ticket" data-id="${t.id}">Delete</button>
        </div>

        <h4>Description</h4>
        <div class="description">${t.description ? esc(t.description) : '<span class="muted">No description.</span>'}</div>

        <h4>Activity</h4>
        ${timeline(t)}

        <form id="comment-form" class="comment-form">
            <textarea id="comment-body" rows="3" placeholder="Write a reply or an internal note…" required maxlength="20000"></textarea>
            <div class="comment-actions">
                <label class="check"><input type="checkbox" id="comment-internal"> Internal note (technicians only)</label>
                <button type="submit" class="btn btn-primary btn-sm">Add comment</button>
            </div>
        </form>`;
}

async function updateTicketField(field, raw) {
    const t = state.ticket;
    let value = raw;
    if (field === 'assignee_id') value = raw ? Number(raw) : null;
    if (field === 'company_id') value = Number(raw);
    if (field === 'priority' && !raw) return renderDrawer();  // a priority can be changed but not cleared
    try {
        state.ticket = await api(`/tickets/${t.id}`, { method: 'PATCH', body: { [field]: value } });
        renderDrawer();
        toast('Ticket updated');
        loadTickets();
    } catch (err) {
        toast(err.message, 'error');
        renderDrawer(); // put the select back to the saved value
    }
}

async function submitComment(form) {
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
        await api(`/tickets/${state.ticket.id}/comments`, {
            method: 'POST',
            body: { body: $('#comment-body').value.trim(), is_internal: $('#comment-internal').checked },
        });
        state.ticket = await api(`/tickets/${state.ticket.id}`);
        renderDrawer();
        toast('Comment added');
        loadTickets();
    } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
    }
}

// ======================================================================
//  Ticket create / edit modal
// ======================================================================
function openTicketModal(id = null) {
    if (!state.companies.length) return toast('Create a company first.', 'error');
    $('#ticket-form').reset();
    updateCompanySelects();
    $('#ticket-requester').innerHTML = options([['', 'Nobody'], ...activeUsers().map(u => [u.id, `${u.name} (${u.email})`])]);
    const t = id && state.ticket?.id === id ? state.ticket : null;
    $('#ticket-id').value = t?.id ?? '';
    $('#ticket-modal-title').textContent = t ? `Edit Ticket ${t.code}` : 'New Ticket';
    if (t) {
        $('#ticket-title').value = t.title;
        $('#ticket-description').value = t.description || '';
        $('#ticket-company').value = t.company_id;
        $('#ticket-category').value = t.category;
        $('#ticket-requester').value = t.requester_id ?? '';
        $('#ticket-assignee').value = t.assignee_id ?? '';
    } else {
        // Pre-fill the company when the list is filtered to one
        const filtered = $('#filter-company').value;
        if (filtered) $('#ticket-company').value = filtered;
    }
    openModal($('#ticket-modal'));
}

onSubmit($('#ticket-form'), async () => {
    const id = $('#ticket-id').value;
    const assignee = $('#ticket-assignee').value;
    const body = {
        title: $('#ticket-title').value.trim(),
        description: $('#ticket-description').value.trim() || null,
        company_id: Number($('#ticket-company').value),
        category: $('#ticket-category').value,
        assignee_id: assignee ? Number(assignee) : null,
        requester_id: $('#ticket-requester').value ? Number($('#ticket-requester').value) : null,
    };
    const saved = id
        ? await api(`/tickets/${id}`, { method: 'PATCH', body })
        : await api('/tickets', { method: 'POST', body });
    closeModal($('#ticket-modal'));
    toast(id ? 'Ticket updated' : `Ticket ${saved.code} created`);
    if (state.tab === 'tickets') loadTickets();
    go(`tickets/${saved.id}`);
});

async function deleteTicket(id) {
    if (!confirm(`Permanently delete ticket #${id} and its comments?`)) return;
    try {
        await api(`/tickets/${id}`, { method: 'DELETE' });
        toast('Ticket deleted');
        closeDrawer();
        state.selected.delete(id);
        loadTickets();
    } catch (err) {
        toast(err.message, 'error');
    }
}

// ======================================================================
//  Events
// ======================================================================
function setupEvents() {
    window.addEventListener('hashchange', route);

    $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
        if (location.hash === `#${btn.dataset.tab}`) showTab(btn.dataset.tab, true);
        else location.hash = btn.dataset.tab;
    }));

    $('#logout-btn').addEventListener('click', logout);
    $('#profile-btn').addEventListener('click', openProfileModal);
    $('#new-ticket-btn').addEventListener('click', () => openTicketModal());
    $('#new-company-btn').addEventListener('click', () => openCompanyModal());
    $('#new-user-btn').addEventListener('click', () => openUserModal());
    $('#export-btn').addEventListener('click', exportCsv);

    ['#filter-status', '#filter-priority', '#filter-company', '#filter-assignee', '#filter-overdue']
        .forEach(sel => $(sel).addEventListener('change', resetAndLoadTickets));
    $('#filter-q').addEventListener('input', debounce(resetAndLoadTickets, 300));

    $('#prev-page').addEventListener('click', () => { state.page--; loadTickets(); });
    $('#next-page').addEventListener('click', () => { state.page++; loadTickets(); });

    $$('#tickets-table th[data-sort]').forEach(th => th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (state.sort === col) state.order = state.order === 'asc' ? 'desc' : 'asc';
        else { state.sort = col; state.order = ['title', 'id'].includes(col) ? 'asc' : 'desc'; }
        if (col === 'due_at' && state.sort === col && th.dataset.order === '') state.order = 'asc';
        state.page = 1;
        loadTickets();
    }));

    $('#select-all').addEventListener('change', (e) => {
        state.tickets.forEach(t => (e.target.checked ? state.selected.add(t.id) : state.selected.delete(t.id)));
        renderTickets();
    });
    $('#bulk-apply').addEventListener('click', applyBulk);
    $('#bulk-clear').addEventListener('click', () => { state.selected.clear(); renderTickets(); });

    const actions = {
        'edit-company': openCompanyModal,
        'delete-company': deleteCompany,
        'company-tickets': (id) => goToTickets({ status: '', company_id: id }),
        'edit-ticket': openTicketModal,
        'delete-ticket': deleteTicket,
        'edit-user': openUserModal,
    };

    document.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-action]');
        if (actionBtn) return actions[actionBtn.dataset.action]?.(Number(actionBtn.dataset.id));

        const goBtn = e.target.closest('[data-go]');
        if (goBtn) return goToTickets(JSON.parse(goBtn.dataset.go));

        const check = e.target.closest('[data-select]');
        if (check) {
            const id = Number(check.dataset.select);
            check.checked ? state.selected.add(id) : state.selected.delete(id);
            check.closest('tr').classList.toggle('selected', check.checked);
            return updateBulkBar();
        }
        if (e.target.closest('.col-check')) return; // clicking around the checkbox

        const row = e.target.closest('[data-open-ticket]');
        if (row) return go(`tickets/${row.dataset.openTicket}`);

        if (e.target.closest('[data-close-drawer]') || e.target.id === 'drawer-backdrop') return closeDrawer();
        if (e.target.matches('[data-close-modal]')) return closeModal(e.target.closest('.modal'));
        if (e.target.classList.contains('modal')) return closeModal(e.target);
    });

    // Drawer: inline field edits and comment form (rendered dynamically → delegated)
    $('#ticket-drawer').addEventListener('change', (e) => {
        const field = e.target.dataset.field;
        if (field) updateTicketField(field, e.target.value);
    });
    $('#ticket-drawer').addEventListener('submit', (e) => {
        if (e.target.id === 'comment-form') { e.preventDefault(); submitComment(e.target); }
    });
    $('#ticket-drawer').addEventListener('keydown', (e) => {
        if (e.target.id === 'comment-body' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.target.form.requestSubmit();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const open = $$('.modal.active');
        if (open.length) open.forEach(closeModal);
        else if (state.ticket) closeDrawer();
    });
}

// ======================================================================
//  Boot
// ======================================================================
document.addEventListener('DOMContentLoaded', async () => {
    setupEvents();
    if (token) {
        try {
            state.me = await api('/auth/me');
            return await enterApp();
        } catch { /* token expired → fall through to sign-in */ }
    }
    showAuth();
});
