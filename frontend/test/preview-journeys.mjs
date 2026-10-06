import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const user = { id: '00000000-0000-4000-8000-000000000001', email: 'preview@example.invalid', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const token = Buffer.from(JSON.stringify({ alg: 'HS256',typ: 'JWT' })).toString('base64url')+'.'+Buffer.from(JSON.stringify({ sub: user.id,exp: Math.floor(Date.now()/1000)+3600,aud: 'authenticated' })).toString('base64url')+'.fixture';
// Ephemeral contract fixtures, never production credentials or data.
const fixtures = createServer((req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Content-Type','application/json');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.url.startsWith('/auth/')) { if (req.headers.authorization === 'Bearer '+token && req.url === '/auth/v1/user') { res.end(JSON.stringify(user)); return; } res.statusCode = 401; res.end(JSON.stringify({ message: 'Invalid token' })); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.url.startsWith('/rest/v1/rpc/')) { res.statusCode = 405; res.end('{}'); return; }
  const resource = req.url.split('?')[0].split('/').pop();
  let body = [];
  if (resource === 'leetcode_company_problems') body = [{ id: 1, title: 'Two Sum', company: ['Google'], difficulty: 'Easy', topics: ['Array'], slug: 'two-sum' }];
  if (resource === 'lld_problems') body = [{ id: 1, title: 'Rate Limiter', slug: 'rate-limiter', companies: ['Google'], difficulty: 'Easy' }];
  if (resource === 'interview_questions') body = [{ id: 1, category: 'Engineering', subcategory: 'System Design', question: 'Design a cache', order_number: 1, answer_status: 'completed' }];
  if (resource === 'company') body = [{ slug: 'google', name: 'Google', company_type: 'product' }];
  if (resource === 'jobs_analytics') body = { total: 0, companies_with_jobs: 0, top_companies: [] };
  res.setHeader('Content-Range',body.length ? `0-${body.length-1}/${body.length}` : '*/0');
  if (req.headers.accept?.includes('vnd.pgrst.object')) body = body[0] ?? null;
  res.end(req.method === 'HEAD' ? '' : JSON.stringify(body));
});
await new Promise(resolve => fixtures.listen(54321,'127.0.0.1',resolve));
const sha = 'a'.repeat(40);
// Construct an environment allowlist: a developer's .env or inherited live
// tokens must never be used by this preview. Server dotenv sees a different cwd.
const scratch = await mkdtemp(path.join(tmpdir(),'growth-preview-'));
const env = { PATH: process.env.PATH, NODE_ENV: 'test', PORT: '4317', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'ci-fixture-not-a-real-key', APP_BASE_URL: 'http://localhost:4317', CORS_ORIGINS: 'http://localhost:4317', RAILWAY_GIT_COMMIT_SHA: sha };
const server = spawn(process.execPath,[path.resolve('server.js')],{ cwd: scratch,env,stdio: ['ignore','pipe','pipe'] });
let logs = ''; server.stdout.on('data',chunk => { logs += chunk; }); server.stderr.on('data',chunk => { logs += chunk; });
let chrome, socket;
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const origin = 'http://localhost:4317';
const request = async (route,options) => fetch(origin+route,{ ...options,signal: AbortSignal.timeout(10_000) });
try {
  let ready = false;
  for (let n=0;n<60;n++) { try { if ((await request('/api/health')).ok) { ready=true; break; } } catch {} await pause(250); }
  assert.ok(ready,'Preview server failed to start: '+logs.slice(-1500));
  assert.deepEqual(await (await request('/api/health')).json(),{ ok: true,commitSha: sha });
  for (const route of ['/','/optimizer','/dsa','/lld','/hld','/interview','/pricing','/auth','/blog']) {
    const response = await request(route); assert.equal(response.status,200,route);
    const html = await response.text(); assert.match(html,/<title>[^<]+<\/title>/,route+' title');
    assert.match(html,/\/assets\/[^"']+\.js/,route+' built asset');
    if (route === '/auth') assert.match(html,/noindex/, 'Auth is not indexable');
  }
  for (const route of ['/api/catalog/companies','/api/catalog/interview','/api/jobs','/api/blog']) {
    const response = await request(route); assert.equal(response.status,200,route); await response.json();
  }
  assert.match(await (await request('/robots.txt')).text(),/Disallow: \/api\//);
  const sitemap = await (await request('/sitemap.xml')).text(); assert.match(sitemap,/<urlset/); assert.match(sitemap,/\/optimizer<\/loc>/);
  for (const [route,method] of [['/api/entitlements/me','GET'],['/api/payments/razorpay/order','POST'],['/api/payments/razorpay/verify','POST'],['/api/run','POST']]) {
    assert.equal((await request(route,{ method,headers: { 'Content-Type': 'application/json' },body: method === 'POST' ? '{}' : undefined })).status,401,route+' rejects anonymous callers');
    assert.equal((await request(route,{ method,headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' },body: method === 'POST' ? '{}' : undefined })).status,401,route+' rejects invalid tokens');
  }
  const chromeBin = process.env.CHROME_BIN || 'google-chrome';
  chrome = spawn(chromeBin,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-port=9222','--user-data-dir='+path.join(scratch,'chrome'),'about:blank'],{ stdio: 'ignore' });
  let chromeError; chrome.on('error',e => { chromeError=e; });
  let target;
  for (let n=0;n<80;n++) { if (chromeError) throw chromeError; try { target = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find(t => t.type==='page'); if (target) break; } catch {} await pause(250); }
  assert.ok(target,'Headless browser unavailable; browser validation cannot be skipped');
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve,reject) => { socket.onopen=resolve; socket.onerror=reject; });
  let id=0; const pending=new Map(); const errors=[];
  socket.onmessage=event => { const message=JSON.parse(event.data); if (message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text); const p=pending.get(message.id); if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); } };
  const cdp = (method,params={}) => new Promise((resolve,reject) => { const n=++id; const timer=setTimeout(() => { pending.delete(n); reject(new Error('Browser command timed out')); },10_000); pending.set(n,{ resolve: value => { clearTimeout(timer); resolve(value); },reject: error => { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id:n,method,params })); });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  // Block external calls, including third-party analytics/payment scripts.
  await cdp('Network.enable'); await cdp('Network.setBlockedURLs',{ urls: ['https://*','http://*.com/*'] });
  const session = { access_token: token,refresh_token: 'fixture',token_type: 'bearer',expires_in: 3600,expires_at: Math.floor(Date.now()/1000)+3600,user };
  await cdp('Page.addScriptToEvaluateOnNewDocument',{ source: `if(location.pathname==='/auth') localStorage.removeItem('sb-127-auth-token'); else localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify(session))})` });
  for (const [route,heading] of [['/','Jobs'],['/interview','Interview Q&A'],['/optimizer','Resume Optimizer'],['/pricing',"Prep like it’s your job."],['/auth','Vloombox']]) {
    await cdp('Page.navigate',{ url:origin+route }); let rendered=false;
    for (let n=0;n<60;n++) {
      const result=await cdp('Runtime.evaluate',{ expression: `JSON.stringify({ headings:[...document.querySelectorAll('h1,h2')].map(n=>n.textContent.trim()),root:!!document.querySelector('#root')?.children.length })`,returnByValue:true });
      const page=JSON.parse(result.result.value || '{}');
      if (page.root && page.headings?.includes(heading)) { rendered=true; break; } await pause(250);
    }
    assert.ok(rendered,'React preview did not render expected heading: '+route);
  }
  assert.deepEqual(errors,[],'Unhandled browser exceptions');
  console.log('PASS: built pages, catalog APIs, metadata, sitemap, auth/payment guards and React rendering. Billing, email and AI use no live credentials.');
} finally {
  socket?.close();
  const stop = async child => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); },3000);
      child.once('exit',() => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  };
  await stop(chrome); await stop(server);
  await new Promise(resolve => fixtures.close(resolve));
  await rm(scratch,{ recursive:true,force:true,maxRetries:5,retryDelay:100 });
}
