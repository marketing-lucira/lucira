// Production smoke test. Credentials come from env (DASH_USER/DASH_PASS), never hard-coded.
const puppeteer = require('puppeteer-core');
const BASE = process.env.BASE || 'https://store-visit-intelligence-3mvv5mdr2q-el.a.run.app';
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', args: ['--no-sandbox']
  });
  const p = await b.newPage();
  await p.authenticate({ username: process.env.DASH_USER, password: process.env.DASH_PASS });
  await p.setViewport({ width: 1600, height: 1000 });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 160)); });
  p.on('response', r => { if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url().replace(BASE, '')); });

  await p.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 120000 });
  // wait for live data to land (cold instance runs the BigQuery query)
  for (let i = 0; i < 40; i++) {
    const ready = await p.evaluate(() => document.querySelectorAll('#tab-created .kpi').length > 0);
    if (ready) break;
    await new Promise(r => setTimeout(r, 3000));
  }
  const hdr = await p.evaluate(() => ({
    refresh: (document.getElementById('refreshInfo') || {}).innerText || '',
    health: Array.from(document.querySelectorAll('.health .pill, .health span')).map(e => e.innerText.trim()).filter(Boolean).slice(0, 8)
  }));
  console.log('HEADER: ' + hdr.refresh.replace(/\n/g, ' | '));
  console.log('HEALTH: ' + JSON.stringify(hdr.health));

  for (let i = 0; i < 3; i++) {
    await p.evaluate(idx => document.querySelectorAll('nav.tabs button')[idx].click(), i);
    await new Promise(r => setTimeout(r, 3000));
    const info = await p.evaluate(() => {
      const s = Array.from(document.querySelectorAll('section[id^=tab-')).find(x => !x.hidden);
      return s ? { id: s.id, chars: s.innerText.length, kpis: s.querySelectorAll('.kpi').length,
                   tables: s.querySelectorAll('table').length, rows: s.querySelectorAll('tbody tr').length,
                   mids: s.querySelectorAll('tr[data-mid]').length } : null;
    });
    console.log(`  tab${i}: ` + JSON.stringify(info));
    await p.screenshot({ path: `prod_${i}.png` });
  }

  // drill-down in production
  await p.evaluate(() => document.querySelectorAll('nav.tabs button')[0].click());
  await new Promise(r => setTimeout(r, 2500));
  await p.evaluate(() => { const t = document.querySelector('tr[data-mid]'); if (t) t.click(); });
  await new Promise(r => setTimeout(r, 2000));
  const d = await p.evaluate(() => {
    const d = document.getElementById('drawer');
    return { open: d.classList.contains('open'), chars: d.innerText.length };
  });
  console.log('DRILL: ' + JSON.stringify(d));
  if (d.open) await p.screenshot({ path: 'prod_drill.png' });

  console.log('\nERRORS: ' + errs.length);
  [...new Set(errs)].slice(0, 10).forEach(e => console.log('  - ' + e));
  await b.close();
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
