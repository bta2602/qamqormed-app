import { neon } from '@netlify/neon';

export default async function handler(request, context) {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });

    const sql = neon();

    try {
        const data = await request.json();
        const { action, sender, receiver, text } = data;

        await sql`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id SERIAL PRIMARY KEY,
                sender VARCHAR(50) NOT NULL,
                receiver VARCHAR(50) NOT NULL,
                text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;

        // 1. ОТПРАВКА СООБЩЕНИЯ И МГНОВЕННЫЙ ОТВЕТ ИИ
        if (action === 'send') {
            // Сохраняем вопрос пациента
            await sql`INSERT INTO chat_messages (sender, receiver, text) VALUES (${sender}, ${receiver}, ${text})`;

            let replyText = "";

            if (receiver === 'support') {
                const apiKey = process.env.GEMINI_API_KEY;
                
                if (apiKey) {
                    try {
                        const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [{ parts: [{ text: `Ты медицинский ассистент клиники QamqorMed. Отвечай кратко, эмпатично. Клиент пишет: "${text}"` }] }]
                            })
                        });
                        
                        const aiData = await aiResponse.json();
                        
                        // Если Google вернул ошибку, выводим её прямо в чат
                        if (!aiResponse.ok) {
                            replyText = `Ошибка API (${aiResponse.status}): ${aiData.error?.message || 'Неизвестная ошибка'}`;
                            console.error("Gemini API Error:", aiData);
                        } else {
                            replyText = aiData.candidates[0].content.parts[0].text;
                        }
                    } catch (e) {
                        replyText = 'Системная ошибка сети: ' + e.message;
                        console.error("Network Error:", e);
                    }
                } else {
                    replyText = 'Автоответчик: Система ИИ пока не подключена (нужен API ключ).';
                }

                // Сохраняем ответ ИИ
                await sql`INSERT INTO chat_messages (sender, receiver, text) VALUES ('support', ${sender}, ${replyText})`;
            }

            // Возвращаем ответ прямо в этом же запросе!
            return new Response(JSON.stringify({ message: "Отправлено", reply: replyText }), { status: 200 });
        }

        // 2. ЗАГРУЗКА ИСТОРИИ (вызывается только один раз при открытии чата)
        if (action === 'get') {
            const msgs = await sql`
                SELECT * FROM chat_messages 
                WHERE (sender = ${sender} AND receiver = ${receiver}) 
                   OR (sender = ${receiver} AND receiver = ${sender})
                ORDER BY created_at ASC;
            `;
            return new Response(JSON.stringify({ messages: msgs }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: "Неизвестное действие" }), { status: 400 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}