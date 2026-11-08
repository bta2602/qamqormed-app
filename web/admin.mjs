import { el, button, field, select, listOrEmpty } from './dom.mjs';
import { t, localeDate } from './i18n.mjs';
import { load, modal, form, notice, heading, detail, status, passwordField, newPasswordField, validPassword, validation } from './ui.mjs';
import { appointmentRecord, analysisRecord, prescriptionRecord } from './clinical.mjs';

function paginator(page, pageSize, total, change) {
    const previous = button(t('back'), () => change(page - 1), 'chevron-left'); previous.disabled = page <= 1;
    const next = button(t('next'), () => change(page + 1), 'chevron-right'); next.disabled = page * pageSize >= total;
    return el('div', { class: 'pagination' }, previous, el('span', { text: page + ' / ' + Math.max(1, Math.ceil(total / pageSize)) + ' · ' + t('total') + ': ' + total }), next);
}
function userEditor(ctx, existing) {
    modal(ctx, t(existing ? 'edit' : 'createUser'), () => {
        const doctorFields = el('div', { class: 'form-fields' },
            field(t('spec'), 'spec', { maxLength: 100, value: existing?.spec || '' }), field(t('city'), 'city', { maxLength: 100, value: existing?.city || '' }),
            field(t('experience'), 'exp', { maxLength: 50, value: existing?.exp || '' }), field(t('bio'), 'bio', { multiline: true, maxLength: 5000, value: existing?.bio || '' }),
            field(t('photo'), 'img', { type: 'url', maxLength: 2048, pattern: 'https://.*', value: existing?.img || '' }));
        const role = existing ? el('p', { text: t(existing.role) }) : select(t('role'), 'role', [['patient', t('patient')], ['doctor', t('doctor')]]);
        const updateRole = () => {
            const doctor = (existing?.role || role.querySelector('select').value) === 'doctor';
            doctorFields.hidden = !doctor;
            doctorFields.querySelectorAll('input,textarea').forEach(input => { input.disabled = !doctor; input.required = doctor && ['spec', 'city'].includes(input.name); });
        };
        if (!existing) role.addEventListener('change', updateRole); updateRole();
        return form(ctx, [field(t('name'), 'name', { required: true, maxLength: 100, value: existing?.name || '' }),
            field(t('email'), 'email', { required: true, type: 'email', maxLength: 100, value: existing?.email || '' }),
            !existing && field(t('iin'), 'iin', { required: true, pattern: '[0-9]{12}', maxLength: 12, inputmode: 'numeric', autocomplete: 'off' }),
            !existing && newPasswordField(), !existing && notice(t('passwordRule')), role, doctorFields, passwordField()], async data => {
            if (!existing && !validPassword(data.password)) validation(t('passwordRule'));
            await ctx.api.request('admin', { action: existing ? 'update' : 'create', ...data,
                ...(existing ? { targetId: existing.id, role: existing.role } : {}) }, { write: true });
            if (ctx.alive()) { ctx.announce(t('saved')); ctx.refresh(); }
        });
    });
}
function setActive(ctx, user) {
    modal(ctx, t(user.is_active ? 'deactivate' : 'activate'), () => form(ctx, [notice(user.name), passwordField()], async data => {
        await ctx.api.request('admin', { action: 'set_active', targetId: user.id, active: !user.is_active, currentPassword: data.currentPassword }, { write: true });
        if (ctx.alive()) ctx.refresh();
    }, t('confirm')));
}
function medicalRecord(ctx, user) {
    modal(ctx, t('medicalRecord'), () => {
        const content = el('section');
        const gate = form(ctx, [notice(user.name), notice(t('auditNotice')),
            select(t('accessReason'), 'reason', ['care_review', 'patient_request', 'security_review'].map(x => [x, t(x)])), passwordField()], async data => {
            const record = await ctx.api.request('admin', { action: 'medical_record', targetId: user.id, ...data }, { write: true });
            if (!ctx.alive() || !content.isConnected) return;
            content.replaceChildren(el('h3', { text: record.patient.name }), detail(t('iin'), record.patient.iin),
                heading(t('appointments')), ...[listOrEmpty(record.appointments, a => appointmentRecord(a), t('noAppointments'))].flat(),
                heading(t('analyses')), ...[listOrEmpty(record.analyses, analysisRecord, t('noAnalyses'))].flat(),
                heading(t('medicines')), ...[listOrEmpty(record.prescriptions, prescriptionRecord, t('noPrescriptions'))].flat());
        }, t('view'));
        content.append(gate); return content;
    });
}
export function users(ctx, root) {
    let page = 1, query = '', version = 0;
    const search = field(t('search'), 'query', { type: 'search', maxLength: 100 });
    const searchForm = el('form', { class: 'toolbar', onSubmit: event => { event.preventDefault(); query = search.querySelector('input').value.trim(); page = 1; reload(); } },
        search, el('button', { class: 'button secondary', type: 'submit', text: t('search') }), button(t('createUser'), () => userEditor(ctx), 'plus', 'primary'));
    const list = el('div', { class: 'record-list' });
    root.append(searchForm, list);
    function reload() {
        const current = ++version;
        load({ ...ctx, alive: () => ctx.alive() && current === version }, list, () => ctx.api.request('admin', { action: 'get_all', page, pageSize: 30, ...(query ? { query } : {}) }), data => [
            notice(t('total') + ': ' + data.total + ' · ' + t('appointments') + ': ' + data.totalAppointments),
            listOrEmpty(data.users, user => el('article', { class: 'record' }, el('div', { class: 'section-heading' }, el('h3', { text: user.name }), status(user.is_active ? 'active' : 'inactive')),
                detail(t('email'), user.email), detail(t('role'), t(user.role)), detail(t('spec'), user.spec), detail(t('city'), user.city),
                user.role !== 'admin' && el('div', { class: 'toolbar' }, button(t('edit'), () => userEditor(ctx, user), 'pencil'),
                    button(t(user.is_active ? 'deactivate' : 'activate'), () => setActive(ctx, user), 'user-round'),
                    user.role === 'patient' && button(t('medicalRecord'), () => medicalRecord(ctx, user), 'file-heart'))), t('empty')),
            paginator(data.page, data.pageSize, data.total, next => { page = next; reload(); }),
        ].flat());
    }
    reload();
}
export function audit(ctx, root) {
    const body = el('section'); root.append(body);
    let page = 1, version = 0;
    function reload() {
        const current = ++version;
        load({ ...ctx, alive: () => ctx.alive() && current === version }, body, () => ctx.api.request('admin', { action: 'audit', page, pageSize: 30 }), data => el('div', {},
            el('div', { class: 'table-scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ['date', 'actor', 'action', 'resource'].map(key => el('th', { scope: 'col', text: t(key) })))),
                el('tbody', {}, data.events.map(event => el('tr', {}, el('td', { text: localeDate(event.created_at, true) }), el('td', { text: event.actor_id }),
                    el('td', { text: event.action }), el('td', { text: event.resource_type + ' #' + event.resource_id })))))),
            !data.events.length && notice(t('empty')), paginator(data.page, data.pageSize, data.total, next => { page = next; reload(); })));
    }
    reload();
}

