import { el, icon, button, field, select, listOrEmpty } from './dom.mjs';
import { t, language, localeDate } from './i18n.mjs';
import { load, form, notice, heading, detail, passwordField, newPasswordField, validPassword, validation } from './ui.mjs';
import { doctors, doctorCard, clinics, chat } from './catalog.mjs';
import { appointments, analyses, medicines, patients, getAppointments } from './clinical.mjs';
import { users, audit, recoveryRequests } from './admin.mjs';
import { hasMedicalAccess, patientsFrom } from './api.mjs';

const homeWords = {
    services: ['Сервисы', 'Қызметтер'], workspace: ['Рабочие разделы', 'Жұмыс бөлімдері'],
    visitsTile: ['Мои\nприёмы', 'Менің\nқабылдауым'], medsTile: ['Приём\nлекарств', 'Дәрі\nқабылдау'],
    bookTile: ['Запись к\nврачу', 'Дәрігерге\nжазылу'], doctorsTile: ['Врачи\nрядом', 'Жақын\nдәрігерлер'],
    checkup: ['Проверьте здоровье вовремя', 'Денсаулықты уақытында тексеріңіз'],
    care: ['Ваше здоровье, наша забота', 'Сіздің саулығыңыз, біздің қамқорлығымыз'],
    assistant: ['Ваш умный медицинский ассистент', 'Сіздің ақылды медициналық көмекшіңіз'],
    nextVisits: ['Ближайшие приёмы', 'Алдағы қабылдаулар'], noNext: ['Предстоящих приёмов нет', 'Алдағы қабылдаулар жоқ'],
    results: ['Результаты поиска', 'Іздеу нәтижелері'],
};
const homeText = key => homeWords[key]?.[language === 'kk' ? 1 : 0] ?? t(key);

