'use strict';
// End-to-end self-test of the X Articles channel:
// create scratch -> (optional) insert inline image(s) -> publishConfirm -> verify in Published -> delete.
// Usage: node x_article_selftest.js [image1.jpg image2.png ...]
const fs = require('fs');
const { chromium } = require('playwright');
const IMAGES = process.argv.slice(2).filter((f) => fs.existsSync(f));
const TITLE = 'ZZ 发布通道自检（马上删除）';

async function articleRectClick(page, finderSrc) {
  const rect = await page.evaluate((src) => {
    const el = (new Function('return (' + src + ')'))();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, finderSrc).catch(() => null);
  if (!rect || !rect.x) return false;
  await page.mouse.click(rect.x, rect.y).catch(() => {});
  return true;
}

// Insert -> Media 临时生成的正文媒体 input（accept 含 video/mp4）；常驻那个是封面槽，别用
async function openArticleMediaInput(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await articleRectClick(page, "Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label')||'')==='Add Media' || /^Insert$/i.test((b.innerText||'').trim()))");
    await page.waitForTimeout(1200);
    for (let t = 0; t < 3; t++) {
      await articleRectClick(page, "(() => { const m = Array.from(document.querySelectorAll('[role=\"menuitem\"]')).find(e => (e.innerText||'').trim()==='Media'); if (m) return m; const alt = Array.from(document.querySelectorAll('[role=\"menu\"] div, [role=\"menu\"] span')).filter(e => (e.innerText||'').trim()==='Media'); return alt[0]||null; })()");
      await page.waitForTimeout(1500);
      const idx = await page.evaluate(() => Array.from(document.querySelectorAll('input[type="file"]')).findIndex((i) => /video\/mp4/.test(i.getAttribute('accept') || '')));
      if (idx >= 0) return idx;
    }
  }
  return -1;
}

async function insertArticleImages(page, files) {
  const countImgs = () => page.evaluate(() => document.querySelectorAll('div[data-testid="composer"][contenteditable="true"] img').length);
  await page.keyboard.press('Control+Home').catch(() => {});
  await page.waitForTimeout(600);
  let inserted = 0;
  for (const f of files) {
    const before = await countImgs();
    const idx = await openArticleMediaInput(page);
    if (idx < 0) break;
    await page.locator('input[type="file"]').nth(idx).setInputFiles(f).catch(() => {});
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1500);
      if ((await countImgs()) > before) { inserted++; break; }
      const dlgN = await page.locator('[role="dialog"], [role="alertdialog"]').count().catch(() => 0);
      if (dlgN > 0) await clickDialogConfirm(page, /apply|应用/);
    }
  }
  return inserted;
}

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
  for (const p of ['自检内容第一段。', '第二段：验证正文图片插入。']) {
    await page.keyboard.insertText(p);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1500);

  // 可选：正文插图（传了图片路径才跑）
  if (IMAGES.length) {
    out.imgsInserted = await insertArticleImages(page, IMAGES);
    out.imgsA = (out.imgsInserted === IMAGES.length) ? 'ok' : 'WARN expected ' + IMAGES.length;
    out.steps.push(`inline images: ${out.imgsInserted}/${IMAGES.length} ${out.imgsA}`);
  }

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
