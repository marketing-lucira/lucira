const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });
  page.on('requestfailed', r => errors.push('REQFAIL: ' + r.url() + ' ' + ((r.failure() || {}).errorText)));
  page.on('response', r => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url()); });

  await page.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle2', timeout: 90000 });
  await new Promise(r => setTimeout(r, 5000));

  // What tab buttons exist?
  const navInfo = await page.evaluate(() => Array.from(document.querySelectorAll('nav.tabs button'))
    .map(b => ({ text: b.innerText.trim(), tab: b.dataset.tab || null, cls: b.className })));
  console.log('NAV BUTTONS: ' + JSON.stringify(navInfo));

  for (let i = 0; i < navInfo.length; i++) {
    await page.evaluate((idx) => document.querySelectorAll('nav.tabs button')[idx].click(), i);
    await new Promise(r => setTimeout(r, 2500));
    const info = await page.evaluate(() => {
      const secs = Array.from(document.querySelectorAll('section[id^=tab-]'));
      const shown = secs.filter(s => !s.hidden);
      const s = shown[0];
      return {
        shownIds: shown.map(x => x.id),
        chars: s ? s.innerText.length : 0,
        kpis: s ? s.querySelectorAll('.kpi').length : 0,
        tables: s ? s.querySelectorAll('table').length : 0,
        rows: s ? s.querySelectorAll('tbody tr').length : 0
      };
    });
    console.log(`  click "${navInfo[i].text}" -> shown=${JSON.stringify(info.shownIds)} chars=${info.chars} kpis=${info.kpis} tables=${info.tables} rows=${info.rows}`);
    await page.screenshot({ path: `shot_${i}.png` });
  }

  // back to tab 1, then drill down on a real row
  await page.evaluate(() => document.querySelectorAll('nav.tabs button')[0].click());
  await new Promise(r => setTimeout(r, 2500));
  const rowProbe = await page.evaluate(() => {
    const tr = document.querySelector('#tab-created tbody tr');
    if (!tr) return { found: false };
    return { found: true, cls: tr.className, mid: tr.dataset.mid || tr.getAttribute('data-mid'), cells: tr.children.length };
  });
  console.log('ROW PROBE: ' + JSON.stringify(rowProbe));
  await page.evaluate(() => { const tr = document.querySelector('#tab-created tbody tr'); if (tr) tr.click(); });
  await new Promise(r => setTimeout(r, 2000));
  const drawer = await page.evaluate(() => {
    const d = document.getElementById('drawer');
    return { exists: !!d, cls: d ? d.className : null, chars: d ? d.innerText.length : 0,
             head: d ? d.innerText.slice(0, 120) : '' };
  });
  console.log('DRAWER: ' + JSON.stringify(drawer));
  if (drawer.chars > 50) await page.screenshot({ path: 'shot_drilldown.png' });

  console.log('\nERRORS: ' + errors.length);
  [...new Set(errors)].slice(0, 12).forEach(e => console.log('  - ' + e));
  await browser.close();
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
