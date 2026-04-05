import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });

    const sql = neon(process.env.DATABASE_URL);

    try {
        // 1. Убеждаемся, что колонка существует
        await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS doctor_iin VARCHAR(12);`;
        
        // 2. Делаем doctor_id необязательным (теперь он может быть NULL)
        await sql`ALTER TABLE appointments ALTER COLUMN doctor_id DROP NOT NULL;`;

        // 3. Делаем doctor_iin обязательным (NOT NULL)
        // Сначала проставим временное значение для старых записей, где ИИН был пуст
        await sql`UPDATE appointments SET doctor_iin = '000000000000' WHERE doctor_iin IS NULL;`;
        await sql`ALTER TABLE appointments ALTER COLUMN doctor_iin SET NOT NULL;`;

        const data = await request.json();
        const { action, patientIin, doctorIin, date, time, type, message, appointmentId, treatment, diagnosis, notes, doctorEmail, analysis } = data;

        // --- СОЗДАНИЕ ЗАПИСИ ---
        if (action === 'book') {
            // Валидация на стороне сервера
            if (!doctorIin || doctorIin.length !== 12) {
                return new Response(JSON.stringify({ error: "Ошибка: ИИН врача обязателен и должен состоять из 12 цифр." }), { status: 400 });
            }

            const result = await sql`
                INSERT INTO appointments (patient_iin, doctor_iin, date, time, type, message, status)
                VALUES (${patientIin}, ${doctorIin}, ${date}, ${time}, ${type}, ${message}, 'upcoming')
                RETURNING id;
            `;
            return new Response(JSON.stringify({ message: "✅ Запись подтверждена!", id: result[0].id }), { status: 200 });
        }

        // --- ПОЛУЧЕНИЕ ЗАПИСЕЙ ВРАЧА ---
        if (action === 'get_all_for_doctor') {
            if (!doctorIin) return new Response(JSON.stringify({ error: "Не указан ИИН врача" }), { status: 400 });

            const result = await sql`
                SELECT a.*, u.name as patient_name 
                FROM appointments a 
                LEFT JOIN users u ON a.patient_iin = u.iin
                WHERE a.doctor_iin = ${doctorIin}
                ORDER BY a.date ASC, a.time ASC;
            `;
            return new Response(JSON.stringify({ appointments: result }), { status: 200 });
        }

        // --- ПОЛУЧЕНИЕ ЗАПИСЕЙ ПАЦИЕНТА ---
        if (action === 'get') {
            const result = await sql`SELECT * FROM appointments WHERE patient_iin = ${patientIin} ORDER BY date ASC, time ASC;`;
            return new Response(JSON.stringify({ appointments: result }), { status: 200 });
        }

        // --- ЗАВЕРШЕНИЕ ПРИЕМА ---
        if (action === 'complete') {
            await sql`
                UPDATE appointments 
                SET diagnosis = ${diagnosis}, notes = ${notes}, treatment = ${treatment}, status = 'completed' 
                WHERE id = ${appointmentId}
            `;
            
            if (analysis && analysis.type) {
                await sql`
                    INSERT INTO analyses (patient_iin, doctor_email, type, date, results, overall_status)
                    VALUES (${patientIin}, ${doctorEmail}, ${analysis.type}, ${analysis.date}, ${JSON.stringify(analysis.results)}, ${analysis.overallStatus})
                `;
            }
            return new Response(JSON.stringify({ message: "Прием успешно завершен!" }), { status: 200 });
        }

        // --- ОТМЕНА ЗАПИСИ ---
        if (action === 'cancel') {
            await sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${appointmentId}`;
            return new Response(JSON.stringify({ message: "Запись отменена" }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: "Неизвестное действие" }), { status: 400 });

    } catch (error) {
        console.error("Database Error:", error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}