const patientTiles = [
    ['profile'], ['appointments', 'visitsTile', 'list'], ['analyses'], ['medicines', 'medsTile'],
    ['doctors', 'bookTile', 'calendar-days'], ['doctors', 'doctorsTile'], ['clinics'], ['chat', 'Asem-Ai', 'sparkles'],
];
function shortcuts(ctx, tiles, title) {
    return el('section', {}, heading(homeText(title)),
        el('nav', { class: 'services home-shortcuts', 'aria-label': homeText(title) }, tiles.map(([route, label = route, glyph = ctx.symbols[route]]) =>
            el('a', { class: 'service home-shortcut', href: '#' + route },
                el('span', { class: 'service-icon' }, icon(glyph)), el('span', { text: homeText(label) })))));
}
function homeLink(route, label) {
    return el('a', { class: 'home-link', href: '#' + route }, el('span', { text: t(label) }), icon('arrow-right'));
}
function upcomingVisits(ctx) {
    const body = el('div', { class: 'home-visits' });
    const doctor = ctx.user.role === 'doctor';
    load(ctx, body, () => getAppointments(ctx), ({ appointments }) => {
        const upcoming = appointments.filter(a => a.status === 'upcoming');
        return el('div', {}, doctor && el('dl', { class: 'home-totals' },
            [[homeText('nextVisits'), upcoming.length], [t('patients'), patientsFrom(appointments).length]].map(([label, count]) =>
                el('div', {}, el('dt', { text: label }), el('dd', { text: count })))),
            upcoming.length ? el('ul', { class: 'home-agenda' }, upcoming.slice(0, 3).map(a => {
                const format = t(['Онлайн', 'online'].includes(a.type) ? 'online' : 'clinic');
                return el('li', {}, el('strong', { class: 'home-time', text: String(a.time).slice(0, 5) }),
                    el('div', {}, el('strong', { text: localeDate(a.date) }), el('p', { class: 'muted', text: [doctor && a.patient_name, format].filter(Boolean).join(' · ') })));
            })) : el('div', { class: 'home-empty' }, icon('calendar-days'), el('p', { text: homeText('noNext') }),
                !doctor && homeLink('doctors', 'booking')),
            upcoming.length > 0 && el('p', { class: 'home-zone', text: t('appointmentsZone') }));
    });
    return el('section', {}, heading(homeText('nextVisits'), homeLink('appointments', 'all')), body);
}
function bookingBanner(title, caption, art) {
    return el('a', { class: 'home-promo', href: '#doctors' },
        el('strong', { text: homeText(title) }), el('span', { text: homeText(caption) }),
        el('img', { src: '/web/art/' + art + '.webp', alt: '', width: 96, height: 96 }));
}
function assistantLink() {
    return el('section', {}, el('a', { class: 'home-assistant', href: '#chat' }, el('span', { class: 'service-icon' }, icon('sparkles')),
        el('div', {}, el('h2', { text: 'Asem-Ai' }), el('p', { text: homeText('assistant') })), icon('chevron-right')), notice(t('aiNotice')));
}
function patientHome(ctx, dashboard) {
    const search = el('input', { type: 'search', 'aria-label': t('searchDoctor'), placeholder: t('searchDoctor'), maxlength: 100 });
    const overview = el('div', { class: 'home-columns' },
        el('div', { class: 'home-stack' }, el('div', { class: 'home-promos' },
            bookingBanner('checkup', 'book', 'health'), bookingBanner('care', 'QamqorMed', 'care')),
            shortcuts(ctx, patientTiles, 'services')),
        el('div', { class: 'home-stack' }, upcomingVisits(ctx), assistantLink()));
    const title = heading(t('doctors'), homeLink('doctors', 'allDoctors'));
    const results = el('div', { class: 'home-results' });
    dashboard.append(el('label', { class: 'home-search' }, icon('search'), search), overview, el('section', {}, title, results));

    let directory;
    function matches(query) {
        const items = query ? directory.filter(d => [d.name, d.spec, d.city].join(' ').toLocaleLowerCase().includes(query)) : directory.slice(0, 4);
        return el('div', { class: 'doctor-grid' }, listOrEmpty(items, d => doctorCard(ctx, d), t('noDoctors')));
    }
    const query = () => search.value.trim().toLocaleLowerCase();
    search.addEventListener('input', () => {
        const term = query();
        overview.hidden = Boolean(term);
        title.querySelector('h2').textContent = term ? homeText('results') : t('doctors');
        if (directory) results.replaceChildren(matches(term));
    });
    load(ctx, results, () => ctx.api.request('get-doctors'), ({ doctors }) => {
        directory = doctors;
        return matches(query());
    });
}
function home(ctx, root) {
    root.querySelector('h1').textContent = t('welcome') + ', ' + ctx.user.name;
    const dashboard = el('div', { class: 'home-dashboard' });
    root.append(dashboard);
    if (ctx.user.role === 'patient') {
        if (!hasMedicalAccess(ctx.user)) {
            dashboard.append(el('div', { class: 'home-columns home-pending' },
                el('section', { class: 'identity-pending', role: 'status' }, el('h2', { text: t('pendingTitle') }), notice(t('pendingBody'))),
                shortcuts(ctx, [['profile'], ['doctors'], ['clinics']], 'services')));
        } else patientHome(ctx, dashboard);
        return;
    }
    if (ctx.user.role === 'doctor') {
        dashboard.append(el('div', { class: 'home-columns home-doctor' },
            shortcuts(ctx, [['appointments'], ['patients'], ['analyses'], ['medicines'], ['chat'], ['profile']], 'workspace'), upcomingVisits(ctx)));
        return;
    }
    const directory = el('section', {}, heading(t('users')));
    dashboard.append(el('div', { class: 'home-columns home-admin' },
        shortcuts(ctx, [['users'], ['recovery'], ['audit']], 'workspace'), directory));
    users(ctx, directory);
}
function profile(ctx, root) {
    const user = ctx.user;
    root.append(el('section', { class: 'profile-identity' }, icon('user-round'), el('div', {}, el('h2', { text: user.name }), el('p', { class: 'muted', text: t(user.role) }))), detail(t('iin'), user.iin));
    const current = passwordField();
    current.hidden = true;
    current.querySelector('input').required = false;
    const email = field(t('email'), 'email', { type: 'email', required: true, value: user.email, maxLength: 100, autocomplete: 'email' });
    email.querySelector('input').addEventListener('input', event => {
        const changed = event.target.value.trim().toLowerCase() !== user.email.toLowerCase();
        current.hidden = !changed;
        current.querySelector('input').required = changed;
    });
    root.append(el('div', { class: 'settings-grid' }, el('section', {}, heading(t('profile')),
        form(ctx, [email, select(t('bloodType'), 'bloodType', [['', t('unspecified')], ...['O(I)+', 'O(I)-', 'A(II)+', 'A(II)-', 'B(III)+', 'B(III)-', 'AB(IV)+', 'AB(IV)-'].map(x => [x, x])], user.blood_type || ''), current], async data => {
            await ctx.api.request('update-user', { action: 'update_profile', ...data }, { write: true });
            const session = await ctx.api.request('session');
            if (ctx.alive()) { ctx.updateUser(session.user); ctx.announce(t('saved')); ctx.refresh(); }
        })), el('section', {}, heading(t('changePassword')),
        form(ctx, [passwordField(t('oldPassword'), 'oldPassword'), newPasswordField('newPassword', t('newPassword')),
            newPasswordField('repeatPassword', t('repeatPassword')), notice(t('passwordRule'))], async (data, node) => {
            if (!validPassword(data.newPassword)) validation(t('passwordRule'));
            if (data.newPassword !== data.repeatPassword) validation(t('mismatch'));
            await ctx.api.request('update-user', { action: 'change_password', oldPassword: data.oldPassword, newPassword: data.newPassword }, { write: true });
            if (ctx.alive()) { node.reset(); ctx.announce(t('saved')); node.append(notice(t('saved'))); }
        }, t('changePassword')))));
    // The sidebar is hidden on compact viewports, so logout remains available here too.
    root.append(button(t('logout'), ctx.logout, 'log-out', 'text-button'));
}
export const screens = { home, profile, doctors, clinics, chat, appointments, analyses, medicines, patients, users, audit, recovery: recoveryRequests };
