'use strict';
// Robust delete of a scratch X article (published or draft) via editor More menu.
const { chromium } = require('playwright');
const editUrl = process.argv[2];

(async () => {
  if (!editUrl) throw new Error('usage: node _x_article_delete.js <editUrl>');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const out = { url: page.url() };
  const more = page.locator('button[aria-label="More"]').first();
  if (!(await more.count())) { out.result = 'no-more-button'; console.log(JSON.stringify(out)); process.exit(1); }
  await more.click({ force: true, timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1500);
  out.menuItems = await page.$$eval('[role="menuitem"], [role="menu"] *', (els) => els.map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 30).slice(0, 12));
  const del = page.getByText(/Delete Article|删除文章/).first();
  if (!(await del.count())) { out.result = 'no-delete-item'; console.log(JSON.stringify(out)); process.exit(1); }
  await del.click({ timeout: 12000 });
  await page.waitForTimeout(2500);
  out.dialog = await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter((x) => x.offsetParent !== null)[0];
    return d ? { text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 150), buttons: Array.from(d.querySelectorAll('button')).map((b) => (b.innerText || b.getAttribute('aria-label') || '(no-text)').trim()) } : null;
  });
  // 点确认键：X 的按钮吃真实鼠标事件，用坐标点击最稳（innerText 可能为空，回退 aria-label）
  const rect = await page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter((x) => x.offsetParent !== null)[0];
    if (!d) return { err: 'no dialog' };
    const b = Array.from(d.querySelectorAll('button')).find((x) => {
      const t = ((x.innerText || '') + ' ' + (x.getAttribute('aria-label') || '')).trim();
      return /delete|删除/i.test(t) && !/cancel|取消/i.test(t);
    });
    if (!b) return { err: 'no confirm btn' };
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim() };
  });
  let clicked = '';
  if (rect && rect.x) {
    await page.mouse.click(rect.x, rect.y);
    clicked = rect.label || 'confirm';
  }
  await page.waitForTimeout(4000);
  out.rect = rect;
  out.deleted = !!clicked;
  out.clicked = clicked;
  out.afterUrl = page.url();
  // 二次确认：编辑页是否已 404/跳走
  out.gone = !(await page.locator('button[aria-label="More"]').count().catch(() => 0));
  console.log(JSON.stringify(out, null, 2));
  await page.close();
  await browser.close();
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
