import { el, icon, button, iconButton, field, select } from './dom.mjs';
import { t, language, setLanguage } from './i18n.mjs';
import { createApi, roleRoutes, canAccess } from './api.mjs';
import { form, notice, passwordField, newPasswordField, validPassword, validation, errorText } from './ui.mjs';
import { screens } from './screens.mjs';

const api = createApi();
const app = document.getElementById('app');
let user = null, route = 'home', cleanup = [], registration = false, loggingOut = false;
let sessionState = {};
let recoveryMode = false, recoveryStatus = 'request';
const symbols = { home: 'house', doctors: 'stethoscope', appointments: 'calendar-days', analyses: 'flask-conical', medicines: 'pill', clinics: 'hospital', chat: 'messages-square', profile: 'user-round', patients: 'users-round', users: 'users-round', audit: 'shield-check' };
// Only appearance preferences are persisted. Never serialize API responses or identities.
symbols.recovery = 'key-round';
try {
    for (const key of Object.keys(localStorage)) {
        if (['qamqorAccount', 'qamqorSession', 'qamqorSavedEmail'].includes(key) || key.startsWith('qamqorNotifs_')) {
            localStorage.removeItem(key);
        }
    }
} catch { /* Storage may be blocked; legacy identities are never used for access. */ }
function preference(key, value) {
    try { if (value === undefined) return localStorage.getItem('qamqor.' + key); localStorage.setItem('qamqor.' + key, value); } catch { /* Storage may be blocked. */ }
}
setLanguage(preference('language'));
document.documentElement.dataset.theme = preference('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function settings() {
    const langs = el('div', { class: 'segmented', 'aria-label': t('language') }, ['ru', 'kk'].map(code => el('button', {
        type: 'button', text: code === 'kk' ? 'ҚАЗ' : 'РУС', 'aria-pressed': String(language === code),
        onClick: () => { setLanguage(code); preference('language', code); render(); },
    })));
    const theme = iconButton(t('theme'), () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        preference('theme', next);
        theme.setAttribute('aria-pressed', String(next === 'dark'));
    }, 'moon');
    theme.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
    return el('div', { class: 'settings' }, langs, theme);
}
function clear() {
    api.reset();
    cleanup.splice(0).forEach(fn => fn());
    document.querySelectorAll('dialog').forEach(dialog => dialog.remove());
}
function context() {
    const generation = api.generation;
    return {
        user, api, symbols, route, sessionState,
        alive: () => generation === api.generation,
        cleanup: fn => cleanup.push(fn),
        navigate,
        refresh: () => render(),
        expire: () => { user = null; sessionState = {}; registration = false; route = 'home'; history.replaceState(null, '', '#home'); render(t('expired')); },
        updateUser: value => { user = value; },
        announce: value => { document.getElementById('announcer').textContent = value; },
    };
}
function navigate(next) {
    if (!canAccess(user?.role, next)) return;
    if (location.hash !== '#' + next) location.hash = next;
    else render();
}
async function logout() {
    if (loggingOut) return;
    loggingOut = true;
    clear();
    user = null;
    sessionState = {};
    app.replaceChildren(el('p', { role: 'status', text: t('loading') }));
    try { await api.request('logout', {}, { write: true }); registration = false; route = 'home'; history.replaceState(null, '', '#home'); render(); }
    catch {
        app.replaceChildren(el('main', { class: 'auth' }, el('h1', { text: 'QamqorMed' }), notice(t('logoutFailed')), button(t('logout'), logout, 'log-out', 'primary')));
    } finally { loggingOut = false; }
}
function auth(ctx, message) {
    if (recoveryMode) return recoveryForm(ctx);
    const fields = [registration && field(t('name'), 'name', { required: true, maxLength: 100, autocomplete: 'name' }),
        registration && field(t('iin'), 'iin', { required: true, pattern: '[0-9]{12}', maxLength: 12, inputmode: 'numeric', autocomplete: 'off' }),
        field(t('email'), 'email', { type: 'email', required: true, maxLength: 100, autocomplete: 'username' }),
        registration ? newPasswordField() : passwordField(t('password'), 'password'),
        registration && notice(t('passwordRule'))];
    return el('main', { class: 'auth' }, icon('heart-pulse'), el('h1', { text: 'QamqorMed' }), el('h2', { text: t(registration ? 'register' : 'login') }),
        message && el('p', { role: 'alert', class: 'error', text: message }),
        form(ctx, fields, async data => {
            if (registration && !validPassword(data.password)) validation(t('passwordRule'));
            await api.request(registration ? 'register' : 'login', data, { write: true });
            // Ignore the mobile bearer token response: only a server-verified cookie grants web access.
            const session = await api.request('session');
            if (!roleRoutes[session.user?.role]) validation(t('forbidden'));
            if (!ctx.alive()) return;
            user = session.user;
            route = 'home'; history.replaceState(null, '', '#home'); render();
        }, t(registration ? 'register' : 'login')),
        button(t(registration ? 'login' : 'register'), () => { registration = !registration; render(); }, 'arrow-right', 'text-button'),
        !registration && button(t('forgot'), () => { recoveryMode = true; render(); }, 'key-round', 'text-button'));
}
function recoveryForm(ctx) {
    const root = el('main', { class: 'auth' }, el('h1', { text: t('recovery') }));
    if (recoveryStatus === 'approved') {
        root.append(form(ctx, [newPasswordField('newPassword', t('newPassword')), newPasswordField('repeatPassword', t('repeatPassword')), notice(t('passwordRule'))], async data => {
            if (!validPassword(data.newPassword)) validation(t('passwordRule'));
            if (data.newPassword !== data.repeatPassword) validation(t('mismatch'));
            await api.request('password-recovery', { action: 'complete', newPassword: data.newPassword }, { write: true });
            if (ctx.alive()) { recoveryMode = false; recoveryStatus = 'request'; registration = false; render(t('recoveryDone')); }
        }, t('save')));
    } else {
        if (recoveryStatus !== 'request') root.append(notice(t(recoveryStatus === 'pending' ? 'recoveryPending' : 'recoveryExpired')));
        if (recoveryStatus !== 'pending') root.append(form(ctx, [
            field(t('email'), 'email', { type: 'email', required: true, maxLength: 100, autocomplete: 'email' }),
            field(t('iin'), 'iin', { required: true, pattern: '[0-9]{12}', maxLength: 12, inputmode: 'numeric', autocomplete: 'off' }),
        ], async data => {
            await api.request('password-recovery', { action: 'request', ...data }, { write: true });
            if (ctx.alive()) { recoveryStatus = 'pending'; render(); }
        }, t('send')));
        root.append(form(ctx, [], async () => {
            const data = await api.request('password-recovery', { action: 'status' });
            if (ctx.alive()) { recoveryStatus = data.status; render(); }
        }, t('recoveryCheck')));
        if (recoveryStatus === 'pending') root.append(button(t('recoveryNew'), () => {
            recoveryStatus = 'request'; render();
        }, 'plus', 'text-button'));
    }
    root.append(button(t('back'), () => { recoveryMode = false; render(); }, 'arrow-left', 'text-button'));
    return root;
}
function render(message) {
    clear();
    const ctx = context();
    document.documentElement.lang = language;
    app.setAttribute('aria-busy', 'false');
    const brand = el('a', { class: 'brand', href: '#home' }, icon('heart-pulse'), el('span', { text: 'QamqorMed' }));
    const header = el('header', { class: 'topbar' }, brand, user && el('span', { class: 'role-label', text: t(user.role + 'Space') }), settings());
    if (!user) { app.replaceChildren(header, auth(ctx, message)); return; }
    const desired = location.hash.slice(1) || 'home';
    route = canAccess(user.role, desired) ? desired : 'home';
    if (route !== desired) history.replaceState(null, '', '#home');
    const routes = roleRoutes[user.role];
    const primary = user.role === 'patient' ? ['home', 'appointments', 'chat', 'profile'] : user.role === 'doctor' ? ['home', 'appointments', 'patients', 'profile'] : ['home', 'users', 'audit', 'profile'];
    function navLink(key) {
        return el('a', { href: '#' + key, class: 'nav-item', ...(key === route ? { 'aria-current': 'page' } : {}) }, icon(symbols[key]), el('span', { text: t(key) }));
    }
    const sidebar = el('aside', { class: 'sidebar' }, el('div', { class: 'identity' }, el('strong', { text: user.name }), el('span', { class: 'muted', text: t(user.role) })),
        el('nav', { 'aria-label': 'QamqorMed' }, routes.map(navLink)), button(t('logout'), logout, 'log-out', 'text-button'));
    const main = el('main', { id: 'main', tabIndex: -1 }, el('div', { class: 'page-heading' }, el('div', {}, el('p', { class: 'eyebrow', text: t(user.role + 'Space') }), el('h1', { text: t(route) })), iconButton(t('refresh'), () => render(), 'refresh-cw')));
    app.replaceChildren(header, el('div', { class: 'app-layout' }, sidebar, main), el('nav', { class: 'bottomnav', 'aria-label': 'QamqorMed mobile' }, primary.map(navLink)));
    screens[route]({ ...ctx, route }, main);
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { if (!loggingOut) render(); });
window.addEventListener('pagehide', () => { clear(); user = null; sessionState = {}; app.replaceChildren(); });
window.addEventListener('pageshow', event => { if (event.persisted) bootstrap(); });
async function bootstrap() {
    clear();
    const generation = api.generation;
    try {
        const session = await api.request('session');
        if (generation !== api.generation) return;
        user = roleRoutes[session.user?.role] ? session.user : null;
        render();
    } catch (error) {
        if (generation !== api.generation) return;
        if (error.status === 401) { user = null; render(); }
        else app.replaceChildren(el('main', { class: 'auth' }, el('h1', { text: 'QamqorMed' }), notice(errorText(error)), button(t('retry'), bootstrap, 'refresh-cw')));
    }
}
bootstrap();
