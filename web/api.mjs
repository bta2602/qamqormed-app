export class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
export function createApi(fetcher = fetch) {
    let controller = new AbortController();
    let generation = 0;
    const writes = new Set();
    return {
        get signal() { return controller.signal; },
        get generation() { return generation; },
        reset() { controller.abort(); controller = new AbortController(); generation++; },
        async request(endpoint, data, { write = false } = {}) {
            if (!/^[a-z-]+(?:\?city=[a-z]+)?$/.test(endpoint)) throw new Error('Invalid API endpoint');
            const signal = controller.signal;
            const key = endpoint + ':' + (data?.action ?? '') + ':' + (data?.id ?? data?.appointmentId ?? data?.targetId ?? '');
            if (write && writes.has(key)) throw new ApiError(409, 'Duplicate request');
            if (write) writes.add(key);
            const timeout = new AbortController();
            const timer = setTimeout(() => timeout.abort(), 35000);
            try {
                const response = await fetcher('/.netlify/functions/' + endpoint, {
                    method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
                    redirect: 'error', signal: AbortSignal.any([signal, timeout.signal]),
                    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
                });
                signal.throwIfAborted();
                let body;
                try { body = await response.json(); } catch { throw new ApiError(502, 'Invalid response'); }
                signal.throwIfAborted();
                if (!response.ok) throw new ApiError(response.status, typeof body.error === 'string' ? body.error.slice(0, 500) : '');
                return body;
            } finally {
                clearTimeout(timer);
                if (write) writes.delete(key);
            }
        },
    };
}
export const roleRoutes = {
    patient: ['home', 'doctors', 'appointments', 'analyses', 'medicines', 'clinics', 'chat', 'profile'],
    doctor: ['home', 'appointments', 'patients', 'analyses', 'medicines', 'chat', 'profile'],
    admin: ['home', 'users', 'recovery', 'audit', 'profile'],
};
export function canAccess(role, route) { return roleRoutes[role]?.includes(route) ?? false; }
export function patientsFrom(appointments) {
    return [...new Map(appointments.filter(a => ['upcoming', 'completed'].includes(a.status))
        .map(a => [a.patient_iin, { iin: a.patient_iin, name: a.patient_name || a.patient_iin }])).values()];
}
