import { el, icon, button, iconButton, field, values } from './dom.mjs';
import { t, language } from './i18n.mjs';

export function errorText(error, write = false) {
    if (error.status === 401) return t('expired');
    if (error.status === 403) return t('forbidden');
    if (error.status === 409) return t('conflict');
    if (error.status === 429) return t('rateLimit');
    if (error.status >= 500) return t('unavailable');
    if (!error.status && write) return t('unknownWrite');
    return (language === 'ru' && error.status === 400 && error.message) || t('network');
}
export function status(value) { return el('span', { class: 'badge ' + (['upcoming', 'completed', 'cancelled', 'active', 'revoked', 'normal', 'warning', 'danger'].includes(value) ? value : ''), text: t(value) }); }
export function notice(text) { return el('p', { class: 'notice', text }); }
export function heading(title, action) { return el('div', { class: 'section-heading' }, el('h2', { text: title }), action); }
export function detail(label, value) { return value === undefined || value === null || value === '' ? null : el('div', { class: 'detail' }, el('span', { class: 'muted', text: label }), el('span', { text: value })); }
export function passwordField(label = t('oldPassword'), name = 'currentPassword') {
    return field(label, name, { type: 'password', required: true, maxLength: 128, autocomplete: 'current-password' });
}
export function newPasswordField(name = 'password', label = t('password')) {
    return field(label, name, { type: 'password', required: true, minLength: 8, maxLength: 128, autocomplete: 'new-password' });
}
export function validPassword(value) { return value.length >= 8 && value.length <= 128 && /[A-ZА-ЯӘҒҚҢӨҰҮҺІ]/.test(value) && (value.match(/\d/g) ?? []).length >= 2; }
export function form(ctx, fields, onSubmit, label = t('save')) {
    const error = el('p', { class: 'error', role: 'alert', hidden: true });
    const submit = el('button', { type: 'submit', class: 'button primary' }, icon('check'), el('span', { text: label }));
    const node = el('form', { class: 'form' }, fields, error, submit);
    let busy = false;
    node.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !ctx.alive() || !node.reportValidity()) return;
        busy = true;
        error.hidden = true;
        submit.disabled = true;
        node.setAttribute('aria-busy', 'true');
        // A fieldset lock also prevents edits to a request already being committed.
        const controls = [...node.querySelectorAll('input,select,textarea,button')];
        const disabled = controls.map(control => control.disabled);
        const data = values(node);
        controls.forEach(control => { control.disabled = true; });
        try { await onSubmit(data, node); }
        catch (failure) {
            if (!ctx.alive()) return;
            if (failure.status === 401 && ctx.user) { ctx.expire(); return; }
            error.textContent = failure.userMessage || errorText(failure, true);
            error.hidden = false;
            error.tabIndex = -1;
            error.focus();
        } finally {
            busy = false;
            controls.forEach((control, index) => { control.disabled = disabled[index]; });
            submit.disabled = false;
            node.setAttribute('aria-busy', 'false');
            node.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; });
        }
    });
    return node;
}
export function validation(message) { const error = new Error(message); error.userMessage = message; throw error; }
export function modal(ctx, title, content) {
    const previous = document.activeElement;
    const dialog = el('dialog', { class: 'dialog', 'aria-label': title });
    const close = () => { dialog.close(); dialog.remove(); if (previous?.isConnected) previous.focus(); };
    dialog.append(el('div', { class: 'section-heading' }, el('h2', { text: title }), iconButton(t('close'), close, 'x')), content(close));
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    ctx.cleanup(() => { dialog.close(); dialog.remove(); });
    return close;
}
export function confirmAction(ctx, title, execute) {
    modal(ctx, title, close => form(ctx, [], async () => { await execute(); if (ctx.alive()) close(); }, t('confirm')));
}
export async function load(ctx, target, request, render) {
    target.replaceChildren(el('p', { role: 'status', class: 'loading', text: t('loading') }));
    target.setAttribute('aria-busy', 'true');
    try {
        const result = await request();
        if (ctx.alive()) target.replaceChildren(...[render(result)].flat());
    } catch (error) {
        if (!ctx.alive()) return;
        if (error.status === 401) { ctx.expire(); return; }
        target.replaceChildren(el('div', { class: 'error-panel', role: 'alert' }, el('p', { text: errorText(error) }), button(t('retry'), () => load(ctx, target, request, render), 'refresh-cw')));
    } finally { if (ctx.alive()) target.setAttribute('aria-busy', 'false'); }
}
