import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Метод не поддерживается' }), { status: 405 });

    try {
        const data = await request.json();
        const { iin } = data;
        const sql = neon();

        // Достаем все анализы для конкретного ИИН, сортируем по дате (свежие сверху)
        const result = await sql`
            SELECT * FROM analyses 
            WHERE patient_iin = ${iin} 
            ORDER BY created_at DESC
        `;

        return new Response(JSON.stringify({ analyses: result }), {
            status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}
