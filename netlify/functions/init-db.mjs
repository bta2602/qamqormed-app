import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    // Подключаемся к базе (Netlify сам подставит пароль из настроек)
    const sql = neon();

    try {
        // 1. Создаем таблицу пользователей
        await sql`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(100) NOT NULL,
                iin VARCHAR(12) UNIQUE,
                role VARCHAR(20) DEFAULT 'patient',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;

        // 2. Создаем таблицу анализов
        await sql`
            CREATE TABLE IF NOT EXISTS analyses (
                id SERIAL PRIMARY KEY,
                patient_iin VARCHAR(12) NOT NULL,
                doctor_email VARCHAR(100),
                type VARCHAR(100) NOT NULL,
                date VARCHAR(20),
                results JSONB NOT NULL,
                overall_status VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;

        // 3. Сразу создаем аккаунт Главного Врача (чтобы нам не пришлось делать это вручную)
        await sql`
            INSERT INTO users (name, email, password, role)
            VALUES ('Главный Врач', 'doctor123@qamqormed.gov.kz', 'Doctor123', 'doctor')
            ON CONFLICT (email) DO NOTHING
        `;

        return new Response(JSON.stringify({ 
            message: "✅ Ура! Таблицы успешно созданы, база готова!" 
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

}
