'use strict';
// Open WeChat MP login page in a NEW tab and LEAVE IT OPEN for the user to scan the QR.
const { chromium } = require('playwright');
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  try {
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
    await page.bringToFront().catch(() => {});
    console.log('opened:', page.url());
    // detach only — tab stays open in Chrome
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
