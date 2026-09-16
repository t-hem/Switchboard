// Optional extension of restart.mjs: real web client + Chromium, disposable host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';

export async function browserRecovery({config, api, restart, until, remove, dir}) {
  const root=path.resolve('packages/web/dist');
  const server=createServer((req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=path.resolve(root,`.${name==='/'?'/index.html':name}`);
    if(!file.startsWith(`${root}/`)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'})[path.extname(file)]??'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  let browser;
  let session;
  try {
    browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.createBrowserContext();
    const page=await context.newPage();
    await page.setViewport({width:1280,height:800});
    const setup=async(p,id)=>{
      await p.evaluateOnNewDocument((entry,clientId)=>{
        localStorage.setItem('switchboard.hosts',JSON.stringify([entry]));
        localStorage.setItem('switchboard.clientId',clientId);
      },{id:'test-host',label:'Recovery test',baseUrl:`http://127.0.0.1:${config.port}`,token:config.token},id);
      await p.goto(url,{waitUntil:'networkidle2'});
    };
    session=await api('/sessions',{agent:'bash',cwd:dir,label:'Browser recovery fixture'});
    const open=async p=>{
      await p.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Browser recovery fixture')));
      await p.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Browser recovery fixture')).click());
      await p.waitForSelector('.xterm-screen');
    };
    const terminal=p=>p.evaluate(()=>document.querySelector('.xterm-rows')?.innerText??'');
    const type=async(p,text)=>{await p.click('.xterm-screen');await p.keyboard.type(text);await p.keyboard.press('Enter');};
    await setup(page,'browser-primary');await open(page);
    await until(async()=> (await terminal(page)).includes('$'),'browser prompt');
    assert.ok((await page.evaluate(()=>document.body.innerText)).includes('survives host restart'));
    await type(page,'echo BEFORE_BROWSER_RESTART');
    await until(async()=> (await terminal(page)).includes('BEFORE_BROWSER_RESTART'),'browser input');
    await restart();
    await until(async()=> (await page.evaluate(()=>document.body.innerText)).includes('connected'),'browser reconnect');
    await until(async()=> (await terminal(page)).includes('BEFORE_BROWSER_RESTART'),'reconstructed screen');
    assert.equal((await api(`/sessions/${session.id}`)).pid,session.pid);
    await type(page,'echo AFTER_BROWSER_RESTART');
    await until(async()=> (await terminal(page)).includes('AFTER_BROWSER_RESTART'),'post-restart input');
    const before=await api(`/sessions/${session.id}`);
    await page.setViewport({width:900,height:600});
    await until(async()=> (await api(`/sessions/${session.id}`)).cols!==before.cols,'browser resize');
    const other=await browser.createBrowserContext();
    const phone=await other.newPage();await phone.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    await setup(phone,'browser-phone');await open(phone);
    await until(async()=> (await page.evaluate(()=>document.body.innerText)).includes('Take back'),'old browser evicted');
    await until(async()=> (await terminal(phone)).includes('AFTER_BROWSER_RESTART'),'mobile viewport reconstructed');
    await type(phone,'echo PHONE_VIEWPORT_INPUT');
    await until(async()=> (await terminal(phone)).includes('PHONE_VIEWPORT_INPUT'),'mobile viewport input');
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Take back')).click());
    await until(async()=> !(await page.evaluate(()=>document.body.innerText)).includes('Take back'),'desktop reclaimed');
    await type(page,'echo DESKTOP_RECLAIMED');
    await until(async()=> (await terminal(page)).includes('DESKTOP_RECLAIMED'),'input after take-back');
    console.log('PASS Chromium reconnect/redraw/input/resize/takeover and mobile viewport (not physical phone)');
  } finally {
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
    if(session)await remove(session.id);
  }
}
