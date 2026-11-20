import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { publicAssets } from '../scripts/public-assets.mjs';
import { canAccess, createApi } from '../web/api.mjs';
import { headingDate, localeDate, setLanguage } from '../web/i18n.mjs';

let server, browser, base;
const allowed = new Set(publicAssets.map(([, path]) => '/' + path));
const root = new URL('../public/', import.meta.url);
let browserSetup;
function prepareBrowser() {
    if (!browserSetup) browserSetup = startBrowser();
    return browserSetup;
}
async function startBrowser() {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: new URL('../', import.meta.url), windowsHide: true });
    server = createServer(async (request, response) => {
        const path = new URL(request.url, 'http://localhost').pathname;
        const file = path === '/' ? '/index.html' : path;
        if (!allowed.has(file)) { response.writeHead(404).end(); return; }
        try {
            const type = file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
            response.writeHead(200, { 'Content-Type': type }); response.end(await readFile(new URL(file.slice(1), root)));
        } catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true,
        ...(process.env.QAMQOR_TEST_BROWSER ? { executablePath: process.env.QAMQOR_TEST_BROWSER } :
            process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
        args: ['--disable-gpu', '--renderer-process-limit=1'] });
    await mkdir(new URL('../verification/2026-09-25', import.meta.url), { recursive: true });
    await mkdir(new URL('../verification/2026-11-08', import.meta.url), { recursive: true });
}
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function pageFor(t, role = null, viewport = { width: 390, height: 844 }, preferredLanguage = 'ru') {
    await prepareBrowser();
    const context = await browser.newContext({ viewport });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.addInitScript(locale => {
        if (locale && localStorage.getItem('qamqor.language') === null) localStorage.setItem('qamqor.language', locale);
    }, preferredLanguage);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    const user = { id: 1, name: 'Тестовый пользователь', email: 'fixture@example.invalid', iin: '000000000001', role };
    let recoveryStatus = 'pending';
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) return route.abort();
        if (!url.pathname.startsWith('/.netlify/functions/')) return route.continue();
        const endpoint = url.pathname.split('/').at(-1);
        const data = route.request().postDataJSON() ?? {};
        requests.push({ endpoint, data });
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (endpoint === 'session') return role ? json({ user }) : json({ error: 'Unauthorized' }, 401);
        if (endpoint === 'password-recovery') {
            if (data.action === 'request') return json({ status: 'pending' }, 202);
            if (data.action === 'status') return json({ status: recoveryStatus });
            return json({ status: 'consumed' });
        }
        if (endpoint === 'get-doctors') return json({ doctors: [] });
        if (endpoint === 'appointments') return json({ appointments: [] });
        if (endpoint === 'get-analyses') return json({ analyses: [] });
        if (endpoint === 'prescriptions') return json({ prescriptions: [] });
        if (endpoint === 'ai-chat') return json({ reply: 'Synthetic answer' });
        if (endpoint === 'chat') return json({ messages: [{ id: 1, sender: 'support', text: '<img src=x onerror=window.injected=1><script>window.injected=1</script>', created_at: '2026-09-25T10:00:00Z' }] });
        if (endpoint === 'admin') {
            if (data.action === 'recovery_requests') return json({ requests: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Тестовый пациент', email: 'patient@example.invalid', created_at: '2026-09-25T10:00:00Z' }], total: 1, page: 1, pageSize: 30 });
            if (data.action === 'audit') return json({ events: [], total: 0, page: 1, pageSize: 30 });
            if (data.action === 'review_recovery') return json({ message: 'Saved' });
            return json({ users: [], total: 0, totalAppointments: 0, page: 1, pageSize: 30 });
        }
        return json({ error: 'Unavailable fixture' }, 503);
    });
    await page.goto(base);
    await page.locator('#app[aria-busy=false]').waitFor();
    return { page, requests, errors, approve: () => { recoveryStatus = 'approved'; } };
}
test('recovery opens new-password form only after status approval; never saves tokens in localStorage', async t => {
    const { page, requests, errors, approve } = await pageFor(t);
    await page.getByRole('button', { name: 'Забыли пароль?' }).click();
    await page.getByLabel('Электронная почта', { exact: true }).fill('fixture@example.invalid');
    await page.getByLabel('ИИН', { exact: true }).fill('000000000001');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.getByText('Если данные совпадают', { exact: false }).waitFor();
    assert.equal(await page.locator('input[name=newPassword]').count(), 0);
    await page.getByRole('button', { name: 'Новый запрос', exact: true }).click();
    await page.getByLabel('Электронная почта', { exact: true }).fill('fixture@example.invalid');
    await page.getByLabel('ИИН', { exact: true }).fill('000000000001');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.getByText('Если данные совпадают', { exact: false }).waitFor();
    approve();
    await page.getByRole('button', { name: 'Проверить решение' }).click();
    await page.getByLabel('Новый пароль', { exact: true }).fill('FixturePassword12');
    await page.getByLabel('Повторите пароль', { exact: true }).fill('FixturePassword12');
    await page.screenshot({ path: new URL('../verification/2026-09-25/recovery-mobile.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('Пароль изменён. Войдите с новым паролем.', { exact: true }).waitFor();
    assert.equal(requests.filter(r => r.endpoint === 'password-recovery' && r.data.action === 'complete').length, 1);
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ['qamqor.language']);
    assert.deepEqual(errors, []);
});
test('administrator recovery review requires acknowledgement and password', async t => {
    const { page, requests, errors } = await pageFor(t, 'admin', { width: 1280, height: 900 });
    await page.locator('.services a[href="#recovery"]').click();
    await page.getByRole('button', { name: 'Одобрить', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Я проверил обращение', { exact: false }).check();
    await dialog.getByLabel('Текущий пароль', { exact: true }).fill('FixtureAdmin12');
    await dialog.getByRole('button', { name: 'Подтвердить' }).click();
    await page.waitForFunction(() => document.querySelector('dialog') === null);
    const review = requests.find(r => r.data.action === 'review_recovery');
    assert.equal(review.data.approve, true); assert.equal(review.data.acknowledgeRisk, true);
    assert.equal(review.data.newPassword, undefined);
    assert.deepEqual(errors, []);
});
test('patient navigation, XSS-safe messages, dark theme and Kazakh layout work on mobile', async t => {
    const { page, errors } = await pageFor(t, 'patient');
    assert.equal(await page.locator('.services a').count(), 8);
    await page.screenshot({ path: new URL('../verification/2026-09-25/home-mobile.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
    await page.locator('.bottomnav a[href="#chat"]').click();
    await page.getByText('<img src=x onerror=window.injected=1>', { exact: false }).waitFor();
    assert.equal(await page.locator('.messages img,.messages script').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.goBack();
    await page.locator('.services').waitFor();
    await page.getByRole('button', { name: 'Тёмная тема', exact: true }).click();
    await page.getByRole('button', { name: 'ҚАЗ', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'kk');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('img').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0)), true);
    await page.screenshot({ path: new URL('../verification/2026-09-25/home-kk-dark.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
    assert.deepEqual(errors, []);
});
test('route guards exclude privileged screens from patients and doctor writes from administrators', () => {
    assert.equal(canAccess('patient', 'recovery'), false);
    assert.equal(canAccess('doctor', 'users'), false);
    assert.equal(canAccess('admin', 'medicines'), false);
    assert.equal(canAccess('admin', 'recovery'), true);
});

test('first visit opens the Kazakh sign-in and an optional introduction; language choice survives reload', async t => {
    const { page } = await pageFor(t, null, { width: 1366, height: 768 }, null);
    assert.equal(await page.locator('html').getAttribute('lang'), 'kk');
    await page.locator('.qw-signin input[name=email]').fill('sample@example.invalid');
    await page.locator('.qw-pager .primary').click();
    assert.equal(await page.locator('.qw-signin input[name=email]').inputValue(), 'sample@example.invalid');
    await page.getByRole('button', { name: 'РУС', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Забыли пароль?' }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'ru');
});

test('Kazakh headings and appointment timestamps use the same Kazakhstan calendar day', () => {
    setLanguage('kk');
    const late = new Date('2026-11-20T19:30:00Z');
    assert.equal(headingDate(late), 'сенбі, 21 қараша');
    assert.equal(localeDate(late, true), '21 қараша 2026 ж., 00:30');
});

test('the same patient menu reflows across phone, tablet, laptop and desktop', async t => {
    const { page, errors } = await pageFor(t, 'patient');
    for (const width of [320,390,768,1024,1366,1920]) {
        await page.setViewportSize({ width, height: 900 });
        const dock = page.locator('.bottomnav');
        const rail = page.locator('.sidebar');
        assert.equal(await dock.isVisible(), width <= 760);
        assert.equal(await rail.isVisible(), width > 760);
        await page.locator('.home-shortcuts').waitFor();
        const rows = await page.locator('.home-shortcut').evaluateAll(items => {
            const counts = new Map();
            for (const item of items) { const y = item.offsetTop; counts.set(y, (counts.get(y) || 0) + 1); }
            return [...counts.values()];
        });
        assert.deepEqual(rows, [4,4], String(width));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(width));
        const menu = width <= 760 ? dock : rail;
        await menu.locator('a[href="#services"]').click();
        await page.locator('[data-route="services"] .service-rows a[href="#analyses"]').click();
        await page.locator('[data-route="analyses"] .empty').waitFor();
        await page.locator('.account-link').click();
        await page.locator('[data-route="profile"]').waitFor();
        await menu.locator('a[href="#home"]').click();
        await page.locator('.home-shortcuts').waitFor();
    }
    assert.deepEqual(errors, []);
});

for (const locale of [
    { language: 'ru', message: 'Сообщение', send: 'Отправить',
        consent: 'Я согласен на обработку Google Gemini текущего сообщения и до 10 предыдущих сообщений этого чата.',
        privacy: /Бесплатный Google Gemini: сейчас только демо\. Не отправляйте реальные персональные или медицинские данные\./ },
    { language: 'kk', message: 'Хабарлама', send: 'Жіберу',
        consent: 'Осы хабарламаны және осы чаттың алдыңғы 10 хабарламасына дейін Google Gemini өңдеуіне келісемін.',
        privacy: /Тегін Google Gemini: қазір тек демо\. Нақты жеке немесе медициналық деректерді жібермеңіз\./ },
]) {
    test(`${locale.language} chat requires Google Gemini consent and sends its version; consent resets on reload`, async t => {
        const { page, requests, errors } = await pageFor(t, 'patient');
        if (locale.language === 'kk') await page.getByRole('button', { name: 'ҚАЗ', exact: true }).click();
        await page.locator('.bottomnav a[href="#chat"]').click();
        const consent = page.getByRole('checkbox', { name: locale.consent, exact: true });
        await consent.waitFor();
        await page.getByText(locale.privacy).waitFor();
        await page.screenshot({ path: new URL(`../verification/2026-11-08/gemini-consent${locale.language === 'kk' ? '-kk' : ''}-mobile.png`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
        assert.equal(await consent.isChecked(), false);
        const draft = page.getByLabel(locale.message, { exact: true });
        await draft.fill('Synthetic question');
        await page.getByRole('button', { name: locale.send, exact: true }).click();
        await page.getByRole('alert').filter({ hasText: /Google Gemini/ }).waitFor();
        assert.equal(requests.filter(r => r.data.action === 'send').length, 0);
        assert.equal(await draft.inputValue(), 'Synthetic question');
        await consent.check();
        await page.getByRole('button', { name: locale.send, exact: true }).click();
        await page.waitForFunction(() => document.querySelector('textarea[name=text]').value === '');
        const sends = requests.filter(r => r.data.action === 'send');
        assert.equal(sends.length, 1);
        const [sent] = sends;
        assert.equal(sent.endpoint, 'ai-chat');
        assert.equal(sent.data.receiver, 'support');
        assert.equal(sent.data.text, 'Synthetic question');
        assert.equal(sent.data.aiConsent, true);
        assert.equal(sent.data.aiConsentVersion, 'google-gemini-v2');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.reload();
        await consent.waitFor();
        assert.equal(await consent.isChecked(), false);
        assert.deepEqual(errors, []);
    });
}

test('Google Gemini rate-limit feedback preserves the website draft without automatic retransmission or fallback', async t => {
    const { page, requests, errors } = await pageFor(t, 'patient');
    let sends = 0;
    await page.route('**/.netlify/functions/ai-chat', async route => {
        if (route.request().postDataJSON()?.action !== 'send') return route.fallback();
        sends++;
        return route.fulfill({ status: 429, contentType: 'application/json',
            headers: { 'Retry-After': '60' }, body: JSON.stringify({ error: 'Rate limit' }) });
    });
    await page.locator('.bottomnav a[href="#chat"]').click();
    await page.getByRole('checkbox', { name: /Google Gemini/ }).check();
    const draft = page.getByLabel('Сообщение', { exact: true });
    await draft.fill('Synthetic question');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await draft.inputValue(), 'Synthetic question');
    assert.equal(await page.getByRole('button', { name: 'Отправить', exact: true }).isEnabled(), true);
    assert.equal(sends, 1);
    assert.equal(requests.filter(r => r.data.action === 'send').length, 0);
    assert.deepEqual(errors, []);
});

test('upgrade removes only legacy identity/notification caches and never trusts a cached administrator role', async t => {
    const { page } = await pageFor(t);
    await page.evaluate(() => {
        localStorage.setItem('qamqorAccount', JSON.stringify({ role: 'admin', email: 'fixture@example.invalid' }));
        localStorage.setItem('qamqorSession', 'active');
        localStorage.setItem('qamqorSavedEmail', 'fixture@example.invalid');
        localStorage.setItem('qamqorNotifs_000000000001', '["synthetic private reminder"]');
        localStorage.setItem('qamqor.theme', 'dark');
        localStorage.setItem('unrelated-preference', 'keep');
    });
    await page.reload();
    await page.getByRole('button', { name: 'Забыли пароль?' }).waitFor();
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).sort()), ['qamqor.language', 'qamqor.theme', 'unrelated-preference']);
    assert.equal(await page.locator('.sidebar').count(), 0);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
});
test('duplicate write attempts are rejected while the first request is pending', async () => {
    let release;
    const api = createApi(() => new Promise(resolve => { release = () => resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } })); }));
    const first = api.request('password-recovery', { action: 'request' }, { write: true });
    await assert.rejects(api.request('password-recovery', { action: 'request' }, { write: true }), error => error.status === 409);
    release(); await first;
});
