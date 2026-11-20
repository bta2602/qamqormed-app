// Local design preview only. No production credentials, database or write endpoints.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { publicAssets } from './public-assets.mjs';

const port = Number(process.argv[2] || 4780);
const root = new URL('../public/', import.meta.url);
const files = new Set(publicAssets.map(([, path]) => '/' + path));
const types = { html: 'text/html; charset=utf-8', mjs: 'text/javascript', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', webp: 'image/webp', png: 'image/png', ttf: 'font/ttf' };
const names = { patient: 'Айдана', doctor: 'Дәрігер', admin: 'Әкімші' };
const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const doctors = [{ iin: '000000000002', name: 'А. Нұрлан', city: 'Астана', spec: 'Терапевт' }];
const appointments = [{ id: 1, patient_name: names.patient, patient_iin: '000000000001', doctor_iin: doctors[0].iin,
    status: 'upcoming', date: day, time: '10:30:00', type: 'online' }];

createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const path = new URL(req.url, 'http://localhost').pathname;
    const role = /(?:^|; )qm_preview=(patient|doctor|admin)(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const json = (data, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    try {
        const target = /^\/preview\/(patient|doctor|admin|welcome)$/.exec(path);
        if (target && req.method === 'GET') {
            res.writeHead(303, { Location: '/', 'Set-Cookie': 'qm_preview=' + target[1] + '; HttpOnly; SameSite=Strict; Path=/' }).end();
            return;
        }
        if (path.startsWith('/.netlify/functions/')) {
            const key = path.split('/').at(-1);
            if (key === 'session') return role ? json({ user: { role, name: names[role], iin: '000000000001', email: 'preview@example.invalid' } }) : json({}, 401);
            if (key === 'logout') { res.setHeader('Set-Cookie', 'qm_preview=; Max-Age=0; Path=/; SameSite=Strict'); return json({}); }
            if (!role) return json({}, 503);
            if (key === 'get-doctors') return json({ doctors });
            if (key === 'get-analyses') return json({ analyses: [] });
            if (key === 'clinics') return json({}, 503); // Avoid simulated clinic locations.
            let body = '';
            for await (const chunk of req) {
                if (body.length + chunk.length > 8192) return json({}, 413);
                body += chunk;
            }
            const action = body ? JSON.parse(body).action : '';
            if (key === 'appointments' && ['get', 'get_all_for_doctor'].includes(action)) return json({ appointments });
            if (key === 'prescriptions' && action === 'get') return json({ prescriptions: [] });
            if (key === 'chat' && action === 'get') return json({ messages: [] });
            if (key === 'admin' && role === 'admin' && ['get_all','recovery_requests','identity_requests','audit'].includes(action)) {
                return json({ users: [], requests: [], events: [], page: 1, pageSize: 30, total: 0, totalAppointments: 0 });
            }
            return json({}, 503);
        }
        const file = path === '/' ? '/index.html' : path;
        if (!['GET','HEAD'].includes(req.method) || !files.has(file)) return res.writeHead(404).end();
        const bytes = await readFile(new URL(file.slice(1), root));
        res.writeHead(200, { 'Content-Type': types[file.split('.').at(-1)] || 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : bytes);
    } catch { if (!res.headersSent) json({}, 400); else res.end(); }
}).listen(port, '127.0.0.1', () => console.log('Read-only design preview: http://127.0.0.1:' + port + '/preview/patient'));
