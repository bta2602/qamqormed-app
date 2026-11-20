import { button, el, iconButton } from './dom.mjs';
import { language, t } from './i18n.mjs';

const art = name => '/web/art/' + name + '.webp';
const illustrations = ['health', 'care', 'welcome'];
const strings = {
    ru: {
        pages: [
            ['Здоровье без лишних хлопот', 'Нужный специалист в пару касаний.\nЗабота о вас начинается здесь.'],
            ['Всегда вместе с вами', 'Анализы, назначения, лекарства и приёмы — всё под рукой, в одном месте.'],
            ['Добро пожаловать в\nQamqorMed!', 'Будьте на связи с врачом и заботьтесь о здоровье каждый день.'],
        ],
        intro: 'Знакомство с QamqorMed', next: ['Далее', 'Начать', 'К форме входа'], back: 'Назад',
        step: n => 'Знакомство: ' + n + ' из 2', signIn: 'Приятно видеть вас снова!', noAccount: 'Нет аккаунта?',
        emailHint: 'Введите эл. почту', passwordHint: 'Введите пароль', show: 'Показать пароль', hide: 'Скрыть пароль',
    },
    kk: {
        pages: [
            ['Денсаулыққа қамқорлық оңай', 'Қажетті маман бірнеше басу арқылы.\nСізге қамқорлық осы жерден басталады.'],
            ['Әрдайым жаныңыздамыз', 'Талдаулар, дәрігер тағайындаулары, дәрілер мен қабылдаулар — бәрі бір жерде, қолыңызда.'],
            ['QamqorMed-ке\nқош келдіңіз!', 'Дәрігермен байланыста болып, денсаулығыңызға күн сайын қамқор болыңыз.'],
        ],
        intro: 'QamqorMed-пен танысу', next: ['Келесі', 'Бастау', 'Кіру формасына өту'], back: 'Артқа',
        step: n => 'Танысу: 2 беттің ' + n + '-беті', signIn: 'Сізді қайта көргенімізге қуаныштымыз!', noAccount: 'Тіркелгіңіз жоқ па?',
        emailHint: 'Эл. поштаны енгізіңіз', passwordHint: 'Құпиясөзді енгізіңіз', show: 'Құпиясөзді көрсету', hide: 'Құпиясөзді жасыру',
    },
};

function introduction(copy, focusLogin) {
    let page = 0;
    const artwork = el('img', { class: 'qw-illustration', alt: '', width: 840, height: 840, draggable: 'false' });
    const tracks = [el('span'), el('span')];
    const progress = el('div', { class: 'qw-progress', role: 'img' }, tracks);
    const title = el('h2');
    const body = el('p');
    const back = iconButton(copy.back, () => change(page - 1), 'chevron-left');
    const next = button(copy.next[0], () => page === 2 ? focusLogin() : change(page + 1), null, 'primary');
    const controls = el('div', { class: 'qw-pager' }, back, next);
    const stage = el('section', { class: 'qw-intro', 'aria-label': copy.intro }, artwork,
        el('div', { class: 'qw-description', 'aria-live': 'polite', 'aria-atomic': 'true' }, progress, title, body), controls);

    function change(index) {
        if (index < 0 || index >= illustrations.length) return;
        page = index;
        artwork.src = art(illustrations[page]);
        title.textContent = copy.pages[page][0];
        body.textContent = copy.pages[page][1];
        progress.hidden = page === 2;
        if (!progress.hidden) progress.setAttribute('aria-label', copy.step(page + 1));
        tracks.forEach((track, i) => track.classList.toggle('qw-filled', i <= page));
        if (page === 0 && document.activeElement === back) next.focus();
        back.hidden = page === 0;
        next.querySelector('span').textContent = copy.next[page];
    }
    let start;
    artwork.addEventListener('pointerdown', event => {
        if (event.isPrimary && event.pointerType === 'touch') start = [event.clientX, event.clientY, event.pointerId];
    });
    artwork.addEventListener('pointercancel', () => { start = null; });
    artwork.addEventListener('pointerup', event => {
        if (start?.[2] !== event.pointerId) return;
        const dx = event.clientX - start[0], dy = event.clientY - start[1];
        start = null;
        if (Math.abs(dx) >= 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) change(page + (dx < 0 ? 1 : -1));
    });
    change(0);
    return stage;
}

// Keep the same form and inputs (including form()'s validation, lock and cleanup).
function decorateForm(loginForm, forgotButton, copy) {
    const email = loginForm.elements.namedItem('email');
    const password = loginForm.elements.namedItem('password');
    email.placeholder = copy.emailHint;
    password.placeholder = copy.passwordHint;
    const label = password.closest('label');
    const wrapper = el('div', { class: 'qw-password' });
    const reveal = iconButton(copy.show, () => setVisible(password.type === 'password'), 'eye');
    function setVisible(visible) {
        password.type = visible ? 'text' : 'password';
        const description = visible ? copy.hide : copy.show;
        reveal.title = description;
        reveal.setAttribute('aria-label', description);
        reveal.querySelector('img').src = '/web/icons/' + (visible ? 'eye-off' : 'eye') + '.svg';
    }
    // The shared submit handler clears password-type inputs after every attempt.
    loginForm.addEventListener('submit', () => setVisible(false), { capture: true });
    label.replaceWith(wrapper);
    wrapper.append(label, reveal);
    forgotButton.classList.add('qw-forgot');
    loginForm.querySelector('[type=submit]').before(forgotButton);
    return () => email.focus();
}

/** Present the signed-out login branch. Recovery and enrollment keep their own screens. */
export function welcomeScreen({ loginForm, registerButton, forgotButton, message }) {
    const copy = strings[language] ?? strings.ru;
    const focusLogin = decorateForm(loginForm, forgotButton, copy);
    const heading = el('div', { class: 'qw-signin-heading' },
        el('div', {}, el('h1', { id: 'qw-login-title', text: t('login') }), el('p', { text: copy.signIn })),
        el('img', { class: 'qw-phone-art', src: art('welcome'), alt: '', width: 104, height: 104, loading: 'lazy' }));
    const signIn = el('section', { class: 'qw-signin', 'aria-labelledby': 'qw-login-title' }, heading,
        message && el('p', { class: 'error', role: 'alert', text: message }), loginForm,
        el('div', { class: 'qw-register' }, el('span', { text: copy.noAccount }), registerButton));
    return el('main', { id: 'main', class: 'qm-welcome' },
        el('div', { class: 'qw-layout' }, signIn, introduction(copy, focusLogin)));
}
