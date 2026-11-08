import { el, icon, button, field, select, listOrEmpty, safeUrl, externalLink } from './dom.mjs';
import { t, language, localeDate, cities, today } from './i18n.mjs';
import { load, modal, form, notice, detail, heading, validation } from './ui.mjs';
import { getAppointments } from './clinical.mjs';
import { patientsFrom } from './api.mjs';

function portrait(doctor) {
    const node = el('div', { class: 'portrait' });
    const src = safeUrl(doctor.img, { image: true });
    const fallback = () => node.replaceChildren(icon('user-round'));
    if (src) node.append(el('img', { src, alt: doctor.name, loading: 'lazy', referrerpolicy: 'no-referrer', onError: fallback }));
    else fallback();
    return node;
}
export function doctorCard(ctx, doctor) {
    return el('article', { class: 'doctor-card' }, portrait(doctor), el('div', { class: 'doctor-info' },
        el('p', { class: 'eyebrow', text: doctor.spec }), el('h3', { text: doctor.name }), el('p', { class: 'muted', text: doctor.city }),
        detail(t('experience'), doctor.exp), doctor.rating != null && Number(doctor.rating) > 0 ? detail('★', doctor.rating) : null,
        button(t('view'), () => openDoctor(ctx, doctor), 'arrow-right', 'text-button')));
}
function openDoctor(ctx, doctor) {
    const maxDate = new Date(today() + 'T00:00:00Z'); maxDate.setUTCDate(maxDate.getUTCDate() + 180);
    modal(ctx, doctor.name, () => el('div', {}, el('div', { class: 'doctor-detail' }, portrait(doctor), el('div', {},
        detail(t('spec'), doctor.spec), detail(t('city'), doctor.city), detail(t('experience'), doctor.exp), el('p', { class: 'prewrap', text: doctor.bio }))),
        form(ctx, [field(t('date'), 'date', { type: 'date', required: true, min: today(), max: maxDate.toISOString().slice(0, 10) }), select(t('time'), 'time', ['09', '10', '11', '12', '14', '15', '16', '17', '18'].map(hour => [hour + ':00', hour + ':00'])),
            notice(t('appointmentsZone')), select(t('format'), 'type', [['clinic', t('clinic')], ['online', t('online')]]),
            field(t('reason'), 'message', { multiline: true, maxLength: 2000 })], async data => {
            await ctx.api.request('appointments', { action: 'book', patientIin: ctx.user.iin, doctorIin: doctor.iin, ...data }, { write: true });
            if (ctx.alive()) { ctx.announce(t('saved')); ctx.navigate('appointments'); }
        }, t('book'))));
}
export function doctors(ctx, root) {
    const body = el('section'); root.append(body);
    load(ctx, body, () => ctx.api.request('get-doctors'), data => {
        const query = field(t('search'), 'query', { type: 'search', placeholder: t('searchDoctor'), maxLength: 100 });
        const city = select(t('city'), 'city', [['', t('allCities')], ...[...new Set(data.doctors.map(d => d.city).filter(Boolean))].map(x => [x, x])]);
        const spec = select(t('spec'), 'spec', [['', t('allSpecs')], ...[...new Set(data.doctors.map(d => d.spec).filter(Boolean))].map(x => [x, x])]);
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
export function clinics(ctx, root) {
    const city = select(t('city'), 'city', cities);
    const body = el('section');
    root.append(city, body);
    let version = 0, destroyMap = () => {};
    ctx.cleanup(() => destroyMap());
    const refresh = () => {
        destroyMap();
        const current = ++version;
        const local = { ...ctx, alive: () => ctx.alive() && current === version };
        load(local, body, () => ctx.api.request('clinics?city=' + city.querySelector('select').value), data => {
            const results = el('div', { class: 'clinic-list' });
            const mapNode = el('div', { class: 'map', 'aria-label': t('map'), hidden: true });
            const mapMessage = el('p', { class: 'muted', role: 'status' });
            const actions = el('div', { class: 'toolbar' });
            let map, L, marker;
            const showList = button(t('list'), () => { results.hidden = false; mapNode.hidden = true; }, 'list');
            const showMap = button(t('map'), async () => {
                results.hidden = true; mapNode.hidden = false;
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
                        .addTo(map).bindPopup(el('div', {}, el('strong', { text: language === 'kk' ? clinic.nameKk || clinic.name : clinic.name }), el('p', { text: clinic.address }))));
                    map.invalidateSize();
                } catch { mapMessage.textContent = t('mapError'); results.hidden = false; }
                finally { showMap.disabled = false; }
            }, 'map');
            const locate = button(t('location'), () => {
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
            results.append(...[listOrEmpty(data.clinics, clinic => el('article', { class: 'record' }, el('h3', { text: language === 'kk' ? clinic.nameKk || clinic.name : clinic.name }),
                detail(t('address'), clinic.address), detail(t('phone'), clinic.phone), detail(t('hours'), clinic.openingHours), externalLink(t('website'), clinic.website)), t('noClinics'))].flat());
            actions.append(showList, showMap, locate);
            return el('div', {}, actions, notice(t('locationPrivacy')), mapMessage, mapNode, results,
                el('p', { class: 'attribution' }, externalLink('© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright'), ' · ', localeDate(data.fetchedAt, true)));
        });
    };
    city.addEventListener('change', refresh); refresh();
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
        const messages = el('div', { class: 'messages', role: 'log', 'aria-label': t('chat'), 'aria-live': 'polite' });
        const advisory = notice(t('aiNotice'));
        const consent = field(t('aiConsent'), 'aiConsent', { type: 'checkbox', checked: Boolean(ctx.sessionState.aiConsent) });
        consent.classList.add('checkbox-field');
        consent.addEventListener('change', event => { ctx.sessionState.aiConsent = event.target.checked; });
        const privacy = el('div', {}, notice(t('aiPrivacy')), consent);
        let version = 0;
        const reload = () => {
            const receiver = peer.querySelector('select').value;
            advisory.hidden = receiver !== 'support';
            privacy.hidden = receiver !== 'support';
            const current = ++version;
            const local = { ...ctx, alive: () => ctx.alive() && version === current };
            return load(local, messages, () => ctx.api.request('chat', { action: 'get', sender: ctx.user.iin, receiver }), data => {
                queueMicrotask(() => { if (local.alive()) messages.scrollTop = messages.scrollHeight; });
                return listOrEmpty(data.messages, message => el('article', { class: 'message ' + (message.sender === ctx.user.iin ? 'sent' : 'received') }, el('p', { class: 'prewrap', text: message.text }), el('time', { class: 'muted', text: localeDate(message.created_at, true) })), t('empty'));
            });
        };
        const composer = form(ctx, [field(t('message'), 'text', { multiline: true, required: true, maxLength: 8000, rows: 3 })], async (data, node) => {
            const receiver = peer.querySelector('select').value;
            if (receiver === 'support' && !ctx.sessionState.aiConsent) validation(t('aiConsent'));
            peer.querySelector('select').disabled = true;
            try {
                await ctx.api.request(receiver === 'support' ? 'ai-chat' : 'chat', { action: 'send', sender: ctx.user.iin, receiver, text: data.text, ...(receiver === 'support' ? { aiConsent: true, aiConsentVersion: 'google-gemini-v2' } : {}) }, { write: true });
                if (ctx.alive()) { node.reset(); await reload(); }
            } finally { peer.querySelector('select').disabled = false; }
        }, t('send'));
        peer.addEventListener('change', () => { composer.reset(); reload(); });
        reload();
        return el('div', { class: 'chat-workspace' }, peer, advisory, privacy, button(t('refresh'), reload, 'refresh-cw', 'text-button'), messages, composer);
    });
}
