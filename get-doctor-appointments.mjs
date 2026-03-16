import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    // Разрешаем только POST-запросы
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
    }

    const sql = neon(process.env.DATABASE_URL);

    try {
        const data = await request.json();
        const { doctor_iin } = data;

        if (!doctor_iin) {
            return new Response(JSON.stringify({ error: 'Не указан ИИН врача' }), { status: 400 });
        }

        // 🔥 МАГИЯ SQL: Достаем записи и сразу "приклеиваем" к ним имена пациентов
        const appointments = await sql`
            SELECT 
                a.id, 
                a.date, 
                a.time, 
                a.status, 
                u.name AS patient_name 
            FROM appointments a
            JOIN users u ON a.patient_iin = u.iin
            WHERE a.doctor_iin = ${doctor_iin}
            ORDER BY a.date ASC, a.time ASC;
        `;

        return new Response(JSON.stringify({ appointments }), { 
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error("Ошибка при получении записей врача:", error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}