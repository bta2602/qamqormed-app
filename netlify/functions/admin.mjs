import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });

    const sql = neon();

    try {
        const data = await request.json();
        const { action, adminEmail, iin, email, name, password, role, bloodType, targetIin, spec, city, exp, bio, img, rating } = data;

        // ПРОВЕРКА ПРАВ
        const adminCheck = await sql`SELECT role FROM users WHERE email = ${adminEmail}`;
        if (adminCheck.length === 0 || adminCheck[0].role !== 'admin') {
            return new Response(JSON.stringify({ error: "Отказано в доступе. Вы не администратор." }), { status: 403 });
        }

        // Подготавливаем колонки для врачей (на случай если их еще нет)
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS spec VARCHAR(100) DEFAULT 'Терапевт'`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Астана'`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS exp VARCHAR(50) DEFAULT '5 лет'`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT 'Квалифицированный специалист.'`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS img TEXT`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating NUMERIC(3,1) DEFAULT 5.0`;

        // 1. ПОЛУЧИТЬ ВСЕХ И СТАТИСТИКУ
        if (action === 'get_all') {
            const users = await sql`SELECT name, email, iin, role, blood_type, spec, city, exp, bio, img, rating FROM users ORDER BY role ASC, name ASC`;
            const appts = await sql`SELECT COUNT(*) as total FROM appointments`;
            
            return new Response(JSON.stringify({ 
                users: users, 
                totalAppointments: appts[0].total 
            }), { status: 200 });
        }

        // 2. СОЗДАТЬ
        if (action === 'create') {
            const check = await sql`SELECT iin FROM users WHERE email = ${email} OR iin = ${iin}`;
            if (check.length > 0) return new Response(JSON.stringify({ error: "Email или ИИН уже занят" }), { status: 400 });

            await sql`
                INSERT INTO users (name, email, password, iin, role, blood_type, spec, city, exp, bio, img, rating) 
                VALUES (${name}, ${email}, ${password}, ${iin}, ${role}, ${bloodType || 'Неизвестно'}, ${spec || ''}, ${city || ''}, ${exp || ''}, ${bio || ''}, ${img || ''}, ${rating || 5.0})
            `;
            return new Response(JSON.stringify({ message: "Учетная запись создана" }), { status: 200 });
        }

        // 3. ОБНОВИТЬ
        if (action === 'update') {
            await sql`
                UPDATE users 
                SET name = ${name}, email = ${email}, role = ${role}, blood_type = ${bloodType},
                    spec = ${spec || ''}, city = ${city || ''}, exp = ${exp || ''}, bio = ${bio || ''}, img = ${img || ''}, rating = ${rating || 5.0}
                WHERE iin = ${targetIin}
            `;
            return new Response(JSON.stringify({ message: "Данные успешно обновлены" }), { status: 200 });
        }

        // 4. УДАЛИТЬ
        if (action === 'delete') {
            await sql`DELETE FROM users WHERE iin = ${targetIin}`;
            await sql`DELETE FROM appointments WHERE patient_iin = ${targetIin}`;
            return new Response(JSON.stringify({ message: "Пользователь удален" }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: "Неизвестное действие" }), { status: 400 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}