// Keep the legacy route inert. Migrations and seeding must never be public HTTP operations.
export default async function handler() {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}
