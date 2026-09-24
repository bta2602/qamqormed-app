import { endpoint, authenticate, requireRole, requirePatientAccess, throttle, text, fail, json } from '../lib/security.mjs';

export default endpoint('POST', async ({ sql, request, data }) => {
    const user = await authenticate(sql, request);
    const sender = user.iin;
    if (data.sender !== sender) fail(403, 'Недостаточно прав');
    let receiver = text(data.receiver, 'receiver', 50);
    let doctorPublicId;
    if (receiver !== 'support') {
        if (user.role === 'doctor') await requirePatientAccess(sql, user, receiver);
        else {
            requireRole(user, 'patient');
            // Clients use catalogue UUIDs; persisted conversations retain their legacy IIN keys.
            const [doctor] = await sql`SELECT iin, public_id::text AS public_id FROM users
                WHERE role = 'doctor' AND (public_id::text = ${receiver} OR iin = ${receiver})`;
            if (!doctor) fail(403, 'Нет доступа к этому чату');
            receiver = doctor.iin;
            doctorPublicId = doctor.public_id;
            const relation = await sql`SELECT id FROM appointments WHERE patient_iin = ${sender} AND doctor_iin = ${receiver} AND status IN ('upcoming', 'completed') LIMIT 1`;
            if (!relation.length) fail(403, 'Нет доступа к этому чату');
        }
    }
    if (data.action === 'get') {
        const messages = await sql`SELECT * FROM chat_messages WHERE (sender = ${sender} AND receiver = ${receiver})
            OR (sender = ${receiver} AND receiver = ${sender}) ORDER BY created_at DESC, id DESC LIMIT 500`;
        return json({ messages: messages.reverse().map(message => doctorPublicId ? {
            ...message,
            sender: message.sender === receiver ? doctorPublicId : message.sender,
            receiver: message.receiver === receiver ? doctorPublicId : message.receiver,
        } : message) });
    }
    if (data.action !== 'send') fail(400, 'Неизвестное действие');
    const message = text(data.text, 'text', 8000);
    await throttle(sql, 'chat:' + user.id, 30);
    let reply = '';
    if (receiver === 'support') {
        if (!process.env.GEMINI_API_KEY) fail(503, 'ИИ временно недоступен');
        const history = await sql`SELECT sender, text FROM chat_messages WHERE (sender = ${sender} AND receiver = 'support')
            OR (sender = 'support' AND receiver = ${sender}) ORDER BY created_at DESC, id DESC LIMIT 10`;
        const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
            method: 'POST', signal: AbortSignal.timeout(20000),
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: 'Ты Asem-Ai, помощник QamqorMed. Отвечай на языке пользователя: русском или казахском. Не выдавай себя за врача, не назначай лекарства и не меняй назначения. При экстренных симптомах советуй вызвать 103. Не заявляй о выполнении действий в базе: для записи предложи открыть карточку врача. Не раскрывай чужие данные.' }] },
                contents: [...history.reverse().map(m => ({ role: m.sender === 'support' ? 'model' : 'user', parts: [{ text: m.text }] })),
                    { role: 'user', parts: [{ text: message }] }],
            }),
        });
        if (!response.ok) fail(503, 'ИИ временно недоступен');
        const output = await response.json();
        reply = output.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('').trim() ?? '';
        if (!reply || reply.length > 20000) fail(503, 'ИИ не смог подготовить ответ');
        await sql`WITH sent AS (INSERT INTO chat_messages(sender, receiver, text) VALUES (${sender}, 'support', ${message}) RETURNING id)
            INSERT INTO chat_messages(sender, receiver, text) SELECT 'support', ${sender}, ${reply} FROM sent`;
    } else {
        await sql`INSERT INTO chat_messages(sender, receiver, text) VALUES (${sender}, ${receiver}, ${message})`;
    }
    return json({ message: 'Отправлено', reply });
});
