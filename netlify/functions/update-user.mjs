import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Метод не поддерживается' }), { status: 405 });

    try {
        const data = await request.json();
        const { action, iin, email, bloodType, newPassword, oldPassword } = data;
        const sql = neon();

        // Если пришел запрос на смену пароля
        if (action === 'change_password') {
            const user = await sql`SELECT * FROM users WHERE iin = ${iin} AND password = ${oldPassword}`;
            if (user.length === 0) {
                return new Response(JSON.stringify({ error: 'Неверный старый пароль' }), { status: 401 });
            }
            await sql`UPDATE users SET password = ${newPassword} WHERE iin = ${iin}`;
            return new Response(JSON.stringify({ message: '✅ Пароль успешно изменён!' }), { status: 200 });
        }

        // Если пришел запрос на обновление профиля (почта и группа крови)
        if (action === 'update_profile') {
            await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS blood_type TEXT;`;
            await sql`UPDATE users SET email = ${email}, blood_type = ${bloodType} WHERE iin = ${iin}`;
            return new Response(JSON.stringify({ message: 'Данные успешно сохранены!' }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: 'Неизвестное действие' }), { status: 400 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}