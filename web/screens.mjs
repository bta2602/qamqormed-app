import { el, icon, button, field, select, listOrEmpty } from './dom.mjs';
import { t, localeDate } from './i18n.mjs';
import { load, form, notice, heading, detail, passwordField, newPasswordField, validPassword, validation } from './ui.mjs';
import { doctors, doctorCard, clinics, chat } from './catalog.mjs';
import { appointments, analyses, medicines, patients, getAppointments } from './clinical.mjs';
import { users, audit, recoveryRequests } from './admin.mjs';

function home(ctx, root) {
    root.querySelector('h1').textContent = t('welcome') + ', ' + ctx.user.name;
    const patient = ctx.user.role === 'patient';
    const tiles = patient ? [['profile', 'profile'], ['appointments', 'appointments'], ['analyses', 'analyses'], ['medicines', 'medicines'],
        ['booking', 'doctors'], ['doctors', 'doctors'], ['clinics', 'clinics'], ['Asem-Ai', 'chat']] :
        ctx.user.role === 'doctor' ? [['appointments', 'appointments'], ['patients', 'patients'], ['analyses', 'analyses'], ['medicines', 'medicines']] : [['users', 'users'], ['recovery', 'recovery'], ['audit', 'audit']];
    root.append(el('section', { class: 'services', 'aria-label': t('home') }, tiles.map(([label, route], index) =>
        el('a', { class: 'service tone-' + index % 4, href: '#' + route }, el('span', { class: 'service-icon' }, icon(label === 'Asem-Ai' ? 'sparkles' : ctx.symbols[route])), el('span', { text: t(label) })))));
    if (ctx.user.role === 'admin') { users(ctx, root); return; }
    const upcoming = el('section', { class: 'section' });
    root.append(heading(t('appointments'), button(t('view'), () => ctx.navigate('appointments'), 'arrow-right', 'text-button')), upcoming);
    load(ctx, upcoming, () => getAppointments(ctx), data => {
        const visits = data.appointments.filter(a => a.status === 'upcoming');
        return listOrEmpty(visits.slice(0, 3), a => el('article', { class: 'record compact' }, icon('calendar-days'),
            el('div', {}, el('strong', { text: localeDate(a.date) + ' · ' + String(a.time).slice(0, 5) }), el('p', { class: 'muted', text: patient ? t(a.type === 'Онлайн' || a.type === 'online' ? 'online' : 'clinic') : a.patient_name })),
            button(t('view'), () => ctx.navigate('appointments'), 'arrow-right', 'text-button')), t('noAppointments'));
    });
    if (!patient) return;
    root.append(el('section', { class: 'assistant-band' }, icon('sparkles'), el('div', {}, el('h2', { text: 'Asem-Ai' }), el('p', { text: t('aiNotice') })), button(t('chat'), () => ctx.navigate('chat'), 'arrow-right', 'primary')));
    const catalogue = el('div', { class: 'doctor-grid' });
    root.append(heading(t('doctors'), button(t('allDoctors'), () => ctx.navigate('doctors'), 'arrow-right', 'text-button')), catalogue);
    load(ctx, catalogue, () => ctx.api.request('get-doctors'), data => listOrEmpty(data.doctors.slice(0, 4), doctor => doctorCard(ctx, doctor), t('noDoctors')));
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
    root.append(button(t('logout'), () => document.querySelector('.sidebar button').click(), 'log-out', 'text-button'));
}
export const screens = { home, profile, doctors, clinics, chat, appointments, analyses, medicines, patients, users, audit, recovery: recoveryRequests };
