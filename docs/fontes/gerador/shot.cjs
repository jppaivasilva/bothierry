const { chromium } = require('playwright');
(async () => {
  const [html, png, w, h] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
  await p.goto('file://' + html); await p.waitForTimeout(250);
  await p.screenshot({ path: png });
  await b.close();
})();
