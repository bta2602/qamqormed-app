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
                    
                    // ДОСТАЕМ ИСТОРИЮ ЧАТА (последние 10 сообщений для лучшего контекста)
                    const historyMsgs = await sql`
                        SELECT sender, text FROM chat_messages 
                        WHERE (sender = ${sender} AND receiver = 'support') 
                           OR (sender = 'support' AND receiver = ${sender})
                        ORDER BY created_at DESC
                        LIMIT 10;
                    `;
                    
                    historyMsgs.reverse(); 
                    
                    let dialogHistory = "";
                    historyMsgs.forEach(msg => {
                        const role = msg.sender === 'support' ? 'ИИ' : 'Пациент';
                        let cleanText = msg.text.replace(/✅ \*Система:.*?\*/g, '').trim();
                        dialogHistory += `${role}: ${cleanText}\n`;
                    });

                    const systemPrompt = `Ты — Qamqor AI, вежливый, эмпатичный и высококвалифицированный ИИ-ассистент в приложении QamqorMed. 
Твоя задача — проконсультировать пациента и записать его к врачу. Для записи нужно узнать 3 параметра:
1. Специальность врача (Стоматолог, Невролог, Хирург и т.д.)
2. Дата приема (например: завтра, 15 апреля)
3. Время приема (например: 10:00, утром)

Вот история вашей беседы:
${dialogHistory}

ВНИМАТЕЛЬНО ПРОЧИТАЙ ИСТОРИЮ ВЫШЕ!
Если пациент УЖЕ называл специальность ранее, ЗАПОМНИ ЕЕ и не спрашивай снова!
Если он УЖЕ назвал дату, ЗАПОМНИ ЕЕ!
Спрашивай ТОЛЬКО те данные, которых не хватает.
Если пациент назвал все 3 параметра (Специальность, Дата, Время) - переспроси: "Вы подтверждаете запись к [Специальность] на [Дата] в [Время]?".
Если пациент ответил согласием (Да, подтверждаю) - ставь "makeBooking": true.
Если у пациента экстренные симптомы (острая боль в сердце, удушье), немедленно советуй вызвать скорую помощь по номеру 103.

Твой ответ ВСЕГДА должен быть строгим JSON-объектом:
{
  "replyText": "Твой вежливый ответ пациенту от лица Qamqor AI",
  "makeBooking": false,
  "bookingData": {
      "spec": "найденная в истории специальность или пусто",
      "date": "найденная в истории дата или пусто",
      "time": "найденное в истории время или пусто"
  }
}
ОТВЕЧАЙ ТОЛЬКО ФОРМАТОМ JSON. Без лишнего текста, без кавычек \`\`\`json.`;

                    try {
                        const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [{ parts: [{ text: systemPrompt }] }],
                                generationConfig: { responseMimeType: "application/json" }
                            })
                        });
                        
                        const aiData = await aiResponse.json();

                        if (!aiResponse.ok) {
                            replyText = `Ошибка ИИ: ${aiData.error?.message || 'Неизвестная ошибка'}`;
                        } else {
                            // ОЧИСТКА МАРКДАУН-КАВЫЧЕК (Очень частая причина сбоев)
                            let aiJsonStr = aiData.candidates[0].content.parts[0].text;
                            aiJsonStr = aiJsonStr.replace(/```json/gi, '').replace(/```/g, '').trim();
                            
                            const parsedAI = JSON.parse(aiJsonStr);
                            replyText = parsedAI.replyText;

                            if (parsedAI.makeBooking === true && parsedAI.bookingData) {
                                const bData = parsedAI.bookingData;
                                const doctors = await sql`SELECT iin, name FROM users WHERE role = 'doctor' AND spec ILIKE ${'%' + bData.spec + '%'} LIMIT 1`;
                                
                                if (doctors.length > 0) {
                                    const doctor = doctors[0];
                                    // ОБНОВЛЕННЫЙ INSERT С УЧЕТОМ НОВЫХ КОЛОНОК БАЗЫ ДАННЫХ
                                    await sql`
                                        INSERT INTO appointments (patient_iin, doctor_iin, date, time, type, message, status) 
                                        VALUES (${sender}, ${doctor.iin}, ${bData.date}, ${bData.time}, 'clinic', 'Запись через ИИ-чат', 'upcoming')
                                    `;
                                    replyText += `\n\n✅ *Система: Вы успешно записаны к врачу ${doctor.name} на ${bData.date} в ${bData.time}.*`;
                                } else {
                                    replyText += `\n\n❌ *Система: К сожалению, врача специальности "${bData.spec}" сейчас нет в нашей базе.*`;
                                }
                            }
                        }
                    } catch (err) {
                        console.error("Ошибка обработки ИИ:", err);
                        replyText = "Извините, произошел технический сбой (ИИ вернул неверный формат). Пожалуйста, повторите ответ.";
                    }
                }

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