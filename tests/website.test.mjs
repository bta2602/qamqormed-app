import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext, runInContext } from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// These standalone inline functions share a four-space declaration/closing indent.
function functionsNamed(name) {
    return [...html.matchAll(new RegExp('^    (?:async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?^    \\}', 'gm'))]
        .map(match => match[0]);
}

const attack = '<img src=x onerror="globalThis.chatAttack=1"><script>globalThis.chatAttack=1</script></div><svg onload=alert(1)> & " \' &lt;b&gt;';
const escapedAttack = '&lt;img src=x onerror=&quot;globalThis.chatAttack=1&quot;&gt;&lt;script&gt;globalThis.chatAttack=1&lt;/script&gt;&lt;/div&gt;&lt;svg onload=alert(1)&gt; &amp; &quot; &#39; &amp;lt;b&amp;gt;';

function chatContext(functions, input = attack, reply = attack) {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', value: id === 'chat-input' ? input : '',
            scrollHeight: 100, classList: { add() {} }, remove() {} });
        return elements.get(id);
    };
    const requests = [];
    const context = createContext({
        document: { getElementById: element }, currentUser: { iin: 'test-patient' }, currentChatReceiver: 'support',
        myChats: [{ id: 1, doctorId: 2, lastMsg: attack }], doctors: [{ id: 2, name: 'Doctor', img: 'https://example.invalid/photo.png' }],
        currentLang: 'ru', changeLanguage() {}, goToScreen() {}, showToast() { assert.fail('Unexpected error toast'); },
        setTimeout(callback) { callback(); },
        fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ reply }) }; },
    });
    const helpers = functionsNamed('escapeHTMLtext');
    assert.equal(helpers.length, 1);
    runInContext(helpers[0] + '\n' + functions.join('\n'), context);
    return { context, element, requests };
}

function assertTextOnly(markup, occurrences = 1) {
    assert.equal(markup.split(escapedAttack).length - 1, occurrences);
    assert.doesNotMatch(markup, /<(?:img|script|svg)\b/i);
    assert.equal(markup.includes(attack), false);
}

test('both website inline JavaScript blocks parse without executing browser code', async () => {
    const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
        .filter(([, attributes, source]) => !/\bsrc\s*=/i.test(attributes) && source.trim());
    assert.equal(blocks.length, 2);
    for (const [index, [, , source]] of blocks.entries()) {
        assert.doesNotThrow(() => new Script(source, { filename: 'index.html:inline-' + (index + 1) }));
    }
});

test('shared chat escaping preserves text and escapes HTML syntax and existing entities', () => {
    const { context } = chatContext([]);
    assert.equal(context.escapeHTMLtext(attack), escapedAttack);
    assert.equal(context.escapeHTMLtext(null), '');
    assert.equal(context.escapeHTMLtext(undefined), '');
    assert.equal(context.escapeHTMLtext(42), '42');
    assert.equal(context.escapeHTMLtext('Plain text\n\u041f\u0440\u0438\u0432\u0435\u0442'), 'Plain text\n\u041f\u0440\u0438\u0432\u0435\u0442');
});

test('both incoming and outgoing history messages render escaped text', () => {
    const functions = functionsNamed('renderChatMessages');
    assert.equal(functions.length, 1);
    const { context, element } = chatContext(functions);
    context.renderChatMessages([{ sender: 'test-patient', text: attack }, { sender: 'support', text: attack }]);
    assertTextOnly(element('chat-messages').innerHTML, 2);
});

test('legacy support sendMessage escapes optimistic user text', () => {
    const functions = functionsNamed('sendMessage');
    assert.equal(functions.length, 2);
    const { context, element } = chatContext([functions[0]]);
    context.sendMessage();
    assertTextOnly(element('chat-messages').innerHTML);
    assert.equal(element('chat-input').value, '');
});

test('main async sendMessage escapes both user text and AI reply without changing API text', async () => {
    const functions = functionsNamed('sendMessage');
    assert.equal(functions.length, 2);
    const { context, element, requests } = chatContext([functions[1]]);
    await context.sendMessage();
    assertTextOnly(element('chat-messages').innerHTML, 2);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].text, attack);
    assert.equal(element('chat-input').value, '');
});

test('chat preview and opening a legacy doctor conversation escape the last message', () => {
    const functions = [...functionsNamed('renderChats'), ...functionsNamed('openDoctorChat')];
    assert.equal(functions.length, 2);
    const { context, element } = chatContext(functions);
    context.renderChats();
    // The trusted doctor image is expected; only the injected message must remain text.
    const markup = element('chats-list').innerHTML;
    assert.equal(markup.split(escapedAttack).length - 1, 1);
    assert.equal(markup.includes(attack), false);
    assert.doesNotMatch(markup, /<(?:script|svg)\b/i);
    context.openDoctorChat(1);
    assertTextOnly(element('chat-messages').innerHTML);
});
