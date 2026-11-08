import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = 'https://qamqor-med.netlify.app';
async function request(name, data, token, method = 'POST') {
    const response = await fetch(`${base}/.netlify/functions/${name}`, {
        method, redirect:'error', signal:AbortSignal.timeout(35000),
        headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
        ...(method==='GET'?{}:{body:JSON.stringify(data)}),
    });
    return {status:response.status,body:await response.json()};
}

export async function verifyLive(credentials, output = console.log) {
    const emit = result=>output(JSON.stringify(result));
    const folder=join(import.meta.dirname,'..','verification','2026-11-09');
    await mkdir(folder,{recursive:true});
    for (const role of ['patient','doctor','admin']) {
        const credential=credentials.find(c=>c.role===role);
        assert.ok(credential);
        const login=await request('login',{email:credential.email,password:credential.newPassword});
        assert.equal(login.status,200);
        assert.equal(login.body.user.role,role);
        const token=login.body.token;
        assert.equal((await request('session',{},token,'GET')).status,200);
        assert.equal((await request('admin',{action:'get_all'},token)).status,role==='admin'?200:403);
        if (role==='patient') {
            const own=await request('get-analyses',{iin:login.body.user.iin},token);
            assert.equal(own.status,200);
            assert.ok(!JSON.stringify(own.body).includes('qmenc1.'));
            const withoutConsent=await request('ai-chat',{action:'send',sender:login.body.user.iin,receiver:'support',text:'Synthetic technical check'},token);
            assert.equal(withoutConsent.status,400);
        }
        assert.equal((await request('logout',{},token)).status,200);
        assert.equal((await request('session',{},token,'GET')).status,401);
        emit({check:'live_api',role,status:'passed',sessionRevocation:true});
    }
    const patient=credentials.find(c=>c.role==='patient');
    const browser=await chromium.launch({headless:true});
    try {
        const context=await browser.newContext({viewport:{width:390,height:844}});
        const page=await context.newPage();
        emit({check:'live_browser',phase:'login'});
        let errors=0;
        page.on('pageerror',()=>errors++);
        await page.goto(base,{waitUntil:'domcontentloaded'});
        await page.locator('#app[aria-busy=false]').waitFor();
        await page.locator('input[name=email]').fill(patient.email);
        await page.locator('input[name=password]').fill(patient.newPassword);
        await page.locator('form button[type=submit]').click();
        await page.locator('.services').waitFor();
        assert.equal(await page.locator('.services a').count(),8);
        await page.screenshot({path:join(folder,'live-home-mobile.png'),fullPage:true});
        await page.locator('.bottomnav a[href="#chat"]').click();
        emit({check:'live_browser',phase:'gemini'});
        await page.locator('input[name=aiConsent]').check();
        await page.locator('textarea[name=text]').fill('Это техническая проверка QamqorMed без медицинских данных. Как открыть свой профиль? Ответь одним предложением по-русски.');
        const completed=page.waitForResponse(r=>r.url()===base+'/.netlify/functions/ai-chat',{timeout:40000});
        await page.locator('form button[type=submit]').click();
        const response=await completed;
        assert.equal(response.status(),200);
        const answer=await response.json();
        assert.ok(typeof answer.reply==='string' && answer.reply.trim().length>0);
        await page.waitForFunction(()=>document.querySelector('textarea[name=text]')?.value==='');
        await page.locator('.messages .message.received').last().waitFor();
        await page.screenshot({path:join(folder,'live-gemini-mobile.png'),fullPage:true});
        emit({check:'gemini_website',status:'passed',syntheticMessage:true,replyReceived:true});
        await page.goBack();
        await page.locator('.services').waitFor();
        await page.getByRole('button',{name:'Тёмная тема',exact:true}).click();
        await page.getByRole('button',{name:'ҚАЗ',exact:true}).click();
        assert.equal(await page.locator('html').getAttribute('lang'),'kk');
        assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.screenshot({path:join(folder,'live-home-kk-dark.png'),fullPage:true});
        await page.setViewportSize({width:1280,height:900});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.screenshot({path:join(folder,'live-home-desktop.png'),fullPage:true});
        assert.equal(errors,0);
        emit({check:'live_browser',status:'passed',viewports:['390x844','1280x900'],languages:['ru','kk'],darkTheme:true,back:true,pageErrors:errors});
    } finally {await browser.close();}
}
