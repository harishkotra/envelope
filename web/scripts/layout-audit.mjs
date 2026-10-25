import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome' });

const audit = async (width, height, file) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.strip');
  await page.waitForTimeout(1800);

  const report = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const zeroSized = Array.from(document.querySelectorAll('.card, .row, .stat, .meter'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width < 4 || r.height < 4;
      }).length;
    const clipped = Array.from(document.querySelectorAll('.stat-value, .stat-label, .card-head h2'))
      .filter((el) => el.scrollWidth > el.clientWidth + 2).length;
    return {
      horizontalScroll: document.documentElement.scrollWidth - window.innerWidth,
      documentHeight: document.documentElement.scrollHeight,
      cards: document.querySelectorAll('.card').length,
      rows: document.querySelectorAll('.row').length,
      zeroSized,
      clipped,
      top: box('.top'),
      strip: box('.strip'),
      grid: box('.grid'),
      feed: box('.feed'),
      receipt: box('.col-right .card'),
    };
  });

  await page.screenshot({ path: file, fullPage: true });
  console.log(width, JSON.stringify(report), 'errors:', errors.length ? errors : 'none');
  await page.close();
};

await audit(1600, 1000, '/tmp/envelope-final-1600.png');
await audit(1440, 900, '/tmp/envelope-final-1440.png');
await audit(1180, 900, '/tmp/envelope-final-1180.png');

// a tight hero shot of the desk at 1600, viewport only
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.waitForSelector('.strip');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/envelope-hero.png' });

await browser.close();
