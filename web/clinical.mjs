import { el, icon, button, iconButton, field, select, listOrEmpty, values } from './dom.mjs';
import { t, localeDate, today } from './i18n.mjs';
import { patientsFrom } from './api.mjs';
import { load, modal, form, notice, heading, detail, status, confirmAction, validation } from './ui.mjs';

export function getAppointments(ctx) {
    return ctx.api.request('appointments', ctx.user.role === 'doctor'
        ? { action: 'get_all_for_doctor', doctorIin: ctx.user.iin }
        : { action: 'get', patientIin: ctx.user.iin });
}
export function appointmentRecord(a, title) {
    return el('article', { class: 'record', 'data-appointment': a.id }, el('div', { class: 'section-heading' }, el('h3', { text: title || localeDate(a.date) }), status(a.status)),
        detail(t('date'), localeDate(a.date) + ' · ' + String(a.time).slice(0, 5)), detail(t('format'), t(['online', 'Онлайн'].includes(a.type) ? 'online' : 'clinic')),
        detail(t('reason'), a.message), detail(t('diagnosis'), a.diagnosis), detail(t('notes'), a.notes), detail(t('treatment'), a.treatment));
}
export function appointments(ctx, root) {
    root.append(notice(t('appointmentsZone')));
    const body = el('section'); root.append(body);
    load(ctx, body, async () => {
        const data = await getAppointments(ctx);
        const doctors = ctx.user.role === 'patient' ? (await ctx.api.request('get-doctors')).doctors : [];
        return { ...data, doctors };
    }, data => {
        const filter = select(t('status'), 'status', ['all', 'upcoming', 'completed', 'cancelled'].map(x => [x, t(x)]));
        const list = el('div', { class: 'record-list' });
        function draw() {
            const filtered = data.appointments.filter(a => filter.querySelector('select').value === 'all' || a.status === filter.querySelector('select').value);
            list.replaceChildren(...[listOrEmpty(filtered, a => {
                const record = appointmentRecord(a, ctx.user.role === 'doctor' ? a.patient_name : data.doctors.find(d => d.iin === a.doctor_iin)?.name);
                const toolbar = el('div', { class: 'toolbar' });
                if (a.status === 'upcoming') {
                    if (ctx.user.role === 'doctor') toolbar.append(button(t('complete'), () => completeVisit(ctx, a), 'check', 'primary'));
                    toolbar.append(button(t('cancelVisit'), () => confirmAction(ctx, t('confirmCancel'), async () => {
                        await ctx.api.request('appointments', { action: 'cancel', appointmentId: a.id }, { write: true });
                        if (ctx.alive()) ctx.refresh();
                    }), 'calendar-x', 'text-button'));
                }
                record.append(toolbar); return record;
            }, t('noAppointments'))].flat());
        }
        filter.addEventListener('change', draw); draw();
        return el('div', {}, filter, list);
    });
}
function analysisEditor() {
    let id = 0;
    const rows = el('div', { class: 'analysis-rows' });
    const add = () => {
        if (rows.children.length >= 50) return;
        const index = ++id;
        const row = el('fieldset', { class: 'analysis-row' }, el('legend', { text: t('indicator') + ' ' + index }),
            field(t('indicator'), 'name', { required: true, maxLength: 100 }),
            ...['value', 'min', 'max'].map(key => field(t(key), key, { type: 'number', step: 'any', required: true })),
            field(t('unit'), 'unit', { maxLength: 40 }),
            iconButton(t('remove'), () => { if (rows.children.length > 1) row.remove(); }, 'trash-2'));
        rows.append(row);
    };
    add();
    const type = field(t('analysisType'), 'analysisType', { required: true, maxLength: 100 });
    const date = field(t('date'), 'analysisDate', { type: 'date', required: true, value: today(), max: today() });
    const overall = select(t('status'), 'overallStatus', ['normal', 'warning', 'danger'].map(x => [x, t(x)]));
    const node = el('fieldset', { class: 'analysis-editor' }, el('legend', { text: t('addAnalysis') }), type, date, rows, button(t('addRow'), add, 'plus'), overall);
    return { node, read: () => {
        const results = [...rows.children].map(row => {
            const get = key => row.querySelector('[name=' + key + ']').value;
            const result = { name: get('name'), value: Number(get('value')), min: Number(get('min')), max: Number(get('max')), unit: get('unit') };
            if (result.min > result.max) validation(t('invalidRange'));
            result.status = result.value < result.min || result.value > result.max ? 'warning' : 'normal';
            return result;
        });
        return { type: type.querySelector('input').value, date: date.querySelector('input').value, overallStatus: overall.querySelector('select').value, results };
    } };
}
function completeVisit(ctx, appointment) {
    modal(ctx, t('complete'), () => {
        const analysis = analysisEditor();
        analysis.node.disabled = true; analysis.node.hidden = true;
        const include = field(t('addAnalysis'), 'includeAnalysis', { type: 'checkbox' }); include.classList.add('checkbox-field');
        include.addEventListener('change', event => { analysis.node.disabled = !event.target.checked; analysis.node.hidden = !event.target.checked; });
        return form(ctx, [notice(appointment.patient_name),
            field(t('diagnosis'), 'diagnosis', { multiline: true, required: true, maxLength: 2000 }),
            field(t('notes'), 'notes', { multiline: true, maxLength: 5000 }), field(t('treatment'), 'treatment', { multiline: true, maxLength: 5000 }), include, analysis.node], async data => {
            const payload = { action: 'complete', appointmentId: appointment.id, diagnosis: data.diagnosis, notes: data.notes, treatment: data.treatment };
            if (data.includeAnalysis) payload.analysis = analysis.read();
            await ctx.api.request('appointments', payload, { write: true });
            if (ctx.alive()) ctx.refresh();
        }, t('complete'));
    });
}
export function analysisRecord(a) {
    let results = a.results;
    if (typeof results === 'string') { try { results = JSON.parse(results); } catch { results = []; } }
    if (!Array.isArray(results)) results = [];
    return el('article', { class: 'record analysis-record' }, el('div', { class: 'section-heading' }, el('h3', { text: a.type }), status(a.overall_status || a.overallStatus)),
        el('p', { class: 'muted', text: localeDate(a.date) }),
        el('div', { class: 'table-scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ['indicator', 'value', 'range'].map(x => el('th', { scope: 'col', text: t(x) })))),
            el('tbody', {}, results.map(r => el('tr', {}, el('th', { scope: 'row', text: r.name }), el('td', { text: String(r.value ?? '') + ' ' + (r.unit || '') }), el('td', { text: String(r.min ?? '') + ' – ' + String(r.max ?? '') })))))));
}
function analysisModal(ctx, patientIin) {
    modal(ctx, t('addAnalysis'), () => {
        const editor = analysisEditor();
        return form(ctx, [editor.node], async () => {
            await ctx.api.request('save-analysis', { patientIIN: patientIin, ...editor.read() }, { write: true });
            if (ctx.alive()) ctx.refresh();
        });
    });
}
export function analyses(ctx, root) {
    const body = el('section'); root.append(body);
    if (ctx.user.role === 'patient') {
        load(ctx, body, () => ctx.api.request('get-analyses', { iin: ctx.user.iin }), data => listOrEmpty(data.analyses, analysisRecord, t('noAnalyses')));
        return;
    }
    load(ctx, body, () => getAppointments(ctx), data => {
        const patients = patientsFrom(data.appointments);
        if (!patients.length) return notice(t('empty'));
        const patient = select(t('patient'), 'patientIin', patients.map(p => [p.iin, p.name]));
        const list = el('div', { class: 'record-list' }); let version = 0;
        function reload() {
            const current = ++version;
            load({ ...ctx, alive: () => ctx.alive() && current === version }, list, () => ctx.api.request('get-analyses', { iin: patient.querySelector('select').value }),
                response => listOrEmpty(response.analyses, analysisRecord, t('noAnalyses')));
        }
        patient.addEventListener('change', reload); reload();
        return el('div', {}, el('div', { class: 'toolbar' }, patient, button(t('addAnalysis'), () => analysisModal(ctx, patient.querySelector('select').value), 'plus', 'primary')), list);
    });
}
export function patients(ctx, root) {
    const body = el('section', { class: 'record-list' }); root.append(body);
    load(ctx, body, () => getAppointments(ctx), data => listOrEmpty(patientsFrom(data.appointments), p => el('article', { class: 'record' },
        el('h3', { text: p.name }), detail(t('iin'), p.iin), el('div', { class: 'toolbar' },
            button(t('medicalRecord'), () => modal(ctx, p.name, () => {
                const record = el('section');
                load(ctx, record, async () => {
                    const analysis = await ctx.api.request('get-analyses', { iin: p.iin });
                    const prescriptions = await ctx.api.request('prescriptions', { action: 'get' });
                    return { ...analysis, prescriptions: prescriptions.prescriptions.filter(item => item.patient_iin === p.iin) };
                }, result => el('div', {}, heading(t('appointments')), data.appointments.filter(a => a.patient_iin === p.iin).map(a => appointmentRecord(a)),
                    heading(t('analyses')), listOrEmpty(result.analyses, analysisRecord, t('noAnalyses')),
                    heading(t('medicines')), listOrEmpty(result.prescriptions, prescriptionRecord, t('noPrescriptions'))));
                return record;
            }), 'file-heart'),
            button(t('addAnalysis'), () => analysisModal(ctx, p.iin), 'flask-conical'),
            button(t('prescribe'), () => prescribe(ctx, [p]), 'pill'))), t('empty')));
}
export function prescriptionRecord(p) {
    return el('article', { class: 'record' }, el('div', { class: 'section-heading' }, el('h3', { text: p.medicine }), status(p.status)),
        detail(t('dosage'), p.dosage), detail(t('interval'), p.interval_hours), detail(t('duration'), p.duration_days),
        detail(t('instructions'), p.instructions), detail(t('doctor'), p.doctor_name), detail(t('patient'), p.patient_name),
        detail(t('startAt'), p.start_at ? localeDate(p.start_at, true) : null), detail(t('timezone'), p.timezone));
}
function prescribe(ctx, patients) {
    modal(ctx, t('prescribe'), () => form(ctx, [select(t('patient'), 'patientIin', patients.map(p => [p.iin, p.name])),
        field(t('medicine'), 'medicine', { required: true, maxLength: 160 }), field(t('dosage'), 'dosage', { required: true, maxLength: 160 }),
        select(t('interval'), 'intervalHours', [4, 6, 8, 12, 24].map(n => [n, n]), 24),
        field(t('duration'), 'durationDays', { type: 'number', required: true, min: 1, max: 365 }), field(t('instructions'), 'instructions', { multiline: true, maxLength: 2000 })], async data => {
        await ctx.api.request('prescriptions', { action: 'create', ...data, intervalHours: Number(data.intervalHours), durationDays: Number(data.durationDays) }, { write: true });
        if (ctx.alive()) ctx.refresh();
    }));
}
function schedule(ctx, p) {
    modal(ctx, t('schedule'), () => {
        const existing = p.start_at ? new Date(p.start_at) : null;
        const zone = p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const locked = existing && +existing <= Date.now();
        // The picker explicitly uses device time; a locked course always keeps the server instant.
        const defaultDate = existing || new Date(Date.now() + 15 * 60000);
        const localDate = new Date(+defaultDate - defaultDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        const enabled = field(t('enabled'), 'enabled', { type: 'checkbox', checked: p.start_at ? p.reminders_enabled : true }); enabled.classList.add('checkbox-field');
        return form(ctx, [notice(t('scheduleNote')), detail(t('timezone'), Intl.DateTimeFormat().resolvedOptions().timeZone),
            field(t('startAt'), 'startAt', { type: 'datetime-local', required: true, value: localDate, readOnly: locked }), enabled], async data => {
            const startAt = locked ? existing.toISOString() : new Date(data.startAt).toISOString();
            await ctx.api.request('prescriptions', { action: 'schedule', id: p.id, startAt, timezone: locked ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone, enabled: data.enabled === 'on' }, { write: true });
            if (ctx.alive()) ctx.refresh();
        });
    });
}
export function medicines(ctx, root) {
    const body = el('section'); root.append(body);
    load(ctx, body, async () => {
        const data = await ctx.api.request('prescriptions', { action: 'get' });
        return { ...data, patients: ctx.user.role === 'doctor' ? patientsFrom((await getAppointments(ctx)).appointments) : [] };
    }, data => el('div', {}, ctx.user.role === 'doctor' && data.patients.length > 0 && button(t('prescribe'), () => prescribe(ctx, data.patients), 'plus', 'primary'),
        el('div', { class: 'record-list' }, listOrEmpty(data.prescriptions, p => {
            const record = prescriptionRecord(p);
            if (p.status === 'active') record.append(ctx.user.role === 'doctor' ? button(t('revoke'), () => confirmAction(ctx, t('revoke'), async () => {
                await ctx.api.request('prescriptions', { action: 'revoke', id: p.id }, { write: true }); if (ctx.alive()) ctx.refresh();
            }), 'circle-x', 'text-button') : button(t('schedule'), () => schedule(ctx, p), 'clock'));
            return record;
        }, t('noPrescriptions')))));
}
