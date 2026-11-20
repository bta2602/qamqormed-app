import { el, icon, button, iconButton, field, select } from './dom.mjs';
import { t, language, setLanguage, headingDate } from './i18n.mjs';
import { createApi, roleRoutes, canAccess, hasMedicalAccess } from './api.mjs';
import { form, notice, passwordField, newPasswordField, validPassword, validation, errorText } from './ui.mjs';
import { screens } from './screens.mjs';
import { welcomeScreen } from './welcome.mjs';

const api = createApi();
const app = document.getElementById('app');
let user = null, route = 'home', cleanup = [], registration = false, loggingOut = false;
let sessionState = {};
let recoveryMode = false, recoveryStatus = 'request';
const symbols = { home: 'house', doctors: 'stethoscope', appointments: 'calendar-days', analyses: 'flask-conical', medicines: 'pill', clinics: 'hospital', chat: 'messages-square', profile: 'user-round', patients: 'users-round', users: 'users-round', audit: 'shield-check' };
// Only appearance preferences are persisted. Never serialize API responses or identities.
symbols.recovery = 'key-round';
symbols.services = 'layout-grid';
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
    const langs = el('div', { class: 'segmented', role: 'group', 'aria-label': t('language') }, ['kk', 'ru'].map(code => el('button', {
        type: 'button', text: code === 'kk' ? 'ҚАЗ' : 'РУС', 'aria-pressed': String(language === code),
        onClick: () => { setLanguage(code); preference('language', code); render(); },
    })));
    const theme = iconButton(t('theme'), () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        preference('theme', next);
        theme.setAttribute('aria-pressed', String(next === 'dark'));
        theme.replaceChildren(icon(next === 'dark' ? 'sun' : 'moon'));
    }, document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
    theme.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
    return el('div', { class: 'settings' }, langs, theme, user && el('a', {
        class: 'account-link', href: '#profile', title: t('profile'), 'aria-label': t('profile') }, icon('user-round')));
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
        navigate, logout,
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
    const loginForm = form(ctx, fields, async data => {
            if (registration && !validPassword(data.password)) validation(t('passwordRule'));
            await api.request(registration ? 'register' : 'login', data, { write: true });
            // Ignore the mobile bearer token response: only a server-verified cookie grants web access.
            const session = await api.request('session');
            if (!roleRoutes[session.user?.role]) validation(t('forbidden'));
            if (!ctx.alive()) return;
            user = session.user;
            route = 'home'; history.replaceState(null, '', '#home'); render();
    }, t(registration ? 'register' : 'login'));
    const registerButton = button(t(registration ? 'login' : 'register'), () => { registration = !registration; render(); }, 'arrow-right', 'secondary');
    if (registration) return el('main', { class: 'auth' }, el('h1', { text: t('register') }),
        message && el('p', { role: 'alert', class: 'error', text: message }), loginForm, registerButton);
    return welcomeScreen({ loginForm, registerButton, message,
        forgotButton: button(t('forgot'), () => { recoveryMode = true; render(); }, null, 'text-button') });
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
    const brand = el('a', { class: 'brand', href: '#home' },
        el('span', { class: 'brand-mark' }, el('img', { src: '/web/art/brand.webp', width: 40, height: 40, alt: '' })),
        el('span', {}, 'Qamqor', el('b', { text: 'Med' })));
    const header = el('header', { class: 'topbar' }, el('div', { class: 'topbar-inner' }, brand,
        user && el('span', { class: 'role-label', text: t(user.role + 'Space') }), settings()));
    if (!user) { app.replaceChildren(header, auth(ctx, message)); return; }
    const desired = location.hash.slice(1) || 'home';
    route = canAccess(user.role, desired) ? desired : 'home';
    if (route !== desired) history.replaceState(null, '', '#home');
    const pending = user.role === 'patient' && !hasMedicalAccess(user);
    const routes = pending ? ['home', 'doctors', 'clinics', 'profile'] : roleRoutes[user.role];
    const primary = pending ? routes : user.role === 'patient' ? ['home', 'appointments', 'chat', 'services'] : user.role === 'doctor' ? ['home', 'appointments', 'chat', 'patients'] : ['home', 'users', 'audit'];
    function navLink(key, compact = false) {
        const short = t(({ appointments: 'shortVisits', chat: 'shortChat', patients: 'shortPatients', users: 'shortUsers',
            audit: 'shortAudit', identity: 'shortIdentity', recovery: 'shortRecovery' })[key] || key);
        return el('a', { href: '#' + key, class: 'nav-item', title: t(key), 'aria-label': t(key),
            ...(key === route ? { 'aria-current': 'page' } : compact && key === 'services' && !primary.includes(route)
                ? { 'aria-current': 'location' } : {}) }, icon(symbols[key]),
            compact ? el('span', { text: short }) : [el('span', { class: 'nav-full', text: t(key) }), el('span', { class: 'nav-short', text: short })]);
    }
    const groups = user.role === 'patient'
        ? [['myAccount', ['home', 'appointments', 'chat', 'services']], ['medicalRecord', ['analyses', 'medicines']], ['directory', ['doctors', 'clinics']]]
        : [['workspace', routes.filter(key => key !== 'profile')]];
    const nav = el('nav', { 'aria-label': t('navigation') });
    for (const [title, keys] of groups) {
        const available = keys.filter(key => routes.includes(key));
        if (available.length) nav.append(el('div', { class: 'nav-group', role: 'group', 'aria-label': t(title) },
            el('p', { class: 'nav-caption', 'aria-hidden': 'true', text: t(title) }), available.map(key => navLink(key))));
    }
    const sidebar = el('aside', { class: 'sidebar' }, nav, el('div', { class: 'account-menu' },
        el('a', { class: 'identity', href: '#profile', title: t('profile'), ...(route === 'profile' ? { 'aria-current': 'page' } : {}) }, icon('user-round'),
            el('div', {}, el('strong', { text: user.name }), el('span', { text: t(user.role) }))),
        iconButton(t('logout'), logout, 'log-out')));
    const main = el('main', { id: 'main', tabIndex: -1, 'data-route': route }, el('div', { class: 'page-heading' }, el('div', {},
        el('p', { class: 'eyebrow', text: route === 'home' ? headingDate() : t(user.role + 'Space') }),
        el('h1', { text: t(route) })), !['chat', 'clinics'].includes(route) && iconButton(t('refresh'), () => render(), 'refresh-cw')));
    const skip = el('button', { type: 'button', class: 'skip-link', text: t('skipContent'), onClick: () => main.focus() });
    app.replaceChildren(skip, header, el('div', { class: 'app-layout' }, sidebar, main),
        el('nav', { class: 'bottomnav', 'aria-label': t('navigation') }, primary.map(key => navLink(key, true))));
    if (pending && !routes.includes(route)) main.append(el('section', { class: 'identity-pending', role: 'status' },
        el('h2', { text: t('pendingTitle') }), notice(t('pendingBody')), button(t('home'), () => navigate('home'), 'arrow-left')));
    else if (route === 'services') {
        for (const [title, keys] of [['directory', ['doctors', 'clinics', 'appointments']], ['medicalRecord', ['analyses', 'medicines']], ['myAccount', ['chat', 'profile']]]) {
            main.append(el('section', { class: 'service-section' }, el('h2', { text: t(title) }), el('div', { class: 'service-rows' },
                keys.map(key => el('a', { href: '#' + key }, icon(symbols[key]), el('span', { text: t(key) }), icon('chevron-right'))))));
        }
    } else screens[route]({ ...ctx, route }, main);
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
