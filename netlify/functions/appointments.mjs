import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });

    const sql = neon();

    try {
        // Умный ход: добавляем колонку для лечения, если её еще нет!
        await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS treatment TEXT;`;

        const data = await request.json();
        const { action, patientIin, doctorId, date, time, type, message, appointmentId, treatment } = data;

        // 1. СОЗДАНИЕ ЗАПИСИ
        if (action === 'book') {
            const result = await sql`
                INSERT INTO appointments (patient_iin, doctor_id, date, time, type, message, status)
                VALUES (${patientIin}, ${doctorId}, ${date}, ${time}, ${type}, ${message}, 'upcoming')
                RETURNING id;
            `;
            return new Response(JSON.stringify({ message: "✅ Запись подтверждена!", id: result[0].id }), { status: 200 });
        }

        // 2. ПОЛУЧЕНИЕ ЗАПИСЕЙ ПАЦИЕНТА (с лечением)
        if (action === 'get') {
            const result = await sql`
                SELECT * FROM appointments 
                WHERE patient_iin = ${patientIin} 
                ORDER BY date ASC, time ASC;
            `;
            return new Response(JSON.stringify({ appointments: result }), { status: 200 });
        }

        // 3. ПОЛУЧЕНИЕ ВСЕХ ЗАПИСЕЙ ДЛЯ ВРАЧА (подтягиваем ИМЯ пациента из таблицы users)
        if (action === 'get_all_for_doctor') {
            const result = await sql`
                SELECT a.*, u.name as patient_name 
                FROM appointments a 
                LEFT JOIN users u ON a.patient_iin = u.iin
                ORDER BY a.date ASC, a.time ASC;
            `;
            return new Response(JSON.stringify({ appointments: result }), { status: 200 });
        }

        // 4. НАЗНАЧИТЬ ЛЕЧЕНИЕ (НОВАЯ ФУНКЦИЯ)
        if (action === 'add_treatment') {
            await sql`
                UPDATE appointments 
                SET treatment = ${treatment}, status = 'completed' 
                WHERE id = ${appointmentId}
            `;
            return new Response(JSON.stringify({ message: "Лечение назначено" }), { status: 200 });
        }

        // 5. ОТМЕНА ЗАПИСИ
        if (action === 'cancel') {
            await sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${appointmentId}`;
            return new Response(JSON.stringify({ message: "Запись отменена" }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: "Неизвестное действие" }), { status: 400 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}