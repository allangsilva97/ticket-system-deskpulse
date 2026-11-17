'use strict';

/* =====================================================================
   1. UTILITIES
   ===================================================================== */

// --- HTML escaping ----------------------------------------------------
// Every value interpolated through the h`` template tag is escaped automatically,
// so user-supplied text can never inject markup (the original used raw innerHTML
// everywhere, which allowed stored XSS through ticket subjects, notes, asset names...).
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Safe(s);
function toHtml(v) {
    if (v instanceof Safe) return v.s;
    if (Array.isArray(v)) return v.map(toHtml).join('');
    if (v === null || v === undefined || v === false) return '';
    return esc(v);
}
function h(strings, ...vals) {
    let out = strings[0];
    for (let i = 0; i < vals.length; i++) out += toHtml(vals[i]) + strings[i + 1];
    return new Safe(out);
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// --- Storage (every access is guarded: private mode / blocked storage must not break the app) ---
function storageArea(name) {
    try { const s = window[name]; s.setItem('__t', '1'); s.removeItem('__t'); return s; } catch (e) { return null; }
}
const local = storageArea('localStorage');
const session = storageArea('sessionStorage');
const store = {
    read(area, key) { try { const v = area && area.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    write(area, key, val) { try { if (area) area.setItem(key, JSON.stringify(val)); } catch (e) { /* quota or privacy mode */ } },
    remove(area, key) { try { if (area) area.removeItem(key); } catch (e) { /* ignore */ } }
};

// --- Dates ---
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
function fmtDate(s) {
    const d = new Date(s);
    // Use the page language (pt-BR) so dates match the UI instead of the browser's locale.
    return isNaN(d) ? '' : d.toLocaleString(document.documentElement.lang || 'en', { dateStyle: 'medium', timeStyle: 'short' });
}
function timeAgo(s) {
    const diff = Date.now() - new Date(s).getTime();
    if (isNaN(diff)) return '';
    if (diff < MIN) return 'agora há pouco';
    if (diff < HOUR) return 'há ' + Math.floor(diff / MIN) + ' min';
    if (diff < DAY) return 'há ' + Math.floor(diff / HOUR) + ' h';
    if (diff < 7 * DAY) return 'há ' + Math.floor(diff / DAY) + ' d';
    return fmtDate(s);
}
function fmtDuration(ms) {
    const m = Math.max(0, Math.round(ms / MIN));
    if (m < 60) return m + 'm';
    const hrs = Math.floor(m / 60);
    if (hrs < 24) return hrs + 'h ' + (m % 60) + 'm';
    return Math.floor(hrs / 24) + 'd ' + (hrs % 24) + 'h';
}

async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (err) { /* ignore */ }
        ta.remove();
        return ok;
    }
}

// --- QR code for the 2FA setup (optional: without the library the secret is shown as text) ---
function qrDataUrl(text) {
    if (typeof window.qrcode !== 'function') return null; // library blocked or offline: the secret is still shown
    try { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createDataURL(5, 2); } catch (e) { return null; }
}
const groupSecret = (s) => s.replace(/(.{4})/g, '$1 ').trim();

/* =====================================================================
   2. CONSTANTS
   ===================================================================== */
const TOKEN_KEY = 'deskpulse_token';
const THEME_KEY = 'deskpulse_theme';
const API_BASE = '/api';

// The server speaks snake_case values ('in_progress'); the screens use the readable keys on the right.
const ENUMS = {
    status:   [['open', 'Open'], ['in_progress', 'In Progress'], ['waiting', 'Waiting'], ['resolved', 'Resolved'], ['closed', 'Closed']],
    priority: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['critical', 'Critical']],
    category: [['hardware', 'Hardware'], ['software', 'Software'], ['network', 'Network'], ['access_security', 'Access/Security'], ['other', 'Other']],
    type:     [['laptop', 'Laptop'], ['desktop', 'Desktop'], ['printer', 'Printer'], ['server', 'Server'], ['software_license', 'Software License'], ['network', 'Network']],
    asset:    [['in_use', 'In Use'], ['stock', 'Stock'], ['maintenance', 'Maintenance'], ['retired', 'Retired']],
    role:     [['admin', 'Admin'], ['technician', 'Technician'], ['user', 'User']]
};
const toUi = (kind, v) => { const p = ENUMS[kind].find(([a]) => a === v); return p ? p[1] : v; };
const toApi = (kind, v) => { const p = ENUMS[kind].find(([, u]) => u === v); return p ? p[0] : v; };

const STATUSES = ENUMS.status.map(([, ui]) => ui);
const PRIORITIES = ENUMS.priority.map(([, ui]) => ui);
// Only technicians set a priority, so a new ticket has none yet.
const UNRATED = 'Unrated';
const CATEGORIES = [['Hardware', 'Hardware'], ['Software', 'Software'], ['Network', 'Rede e VPN'], ['Access/Security', 'Acesso e segurança'], ['Other', 'Outro']];
const ASSET_TYPES = [['Laptop', 'Notebook'], ['Desktop', 'Desktop'], ['Printer', 'Impressora'], ['Server', 'Servidor'], ['Software License', 'Licença de software'], ['Network', 'Equipamento de rede']];
const ASSET_STATUSES = [['In Use', 'Em uso'], ['Stock', 'Em estoque (pronto)'], ['Maintenance', 'Em manutenção'], ['Retired', 'Desativado / baixado']];
const ROLES = [['Admin', 'Administrador'], ['Technician', 'Técnico'], ['User', 'Usuário final']];
const USER_STATUSES = [['Active', 'Ativo'], ['Inactive', 'Inativo']];

// Values stay in English (they map to the server's enums); only the labels shown to people are translated.
const UNASSIGNED = 'Não atribuído';
const LABEL = {
    status:   { 'Open': 'Aberto', 'In Progress': 'Em andamento', 'Waiting': 'Aguardando', 'Resolved': 'Resolvido', 'Closed': 'Fechado' },
    priority: { 'Low': 'Baixa', 'Medium': 'Média', 'High': 'Alta', 'Critical': 'Crítica', 'Unrated': 'A definir' },
    asset:    { 'In Use': 'Em uso', 'Stock': 'Em estoque', 'Maintenance': 'Em manutenção', 'Retired': 'Desativado' },
    role:     { 'Admin': 'Administrador', 'Technician': 'Técnico', 'User': 'Usuário final' },
    user:     { 'Active': 'Ativo', 'Inactive': 'Inativo' },
    category: Object.fromEntries(CATEGORIES),
    type:     Object.fromEntries(ASSET_TYPES)
};
const lbl = (kind, value) => (LABEL[kind] && LABEL[kind][value]) || value;
const STATUS_OPTS = STATUSES.map((s) => [s, lbl('status', s)]);
const PRIORITY_OPTS = PRIORITIES.map((p) => [p, lbl('priority', p)]);
const PRIORITY_FILTER_OPTS = [...PRIORITY_OPTS, [UNRATED, lbl('priority', UNRATED)]];

// Role -> permissions. These only decide what the screens show: the server enforces every one of them.
const PERMS = {
    Admin:      { allTickets: true,  manageTickets: true,  viewInventory: true,  editInventory: true,  manageUsers: true },
    Technician: { allTickets: true,  manageTickets: true,  viewInventory: true,  editInventory: true,  manageUsers: false },
    User:       { allTickets: false, manageTickets: false, viewInventory: false, editInventory: false, manageUsers: false }
};

const ROUTE_NAMES = ['home', 'overview', 'tickets', 'inventory', 'users', 'settings'];
const ROUTE_PERM = { inventory: 'viewInventory', users: 'manageUsers' };
const ROUTE_TITLES = { home: 'Início', overview: 'Visão geral', tickets: 'Chamados', inventory: 'Inventário de ativos', users: 'Gestão de usuários', settings: 'Configurações' };

// Badge colours (light + dark), defined once so every table and modal looks the same.
const TONE = {
    slate:   'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
    blue:    'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    violet:  'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
    emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    amber:   'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    orange:  'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
    rose:    'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
    brand:   'bg-brand-100 text-brand-800 dark:bg-brand-900/50 dark:text-brand-300'
};
const TONE_OF = {
    status:   { 'Open': 'blue', 'In Progress': 'violet', 'Waiting': 'amber', 'Resolved': 'emerald', 'Closed': 'slate' },
    priority: { 'Low': 'slate', 'Medium': 'blue', 'High': 'orange', 'Critical': 'rose', 'Unrated': 'slate' },
    asset:    { 'In Use': 'emerald', 'Stock': 'blue', 'Maintenance': 'amber', 'Retired': 'slate' },
    role:     { 'Admin': 'violet', 'Technician': 'brand', 'User': 'slate' },
    user:     { 'Active': 'emerald', 'Inactive': 'slate' }
};
const pill = (tone, content) => h`<span class="badge ${TONE[tone] || TONE.slate}">${content}</span>`;
const badge = (kind, value) => pill((TONE_OF[kind] || {})[value] || 'slate', lbl(kind, value));

/* =====================================================================
   3. STATE, API CLIENT & DATA LOADING
   ===================================================================== */
const state = {
    tickets: [], assets: [], users: [], companies: [],
    me: null,
    route: 'home',
    ui: freshUi()
};
function freshUi() {
    return {
        ticketSearch: '', ticketStatus: 'all', ticketPriority: 'all',
        assetSearch: '', assetType: 'all', assetStatus: 'all',
        openTicketId: null,
        totpSetup: null // { userId, secret, uri } while the 2FA enrollment is in progress
    };
}

// --- API client ---
// The token lives in memory and in storage (local = "keep me signed in", session = until the tab closes).
let authToken = null;

class ApiError extends Error {
    constructor(message, status, headers) { super(message); this.status = status; this.headers = headers; }
}

