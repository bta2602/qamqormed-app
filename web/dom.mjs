export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (['value', 'checked', 'disabled', 'required', 'readOnly'].includes(key)) node[key] = value;
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children.flat(Infinity).filter(x => x != null && x !== false));
    return node;
}
export function icon(name) {
    return el('img', { src: '/web/icons/' + name + '.svg', alt: '', class: 'icon', width: 22, height: 22 });
}
export function button(label, handler, glyph, kind = 'secondary') {
    return el('button', { type: 'button', class: 'button ' + kind, onClick: handler }, glyph && icon(glyph), el('span', { text: label }));
}
export function iconButton(label, handler, glyph) {
    return el('button', { type: 'button', class: 'icon-button', title: label, 'aria-label': label, onClick: handler }, icon(glyph));
}
export function field(label, name, options = {}) {
    const input = el(options.multiline ? 'textarea' : 'input', { name, ...options });
    return el('label', { class: 'field' }, el('span', { text: label }), input);
}
export function select(label, name, options, value = '') {
    const input = el('select', { name }, options.map(([id, text]) => el('option', { value: id, text })));
    if (value !== '') input.value = value;
    return el('label', { class: 'field' }, el('span', { text: label }), input);
}
export function safeUrl(value, { image = false } = {}) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
        const url = new URL(value, globalThis.location?.origin ?? 'https://qamqor-med.netlify.app');
        if (url.username || url.password) return '';
        if (url.protocol === 'https:' || (image && url.origin === globalThis.location?.origin && value.startsWith('/web/'))) return url.href;
    } catch { /* Invalid server URLs are omitted, never interpolated into markup. */ }
    return '';
}
export function externalLink(label, url) {
    const safe = safeUrl(url);
    return safe ? el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', text: label }) : null;
}
export function values(form) { return Object.fromEntries(new FormData(form)); }
export function listOrEmpty(items, render, message) {
    return items.length ? items.map(render) : el('div', { class: 'empty' }, icon('inbox'), el('p', { text: message }));
}
