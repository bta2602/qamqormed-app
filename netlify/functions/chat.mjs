import { endpoint, authenticate, requireRole, requirePatientAccess, throttle, text, fail, json } from '../lib/security.mjs';
import { dataKeyring, protectRecord, revealRecord, reserveId } from '../lib/data-crypto.mjs';
import { AI_CONSENT_VERSION, geminiReply } from '../lib/gemini.mjs';

export async function handleChat({ sql, request, data }) {
    const user = await authenticate(sql, request);
    requireRole(user, 'patient', 'doctor');
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
        return json({ messages: messages.reverse().map(row => revealRecord('chat_messages', row)).map(message => doctorPublicId ? {
            ...message,
            sender: message.sender === receiver ? doctorPublicId : message.sender,
            receiver: message.receiver === receiver ? doctorPublicId : message.receiver,
        } : message) });
    }
    if (data.action !== 'send') fail(400, 'Неизвестное действие');
    if (receiver === 'support' && (data.aiConsent !== true || data.aiConsentVersion !== AI_CONSENT_VERSION))
        fail(400, 'Обновите приложение или страницу и подтвердите согласие на обработку сообщений Google Gemini');
    const message = text(data.text, 'text', 8000);
    dataKeyring();
    await throttle(sql, 'chat:' + user.id, 30);
    let reply = '';
    if (receiver === 'support') {
        const history = await sql`SELECT id, sender, text FROM chat_messages WHERE (sender = ${sender} AND receiver = 'support')
            OR (sender = 'support' AND receiver = ${sender}) ORDER BY created_at DESC, id DESC LIMIT 10`;
        reply = await geminiReply(message, history.reverse().map(row => revealRecord('chat_messages', row)));
        const sent = protectRecord('chat_messages', { id: await reserveId(sql, 'chat_messages'), text: message });
        const received = protectRecord('chat_messages', { id: await reserveId(sql, 'chat_messages'), text: reply });
        await sql`WITH sent AS (INSERT INTO chat_messages(id, sender, receiver, text) VALUES (${sent.id}, ${sender}, 'support', ${sent.text}) RETURNING id)
            INSERT INTO chat_messages(id, sender, receiver, text) SELECT ${received.id}, 'support', ${sender}, ${received.text} FROM sent`;
    } else {
        const secured = protectRecord('chat_messages', { id: await reserveId(sql, 'chat_messages'), text: message });
        await sql`INSERT INTO chat_messages(id, sender, receiver, text) VALUES (${secured.id}, ${sender}, ${receiver}, ${secured.text})`;
    }
    return json({ message: 'Отправлено', reply });
}

export default endpoint('POST', handleChat);