// The server answers in English; these are the messages people can actually run into.
const SERVER_TEXT = {
    'Invalid email or password': 'E-mail ou senha inválidos.',
    'Invalid two-factor code': 'Código inválido ou já utilizado. Aguarde o próximo código do aplicativo.',
    'Too many failed attempts. Please wait a few minutes and try again.': 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
    'Current password is incorrect': 'A senha atual está incorreta.',
    'A user with this email already exists': 'Já existe um usuário com esse e-mail.',
    'An asset with this serial number already exists': 'Outro ativo já usa esse número de série.',
    'Your account is not linked to a company. Ask an administrator.': 'Sua conta não está vinculada a uma empresa. Peça a um administrador.',
    'That asset is not assigned to you': 'Esse ativo não está atribuído a você.',
    'Wrong password or code': 'Senha ou código incorretos.',
    'Invalid email or password.': 'E-mail ou senha inválidos.',
    'Invalid setup code': 'Código de instalação incorreto.',
    'Setup is already complete. Please sign in.': 'A instalação já foi concluída. Entre com sua conta.',
    'Keep at least one active administrator': 'É necessário manter pelo menos um administrador ativo.',
    "You can't delete your own account": 'Você não pode excluir a própria conta.',
    "You can't demote or deactivate your own account": 'Você não pode alterar seu próprio perfil ou status.',
    'Technicians only': 'Essa ação é só para a equipe de TI.',
    'Admins only': 'Essa ação é só para administradores.',
    'Only technicians can set priority, assignee, requester or company': 'Só a equipe de TI define prioridade, responsável, solicitante e empresa.',
    'Only technicians can write internal notes': 'Só a equipe de TI escreve notas internas.'
};
function apiMessage(data, res) {
    const detail = data && data.detail;
    if (Array.isArray(detail)) return detail.map((d) => ((d.loc && d.loc.slice(1).join('.')) || 'campo') + ': ' + d.msg).join('\n');
    if (typeof detail === 'string') return SERVER_TEXT[detail] || detail;
    return 'Falha na requisição (' + res.status + ').';
}
async function api(path, { method = 'GET', body, auth = true, headers: extra } = {}) {
    const headers = { ...extra };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && authToken) headers.Authorization = 'Bearer ' + authToken;
    let res;
    try {
        res = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
        throw new ApiError('Sem conexão com o servidor. Verifique sua rede e tente de novo.', 0, null);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        if (res.status === 401 && auth && authToken) sessionExpired();
        throw new ApiError(apiMessage(data, res), res.status, res.headers);
    }
    return data;
}
let expiring = false;
function sessionExpired() {
    if (expiring || !state.me) return;
    expiring = true;
    endSession();
    showToast('Sua sessão expirou. Entre novamente.', 'info');
    navigate('home');
    expiring = false;
}

// --- Adapters: server shape -> what the screens use ---
function adaptUser(u) {
    return {
        id: u.id, name: u.name, email: u.email, role: toUi('role', u.role),
        status: u.is_active ? 'Active' : 'Inactive', twoFactor: !!u.two_factor_enabled, companyId: u.company_id ?? null
    };
}
function adaptTicket(a, prev) {
    const t = {
        id: a.code, num: a.id, subject: a.title,
        description: a.description !== undefined ? (a.description || '') : (prev ? prev.description : ''),
        requester: a.requester ? a.requester.name : '—', requesterId: a.requester ? a.requester.id : null,
        category: toUi('category', a.category), status: toUi('status', a.status),
        priority: a.priority ? toUi('priority', a.priority) : UNRATED,
        companyName: a.company ? a.company.name : '',
        assigneeId: a.assignee_id ?? null, assigneeName: a.assignee ? a.assignee.name : null,
        assetId: a.asset_id ? 'AST-' + a.asset_id : '',
        createdAt: a.created_at, resolvedAt: a.resolved_at, dueAt: a.due_at,
        asset: prev ? prev.asset : null, timeline: prev ? prev.timeline : [], detailLoaded: !!(prev && prev.detailLoaded)
    };
    if (a.comments) { // the full ticket: also carries the history
        t.timeline = buildTimeline(a);
        t.asset = a.asset ? { id: a.asset.code, name: a.asset.name } : null;
        t.detailLoaded = true;
    }
    return t;
}
function adaptAsset(a) {
    const holder = a.assigned_user ? a.assigned_user.name : '';
    return {
        id: a.code, num: a.id, name: a.name, type: toUi('type', a.type), serial: a.serial || '',
        status: toUi('asset', a.status), assignedUserId: a.assigned_user ? a.assigned_user.id : null,
        location: a.location || '', assignedUser: holder || a.location || UNASSIGNED
    };
}
function eventText(e) {
    const nv = e.new_value, ov = e.old_value;
    switch (e.field) {
        case 'created': return 'Chamado criado.';
        case 'status': return 'Status alterado para ' + lbl('status', toUi('status', nv));
        case 'priority': return ov ? 'Prioridade alterada de ' + lbl('priority', toUi('priority', ov)) + ' para ' + lbl('priority', toUi('priority', nv))
            : 'Prioridade definida como ' + lbl('priority', toUi('priority', nv));
        case 'category': return 'Categoria alterada para ' + lbl('category', toUi('category', nv));
        case 'assignee': return nv ? 'Atribuído a ' + nv : 'Atribuição removida';
        case 'requester': return nv ? 'Solicitante alterado para ' + nv : 'Solicitante removido';
        case 'company': return 'Empresa alterada para ' + nv;
        case 'asset': return nv ? 'Ativo vinculado: ' + nv : 'Ativo desvinculado (' + ov + ')';
        case 'title': return 'Título alterado para "' + nv + '"';
        default: return 'Chamado atualizado (' + e.field + ').';
    }
}
// History events and comments become one timeline, oldest first. Internal notes only come back for staff.
function buildTimeline(a) {
    const items = [];
    for (const e of a.events) {
        if (e.field === 'comment') continue; // the comment itself is listed below
        items.push({ author: e.actor ? e.actor.name : 'Sistema', text: eventText(e), at: e.created_at, internal: false });
    }
    for (const c of a.comments) {
        items.push({ author: c.author ? c.author.name : 'Ex-usuário', text: c.body, at: c.created_at, internal: c.is_internal });
    }
    return items.sort((x, y) => new Date(x.at) - new Date(y.at));
}

// --- Loading ---
async function fetchAll(path) {
    const items = [];
    for (let page = 1; ; page++) {
        const r = await api(path + '?page=' + page + '&page_size=200');
        items.push(...r.items);
        if (!r.items.length || items.length >= r.total) return items;
    }
}
async function loadData() {
    if (!state.me) return;
    const staff = can('allTickets');
    const jobs = [fetchAll('/tickets').then((list) => {
        const before = new Map(state.tickets.map((t) => [t.num, t]));
        state.tickets = list.map((a) => adaptTicket(a, before.get(a.id)));
    })];
    if (staff) {
        jobs.push(fetchAll('/assets').then((list) => { state.assets = list.map(adaptAsset); }));
        jobs.push(api('/users?include_inactive=true').then((list) => { state.users = list.map(adaptUser); }));
        jobs.push(api('/companies').then((list) => { state.companies = list; }));
    } else {
        // End users only get the equipment assigned to them, and nobody else's account.
        state.users = [state.me];
        jobs.push(api('/assets/mine').then((list) => {
            state.assets = list.map((a) => ({ id: a.code, num: a.id, name: a.name, type: '', serial: '', status: 'In Use', assignedUser: state.me.name }));
        }));
    }
    await Promise.all(jobs);
}
let reloading = null;
function reloadAndRender() {
    if (!reloading) {
        reloading = loadData().then(refresh).catch((err) => { if (err.status !== 401) showToast('Não foi possível atualizar os dados: ' + err.message, 'error'); })
            .finally(() => { reloading = null; });
    }
    return reloading;
}

// --- Session ---
function persistToken(remember) {
    store.remove(local, TOKEN_KEY); store.remove(session, TOKEN_KEY);
    store.write(remember ? local : session, TOKEN_KEY, authToken);
}
function endSession() {
    authToken = null;
    state.me = null;
    state.tickets = []; state.assets = []; state.users = []; state.companies = [];
    store.remove(local, TOKEN_KEY); store.remove(session, TOKEN_KEY);
    closeAllModals();
    state.ui = freshUi();
}
async function restoreSession() {
    const saved = store.read(local, TOKEN_KEY) || store.read(session, TOKEN_KEY);
    if (!saved) return;
    authToken = saved;
    try {
        state.me = adaptUser(await api('/auth/me'));
        await loadData();
    } catch (err) {
        if (err.status === 401) endSession();
        else showToast('Não foi possível carregar os dados: ' + err.message, 'error');
    }
}

/* =====================================================================
   4. DOMAIN HELPERS
   ===================================================================== */
const currentUser = () => state.me;
const can = (perm) => { const u = currentUser(); return !!(u && PERMS[u.role] && PERMS[u.role][perm]); };
const canAccess = (route) => !ROUTE_PERM[route] || can(ROUTE_PERM[route]);

const isDone = (t) => t.status === 'Resolved' || t.status === 'Closed';
const isActive = (t) => !isDone(t);

