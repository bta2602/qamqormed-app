import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Метод не поддерживается' }), { status: 405 });

    try {
        const data = await request.json();
        // Принимаем данные от телефона
        const { patientIIN, doctorEmail, type, date, results, overallStatus } = data;
        const sql = neon();

        // Записываем в базу данных
        const result = await sql`
            INSERT INTO analyses (patient_iin, doctor_email, type, date, results, overall_status)
            VALUES (${patientIIN}, ${doctorEmail || null}, ${type}, ${date}, ${JSON.stringify(results)}, ${overallStatus})
            RETURNING id;
        `;

        return new Response(JSON.stringify({ message: "✅ Анализ сохранен в базу!", id: result[0].id }), {
            status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}
