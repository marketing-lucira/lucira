const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless:'new', args:['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({width:1600,height:1000});
  const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle2',timeout:90000});
  await new Promise(r=>setTimeout(r,5000));
  for (const tab of [0,1]) {
    await p.evaluate(i=>document.querySelectorAll('nav.tabs button')[i].click(), tab);
    await new Promise(r=>setTimeout(r,2500));
    const probe = await p.evaluate(()=>{
      const rows=document.querySelectorAll('tr[data-mid]');
      return {n:rows.length, first: rows[0]?rows[0].getAttribute('data-mid'):null, cells: rows[0]?rows[0].children.length:0};
    });
    console.log(`tab${tab}: rows-with-mid=${probe.n} firstMid=${probe.first} cells=${probe.cells}`);
    if(!probe.n) continue;
    await p.evaluate(()=>document.querySelector('tr[data-mid]').click());
    await new Promise(r=>setTimeout(r,1800));
    const d = await p.evaluate(()=>{ const d=document.getElementById('drawer');
      return {cls:d.className, chars:d.innerText.length, txt:d.innerText.slice(0,300)}; });
    console.log(`  drawer: class="${d.cls}" chars=${d.chars}`);
    console.log('  ---\n  '+d.txt.replace(/\n/g,'\n  '));
    if(d.chars>50) await p.screenshot({path:`shot_drill_tab${tab}.png`});
    await p.evaluate(()=>{ const c=document.getElementById('drawerClose'); if(c) c.click(); else if(window.closeJourney) closeJourney(); });
    await new Promise(r=>setTimeout(r,600));
  }
  console.log('\nJS ERRORS: '+errs.length); errs.slice(0,5).forEach(e=>console.log('  '+e));
  await b.close();
})().catch(e=>{console.error('FATAL '+e.message);process.exit(1);});