const assigneeName = (t) => t.assigneeName || UNASSIGNED;
const findTicket = (id) => state.tickets.find((t) => t.id === id) || null;
// The server only sends what this person may see (end users get just the tickets they opened).
const visibleTickets = () => [...state.tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
function requesterEmail(t) {
    const u = t.requesterId !== null ? state.users.find((x) => x.id === t.requesterId) : null;
    return u ? u.email : '';
}

// SLA comes from the server: the due date is set when a technician sets the priority.
function slaInfo(t) {
    if (!t.dueAt) return null;
    const due = new Date(t.dueAt).getTime();
    const target = due - new Date(t.createdAt).getTime();
    const finished = isDone(t);
    const end = finished ? new Date(t.resolvedAt || t.createdAt).getTime() : Date.now();
    return { target, due, finished, breached: end > due, remaining: due - end };
}
const isBreached = (t) => { const s = slaInfo(t); return !!s && s.breached; };
function slaBadge(t) {
    const s = slaInfo(t);
    if (!s) return pill('slate', 'Aguardando triagem');
    if (s.finished) return s.breached ? pill('rose', 'SLA descumprido') : pill('emerald', 'SLA cumprido');
    if (s.breached) return pill('rose', 'Atrasado há ' + fmtDuration(-s.remaining));
    return pill(s.remaining < s.target * 0.25 ? 'amber' : 'slate', 'faltam ' + fmtDuration(s.remaining));
}

// Staff can link any asset still in service; an end user only sees the ones assigned to them.
const assetsForRequester = () => (can('viewInventory') ? state.assets.filter((a) => a.status !== 'Retired') : state.assets);

/* =====================================================================
   5. UI INFRASTRUCTURE: toasts, modals, confirm dialog, theme, router
   ===================================================================== */

// --- Toasts ---
function showToast(message, type = 'success') {
    const styles = {
        success: ['bg-emerald-700', 'fa-circle-check'],
        error: ['bg-rose-700', 'fa-circle-exclamation'],
        info: ['bg-slate-800 dark:bg-slate-700', 'fa-circle-info']
    };
    const [bg, icon] = styles[type] || styles.info;
    const toast = document.createElement('div');
    toast.className = 'pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl shadow-xl font-medium text-sm text-white max-w-sm transition-all duration-300 translate-y-2 opacity-0 ' + bg;
    const i = document.createElement('i');
    i.className = 'fa-solid ' + icon + ' text-lg mt-0.5';
    i.setAttribute('aria-hidden', 'true');
    const span = document.createElement('span');
    span.textContent = message; // textContent: messages can contain user input
    toast.append(i, span);
    $('#toast-container').appendChild(toast);
    requestAnimationFrame(() => toast.classList.remove('translate-y-2', 'opacity-0'));
    setTimeout(() => {
        toast.classList.add('translate-y-2', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, type === 'error' ? 5500 : 3500);
}

// --- Modals: focus management, Esc, backdrop click, focus trap ---
const modalStack = [];
const lastFocus = new Map();
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const focusables = (root) => $$(FOCUSABLE, root).filter((n) => n.getClientRects().length > 0);

function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!modalStack.includes(id)) modalStack.push(id);
    lastFocus.set(id, document.activeElement);
    el.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    requestAnimationFrame(() => {
        const target = $('[data-autofocus]', el)
            || $$('input:not([type=hidden]):not([readonly]):not([disabled]), select:not([disabled]), textarea:not([disabled])', el).find((n) => n.getClientRects().length > 0)
            || focusables(el)[0];
        if (target) target.focus();
    });
}
function closeModal(id) {
    const el = document.getElementById(id);
    if (!el || el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    const i = modalStack.indexOf(id);
    if (i >= 0) modalStack.splice(i, 1);
    if (!modalStack.length) document.body.classList.remove('overflow-hidden');
    if (id === 'ticket-detail-modal') state.ui.openTicketId = null;
    if (id === 'confirm-modal') resolveConfirm(false);
    const prev = lastFocus.get(id);
    lastFocus.delete(id);
    const fallback = $('#main');
    const target = prev && document.contains(prev) && prev.getClientRects().length ? prev : fallback;
    if (target) target.focus({ preventScroll: true });
}
function closeAllModals() { [...modalStack].forEach(closeModal); }

let downOnOverlay = false; // avoids closing when a text selection drag ends on the backdrop
document.addEventListener('mousedown', (e) => { downOnOverlay = !!(e.target.classList && e.target.classList.contains('modal-overlay')); });
document.addEventListener('keydown', (e) => {
    const top = modalStack[modalStack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(top); return; }
    if (e.key === 'Tab') {
        const items = focusables(document.getElementById(top));
        if (!items.length) { e.preventDefault(); return; }
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
});

// --- Confirm dialog (promise based) ---
let confirmResolver = null;
function resolveConfirm(value) {
    if (!confirmResolver) return;
    const r = confirmResolver; confirmResolver = null; r(value);
}
function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false }) {
    resolveConfirm(false);
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const btn = $('#confirm-yes');
    btn.textContent = confirmLabel;
    btn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    return new Promise((resolve) => { confirmResolver = resolve; openModal('confirm-modal'); });
}

// --- Theme ---
function applyThemeUI() {
    const dark = document.documentElement.classList.contains('dark');
    $('#theme-icon').className = 'fa-solid ' + (dark ? 'fa-sun' : 'fa-moon');
    const label = dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro';
    const btn = $('#theme-toggle');
    btn.setAttribute('aria-label', label);
    btn.title = label;
}
function toggleTheme() {
    const dark = document.documentElement.classList.toggle('dark');
    try { if (local) local.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) { /* ignore */ }
    applyThemeUI();
}

// --- Router (hash based: back/forward buttons and refresh keep working) ---
function navigate(route) {
    const target = '#/' + route;
    if (location.hash === target) handleRoute(); else location.hash = target;
}
function handleRoute(initial = false) {
    const user = currentUser();
    let route = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'home';
    if (!ROUTE_NAMES.includes(route)) route = 'home';

    if (route === 'home' && user) route = 'overview';
    else if (route !== 'home' && !user) {
        route = 'home';
        if (!initial) showToast('Faça login para continuar.', 'info');
    } else if (!canAccess(route)) {
        route = 'overview';
        showToast('Você não tem acesso a esta seção.', 'error');
    }
    if (location.hash !== '#/' + route) {
        try { history.replaceState(null, '', '#/' + route); } catch (e) { /* sandboxed iframe */ }
    }
    const changed = state.route !== route;
    state.route = route;
    document.title = ROUTE_TITLES[route] + ' - DeskPulse';
    renderHeader();
    renderView();
    if (changed || initial) window.scrollTo(0, 0);
    if (changed && !initial) {
        closeAllModals(); // e.g. the browser Back button while a dialog is open
        $('#main').focus({ preventScroll: true });
    }
    if (user && changed && !initial) reloadAndRender(); // pick up what other people changed meanwhile
}

/* =====================================================================
   6. VIEWS
   ===================================================================== */

// --- Small reusable view helpers ---
const options = (pairs, current) => pairs.map(([v, l]) => h`<option value="${v}" ${v === current ? 'selected' : ''}>${l}</option>`);
const avatar = (name, size = 'w-9 h-9') => h`<span class="${size} shrink-0 rounded-xl bg-brand-500/10 text-brand-700 dark:text-brand-300 font-bold flex items-center justify-center border border-brand-500/20" aria-hidden="true">${(Array.from(String(name))[0] || '?').toUpperCase()}</span>`;
const TH = (label, cls = '') => h`<th scope="col" class="th ${cls}">${label}</th>`;
const emptyState = (icon, title, text, action = '') => h`
    <div class="text-center py-12 muted">
        <i class="fa-solid ${icon} text-3xl mb-3" aria-hidden="true"></i>
        <p class="font-semibold text-slate-800 dark:text-slate-100">${title}</p>
        <p class="text-sm mt-1">${text}</p>
        ${action}
    </div>`;
const pageHeader = (title, subtitle, actions = '') => h`
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
            <h1 class="text-2xl font-bold">${title}</h1>
            <p class="text-sm muted">${subtitle}</p>
        </div>
        ${actions}
    </div>`;
const newTicketButton = () => h`<button type="button" data-action="open-new-ticket" class="btn btn-primary btn-sm w-fit py-2.5"><i class="fa-solid fa-plus" aria-hidden="true"></i> Novo chamado</button>`;
const searchBox = (id, input, placeholder, value) => h`
    <div class="relative flex-1">
        <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" aria-hidden="true"></i>
        <label for="${id}" class="sr-only">${placeholder}</label>
        <input type="search" id="${id}" data-input="${input}" value="${value}" placeholder="${placeholder}" autocomplete="off" class="field pl-10">
    </div>`;

// --- Header ---
function renderHeader() {
    const u = currentUser();
    $('#header-actions').innerHTML = String(u ? h`
        <div class="hidden sm:block text-right leading-tight">
            <div class="text-xs font-bold">${u.name}</div>
            <div class="text-[11px] muted">${lbl('role', u.role)}</div>
        </div>
        ${avatar(u.name)}
        <button type="button" data-action="logout" class="w-10 h-10 rounded-xl text-slate-500 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition" aria-label="Sair" title="Sair">
            <i class="fa-solid fa-arrow-right-from-bracket" aria-hidden="true"></i>
        </button>` : h`
        <button type="button" data-action="open-new-ticket" class="btn btn-sm btn-ghost hidden sm:inline-flex py-2">
            <i class="fa-solid fa-plus text-brand-600 dark:text-brand-400" aria-hidden="true"></i> Abrir chamado
        </button>
        <button type="button" data-action="open-login" class="btn btn-sm btn-primary py-2 px-4">
            <i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i> Entrar
        </button>`);
}

function renderView() {
    // Keep keyboard focus on the same control when the view re-renders (e.g. the 2FA switch).
    const active = document.activeElement;
    const view = $('#view');
    const activeId = active && active.id && view.contains(active) ? active.id : null;
    view.innerHTML = String(state.route === 'home' ? viewHome() : viewDashboard());
    if (activeId) { const el = document.getElementById(activeId); if (el) el.focus({ preventScroll: true }); }
}
function refresh() {
    renderHeader();
    renderView();
    if (state.ui.openTicketId) renderTicketDetail();
}

// --- Public landing page ---
function viewHome() {
    return h`
    <div class="flex-1 flex flex-col justify-center items-center px-4 py-12 max-w-5xl mx-auto w-full text-center">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 text-xs font-semibold mb-6">
            <i class="fa-solid fa-shield-halved" aria-hidden="true"></i> Suíte corporativa de Help Desk &amp; CMDB
        </div>
        <h1 class="text-4xl sm:text-6xl font-extrabold tracking-tight max-w-3xl leading-tight">
            Suporte de TI e gestão de ativos <span class="text-brand-600 dark:text-brand-400">reinventados</span>
        </h1>
        <p class="muted text-base sm:text-lg max-w-2xl mt-4">
            Agilize a resolução de incidentes, audite inventários de hardware e software e acompanhe o cumprimento de SLA em um único espaço de trabalho rápido.
        </p>

        <div class="flex flex-wrap items-center justify-center gap-4 mt-8">
            <button type="button" data-action="open-new-ticket" class="btn btn-primary px-6 py-3.5 rounded-2xl shadow-xl shadow-brand-500/30">
                <i class="fa-solid fa-ticket" aria-hidden="true"></i> Abrir chamado rápido
            </button>
            <button type="button" data-action="open-login" class="btn btn-secondary px-6 py-3.5 rounded-2xl">
                <i class="fa-solid fa-gauge-high text-brand-600 dark:text-brand-400" aria-hidden="true"></i> Acessar portal da equipe
            </button>
        </div>

    </div>`;
}

function timelineList(items) {
    if (!items.length) return h`<p class="text-sm muted">Nenhuma atividade ainda.</p>`;
    return h`<ol>${items.map((n) => h`
        <li class="relative ml-1.5 pl-6 pb-4 border-l-2 border-slate-200 dark:border-slate-700 last:border-transparent last:pb-0">
            <span class="absolute -left-[7px] top-0.5 w-3 h-3 rounded-full ${n.internal ? 'bg-amber-500' : 'bg-brand-500'}" aria-hidden="true"></span>
            <div class="text-xs muted">
                <time datetime="${n.at}" title="${fmtDate(n.at)}">${timeAgo(n.at)}</time> &middot;
                <span class="font-semibold text-slate-800 dark:text-slate-100">${n.author}</span>
                ${n.internal ? h`<span class="badge ${TONE.amber} ml-1"><i class="fa-solid fa-lock mr-1" aria-hidden="true"></i>Interna</span>` : ''}
            </div>
            <p class="text-sm mt-0.5 whitespace-pre-wrap break-words">${n.text}</p>
        </li>`)}</ol>`;
}

// --- Dashboard shell ---
function viewDashboard() {
    const route = state.route;
    const nav = [
        { route: 'overview', icon: 'fa-chart-pie', label: 'Visão geral' },
        { route: 'tickets', icon: 'fa-ticket', label: can('allTickets') ? 'Chamados' : 'Meus chamados' },
        { route: 'inventory', icon: 'fa-boxes-stacked', label: 'Inventário de ativos' },
        { route: 'users', icon: 'fa-users-gear', label: 'Gestão de usuários' },
        { route: 'settings', icon: 'fa-gear', label: 'Configurações e 2FA' }
    ].filter((n) => canAccess(n.route));
    const current = raw('aria-current="page"');
    const content = route === 'overview' ? viewOverview()
        : route === 'tickets' ? viewTickets()
        : route === 'inventory' ? viewInventory()
        : route === 'users' ? viewUsers()
        : viewSettings();

    return h`
    <div class="flex-1 flex flex-col md:flex-row">
        <aside class="w-full md:w-56 shrink-0 bg-white dark:bg-slate-800 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-700">
            <div class="p-4 border-b border-slate-200 dark:border-slate-700 hidden md:block">
                <span class="field-label mb-0">Navegação</span>
            </div>
            <nav aria-label="Navegação principal" class="p-3 flex flex-row md:flex-col gap-1 overflow-x-auto md:overflow-visible">
                ${nav.map((n) => h`
                    <a href="#/${n.route}" ${n.route === route ? current : ''} class="shrink-0 flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition ${n.route === route ? 'bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/60'}">
                        <i class="fa-solid ${n.icon} w-5 text-center" aria-hidden="true"></i> <span class="whitespace-nowrap md:whitespace-normal">${n.label}</span>
                    </a>`)}
            </nav>
        </aside>
        <section class="flex-1 min-w-0 p-4 sm:p-8">
            <div class="max-w-7xl mx-auto w-full">${content}</div>
        </section>
    </div>`;
}

// --- Tickets: shared table ---
function ticketTable(list, { full }) {
    const staff = can('manageTickets');
    return h`
    <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
            <caption class="sr-only">Chamados de suporte</caption>
            <thead class="border-b border-slate-200 dark:border-slate-700 text-xs muted uppercase">
                <tr>
                    ${TH('ID')}${TH('Assunto')}
                    ${TH('Prioridade')}${TH('Status')}
                    ${full && staff ? h`${TH('Responsável')}${TH('SLA')}` : ''}
                    ${TH('Criado')}${TH('Ações', 'text-right pr-0')}
                </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 dark:divide-slate-700/50">
                ${list.map((t) => h`
                    <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30">
                        <td class="td font-mono font-bold text-brand-700 dark:text-brand-300 text-xs whitespace-nowrap">${t.id}</td>
                        <td class="td font-medium max-w-[14rem]">
                            <div class="truncate" title="${t.subject}">${t.subject}</div>
                            <div class="text-xs muted truncate">${staff ? t.requester + ' · ' + lbl('category', t.category) : lbl('category', t.category)}</div>
                        </td>
                        <td class="td">${badge('priority', t.priority)}</td>
                        <td class="td">${badge('status', t.status)}</td>
                        ${full && staff ? h`
                            <td class="td text-xs font-medium whitespace-nowrap">${assigneeName(t)}</td>
                            <td class="td">${slaBadge(t)}</td>` : ''}
                        <td class="td text-xs muted whitespace-nowrap" title="${fmtDate(t.createdAt)}">${timeAgo(t.createdAt)}</td>
                        <td class="td pr-0 text-right">
                            <button type="button" data-action="view-ticket" data-id="${t.id}" class="btn btn-sm btn-ghost" aria-label="${staff ? 'Gerenciar' : 'Ver'} chamado ${t.id}">${staff ? 'Gerenciar' : 'Ver'}</button>
                        </td>
                    </tr>`)}
            </tbody>
        </table>
    </div>`;
}

// --- Overview ---
function metricCard({ label, value, icon, tone, sub, subTone }) {
    const tones = {
        blue: 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
        rose: 'bg-rose-50 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
        purple: 'bg-purple-50 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
        emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
    };
    const subs = {
        good: 'text-emerald-700 dark:text-emerald-400',
        bad: 'text-rose-700 dark:text-rose-400',
        neutral: 'muted'
    };
    return h`
    <div class="card p-6">
        <div class="flex items-center justify-between">
            <span class="field-label mb-0">${label}</span>
            <span class="w-10 h-10 rounded-xl flex items-center justify-center ${tones[tone]}"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
        </div>
        <div class="text-3xl font-extrabold mt-4">${value}</div>
        <div class="text-xs mt-2 font-medium ${subs[subTone]}">${sub}</div>
    </div>`;
}

function viewOverview() {
    const u = currentUser();
    const staff = can('allTickets');
    const tickets = visibleTickets();
    const active = tickets.filter(isActive);
    let cards;

    if (staff) {
        const unassigned = active.filter((t) => t.assigneeId === null || t.assigneeId === undefined).length;
        const critical = active.filter((t) => t.priority === 'Critical').length;
        const inUse = state.assets.filter((a) => a.status === 'In Use').length;
        const stock = state.assets.filter((a) => a.status === 'Stock').length;
        const overdue = active.filter(isBreached).length;
        // Compliance only counts tickets whose SLA outcome is known: finished ones, plus open
        // ones already past due. Open tickets still inside the window would inflate the rate.
        const measured = state.tickets.filter((t) => t.dueAt && (isDone(t) || isBreached(t))); // no due date = not triaged yet
        const onTime = measured.filter((t) => !isBreached(t)).length;
        const pct = measured.length ? Math.round((onTime / measured.length) * 1000) / 10 : 100;
        cards = h`<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            ${metricCard({ label: 'Chamados ativos', value: active.length, icon: 'fa-ticket', tone: 'blue', sub: unassigned ? unassigned + ' sem responsável' : 'Todos os chamados atribuídos', subTone: unassigned ? 'bad' : 'good' })}
            ${metricCard({ label: 'Problemas críticos', value: critical, icon: 'fa-triangle-exclamation', tone: 'rose', sub: critical ? 'Exige atenção imediata' : 'Nenhum incidente crítico', subTone: critical ? 'bad' : 'good' })}
            ${metricCard({ label: 'Total de ativos no CMDB', value: state.assets.length, icon: 'fa-boxes-stacked', tone: 'purple', sub: inUse + ' em uso · ' + stock + ' em estoque', subTone: 'neutral' })}
            ${metricCard({ label: 'Cumprimento de SLA', value: pct + '%', icon: 'fa-circle-check', tone: 'emerald', sub: overdue ? overdue + (overdue > 1 ? ' chamados atrasados' : ' chamado atrasado') : 'Todos os chamados dentro da meta', subTone: overdue ? 'bad' : 'good' })}
        </div>`;
    } else {
        const mine = state.assets.length; // an end user only receives their own equipment
        cards = h`<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            ${metricCard({ label: 'Meus chamados abertos', value: active.length, icon: 'fa-ticket', tone: 'blue', sub: 'Aguardando a TI', subTone: 'neutral' })}
            ${metricCard({ label: 'Resolvidos', value: tickets.length - active.length, icon: 'fa-circle-check', tone: 'emerald', sub: 'Resolvidos ou fechados', subTone: 'good' })}
            ${metricCard({ label: 'Meus ativos', value: mine, icon: 'fa-laptop', tone: 'purple', sub: 'Atribuídos a você', subTone: 'neutral' })}
        </div>`;
    }

    const recent = tickets.slice(0, 5);
    return h`
    <div class="space-y-6">
        ${pageHeader('Visão geral do painel', staff ? 'Bem-vindo(a) de volta, ' + u.name + '. Veja o estado atual da central de atendimento.' : 'Bem-vindo(a) de volta, ' + u.name + '. Veja um resumo das suas solicitações.', newTicketButton())}
        ${cards}
        <div class="card p-4 sm:p-6">
            <div class="flex items-center justify-between mb-4">
                <h2 class="font-bold text-lg">${staff ? 'Chamados recentes' : 'Meus chamados recentes'}</h2>
                <a href="#/tickets" class="link text-xs">Ver todos os chamados &rarr;</a>
            </div>
            ${recent.length ? ticketTable(recent, { full: false }) : emptyState('fa-ticket', 'Nenhum chamado ainda', 'Abra um novo chamado e ele aparecerá aqui.')}
        </div>
    </div>`;
}

// --- Tickets tab (search + filters, results re-render without losing input focus) ---
function ticketResults() {
    const ui = state.ui;
    const q = ui.ticketSearch.trim().toLowerCase();
    const all = visibleTickets();
    const rows = all.filter((t) =>
        (ui.ticketStatus === 'all' || t.status === ui.ticketStatus)
        && (ui.ticketPriority === 'all' || t.priority === ui.ticketPriority)
        && (!q || [t.id, t.subject, t.requester, t.category, assigneeName(t)].some((v) => String(v).toLowerCase().includes(q))));
    const filtered = q || ui.ticketStatus !== 'all' || ui.ticketPriority !== 'all';
    if (!rows.length) {
        return emptyState('fa-ticket', filtered ? 'Nenhum chamado corresponde aos filtros' : 'Nenhum chamado ainda',
            filtered ? 'Tente outro termo de busca ou limpe os filtros.' : 'Abra um novo chamado para começar.',
            filtered ? h`<button type="button" data-action="clear-ticket-filters" class="link text-sm mt-3">Limpar filtros</button>` : '');
    }
    return h`<p class="text-xs muted mb-3" role="status">Exibindo ${rows.length} de ${all.length} chamado${all.length === 1 ? '' : 's'}</p>${ticketTable(rows, { full: true })}`;
}
function refreshTicketResults() { const box = $('#tickets-results'); if (box) box.innerHTML = String(ticketResults()); }

function viewTickets() {
    const staff = can('allTickets');
    const ui = state.ui;
    return h`
    <div class="space-y-6">
        ${pageHeader(staff ? 'Chamados do Help Desk' : 'Meus chamados', staff ? 'Gerencie incidentes, solicitações de serviço e atribuições de técnicos.' : 'Acompanhe as solicitações que você enviou.', newTicketButton())}
        <div class="card p-4 sm:p-6">
            <div class="flex flex-col lg:flex-row gap-3 mb-4">
                ${searchBox('ticket-search', 'ticket-search', 'Buscar por ID, assunto, solicitante...', ui.ticketSearch)}
                <select aria-label="Filtrar por status" data-change="ticket-status-filter" class="field lg:w-52">
                    <option value="all">Todos os status</option>${options(STATUS_OPTS, ui.ticketStatus)}
                </select>
                <select aria-label="Filtrar por prioridade" data-change="ticket-priority-filter" class="field lg:w-52">
                    <option value="all">Todas as prioridades</option>${options(PRIORITY_FILTER_OPTS, ui.ticketPriority)}
                </select>
            </div>
            <div id="tickets-results">${ticketResults()}</div>
        </div>
    </div>`;
}

// --- Inventory (CMDB) ---
function assetResults() {
    const ui = state.ui;
    const q = ui.assetSearch.trim().toLowerCase();
    const rows = state.assets.filter((a) =>
        (ui.assetType === 'all' || a.type === ui.assetType)
        && (ui.assetStatus === 'all' || a.status === ui.assetStatus)
        && (!q || [a.id, a.name, a.type, a.serial, a.assignedUser].some((v) => String(v).toLowerCase().includes(q))));
    const filtered = q || ui.assetType !== 'all' || ui.assetStatus !== 'all';
    if (!rows.length) {
        return emptyState('fa-boxes-stacked', filtered ? 'Nenhum ativo corresponde aos filtros' : 'O inventário está vazio',
            filtered ? 'Tente outro termo de busca ou limpe os filtros.' : 'Adicione seu primeiro ativo para começar o controle.',
            filtered ? h`<button type="button" data-action="clear-asset-filters" class="link text-sm mt-3">Limpar filtros</button>` : '');
    }
    const editable = can('editInventory');
    return h`
    <p class="text-xs muted mb-3" role="status">Exibindo ${rows.length} de ${state.assets.length} ativo${state.assets.length === 1 ? '' : 's'}</p>
    <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
            <caption class="sr-only">Inventário de ativos</caption>
            <thead class="border-b border-slate-200 dark:border-slate-700 text-xs muted uppercase">
                <tr>${TH('Código')}${TH('Nome do ativo')}${TH('Tipo')}${TH('Nº de série')}${TH('Status')}${TH('Atribuído a')}${TH('Chamados abertos')}${editable ? TH('Ações', 'text-right pr-0') : ''}</tr>
            </thead>
            <tbody class="divide-y divide-slate-100 dark:divide-slate-700/50">
                ${rows.map((a) => {
                    const open = state.tickets.filter((t) => t.assetId === a.id && isActive(t)).length;
                    return h`
                    <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30">
                        <td class="td font-mono font-bold text-brand-700 dark:text-brand-300 text-xs whitespace-nowrap">${a.id}</td>
                        <td class="td font-medium">${a.name}</td>
                        <td class="td text-xs muted">${lbl('type', a.type)}</td>
                        <td class="td text-xs font-mono">${a.serial}</td>
                        <td class="td">${badge('asset', a.status)}</td>
                        <td class="td text-xs">${a.assignedUser}</td>
                        <td class="td text-xs">${open ? pill('amber', open) : h`<span class="muted">&mdash;</span>`}</td>
                        ${editable ? h`
                        <td class="td pr-0 text-right whitespace-nowrap space-x-1">
                            <button type="button" data-action="open-asset" data-id="${a.id}" class="btn btn-sm btn-ghost" aria-label="Editar ${a.name}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
                            ${can('manageUsers') ? h`<button type="button" data-action="delete-asset" data-id="${a.id}" class="btn btn-sm btn-ghost-danger" aria-label="Excluir ${a.name}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>` : ''}
                        </td>` : ''}
                    </tr>`;
                })}
            </tbody>
        </table>
    </div>`;
}
function refreshAssetResults() { const box = $('#assets-results'); if (box) box.innerHTML = String(assetResults()); }

function viewInventory() {
    const ui = state.ui;
    const add = can('editInventory') ? h`<button type="button" data-action="open-asset" class="btn btn-primary btn-sm w-fit py-2.5"><i class="fa-solid fa-plus" aria-hidden="true"></i> Adicionar ativo</button>` : '';
    return h`
    <div class="space-y-6">
        ${pageHeader('Inventário de ativos (CMDB)', 'Controle equipamentos, licenças de software, números de série e responsáveis.', add)}
        <div class="card p-4 sm:p-6">
            <div class="flex flex-col lg:flex-row gap-3 mb-4">
                ${searchBox('asset-search', 'asset-search', 'Buscar por código, nome, nº de série, responsável...', ui.assetSearch)}
                <select aria-label="Filtrar por tipo" data-change="asset-type-filter" class="field lg:w-48">
                    <option value="all">Todos os tipos</option>${options(ASSET_TYPES, ui.assetType)}
                </select>
                <select aria-label="Filtrar por status" data-change="asset-status-filter" class="field lg:w-48">
                    <option value="all">Todos os status</option>${options(ASSET_STATUSES, ui.assetStatus)}
                </select>
            </div>
            <div id="assets-results">${assetResults()}</div>
        </div>
    </div>`;
}

// --- Users ---
function viewUsers() {
    const me = currentUser();
    return h`
    <div class="space-y-6">
        ${pageHeader('Gestão de usuários', 'Gerencie perfis, permissões e acesso das contas.', h`<button type="button" data-action="open-user" class="btn btn-primary btn-sm w-fit py-2.5"><i class="fa-solid fa-user-plus" aria-hidden="true"></i> Adicionar usuário</button>`)}
        <div class="card p-4 sm:p-6">
            <div class="overflow-x-auto">
                <table class="w-full text-left text-sm">
                    <caption class="sr-only">Contas de usuário</caption>
                    <thead class="border-b border-slate-200 dark:border-slate-700 text-xs muted uppercase">
                        <tr>${TH('Usuário')}${TH('E-mail')}${TH('Perfil')}${TH('Status')}${TH('2FA')}${TH('Ações', 'text-right pr-0')}</tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100 dark:divide-slate-700/50">
                        ${state.users.map((u) => h`
                            <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30">
                                <td class="td"><div class="flex items-center gap-2 font-medium">${avatar(u.name, 'w-8 h-8')}<span>${u.name}</span>${u.id === me.id ? pill('slate', 'Você') : ''}</div></td>
                                <td class="td text-xs muted break-all">${u.email}</td>
                                <td class="td">${badge('role', u.role)}</td>
                                <td class="td">${badge('user', u.status)}</td>
                                <td class="td text-xs">${u.twoFactor ? h`<span class="text-emerald-700 dark:text-emerald-400 font-semibold"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> Ativado</span>` : h`<span class="muted">Desativado</span>`}</td>
                                <td class="td pr-0 text-right whitespace-nowrap space-x-1">
                                    <button type="button" data-action="open-user" data-id="${u.id}" class="btn btn-sm btn-ghost" aria-label="Editar ${u.name}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
                                    <button type="button" data-action="delete-user" data-id="${u.id}" class="btn btn-sm btn-ghost-danger" aria-label="Excluir ${u.name}" ${u.id === me.id ? raw('disabled title="Você não pode excluir a própria conta"') : ''}><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
                                </td>
                            </tr>`)}
                    </tbody>
                </table>
            </div>
        </div>
    </div>`;
}

// --- Settings & 2FA ---
// Three states: on (code required to turn off), enrolling (QR + confirm code), off (start button).
function twoFactorPanel(u) {
    const box = 'p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700';
    if (u.twoFactor) {
        return h`
        <div class="${box} space-y-3">
            <div class="flex items-center gap-2 font-semibold text-sm text-emerald-700 dark:text-emerald-400">
                <i class="fa-solid fa-shield-halved" aria-hidden="true"></i> 2FA ativado: o login pede o código do seu aplicativo autenticador.
            </div>
            <form data-form="totp-disable" class="flex flex-col sm:flex-row gap-2 sm:items-end">
                <div class="flex-1">
                    <label for="totp-off-password" class="field-label">Sua senha</label>
                    <input type="password" id="totp-off-password" required maxlength="128" autocomplete="current-password" class="field">
                </div>
                <div class="flex-1">
                    <label for="totp-off-code" class="field-label">Para desativar, informe um código atual</label>
                    <input type="text" id="totp-off-code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="123456" class="field font-mono tracking-[0.3em]">
                </div>
                <button type="submit" class="btn btn-ghost-danger">Desativar 2FA</button>
            </form>
        </div>`;
    }
    const setup = state.ui.totpSetup && state.ui.totpSetup.userId === u.id ? state.ui.totpSetup : null;
    if (setup) {
        const uri = setup.uri;
        const qr = qrDataUrl(uri);
        return h`
        <div class="${box} space-y-4">
            <ol class="text-sm space-y-1 list-decimal pl-5">
                <li>Abra o Google Authenticator, Microsoft Authenticator ou Authy.</li>
                <li>Escaneie o QR code ou digite a chave manualmente.</li>
                <li>Informe o código de 6 dígitos que o aplicativo mostrar.</li>
            </ol>
            <div class="flex flex-col sm:flex-row items-center gap-4">
                ${qr ? h`<img src="${qr}" alt="QR code para configurar o 2FA no aplicativo autenticador" width="180" height="180" class="w-44 h-44 rounded-lg bg-white p-1 border border-slate-200 [image-rendering:pixelated]">`
                     : h`<div class="w-44 h-44 shrink-0 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 flex items-center justify-center text-xs muted text-center p-3">QR code indisponível (biblioteca não carregou). Use a chave ao lado.</div>`}
                <div class="flex-1 min-w-0 space-y-2 text-xs">
                    <div class="muted">Chave para digitar manualmente:</div>
                    <code class="block font-mono font-bold text-sm text-brand-700 dark:text-brand-300 break-all">${groupSecret(setup.secret)}</code>
                    <button type="button" data-action="copy-totp-secret" class="btn btn-secondary btn-sm"><i class="fa-solid fa-copy" aria-hidden="true"></i> Copiar chave</button>
                    <div class="muted">Tipo: baseada em tempo (TOTP) · 6 dígitos · 30 segundos</div>
                </div>
            </div>
            <form data-form="totp-enable" class="flex flex-col sm:flex-row gap-2 sm:items-end">
                <div class="flex-1">
                    <label for="totp-code" class="field-label">Código do aplicativo</label>
                    <input type="text" id="totp-code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="123456" class="field font-mono tracking-[0.3em]">
                </div>
                <button type="button" data-action="cancel-2fa" class="btn btn-secondary">Cancelar</button>
                <button type="submit" class="btn btn-primary">Confirmar e ativar</button>
            </form>
        </div>`;
    }
    return h`
    <div class="${box} flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
            <div class="font-semibold text-sm">Aplicativo autenticador (TOTP)</div>
            <div class="text-xs muted mt-0.5">Depois de ativado, o login pede a senha e um código de 6 dígitos que muda a cada 30 segundos.</div>
        </div>
        <button type="button" data-action="start-2fa" class="btn btn-primary shrink-0"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> Configurar 2FA</button>
    </div>`;
}

function viewSettings() {
    const u = currentUser();
    return h`
    <div class="space-y-6 max-w-2xl">
        ${pageHeader('Configurações da conta e segurança', 'Configure seu perfil e a autenticação em dois fatores (2FA).')}
        <div class="card p-6 space-y-6">
            <form data-form="profile" class="space-y-4">
                <h2 class="font-bold text-lg border-b border-slate-100 dark:border-slate-700 pb-3">Perfil pessoal</h2>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label for="pf-name" class="field-label">Nome completo</label>
                        <input type="text" id="pf-name" required maxlength="80" value="${u.name}" autocomplete="name" class="field">
                    </div>
                    <div>
                        <label for="pf-email" class="field-label">Endereço de e-mail</label>
                        <input type="email" id="pf-email" value="${u.email}" readonly autocomplete="email" class="field opacity-70">
                        <p class="text-xs muted mt-1">Para alterar o e-mail, fale com um administrador.</p>
                    </div>
                </div>
                <p class="text-xs muted">Perfil: ${badge('role', u.role)}</p>
                <div class="flex justify-end"><button type="submit" class="btn btn-primary">Salvar alterações</button></div>
            </form>

            <form data-form="password" class="space-y-4" autocomplete="on">
                <h2 class="font-bold text-lg border-b border-slate-100 dark:border-slate-700 pb-3">Alterar senha</h2>
                <input type="text" value="${u.email}" autocomplete="username" class="hidden" tabindex="-1" aria-hidden="true" readonly>
                <div>
                    <label for="pw-current" class="field-label">Senha atual</label>
                    <input type="password" id="pw-current" required maxlength="128" autocomplete="current-password" class="field">
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label for="pw-new" class="field-label">Nova senha</label>
                        <input type="password" id="pw-new" required minlength="8" maxlength="128" autocomplete="new-password" class="field">
                    </div>
                    <div>
                        <label for="pw-confirm" class="field-label">Confirmar nova senha</label>
                        <input type="password" id="pw-confirm" required minlength="8" maxlength="128" autocomplete="new-password" class="field">
                    </div>
                </div>
                <p class="text-xs muted">Mínimo de 8 caracteres. Maiúsculas e minúsculas fazem diferença.</p>
                <div class="flex justify-end"><button type="submit" class="btn btn-primary">Alterar senha</button></div>
            </form>

            <section class="space-y-4" aria-labelledby="twofa-title">
                <h2 id="twofa-title" class="font-bold text-lg border-b border-slate-100 dark:border-slate-700 pb-3">Autenticação em dois fatores (2FA)</h2>
                ${twoFactorPanel(u)}
            </section>
        </div>

    </div>`;
}

// --- Ticket detail modal ---
function renderTicketDetail() {
    const t = findTicket(state.ui.openTicketId);
    if (!t) { closeModal('ticket-detail-modal'); return; }
    const staff = can('manageTickets');
    const body = $('#ticket-detail-body');

    // Preserve the note draft and keyboard focus across re-renders.
    const draft = $('#tn-text') ? $('#tn-text').value : '';
    const draftInternal = $('#tn-internal') ? $('#tn-internal').checked : false;
    const activeId = document.activeElement && body.contains(document.activeElement) ? document.activeElement.id : '';

    const asset = t.asset;
    const techs = state.users.filter((u) => (u.role === 'Admin' || u.role === 'Technician') && (u.status === 'Active' || u.id === t.assigneeId));
    const items = staff ? t.timeline : t.timeline.filter((n) => !n.internal);

    body.innerHTML = String(h`
    <div class="space-y-4">
        <div class="flex flex-wrap items-center gap-2 pr-8">
            <span class="badge ${TONE.brand} font-mono font-bold">${t.id}</span>
            ${badge('priority', t.priority)}
            ${badge('status', t.status)}
            <span class="badge ${TONE.slate}">${lbl('category', t.category)}</span>
            ${staff ? slaBadge(t) : ''}
        </div>
        <h2 id="td-title" class="text-xl font-bold break-words">${t.subject}</h2>
        <p class="text-sm whitespace-pre-wrap break-words bg-slate-50 dark:bg-slate-900 rounded-xl p-3 border border-slate-200 dark:border-slate-700">${t.description || 'Nenhuma descrição informada.'}</p>
        <dl class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs bg-slate-50 dark:bg-slate-900 p-3 rounded-xl">
            <div><dt class="muted">Solicitante</dt><dd class="font-medium break-all">${t.requester}${requesterEmail(t) ? ' (' + requesterEmail(t) + ')' : ''}</dd></div>
            <div><dt class="muted">Aberto em</dt><dd class="font-medium">${fmtDate(t.createdAt)}</dd></div>
            <div><dt class="muted">Ativo vinculado</dt><dd class="font-medium">${asset ? h`<span class="font-mono">${asset.id}</span> &ndash; ${asset.name}` : 'Nenhum'}</dd></div>
            ${staff ? '' : h`<div><dt class="muted">Técnico responsável</dt><dd class="font-medium">${assigneeName(t)}</dd></div>`}
        </dl>

        ${staff ? h`
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
                <label for="td-status" class="field-label">Status</label>
                <select id="td-status" data-change="ticket-status" data-id="${t.id}" class="field">${options(STATUS_OPTS, t.status)}</select>
            </div>
            <div>
                <label for="td-priority" class="field-label">Prioridade</label>
                <select id="td-priority" data-change="ticket-priority" data-id="${t.id}" class="field">${t.priority === UNRATED ? h`<option value="" selected>-- Definir --</option>` : ''}${options(PRIORITY_OPTS, t.priority)}</select>
            </div>
            <div>
                <label for="td-assignee" class="field-label">Responsável</label>
                <select id="td-assignee" data-change="ticket-assignee" data-id="${t.id}" class="field">
                    <option value="">${UNASSIGNED}</option>
                    ${techs.map((u) => h`<option value="${u.id}" ${u.id === t.assigneeId ? 'selected' : ''}>${u.name}${u.status !== 'Active' ? ' (inativo)' : ''}</option>`)}
                </select>
            </div>
        </div>` : ''}

        <div class="pt-2">
            <h3 class="field-label mb-3">Linha do tempo e notas</h3>
            <div id="td-timeline" tabindex="0" aria-label="Linha do tempo do chamado" class="max-h-60 overflow-y-auto pr-2">${timelineList(items)}</div>
        </div>

        ${staff || t.status !== 'Closed' ? h`
        <form data-form="ticket-note" class="pt-4 border-t border-slate-200 dark:border-slate-700 space-y-2">
            <label for="tn-text" class="field-label">${staff ? 'Adicionar atualização ou nota interna' : 'Adicionar comentário'}</label>
            <div class="flex gap-2">
                <textarea id="tn-text" rows="2" required maxlength="1000" class="field flex-1"></textarea>
                <button type="submit" class="btn btn-primary self-end">Adicionar</button>
            </div>
            ${staff ? h`<label class="flex items-center gap-2 text-xs muted cursor-pointer w-fit"><input type="checkbox" id="tn-internal" class="accent-brand-600 w-4 h-4"> Nota interna (oculta do solicitante)</label>` : ''}
        </form>` : h`<p class="pt-4 border-t border-slate-200 dark:border-slate-700 text-sm muted">Este chamado está fechado. Abra um novo chamado se precisar de mais ajuda.</p>`}
    </div>`);

    if ($('#tn-text')) $('#tn-text').value = draft;
    if ($('#tn-internal')) $('#tn-internal').checked = draftInternal;
    const tl = $('#td-timeline'); if (tl) tl.scrollTop = tl.scrollHeight;
    if (activeId) { const el = document.getElementById(activeId); if (el) el.focus({ preventScroll: true }); }
}

/* =====================================================================
   7. ACTIONS
   ===================================================================== */
const fillSelect = (sel, pairs) => { $(sel).innerHTML = String(h`${pairs.map(([v, l]) => h`<option value="${v}">${l}</option>`)}`); };
const activeUsers = () => state.users.filter((u) => u.status === 'Active');
const assetNumber = (code) => { const a = state.assets.find((x) => x.id === code); return a ? a.num : null; };

// --- Auth ---
let pending2fa = null; // { email, password, remember } between the password step and the code step
let loginBusy = false;

function loginError(msg) {
    const err = $('#login-error');
    err.textContent = msg || '';
    err.classList.toggle('hidden', !msg);
}
function showLoginStep(step) {
    $('#login-step1').classList.toggle('hidden', step !== 1);
    $('#login-step2').classList.toggle('hidden', step !== 2);
    const focus = step === 1 ? $('#login-password') : $('#login-code');
    requestAnimationFrame(() => focus && focus.focus());
}
// Before anyone exists, the sign-in form becomes "create the first administrator".
let setupMode = false;
async function applySetupMode() {
    let status = { needs_setup: false, setup_token_required: false };
    try { status = await api('/auth/setup-status', { auth: false }); } catch (e) { /* show the normal login */ }
    setupMode = status.needs_setup;
    $('#login-name-wrap').classList.toggle('hidden', !setupMode);
    $('#login-name').required = setupMode;
    $('#login-setup-wrap').classList.toggle('hidden', !(setupMode && status.setup_token_required));
    $('#login-setup-code').required = setupMode && status.setup_token_required;
    $('#login-password').autocomplete = setupMode ? 'new-password' : 'current-password';
    $('#login-title').textContent = setupMode ? 'Criar o primeiro administrador' : 'Entrar no DeskPulse';
    $('#login-subtitle').textContent = setupMode
        ? 'Ainda não há contas. Crie a conta do administrador para começar (senha com 8 caracteres ou mais).'
        : 'Use a conta criada pelo administrador. A senha diferencia maiúsculas de minúsculas.';
    $('#login-submit').textContent = setupMode ? 'Criar conta e entrar' : 'Entrar';
}
async function openLogin() {
    pending2fa = null;
    loginError('');
    $('#login-password').value = '';
    $('#login-code').value = '';
    showLoginStep(1);
    openModal('login-modal');
    await applySetupMode();
}
async function finishLogin(res, remember) {
    authToken = res.token;
    persistToken(remember);
    state.me = adaptUser(res.user);
    pending2fa = null;
    $('#login-password').value = '';
    $('#login-code').value = '';
    closeModal('login-modal');
    try { await loadData(); } catch (err) { showToast('Não foi possível carregar os dados: ' + err.message, 'error'); }
    showToast('Bem-vindo(a) de volta, ' + state.me.name + ' (' + lbl('role', state.me.role) + ')!', 'success');
    navigate('overview');
}
async function handleLogin() {
    if (loginBusy) return;
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value; // exactly as typed: case sensitive, not trimmed
    const remember = $('#login-remember').checked;
    loginBusy = true;
    $('#login-submit').disabled = true;
    try {
        if (setupMode) {
            const code = $('#login-setup-code').value;
            const body = { name: $('#login-name').value.trim(), email, password };
            await finishLogin(await api('/auth/setup', { method: 'POST', body, auth: false, headers: code ? { 'X-Setup-Token': code } : {} }), remember);
        } else {
            await finishLogin(await api('/auth/login', { method: 'POST', body: { email, password }, auth: false }), remember);
        }
    } catch (err) {
        if (err.status === 401 && err.headers && err.headers.get('X-2FA-Required')) { // the password was right: ask for the code
            pending2fa = { email, password, remember };
            loginError('');
            showLoginStep(2);
        } else {
            loginError(err.message);
        }
    } finally {
        loginBusy = false;
        $('#login-submit').disabled = false;
    }
}
async function handleLogin2fa() {
    if (loginBusy || !pending2fa) return;
    loginBusy = true;
    try {
        const otp = $('#login-code').value.replace(/\s+/g, '');
        const { email, password, remember } = pending2fa;
        await finishLogin(await api('/auth/login', { method: 'POST', body: { email, password, otp }, auth: false }), remember);
    } catch (err) {
        $('#login-code').value = '';
        loginError(err.message);
    } finally {
        loginBusy = false;
    }
}
async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* already signed out */ }
    endSession();
    showToast('Você saiu da sua conta.', 'info');
    navigate('home');
}
function handlePasswordReset() {
    closeModal('forgot-modal');
    $('#reset-email').value = '';
    // No e-mail service is connected yet, so say so instead of pretending a message was sent.
    showToast('A recuperação por e-mail ainda não está disponível. Peça a um administrador para definir uma nova senha para você.', 'info');
}

// --- Tickets ---
function openNewTicket() {
    if (!currentUser()) { showToast('Entre na sua conta para abrir um chamado.', 'info'); openLogin(); return; }
    const staff = can('manageTickets');
    $('#ticket-form').reset();
    // Staff file on behalf of someone and pick the company. An end user's company and name come from their account.
    $('#tf-staff-fields').classList.toggle('hidden', !staff);
    $('#tf-company').required = staff;
    if (staff) {
        $('#tf-requester').innerHTML = String(h`<option value="">-- Ninguém (abertura interna) --</option>${activeUsers().map((u) => h`<option value="${u.id}">${u.name} (${u.email})</option>`)}`);
        $('#tf-company').innerHTML = String(h`<option value="" disabled selected>Selecione a empresa...</option>${state.companies.map((c) => h`<option value="${c.id}">${c.name}</option>`)}`);
    }
    const assets = assetsForRequester();
    $('#tf-asset-wrap').classList.toggle('hidden', !assets.length);
    $('#tf-asset').innerHTML = String(h`<option value="">-- Nenhum ativo vinculado --</option>${assets.map((a) => h`<option value="${a.id}">${a.id} - ${a.name}</option>`)}`);
    openModal('ticket-modal');
}
async function handleCreateTicket() {
    const val = (sel) => $(sel).value.trim();
    const subject = val('#tf-subject');
    const description = val('#tf-desc');
    if (!subject || !description) { showToast('Preencha todos os campos obrigatórios.', 'error'); return; }
    const category = CATEGORIES.some(([v]) => v === $('#tf-category').value) ? $('#tf-category').value : 'Other';
    const body = { title: subject, description, category: toApi('category', category) };
    const assetNum = assetNumber($('#tf-asset').value);
    if (assetNum !== null) body.asset_id = assetNum;
    if (can('manageTickets')) {
        body.company_id = Number($('#tf-company').value);
        if ($('#tf-requester').value) body.requester_id = Number($('#tf-requester').value);
    }
    const created = await api('/tickets', { method: 'POST', body });
    closeModal('ticket-modal');
    showToast('Chamado ' + created.code + ' criado.', 'success');
    await loadData();
    refresh();
}

function mergeTicket(t, full) { Object.assign(t, adaptTicket(full, t)); }
async function openTicket(id) {
    const t = findTicket(id);
    if (!t) return;
    mergeTicket(t, await api('/tickets/' + t.num)); // the list has no description or history
    state.ui.openTicketId = id;
    $('#ticket-detail-body').innerHTML = ''; // drop any draft left over from a previously opened ticket
    renderTicketDetail();
    openModal('ticket-detail-modal');
}
async function patchTicket(t, body, message) {
    try {
        mergeTicket(t, await api('/tickets/' + t.num, { method: 'PATCH', body }));
        showToast(message, 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
    refresh(); // on failure this puts the selects back on the saved values
}
function setTicketStatus(id, status) {
    const t = findTicket(id);
    if (!t || !can('manageTickets') || !STATUSES.includes(status) || t.status === status) return;
    return patchTicket(t, { status: toApi('status', status) }, 'Status do chamado ' + id + ' alterado para ' + lbl('status', status) + '.');
}
function setTicketPriority(id, priority) {
    const t = findTicket(id);
    if (!t || !can('manageTickets') || !PRIORITIES.includes(priority) || t.priority === priority) return;
    return patchTicket(t, { priority: toApi('priority', priority) }, 'Prioridade do chamado ' + id + ' definida como ' + lbl('priority', priority) + '.');
}
function setTicketAssignee(id, userId) {
    const t = findTicket(id);
    if (!t || !can('manageTickets')) return;
    const next = userId === '' ? null : Number(userId);
    if ((t.assigneeId ?? null) === next) return;
    const target = next === null ? null : state.users.find((u) => u.id === next);
    return patchTicket(t, { assignee_id: next }, target ? 'Chamado ' + id + ' atribuído a ' + target.name + '.' : 'Atribuição do chamado ' + id + ' removida.');
}
async function handleAddNote() {
    const t = findTicket(state.ui.openTicketId);
    const text = $('#tn-text').value.trim();
    if (!t || !text) return;
    const staff = can('manageTickets');
    if (!staff && t.status === 'Closed') { showToast('Este chamado está fechado.', 'error'); return; }
    const internal = staff && !!($('#tn-internal') && $('#tn-internal').checked);
    await api('/tickets/' + t.num + '/comments', { method: 'POST', body: { body: text, is_internal: internal } });
    $('#tn-text').value = '';
    mergeTicket(t, await api('/tickets/' + t.num));
    refresh();
    showToast(internal ? 'Nota interna adicionada.' : 'Nota adicionada à linha do tempo.', 'success');
}

// --- Assets ---
function openAssetModal(id) {
    if (!can('editInventory')) return;
    $('#asset-form').reset();
    $('#asset-id').value = '';
    $('#ast-assigned').innerHTML = String(h`<option value="">-- Ninguém --</option>${activeUsers().map((u) => h`<option value="${u.id}">${u.name}</option>`)}`);
    const a = id ? state.assets.find((x) => x.id === id) : null;
    $('#asset-modal-title').textContent = a ? 'Editar ativo ' + a.id : 'Adicionar novo ativo';
    if (a) {
        $('#asset-id').value = a.id;
        $('#ast-name').value = a.name;
        $('#ast-type').value = a.type;
        $('#ast-serial').value = a.serial;
        $('#ast-status').value = a.status;
        $('#ast-assigned').value = a.assignedUserId ?? '';
        $('#ast-location').value = a.location;
    }
    openModal('asset-modal');
}
async function handleSaveAsset() {
    if (!can('editInventory')) return;
    const id = $('#asset-id').value;
    const name = $('#ast-name').value.trim();
    const serial = $('#ast-serial').value.trim();
    if (!name || !serial) { showToast('Nome e número de série são obrigatórios.', 'error'); return; }
    const body = {
        name, serial,
        type: toApi('type', $('#ast-type').value),
        status: toApi('asset', $('#ast-status').value),
        assigned_user_id: $('#ast-assigned').value ? Number($('#ast-assigned').value) : null,
        location: $('#ast-location').value.trim() || null
    };
    const existing = id ? state.assets.find((x) => x.id === id) : null;
    if (id && !existing) return;
    if (existing) await api('/assets/' + existing.num, { method: 'PATCH', body });
    else await api('/assets', { method: 'POST', body });
    showToast(existing ? 'Ativo ' + id + ' atualizado.' : 'Ativo cadastrado.', 'success');
    closeModal('asset-modal');
    await loadData();
    refresh();
}
async function deleteAsset(id) {
    if (!can('manageUsers')) return; // the server only lets administrators delete assets
    const a = state.assets.find((x) => x.id === id);
    if (!a) return;
    const linked = state.tickets.filter((t) => t.assetId === id);
    const ok = await confirmDialog({
        title: 'Remover ' + a.id + '?',
        message: '"' + a.name + '" será removido do inventário.' + (linked.length ? (linked.length > 1 ? ' ' + linked.length + ' chamados vinculados serão desvinculados dele.' : ' 1 chamado vinculado será desvinculado dele.') : '') + ' Esta ação não pode ser desfeita.',
        confirmLabel: 'Remover ativo', danger: true
    });
    if (!ok) return;
    await api('/assets/' + a.num, { method: 'DELETE' });
    await loadData();
    refresh();
    showToast('Ativo ' + id + ' removido.', 'info');
}

// --- Users ---
const activeAdmins = () => state.users.filter((u) => u.role === 'Admin' && u.status === 'Active');
function openUserModal(id) {
    if (!can('manageUsers')) return;
    $('#user-form').reset();
    $('#usr-id').value = '';
    $('#usr-company').innerHTML = String(h`<option value="">-- Sem empresa --</option>${state.companies.map((c) => h`<option value="${c.id}">${c.name}</option>`)}`);
    const u = id ? state.users.find((x) => x.id === Number(id)) : null;
    const isSelf = !!u && u.id === currentUser().id;
    $('#user-modal-title').textContent = u ? 'Editar usuário' : 'Adicionar novo usuário';
    if (u) {
        $('#usr-id').value = u.id;
        $('#usr-name').value = u.name; $('#usr-email').value = u.email;
        $('#usr-role').value = u.role; $('#usr-status').value = u.status;
        $('#usr-company').value = u.companyId ?? '';
    } else {
        $('#usr-role').value = 'User'; $('#usr-status').value = 'Active';
    }
    $('#usr-role').disabled = $('#usr-status').disabled = isSelf;
    $('#usr-self-note').classList.toggle('hidden', !isSelf);
    // New accounts need a password; on edit, a blank field keeps the current one.
    $('#usr-password').required = !u;
    $('#usr-password-hint').textContent = u ? 'Deixe em branco para manter a senha atual. Mínimo de 8 caracteres.' : 'Mínimo de 8 caracteres. Repasse-a ao usuário por um canal seguro.';
    $('#usr-2fa-reset-wrap').classList.toggle('hidden', !(u && u.twoFactor && !isSelf));
    openModal('user-modal');
}
async function handleSaveUser() {
    if (!can('manageUsers')) return;
    const id = $('#usr-id').value ? Number($('#usr-id').value) : null;
    const existing = id ? state.users.find((u) => u.id === id) : null;
    const isSelf = !!existing && existing.id === currentUser().id;
    const name = $('#usr-name').value.trim();
    const email = $('#usr-email').value.trim().toLowerCase();
    const role = isSelf ? existing.role : $('#usr-role').value;
    const status = isSelf ? existing.status : $('#usr-status').value;
    if (!name || !email) { showToast('Nome e e-mail são obrigatórios.', 'error'); return; }
    if (!ROLES.some(([v]) => v === role) || !USER_STATUSES.some(([v]) => v === status)) return;
    const password = $('#usr-password').value;
    if ((!existing || password) && password.length < 8) { showToast('A senha precisa ter pelo menos 8 caracteres.', 'error'); return; }
    if (existing && existing.role === 'Admin' && existing.status === 'Active' && (role !== 'Admin' || status !== 'Active') && activeAdmins().length <= 1) {
        showToast('É necessário manter pelo menos um administrador ativo.', 'error'); return;
    }
    const body = { name, email, role: toApi('role', role), company_id: $('#usr-company').value ? Number($('#usr-company').value) : null };
    if (password) body.password = password;
    if (existing) {
        body.is_active = status === 'Active';
        if (!isSelf && $('#usr-2fa-reset').checked) body.reset_two_factor = true;
        await api('/users/' + existing.id, { method: 'PATCH', body });
    } else {
        await api('/users', { method: 'POST', body });
    }
    showToast('Usuário ' + name + (existing ? ' atualizado.' : ' criado.'), 'success');
    closeModal('user-modal');
    await loadData();
    refresh();
}
async function deleteUser(id) {
    if (!can('manageUsers')) return;
    const u = state.users.find((x) => x.id === Number(id));
    if (!u) return;
    if (u.id === currentUser().id) { showToast('Você não pode excluir a própria conta.', 'error'); return; }
    if (u.role === 'Admin' && u.status === 'Active' && activeAdmins().length <= 1) { showToast('É necessário manter pelo menos um administrador ativo.', 'error'); return; }
    const assigned = state.tickets.filter((t) => t.assigneeId === u.id).length;
    const ok = await confirmDialog({
        title: 'Excluir ' + u.name + '?',
        message: 'Esta conta será removida permanentemente. Os chamados e comentários dela continuam, sem o nome.' + (assigned ? (assigned > 1 ? ' ' + assigned + ' chamados atribuídos a essa pessoa ficarão sem responsável.' : ' 1 chamado atribuído a essa pessoa ficará sem responsável.') : ''),
        confirmLabel: 'Excluir usuário', danger: true
    });
    if (!ok) return;
    await api('/users/' + u.id, { method: 'DELETE' });
    await loadData();
    refresh();
    showToast('Usuário ' + u.name + ' removido.', 'info');
}

// --- Settings ---
function syncMe(userOut) {
    const me = adaptUser(userOut);
    state.me = me;
    const i = state.users.findIndex((x) => x.id === me.id);
    if (i >= 0) state.users[i] = me; else state.users.push(me);
}
async function handleSaveProfile() {
    const name = $('#pf-name').value.trim();
    if (!name) { showToast('O nome é obrigatório.', 'error'); return; }
    syncMe(await api('/auth/me', { method: 'PATCH', body: { name } }));
    refresh();
    showToast('Perfil salvo.', 'success');
}
async function handleChangePassword() {
    const current = $('#pw-current').value, next = $('#pw-new').value, confirm = $('#pw-confirm').value;
    if (next.length < 8) { showToast('A nova senha precisa ter pelo menos 8 caracteres.', 'error'); return; }
    if (next !== confirm) { showToast('A confirmação não confere com a nova senha.', 'error'); return; }
    if (next === current) { showToast('A nova senha deve ser diferente da atual.', 'error'); return; }
    await api('/auth/me', { method: 'PATCH', body: { current_password: current, new_password: next } });
    ['#pw-current', '#pw-new', '#pw-confirm'].forEach((sel) => { $(sel).value = ''; });
    showToast('Senha alterada. Seus outros dispositivos foram desconectados.', 'success');
}
async function startTwoFactor() {
    const u = currentUser();
    const res = await api('/auth/2fa/setup', { method: 'POST' }); // the server creates the secret
    state.ui.totpSetup = { userId: u.id, secret: res.secret, uri: res.otpauth_uri };
    renderView();
    requestAnimationFrame(() => { const el = $('#totp-code'); if (el) el.focus(); });
}
function cancelTwoFactor() { state.ui.totpSetup = null; renderView(); }
async function enableTwoFactor() {
    const code = $('#totp-code').value.replace(/\s+/g, '');
    try {
        syncMe(await api('/auth/2fa/enable', { method: 'POST', body: { code } }));
    } catch (err) {
        showToast('Código incorreto. Confira se o relógio do celular está certo e tente o próximo código.', 'error');
        $('#totp-code').value = ''; $('#totp-code').focus();
        return;
    }
    state.ui.totpSetup = null;
    renderView();
    showToast('2FA ativado. O próximo login vai pedir o código do aplicativo.', 'success');
}
async function disableTwoFactor() {
    const password = $('#totp-off-password').value;
    const code = $('#totp-off-code').value.replace(/\s+/g, '');
    try {
        syncMe(await api('/auth/2fa/disable', { method: 'POST', body: { password, code } }));
    } catch (err) {
        showToast(err.message, 'error'); $('#totp-off-code').value = ''; return;
    }
    renderView();
    showToast('2FA desativado.', 'info');
}

/* =====================================================================
   8. EVENT DELEGATION (no inline onclick handlers: nothing user-controlled ever reaches JS source)
   ===================================================================== */
const actions = {
    'skip-main': () => $('#main').focus(),
    'toggle-theme': () => toggleTheme(),
    'open-login': () => openLogin(),
    'logout': () => logout(),
    'forgot-password': () => { closeModal('login-modal'); openModal('forgot-modal'); },
    'close-modal': (el) => closeModal(el.dataset.modal),
    'open-new-ticket': () => openNewTicket(),
    'view-ticket': (el) => openTicket(el.dataset.id),
    'clear-ticket-filters': () => { Object.assign(state.ui, { ticketSearch: '', ticketStatus: 'all', ticketPriority: 'all' }); renderView(); },
    'clear-asset-filters': () => { Object.assign(state.ui, { assetSearch: '', assetType: 'all', assetStatus: 'all' }); renderView(); },
    'open-asset': (el) => openAssetModal(el.dataset.id),
    'delete-asset': (el) => deleteAsset(el.dataset.id),
    'open-user': (el) => openUserModal(el.dataset.id),
    'delete-user': (el) => deleteUser(el.dataset.id),
    'login-back': () => { pending2fa = null; loginError(''); $('#login-code').value = ''; showLoginStep(1); },
    'start-2fa': () => startTwoFactor(),
    'cancel-2fa': () => cancelTwoFactor(),
    'copy-totp-secret': async () => {
        const setup = state.ui.totpSetup;
        const ok = setup && await copyText(setup.secret);
        showToast(ok ? 'Chave copiada.' : 'Não foi possível copiar. Selecione e copie manualmente.', ok ? 'success' : 'error');
    },
    'confirm-yes': () => { const r = confirmResolver; confirmResolver = null; closeModal('confirm-modal'); if (r) r(true); }
};
const forms = {
    'login': handleLogin, 'login-2fa': handleLogin2fa, 'forgot': handlePasswordReset,
    'password': handleChangePassword, 'totp-enable': enableTwoFactor, 'totp-disable': disableTwoFactor, 'new-ticket': handleCreateTicket,
    'ticket-note': handleAddNote, 'asset': handleSaveAsset, 'user': handleSaveUser, 'profile': handleSaveProfile
};
const inputs = {
    'ticket-search': (el) => { state.ui.ticketSearch = el.value; refreshTicketResults(); },
    'asset-search': (el) => { state.ui.assetSearch = el.value; refreshAssetResults(); }
};
const changes = {
    'ticket-status-filter': (el) => { state.ui.ticketStatus = el.value; refreshTicketResults(); },
    'ticket-priority-filter': (el) => { state.ui.ticketPriority = el.value; refreshTicketResults(); },
    'asset-type-filter': (el) => { state.ui.assetType = el.value; refreshAssetResults(); },
    'asset-status-filter': (el) => { state.ui.assetStatus = el.value; refreshAssetResults(); },
    'ticket-status': (el) => setTicketStatus(el.dataset.id, el.value),
    'ticket-priority': (el) => setTicketPriority(el.dataset.id, el.value),
    'ticket-assignee': (el) => setTicketAssignee(el.dataset.id, el.value),
    // Picking who the ticket is for suggests their company.
    'tf-requester': (el) => {
        const u = state.users.find((x) => x.id === Number(el.value));
        if (u && u.companyId) $('#tf-company').value = u.companyId;
    }
};

// Every handler is async now (the server answers): surface their failures instead of losing them.
const run = (fn, ...args) => Promise.resolve().then(() => fn(...args)).catch((err) => {
    if (err instanceof ApiError && err.status === 401 && !state.me) return; // the session just ended: already announced
    console.error(err);
    showToast(err && err.message ? err.message : 'Algo deu errado.', 'error');
});
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('modal-overlay')) { if (downOnOverlay) closeModal(t.id); return; }
    const el = t.closest && t.closest('[data-action]');
    if (el && actions[el.dataset.action]) run(actions[el.dataset.action], el, e);
});
document.addEventListener('submit', (e) => {
    const f = e.target.closest && e.target.closest('[data-form]');
    if (!f || !forms[f.dataset.form]) return;
    e.preventDefault();
    run(forms[f.dataset.form], f, e);
});
document.addEventListener('input', (e) => {
    const el = e.target.closest && e.target.closest('[data-input]');
    if (el && inputs[el.dataset.input]) inputs[el.dataset.input](el);
});
document.addEventListener('change', (e) => {
    const el = e.target.closest && e.target.closest('[data-change]');
    if (el && changes[el.dataset.change]) run(changes[el.dataset.change], el);
});

// Other people use the system too: pick up their changes when this tab comes back into view.
let lastSync = Date.now();
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.me || Date.now() - lastSync < 30000) return;
    lastSync = Date.now();
    reloadAndRender();
});
window.addEventListener('hashchange', () => handleRoute());

/* =====================================================================
   9. BOOT
   ===================================================================== */
async function boot() {
    fillSelect('#tf-category', CATEGORIES);
    fillSelect('#ast-type', ASSET_TYPES);
    fillSelect('#ast-status', ASSET_STATUSES);
    fillSelect('#usr-role', ROLES);
    fillSelect('#usr-status', USER_STATUSES);
    applyThemeUI();
    await restoreSession();
    handleRoute(true);
}
boot();
