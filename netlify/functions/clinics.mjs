import { endpoint, fail, json } from '../lib/security.mjs';

// Fixed city bounds prevent arbitrary expensive Overpass requests and never include device location.
export const cityBounds = {
    astana: [50.97, 71.18, 51.29, 71.70],
    almaty: [43.07, 76.74, 43.39, 77.15],
    shymkent: [42.16, 69.36, 42.49, 69.81],
    aktau: [43.56, 51.04, 43.81, 51.36],
    zhezkazgan: [47.71, 67.59, 47.91, 67.89],
};
export function mapClinics(elements) {
    const seen = new Set();
    return elements.flatMap(element => {
        if (!element || !['node', 'way', 'relation'].includes(element.type) || !Number.isSafeInteger(element.id) || element.id <= 0) return [];
        const tags = element.tags ?? {};
        const tag = key => typeof tags[key] === 'string' ? tags[key].trim() : '';
        const lat = element.lat ?? element.center?.lat, lon = element.lon ?? element.center?.lon;
        const name = tag('name:ru') || tag('name') || tag('name:kk');
        if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
        const key = name.toLowerCase() + ':' + lat.toFixed(4) + ':' + lon.toFixed(4);
        if (seen.has(key)) return [];
        seen.add(key);
        let website = tag('website') || tag('contact:website');
        try { if (!['https:', 'http:'].includes(new URL(website).protocol)) website = ''; } catch { website = ''; }
        return [{ id: element.type + '/' + element.id, name, nameKk: tag('name:kk') || null,
            latitude: lat, longitude: lon,
            address: tag('addr:full') || [tag('addr:street'), tag('addr:housenumber')].filter(Boolean).join(', '),
            phone: tag('phone') || tag('contact:phone'), website,
            openingHours: tag('opening_hours') }];
    }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export function createClinicLookup(fetcher = fetch, now = Date.now,
    apiUrl = process.env.OVERPASS_API_URL ?? 'https://overpass-api.de/api/interpreter') {
    const cache = new Map(), pending = new Map();
    let upstream;
    try {
        const url = new URL(apiUrl);
        if (/^https:\/\//i.test(apiUrl) && apiUrl === apiUrl.trim() && url.protocol === 'https:' &&
            !url.username && !url.password && !url.hash) upstream = url.href;
    } catch { /* Invalid operator configuration must not fall back to a public instance. */ }
    async function fetchCity(city) {
        const box = cityBounds[city].join(',');
        const query = '[out:json][timeout:20];(nwr["amenity"~"^(clinic|hospital|doctors)$"](' + box + ');nwr["healthcare"~"^(clinic|hospital|centre|doctor)$"](' + box + '););out center tags;';
        const failure = (code, upstreamStatus, retryAfter = 60) => ({ status: 503, retryAfter,
            body: { error: 'Каталог клиник временно недоступен', code, ...(upstreamStatus ? { upstreamStatus } : {}) } });
        if (!upstream) return failure('upstream_configuration_error');
        let response;
        try {
            response = await fetcher(upstream, {
                method: 'POST', signal: AbortSignal.timeout(25000), redirect: 'error',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'QamqorMed/1.0 (+https://qamqor-med.netlify.app)' },
                body: new URLSearchParams({ data: query }),
            });
        } catch (error) {
            return failure(['AbortError', 'TimeoutError'].includes(error.name) ? 'upstream_timeout' : 'upstream_network_error');
        }
        if (!response.ok) {
            const value = response.headers.get('Retry-After');
            const seconds = value && /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now()) / 1000);
            // Do not retry, change identities, or switch providers in response to a refusal.
            await response.body?.cancel();
            return failure('upstream_http_error', response.status, Number.isFinite(seconds) ? Math.max(60, seconds) : 60);
        }
        let body;
        try { body = await response.json(); } catch { return failure('upstream_invalid_json'); }
        if (!body || body.remark || !Array.isArray(body.elements)) return failure('upstream_incomplete');
        return { status: 200, body: { clinics: mapClinics(body.elements), source: 'OpenStreetMap',
            attribution: 'OpenStreetMap contributors', sourceUrl: 'https://www.openstreetmap.org/copyright',
            fetchedAt: new Date(now()).toISOString(), bounds: cityBounds[city] } };
    }
    return async city => {
        if (!Object.hasOwn(cityBounds, city)) fail(400, 'Неизвестный город');
        const previous = cache.get(city);
        let result;
        if (previous && previous.until > now()) {
            result = { ...previous.result, retryAfter: Math.ceil((previous.until - now()) / 1000) };
        } else {
            // Coalesce requests per warm instance; the map is bounded by the city allowlist.
            if (!pending.has(city)) pending.set(city, fetchCity(city).then(value => {
                cache.set(city, { result: value, until: now() + (value.status === 200 ? 300 : value.retryAfter) * 1000 });
                return value;
            }).finally(() => pending.delete(city)));
            result = await pending.get(city);
        }
        return json(result.body, result.status, result.status === 200 ?
            { 'Cache-Control': 'public, max-age=300, s-maxage=3600' } : { 'Retry-After': String(result.retryAfter) });
    };
}
const lookup = createClinicLookup();
export default endpoint('GET', async ({ request, context }) =>
    (context.testClinicLookup ?? (context.testFetch ? createClinicLookup(context.testFetch) : lookup))(
        new URL(request.url).searchParams.get('city')),
{ database: false });
