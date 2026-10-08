'use strict';
// Final end-to-end self-test of the FIXED X Articles publish channel (mirrors wx2x.js logic):
// create scratch -> publishConfirm (retry clicks + dialog-optional) -> verify in Published -> delete.
const { chromium } = require('playwright');
const TITLE = 'ZZ 发布通道终检（马上删除）';

async function clickDialogConfirm(page, re) {
  const rect = await page.evaluate((src) => {
    const re = new RegExp(src.re, 'i'), ban = new RegExp(src.ban, 'i');
    const d = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter((x) => x.offsetParent !== null)[0];
    if (!d) return null;
    const b = Array.from(d.querySelectorAll('button')).find((x) => {
      const t = ((x.innerText || '') + ' ' + (x.getAttribute('aria-label') || '')).trim();
      return re.test(t) && !ban.test(t);
    });
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim() };
  }, { re: re.source, ban: 'cancel|取消|close|返回' });
  if (!rect || !rect.x) return null;
  await page.mouse.click(rect.x, rect.y);
  return rect.label;
}

async function publishConfirm(page) {
  const steps = [];
  const pub = page.getByRole('button', { name: 'Publish', exact: true }).first();
  await pub.waitFor({ timeout: 30000 });
  let enabled = false;
  for (let i = 0; i < 30; i++) {
    enabled = await pub.isEnabled().catch(() => false);
    if (enabled) break;
    await page.waitForTimeout(2000);
  }
  if (!enabled) return { confirmed: false, finalUrl: page.url(), publishedUrl: null, steps: ['publish button stayed disabled'] };
  let confirmed = false;
  for (let round = 0; round < 3 && !/\/status\//.test(page.url()); round++) {
    await pub.click({ force: true }).catch((e) => steps.push('click err: ' + e.message.split('\n')[0].slice(0, 50)));
    steps.push('publish click #' + (round + 1));
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1500);
      if (/\/status\//.test(page.url())) break;
      const dlgN = await page.locator('[role="dialog"], [role="alertdialog"]').count().catch(() => 0);
      if (dlgN > 0) {
        const label = await clickDialogConfirm(page, /publish|yes|confirm|发布/);
        if (label) { confirmed = true; steps.push('confirm clicked: ' + label); break; }
      }
    }
    if (confirmed) break;
    await page.waitForTimeout(1500);
  }
  let finalUrl = page.url();
  for (let i = 0; i < 12 && !/\/status\//.test(finalUrl); i++) { await page.waitForTimeout(2000); finalUrl = page.url(); }
  return { confirmed, finalUrl, publishedUrl: /\/status\//.test(finalUrl) ? finalUrl : null, steps };
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const out = { steps: [] };

  await page.goto('https://x.com/compose/articles', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  let entered = false;
  for (let round = 0; round < 3 && !entered; round++) {
    const rect = await page.evaluate(() => {
      const x = Array.from(document.querySelectorAll('button, a, div[role="button"]'))
        .find((e) => (e.getAttribute('aria-label') || '') === 'create' || /create article/i.test(e.innerText || ''));
      if (!x) return null;
      const r = x.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (rect && rect.x) await page.mouse.click(rect.x, rect.y).catch(() => {});
    await page.waitForTimeout(5000);
    entered = /\/compose\/articles\/edit\//.test(page.url());
  }
  await page.waitForTimeout(2500);
  if (!/\/compose\/articles\/edit\//.test(page.url())) throw new Error('no editor: ' + page.url());
  const editUrl = page.url();
  out.steps.push('editor ok');

  await page.locator('textarea[placeholder="Add a title"]').first().fill(TITLE);
  await page.locator('div[data-testid="composer"][contenteditable="true"]').first().click();
  await page.keyboard.insertText('终检内容，验证修复后的发布通道，随即删除。');
  await page.waitForTimeout(2000);

  out.publish = await publishConfirm(page);

  // verify in Published tab
  await page.goto('https://x.com/compose/articles', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const tab = page.getByText('Published', { exact: true }).first();
  if (await tab.count()) { await tab.click().catch(() => {}); await page.waitForTimeout(5000); }
  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  out.publishedFound = body.includes(TITLE);
  out.steps.push('publishedFound: ' + out.publishedFound);

  // delete (robust: menu -> dialog confirm via mouse click)
  await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const more = page.locator('button[aria-label="More"]').first();
  let cleaned = 'no-more';
  if (await more.count()) {
    await more.click({ force: true, timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const del = page.getByText('Delete Article', { exact: true }).first();
    if (await del.count()) {
      await del.click({ timeout: 12000 });
      await page.waitForTimeout(2500);
      const label = await clickDialogConfirm(page, /delete|删除/);
      cleaned = label ? 'deleted' : 'no-confirm';
      await page.waitForTimeout(3000);
    } else cleaned = 'no-delete-item';
  }
  out.cleanup = cleaned;
  out.steps.push('cleanup: ' + cleaned);
  console.log(JSON.stringify(out, null, 2));
  await page.close();
  await browser.close();
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
