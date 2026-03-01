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

        // 1. ОТПРАВКА СООБЩЕНИЯ
        if (action === 'send') {
            await sql`INSERT INTO chat_messages (sender, receiver, text) VALUES (${sender}, ${receiver}, ${text})`;

            let replyText = "";

            if (receiver === 'support') {
                const apiKey = process.env.GEMINI_API_KEY;
                
                if (!apiKey) {
                    replyText = "Автоответчик: Система ИИ не подключена (нужен API ключ в настройках Netlify).";
                } else {
                    const systemPrompt = `
Ты — умный ИИ-ассистент клиники QamqorMed. 
Твоя цель: общаться с пациентом и, если он хочет записаться к врачу, собрать 3 параметра: специальность врача, дату и время.
Если пациент не назвал все три параметра — вежливо уточни их.
Если пациент назвал всё и подтверждает запись — ставь флаг makeBooking: true.

ВНИМАНИЕ! Твой ответ ВСЕГДА должен быть строгим JSON-объектом такого формата:
{
  "replyText": "Твой ответ пациенту (человеческим языком)",
  "makeBooking": false,
  "bookingData": {
      "spec": "название специальности врача (если есть)",
      "date": "дата приема (если есть)",
      "time": "время приема (если есть)"
  }
}
Отвечай ТОЛЬКО форматом JSON, без лишнего текста и без кавычек markdown.
Вопрос от пациента: "${text}"
                    `;

                    try {
                        const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [{ parts: [{ text: systemPrompt }] }],
                                generationConfig: { responseMimeType: "application/json" }
                            })
                        });
                        
                        const aiData = await aiResponse.json();

                        // ЗАЩИТА ОТ ОШИБОК API
                        if (!aiResponse.ok) {
                            replyText = `Ошибка ИИ: ${aiData.error?.message || 'Неизвестная ошибка'}`;
                        } else {
                            const aiJsonStr = aiData.candidates[0].content.parts[0].text;
                            const parsedAI = JSON.parse(aiJsonStr);
                            replyText = parsedAI.replyText;

                            // МАГИЯ: ЕСЛИ ИИ РЕШИЛ ЗАПИСАТЬ ПАЦИЕНТА
                            if (parsedAI.makeBooking === true && parsedAI.bookingData) {
                                const bData = parsedAI.bookingData;
                                // Ищем врача нужной специальности
                                const doctors = await sql`SELECT iin, name FROM users WHERE role = 'doctor' AND spec ILIKE ${'%' + bData.spec + '%'} LIMIT 1`;
                                
                                if (doctors.length > 0) {
                                    const doctor = doctors[0];
                                    await sql`
                                        INSERT INTO appointments (patient_iin, doctor_iin, date, time, status) 
                                        VALUES (${sender}, ${doctor.iin}, ${bData.date}, ${bData.time}, 'pending')
                                    `;
                                    replyText += `\n\n✅ *Система: Вы успешно записаны к врачу ${doctor.name} на ${bData.date} в ${bData.time}.*`;
                                } else {
                                    replyText += `\n\n❌ *Система: К сожалению, врача специальности "${bData.spec}" сейчас нет в нашей базе.*`;
                                }
                            }
                        }
                    } catch (err) {
                        console.error("Ошибка обработки ИИ:", err);
                        replyText = "Извините, произошла техническая ошибка при ответе.";
                    }
                }

                // Сохраняем итоговый ответ в чат
                await sql`INSERT INTO chat_messages (sender, receiver, text) VALUES ('support', ${sender}, ${replyText})`;
            }

            return new Response(JSON.stringify({ message: "Отправлено", reply: replyText }), { status: 200 });
        }

        // 2. ЗАГРУЗКА ИСТОРИИ
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