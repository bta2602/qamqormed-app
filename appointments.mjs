import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });

    const sql = neon();

    try {
        // Добавляем новые колонки для полноценной медкарты, если их еще нет
        await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS treatment TEXT;`;
        await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS diagnosis VARCHAR(255);`;
        await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes TEXT;`;

        const data = await request.json();
        const { action, patientIin, doctorId, date, time, type, message, appointmentId, treatment, diagnosis, notes, doctorEmail, analysis } = data;

        // 1. СОЗДАНИЕ ЗАПИСИ (Пациент)
        if (action === 'book') {
            const result = await sql`
                INSERT INTO appointments (patient_iin, doctor_id, date, time, type, message, status)
                VALUES (${patientIin}, ${doctorId}, ${date}, ${time}, ${type}, ${message}, 'upcoming')
                RETURNING id;
            `;
            return new Response(JSON.stringify({ message: "✅ Запись подтверждена!", id: result[0].id }), { status: 200 });
        }

        // 2. ПОЛУЧЕНИЕ ЗАПИСЕЙ ПАЦИЕНТА 
        if (action === 'get') {
            const result = await sql`SELECT * FROM appointments WHERE patient_iin = ${patientIin} ORDER BY date ASC, time ASC;`;
            return new Response(JSON.stringify({ appointments: result }), { status: 200 });
        }

        // 3. ПОЛУЧЕНИЕ ЗАПИСЕЙ ВРАЧА
        if (action === 'get_all_for_doctor') {
            const result = await sql`
                SELECT a.*, u.name as patient_name 
                FROM appointments a 
                LEFT JOIN users u ON a.patient_iin = u.iin
                WHERE a.doctor_id = ${doctorId} OR a.doctor_iin = ${doctorId}
                ORDER BY a.date ASC, a.time ASC;
            `;
            return new Response(JSON.stringify({ appointments: result }), { status: 200 });
        }

        // 4. 🔥 СУПЕР-ФУНКЦИЯ: ПРОВЕСТИ ПРИЕМ (Диагноз + Лечение + Анализы)
        if (action === 'complete') {
            // Обновляем прием
            await sql`
                UPDATE appointments 
                SET diagnosis = ${diagnosis}, notes = ${notes}, treatment = ${treatment}, status = 'completed' 
                WHERE id = ${appointmentId}
            `;
            
            // Если врач прямо на приеме вбил анализы — сохраняем их в таблицу analyses
            if (analysis && analysis.type) {
                await sql`
                    INSERT INTO analyses (patient_iin, doctor_email, type, date, results, overall_status)
                    VALUES (${patientIin}, ${doctorEmail}, ${analysis.type}, ${analysis.date}, ${JSON.stringify(analysis.results)}, ${analysis.overallStatus})
                `;
            }

            return new Response(JSON.stringify({ message: "Прием успешно завершен!" }), { status: 200 });
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