import { chromium } from 'playwright';

const URL = process.env.UI_URL ?? 'http://localhost:5199/';

const run = async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.strip', { timeout: 15000 });
  await page.waitForTimeout(1500);

  const stat = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const css = (s) => {
      const el = q(s);
      return el ? getComputedStyle(el) : null;
    };
    return {
      title: document.title,
      statCount: document.querySelectorAll('.stat').length,
      cardCount: document.querySelectorAll('.card').length,
      rowCount: document.querySelectorAll('.row').length,
      meterCount: document.querySelectorAll('.meter').length,
      values: Array.from(document.querySelectorAll('.stat-value')).map((n) => n.textContent),
      brandFont: css('.brand-name')?.fontFamily ?? '',
      bodyBg: css('body')?.backgroundColor ?? '',
      cardBg: css('.card')?.backgroundColor ?? '',
      cardRadius: css('.card')?.borderRadius ?? '',
      stripCols: css('.strip')?.gridTemplateColumns ?? '',
      gridCols: css('.grid')?.gridTemplateColumns ?? '',
      topText: q('.top')?.textContent?.slice(0, 160) ?? '',
      firstThesis: q('.thesis')?.textContent?.slice(0, 120) ?? '',
      proofRows: Array.from(document.querySelectorAll('.proof-row')).map((n) => n.textContent),
    };
  });

  console.log('--- DOM ---');
  console.log(JSON.stringify(stat, null, 1));

  await page.screenshot({ path: '/tmp/envelope-1-desk.png', fullPage: true });

  // exercise: run one cycle
  const tickBtn = page.getByRole('button', { name: /run one cycle/i });
  if (await tickBtn.count()) {
    await tickBtn.click();
    await page.waitForTimeout(12000);
    const toast = await page.$eval('.toast', (n) => n.textContent).catch(() => null);
    console.log('tick toast:', toast);
    await page.screenshot({ path: '/tmp/envelope-2-after-tick.png', fullPage: true });
  }

  // exercise: breach the envelope
  const breakBtn = page.getByRole('button', { name: /4× the mandate/i });
  if (await breakBtn.count()) {
    await breakBtn.click();
    await page.waitForTimeout(12000);
    const toast = await page.$eval('.toast', (n) => n.textContent).catch(() => null);
    console.log('break toast:', toast);
    const breach = await page.$eval('.breach code', (n) => n.textContent).catch(() => null);
    console.log('breach code shown:', breach);
    await page.screenshot({ path: '/tmp/envelope-3-breach.png', fullPage: true });
  }

  // exercise: natural language mandate change
  const input = page.locator('.console input');
  if (await input.count()) {
    await input.fill('be more aggressive, allow up to 3 trades per hour and 1500 bps position');
    await page.getByRole('button', { name: /^Interpret$/ }).click();
    await page.waitForTimeout(9000);
    const reply = await page.$eval('.proposal p', (n) => n.textContent).catch(() => null);
    console.log('chat reply:', reply);
    const sign = page.getByRole('button', { name: /sign and install mandate/i });
    if (await sign.count()) { await sign.click(); await page.waitForTimeout(6000); const t = await page.$eval('.toast', (n) => n.textContent).catch(() => null); console.log('mandate toast:', t); const nonce = await page.$eval('.mandate-nonce', (n) => n.textContent).catch(()=>null); console.log('nonce now:', nonce); }
    await page.screenshot({ path: '/tmp/envelope-4-chat.png', fullPage: true });
  }

  // narrow viewport check
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.waitForTimeout(800);
  const narrow = await page.evaluate(() => ({
    gridCols: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
  }));
  console.log('narrow:', JSON.stringify(narrow));
  await page.screenshot({ path: '/tmp/envelope-5-narrow.png', fullPage: true });

  console.log('--- console errors ---');
  console.log(consoleErrors.length ? consoleErrors.slice(0, 6).join('\n') : 'none');

  await browser.close();
};

run().catch((error) => {
  console.error('UI RUN FAILED', error);
  process.exit(1);
});
