import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    // Проверяем, что нам прислали данные (метод POST)
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Метод не поддерживается' }), { status: 405 });
    }

    try {
        // Читаем данные, которые отправил телефон/сайт (Имя, Почту, Пароль, ИИН)
        const data = await request.json();
        const { name, email, password, iin, role } = data;

        const sql = neon();

        // Записываем нового пользователя в таблицу users
        const result = await sql`
            INSERT INTO users (name, email, password, iin, role)
            VALUES (${name}, ${email}, ${password}, ${iin}, ${role || 'patient'})
            RETURNING id, name, email, role;
        `;

        // Отвечаем сайту, что всё прошло успешно
        return new Response(JSON.stringify({ 
            message: "✅ Регистрация успешна!", 
            user: result[0] 
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });

    } catch (error) {
        // Если такой ИИН или почта уже есть в базе, выдаст ошибку
        return new Response(JSON.stringify({ error: "Ошибка регистрации. Возможно, такой пользователь уже существует." }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }
}
