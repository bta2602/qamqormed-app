import { el, icon, button, iconButton, field, select, listOrEmpty, safeUrl, externalLink } from './dom.mjs';
import { t, language, localeDate, cities, today } from './i18n.mjs';
import { load, modal, form, notice, detail, validation } from './ui.mjs';
import { getAppointments } from './clinical.mjs';
import { patientsFrom, hasMedicalAccess } from './api.mjs';

function portrait(doctor) {
    const node = el('div', { class: 'portrait' });
    const src = safeUrl(doctor.img, { image: true });
    const fallback = () => node.replaceChildren(icon('user-round'));
    if (src) node.append(el('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onError: fallback }));
    else fallback();
    return node;
}
function rating(value) {
    if (!Number.isFinite(Number(value)) || !(Number(value) > 0)) return null;
    return el('span', { class: 'catalog-rating' }, el('span', { 'aria-hidden': 'true', text: '★' }),
        el('span', { class: 'sr-only', text: 'Рейтинг: ' }),
        Number(value).toLocaleString(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
}
export function doctorCard(ctx, doctor) {
    const open = iconButton(t('view'), () => openDoctor(ctx, doctor), 'arrow-right');
    open.setAttribute('aria-description', doctor.name);
    return el('article', { class: 'doctor-card catalog-doctor' },
        el('div', { class: 'catalog-photo' }, portrait(doctor), rating(doctor.rating)),
        el('div', { class: 'catalog-identity' }, el('h3', { text: doctor.name }),
            el('p', { text: doctor.spec }), doctor.exp && el('small', { text: t('experience') + ': ' + doctor.exp })),
        el('div', { class: 'catalog-card-foot' }, el('span', { text: doctor.city }), open));
}
function bookingChoices(label, name, options) {
    return el('fieldset', { class: 'booking-choices' }, el('legend', { text: label }),
        el('div', { class: 'booking-options booking-' + name }, options.map(([value, text], index) =>
            el('label', {}, el('input', { class: 'sr-only', type: 'radio', name, value, checked: index === 0 }), el('span', { text })))));
}
function bookingForm(ctx, doctor) {
    const min = today();
    const max = new Date(min + 'T00:00:00Z');
    max.setUTCDate(max.getUTCDate() + 180);
    const times = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
    return form(ctx, [
        el('h3', { text: t('booking') }),
        field(t('date'), 'date', { type: 'date', required: true, min, max: max.toISOString().slice(0, 10) }),
        bookingChoices(t('time'), 'time', times.map(slot => [slot, slot])),
        notice(t('appointmentsZone')),
        bookingChoices(t('format'), 'type', [['clinic', t('clinic')], ['online', t('online')]]),
        field(t('reason'), 'message', { multiline: true, rows: 2, maxLength: 2000 }),
    ], async data => {
        if (!hasMedicalAccess(ctx.user)) validation(t('pendingBody'));
        await ctx.api.request('appointments', { action: 'book', patientIin: ctx.user.iin, doctorIin: doctor.iin, ...data }, { write: true });
        if (ctx.alive()) { ctx.announce(t('saved')); ctx.navigate('appointments'); }
    }, t('book'));
}
function openDoctor(ctx, doctor) {
    modal(ctx, doctor.name, () => el('div', { class: 'catalog-booking' },
        el('section', { class: 'booking-profile' },
            el('div', { class: 'catalog-photo' }, portrait(doctor), rating(doctor.rating)),
            el('div', { class: 'booking-facts' }, el('h3', { text: doctor.spec }),
                detail(t('city'), doctor.city), detail(t('experience'), doctor.exp)),
            doctor.bio && el('div', { class: 'booking-bio' }, el('h3', { text: t('bio') }), el('p', { class: 'prewrap', text: doctor.bio }))),
        hasMedicalAccess(ctx.user) ? bookingForm(ctx, doctor) : notice(t('pendingBody'))));
}
export function doctors(ctx, root) {
    const body = el('section', { class: 'catalog-doctors' }); root.append(body);
    load(ctx, body, () => ctx.api.request('get-doctors'), data => {
        const query = field(t('search'), 'query', { type: 'search', placeholder: t('searchDoctor'), maxLength: 100 });
        const city = select(t('city'), 'city', [['', t('all')], ...[...new Set(data.doctors.map(d => d.city).filter(Boolean))].map(x => [x, x])]);
        const spec = select(t('spec'), 'spec', [['', t('all')], ...[...new Set(data.doctors.map(d => d.spec).filter(Boolean))].map(x => [x, x])]);
        const list = el('div', { class: 'doctor-grid' });
        function filter() {
            const search = query.querySelector('input').value.trim().toLocaleLowerCase();
            const result = data.doctors.filter(d => [d.name, d.spec, d.city].join(' ').toLocaleLowerCase().includes(search)
                && (!city.querySelector('select').value || d.city === city.querySelector('select').value)
                && (!spec.querySelector('select').value || d.spec === spec.querySelector('select').value));
            list.replaceChildren(...[listOrEmpty(result, d => doctorCard(ctx, d), t('noDoctors'))].flat());
        }
        [query, city, spec].forEach(node => node.addEventListener('input', filter)); filter();
        return el('div', {}, el('div', { class: 'filters' }, query, city, spec), list);
    });
}
function clinicName(clinic) {
    return language === 'kk' ? clinic.nameKk || clinic.name : clinic.name;
}
function clinicRow(ctx, clinic) {
    const name = clinicName(clinic);
    function open() {
        modal(ctx, name, () => el('div', { class: 'catalog-clinic-detail' },
            detail(t('address'), clinic.address), detail(t('phone'), clinic.phone), detail(t('hours'), clinic.openingHours),
            externalLink(t('website'), clinic.website)));
    }
    return el('article', { class: 'catalog-clinic' }, el('button', { type: 'button', onClick: open, 'aria-haspopup': 'dialog' },
        el('span', { class: 'clinic-symbol' }, icon('hospital')),
        el('span', { class: 'clinic-identity' }, el('strong', { text: name }), clinic.address && el('span', { text: clinic.address })),
        icon('chevron-right')));
}
export function clinics(ctx, root) {
    const city = select(t('city'), 'city', cities);
    const body = el('section');
    const modes = el('div', { class: 'clinic-actions' });
    root.append(el('section', { class: 'catalog-clinics' },
        el('div', { class: 'clinic-controls' }, city, modes), body));
    let version = 0, destroyMap = () => {};
    ctx.cleanup(() => destroyMap());
    const refresh = () => {
        destroyMap();
        modes.replaceChildren();
        const current = ++version;
        const local = { ...ctx, alive: () => ctx.alive() && current === version };
        load(local, body, () => ctx.api.request('clinics?city=' + city.querySelector('select').value), data => {
            const results = el('div', { class: 'clinic-list' });
            const mapNode = el('div', { class: 'map', 'aria-label': t('map'), hidden: true });
            const mapMessage = el('p', { class: 'muted', role: 'status' });
            let map, L, marker;
            function setMapMode(active) {
                results.hidden = active;
                mapNode.hidden = locate.hidden = !active;
                showList.setAttribute('aria-pressed', String(!active));
                showMap.setAttribute('aria-pressed', String(active));
            }
            const showList = button(t('list'), () => setMapMode(false), 'list');
            const showMap = button(t('map'), async () => {
                setMapMode(true);
                if (map) { map.invalidateSize(); return; }
                showMap.disabled = true;
                try {
                    L = await import('./vendor/leaflet.mjs');
                    if (!local.alive()) return;
                    map = L.map(mapNode, { attributionControl: false });
                    destroyMap = () => { map?.remove(); map = null; };
                    const bounds = data.bounds;
                    map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]]);
                    const layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });
                    layer.on('tileerror', () => { if (local.alive()) mapMessage.textContent = t('mapError'); });
                    layer.addTo(map);
                    data.clinics.forEach(clinic => L.circleMarker([clinic.latitude, clinic.longitude], { radius: 8, color: '#2b7478', fillOpacity: 0.9 })
                        .addTo(map).bindPopup(el('div', {}, el('strong', { text: clinicName(clinic) }), el('p', { text: clinic.address }))));
                    map.invalidateSize();
                } catch {
                    if (local.alive()) { destroyMap(); mapMessage.textContent = t('mapError'); setMapMode(false); }
                }
                finally { showMap.disabled = false; }
            }, 'map');
            const locate = iconButton(t('location'), () => {
                if (!navigator.geolocation) { mapMessage.textContent = t('locationError'); return; }
                locate.disabled = true;
                navigator.geolocation.getCurrentPosition(position => {
                    locate.disabled = false;
                    if (!local.alive()) return;
                    if (!map) { mapMessage.textContent = t('map'); return; }
                    const coordinates = [position.coords.latitude, position.coords.longitude];
                    marker?.remove();
                    marker = L.circleMarker(coordinates, { color: '#36658a', radius: 9 }).addTo(map).bindPopup(el('span', { text: t('location') }));
                    map.setView(coordinates, 13);
                }, () => { locate.disabled = false; if (local.alive()) mapMessage.textContent = t('locationError'); }, { timeout: 10000, maximumAge: 60000, enableHighAccuracy: false });
            }, 'locate-fixed');
            results.append(...[listOrEmpty(data.clinics, clinic => clinicRow(ctx, clinic), t('noClinics'))].flat());
            setMapMode(false);
            modes.replaceChildren(el('div', { class: 'clinic-switch', role: 'group', 'aria-label': t('clinics') }, showList, showMap), locate);
            return el('div', {}, notice(t('locationPrivacy')), mapMessage, mapNode, results,
                el('p', { class: 'attribution' }, externalLink('© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright'), ' · ', localeDate(data.fetchedAt, true)));
        });
    };
    city.addEventListener('change', refresh); refresh();
}
function assistantWelcome(draft) {
    const kk = language === 'kk';
    const prompts = kk ? ['Дәрігер қабылдауына қалай дайындалуға болады?', 'Тексерілуге өзіммен не ала баруым керек?']
        : ['Как подготовиться к приёму врача?', 'Что взять с собой на обследование?'];
    return el('div', { class: 'chat-welcome' },
        el('h3', { text: kk ? 'Сәлеметсіз бе! Мен Asem-Ai' : 'Здравствуйте! Я Asem-Ai' }),
        prompts.map(prompt => button(prompt, () => {
            if (!draft.value) draft.value = prompt;
            draft.focus();
        }, 'arrow-right')));
}
export function chat(ctx, root) {
    const container = el('section'); root.append(container);
    load(ctx, container, async () => {
        const visits = await getAppointments(ctx);
        if (ctx.user.role === 'doctor') return { peers: patientsFrom(visits.appointments).map(p => [p.iin, p.name]) };
        const data = await ctx.api.request('get-doctors');
        const ids = new Set(visits.appointments.filter(a => ['upcoming', 'completed'].includes(a.status)).map(a => a.doctor_iin));
        return { peers: data.doctors.filter(d => ids.has(d.iin)).map(d => [d.iin, d.name]) };
    }, ({ peers }) => {
        const peer = select(t('chat'), 'receiver', [['support', 'Asem-Ai'], ...peers]);
        const receiverInput = peer.querySelector('select');
        const avatar = el('span', { class: 'chat-avatar' });
        const subtitle = el('small', { class: 'muted' });
        const messageField = field(t('message'), 'text', { multiline: true, required: true, maxLength: 8000, rows: 1, placeholder: t('message') });
        const messages = el('div', { class: 'messages', role: 'log', 'aria-label': t('chat'), 'aria-live': 'polite' });
        const consent = field(t('aiConsent'), 'aiConsent', { type: 'checkbox', checked: Boolean(ctx.sessionState.aiConsent) });
        consent.classList.add('checkbox-field');
        consent.addEventListener('change', event => { ctx.sessionState.aiConsent = event.target.checked; });
        const privacy = el('aside', { class: 'chat-privacy', 'aria-label': 'Asem-Ai' },
            el('div', { class: 'chat-policy-heading' }, icon('shield-check'), el('strong', { text: 'Google Gemini' })),
            notice(t('aiPrivacy')), notice(t('aiNotice')), consent);
        let version = 0;
        const reload = () => {
            const receiver = receiverInput.value;
            const contactName = receiverInput.selectedOptions[0].textContent;
            privacy.hidden = receiver !== 'support';
            avatar.replaceChildren(icon(privacy.hidden ? 'user-round' : 'sparkles'));
            subtitle.textContent = privacy.hidden ? (language === 'kk' ? 'Қабылдау бойынша хат алмасу' : 'Переписка по приёму')
                : (language === 'kk' ? 'ЖИ көмекшісі' : 'ИИ-ассистент');
            const current = ++version;
            const local = { ...ctx, alive: () => ctx.alive() && version === current };
            return load(local, messages, () => ctx.api.request('chat', { action: 'get', sender: ctx.user.iin, receiver }), data => {
                queueMicrotask(() => { if (local.alive()) messages.scrollTop = messages.scrollHeight; });
                if (receiver === 'support' && !data.messages.length) return assistantWelcome(messageField.querySelector('textarea'));
                return listOrEmpty(data.messages, message => {
                    const mine = message.sender === ctx.user.iin;
                    return el('article', { class: 'message ' + (mine ? 'sent' : 'received') },
                        el('strong', { text: mine ? (language === 'kk' ? 'Сіз' : 'Вы') : contactName }),
                        el('p', { class: 'prewrap', text: message.text }),
                        el('time', { text: localeDate(message.created_at, true) }));
                }, t('empty'));
            });
        };
        const composer = form(ctx, [messageField], async (data, node) => {
            const receiver = receiverInput.value;
            if (receiver === 'support' && !ctx.sessionState.aiConsent) validation(t('aiConsent'));
            receiverInput.disabled = true;
            try {
                await ctx.api.request(receiver === 'support' ? 'ai-chat' : 'chat', { action: 'send', sender: ctx.user.iin, receiver, text: data.text, ...(receiver === 'support' ? { aiConsent: true, aiConsentVersion: 'google-gemini-v2' } : {}) }, { write: true });
                if (ctx.alive()) { node.reset(); await reload(); }
            } finally { receiverInput.disabled = false; }
        }, t('send'));
        composer.classList.add('chat-composer');
        const submit = composer.querySelector('button[type=submit]');
        submit.replaceChildren(icon('arrow-right'));
        submit.setAttribute('aria-label', t('send'));
        submit.title = t('send');
        peer.addEventListener('change', () => { composer.reset(); reload(); });
        reload();
        return el('div', { class: 'chat-workspace catalog-chat' },
            el('header', { class: 'chat-head' }, avatar, el('div', { class: 'chat-peer' }, peer, subtitle),
                iconButton(t('refresh'), reload, 'refresh-cw')),
            messages, privacy, composer);
    });
}