export function recoveryRequests(ctx, root) {
    let page = 1;
    const body = el('section'); root.append(body);
    function review(item, approve) {
        modal(ctx, t(approve ? 'approve' : 'reject'), () => form(ctx, [notice(item.name + ' · ' + item.email), notice(t('recoveryRisk')),
            field(t('recoveryAck'), 'acknowledgeRisk', { type: 'checkbox', required: true }), passwordField()], async data => {
            await ctx.api.request('admin', { action: 'review_recovery', requestId: item.id, approve,
                acknowledgeRisk: data.acknowledgeRisk === 'on', currentPassword: data.currentPassword }, { write: true });
            if (ctx.alive()) ctx.refresh();
        }, t('confirm')));
    }
    function reload() {
        load(ctx, body, () => ctx.api.request('admin', { action: 'recovery_requests', page, pageSize: 30 }), data => [
            ...[listOrEmpty(data.requests, item => el('article', { class: 'record' }, el('h3', { text: item.name }),
                detail(t('email'), item.email), detail(t('date'), localeDate(item.created_at, true)),
                el('div', { class: 'toolbar' }, button(t('approve'), () => review(item, true), 'check'), button(t('reject'), () => review(item, false), 'x'))), t('empty'))].flat(),
            paginator(data.page, data.pageSize, data.total, next => { page = next; reload(); }),
        ]);
    }
    reload();
}
