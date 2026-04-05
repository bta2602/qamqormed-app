import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });

    const sql = neon();

    try {
        // Умный ход: автоматически добавляем колонки для профиля врача, если их еще нет
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS spec VARCHAR(100) DEFAULT 'Терапевт'`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Астана'`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS exp VARCHAR(50) DEFAULT '5 лет'`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT 'Квалифицированный специалист.'`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS img TEXT DEFAULT 'https://res.cloudinary.com/dr1ewnxpp/image/upload/v1775378385/file_000000001044720b99a06f6e4900d8fe_kq3zco.png'`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rating NUMERIC(3,1) DEFAULT 5.0`;

        // Скачиваем из базы только тех, у кого роль 'doctor'
        const result = await sql`SELECT * FROM users WHERE role = 'doctor'`;
        
        return new Response(JSON.stringify({ doctors: result }), { status: 200 });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}