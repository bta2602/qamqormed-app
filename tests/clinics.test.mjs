import test from 'node:test';
import assert from 'node:assert/strict';
import clinics, { createClinicLookup, mapClinics } from '../netlify/functions/clinics.mjs';

const fixture = { elements: [
    { type: 'node', id: 1, lat: 51.1, lon: 71.4, tags: { name: 'Test clinic', 'addr:street': 'Test street' } },
    { type: 'way', id: 2, center: { lat: 51.1, lon: 71.4 }, tags: { name: 'Test clinic' } },
] };
const request = city => new Request('https://qamqor-med.netlify.app/.netlify/functions/clinics?city=' + city);

test('clinic handler works without a database and rejects prototype/injection city keys', async () => {
    let count = 0;
    const context = { testFetch: async () => { count++; return Response.json(fixture); } };
    assert.equal((await clinics(request('astana'), context)).status, 200);
    for (const city of ['__proto__', 'constructor', 'toString', '', 'astana%3Bnode%3B']) {
        assert.equal((await clinics(request(city), context)).status, 400);
    }
    assert.equal(count, 1);
});

test('clinic successes are coalesced and cached per city with original retrieval time', async () => {
    let now = Date.parse('2026-09-24T12:00:00Z'), count = 0;
    const lookup = createClinicLookup(async (url, init) => {
        count++;
        assert.equal(url, 'https://overpass-api.de/api/interpreter');
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.match(init.body.get('data'), /out center tags;/);
        return Response.json(fixture);
    }, () => now);
    const firstPending = lookup('astana');
    const secondPending = lookup('astana');
    const first = await firstPending, second = await secondPending;
    assert.equal(count, 1);
    const body = await first.json();
    assert.equal(body.clinics.length, 1);
    assert.deepEqual(await second.json(), body);
    assert.match(first.headers.get('cache-control'), /public/);
    now += 60000;
    assert.deepEqual(await (await lookup('astana')).json(), body);
    assert.equal(count, 1);
    await lookup('almaty');
    assert.equal(count, 2);
    now += 300000;
    assert.notEqual((await (await lookup('astana')).json()).fetchedAt, body.fetchedAt);
    assert.equal(count, 3);
});

test('upstream refusals are explicit, cooled down, never retried or routed around', async () => {
    let now = Date.parse('2026-09-24T12:00:00Z'), count = 0;
    const lookup = createClinicLookup(async () => {
        count++;
        return new Response('<html>Not Acceptable</html>', { status: 406, headers: { 'Content-Type': 'text/html' } });
    }, () => now);
    const response = await lookup('astana');
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'upstream_http_error');
    assert.equal(body.upstreamStatus, 406);
    assert.equal(body.clinics, undefined);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('retry-after'), '60');
    now += 10000;
    assert.equal((await lookup('astana')).headers.get('retry-after'), '50');
    assert.equal(count, 1);
    now += 50000;
    await lookup('astana');
    assert.equal(count, 2);
});

test('upstream rate limits respect numeric and HTTP-date Retry-After', async () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    for (const value of ['120', new Date(now + 120000).toUTCString()]) {
        const lookup = createClinicLookup(async () => new Response('', { status: 429, headers: { 'Retry-After': value } }), () => now);
        const response = await lookup('astana');
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('retry-after'), '120');
        assert.equal((await response.json()).upstreamStatus, 429);
    }
});

test('invalid, partial, network and timeout results never become empty successful catalogues', async () => {
    const cases = [
        [async () => new Response('<html>Error</html>'), 'upstream_invalid_json'],
        [async () => Response.json({ elements: fixture.elements, remark: 'Query timed out' }), 'upstream_incomplete'],
        [async () => Response.json({}), 'upstream_incomplete'],
        [async () => Response.json(null), 'upstream_incomplete'],
        [async () => { throw new TypeError('network failure'); }, 'upstream_network_error'],
        [async () => { throw new DOMException('Timeout', 'TimeoutError'); }, 'upstream_timeout'],
    ];
    for (const [fetcher, code] of cases) {
        const response = await createClinicLookup(fetcher)('astana');
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.code, code);
        assert.equal(body.clinics, undefined);
    }
});

test('empty complete upstream results are honest; mapper rejects invalid locations and unsafe links', async () => {
    const response = await createClinicLookup(async () => Response.json({ elements: [] }))('astana');
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).clinics, []);
    const rows = mapClinics([null, {},
        { ...fixture.elements[0], id: 3, lat: 91 },
        { ...fixture.elements[0], id: 4, tags: { name: {} } },
        { ...fixture.elements[0], id: 5, tags: { name: '   ', 'name:kk': 'Test', website: 'javascript:alert(1)' } },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Test');
    assert.equal(rows[0].website, '');
});

test('an explicitly configured HTTPS Overpass instance is the sole upstream, including on refusal', async () => {
    const previous = process.env.OVERPASS_API_URL;
    const configured = 'https://owned-overpass.example.invalid:8443/api/interpreter';
    try {
        process.env.OVERPASS_API_URL = configured;
        const requests = [];
        const lookup = createClinicLookup(async (url, options) => {
            requests.push(url);
            assert.equal(options.redirect, 'error');
            return new Response('', { status: 406 });
        });
        const response = await lookup('astana');
        assert.equal(response.status, 503);
        assert.equal((await response.json()).upstreamStatus, 406);
        assert.deepEqual(requests, [configured]);
    } finally {
        if (previous === undefined) delete process.env.OVERPASS_API_URL;
        else process.env.OVERPASS_API_URL = previous;
    }
});

test('invalid or non-HTTPS Overpass configuration fails without fetching or falling back', async () => {
    for (const url of ['', 'not-a-url', 'http://example.invalid/api/interpreter', 'ftp://example.invalid/',
        'https://user:password@example.invalid/api/interpreter', 'https://example.invalid/api/interpreter#fragment']) {
        let fetched = false;
        const lookup = createClinicLookup(async () => { fetched = true; return Response.json(fixture); }, Date.now, url);
        const response = await lookup('astana');
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, 'upstream_configuration_error');
        assert.equal(fetched, false);
    }
});
