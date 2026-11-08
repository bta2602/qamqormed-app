import { endpoint, fail } from '../lib/security.mjs';
import { handleChat } from './chat.mjs';

// Legacy servers lack this route; provider-versioned consent is enforced by handleChat.
export default endpoint('POST', context => {
    if (context.data.action !== 'send' || context.data.receiver !== 'support') fail(400, 'Некорректный запрос');
    return handleChat(context);
});
