import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Метод не поддерживается' }), { status: 405 });
    }

    try {
        const data = await request.json();
        const { email, password } = data;

        const sql = neon();

        // Ищем в базе пользователя с такой почтой и паролем
        const result = await sql`
            SELECT id, name, email, iin, role 
            FROM users 
            WHERE email = ${email} AND password = ${password}
        `;

        // Если база нашла совпадение (длина ответа больше 0)
        if (result.length > 0) {
            return new Response(JSON.stringify({ 
                message: "Успешный вход", 
                user: result[0] // Отправляем данные пользователя обратно на телефон
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        } else {
            // Если пароль или почта не совпали
            return new Response(JSON.stringify({ error: "Неверная почта или пароль" }), { 
                status: 401,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
        }

    } catch (error) {
        return new Response(JSON.stringify({ error: "Ошибка сервера" }), { status: 500 });
    }
}
