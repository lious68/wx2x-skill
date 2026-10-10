'use strict';
// wx2x.js — 公众号 → X 文章搬运流水线（参考实现·脱敏版）
//
// 命令：
//   node wx2x.js sync                同步公众号文章列表 + 扫描 X 主页去重，打印摘要
//   node wx2x.js run                 定时任务入口：sync + 按节奏自动发帖（幂等）
//   node wx2x.js post <url|标题片段>  立即搬运指定一篇
//   node wx2x.js status              打印状态摘要
//
// 节奏（用户约定）：
//   - 当天新文章：检查到就发（最高优先）
//   - 历史欠账：从最旧开始按时间顺序补齐（补完后 X 主页时间线与公众号一致）
//   - 补账期每日上限 DAILY_CAP_BACKFILL 篇，补完后每日上限 DAILY_CAP_NORMAL 篇
//   - 每次 run 最多发 RUN_CAP 篇，同一次 run 内两篇间隔 WITHIN_RUN_GAP_MS
//
// 发帖形式（用户约定）：长文发全文 = 标题 + 正文全文 + 原文链接 + 文中前 4 张图作配图

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const WORKDIR = process.env.WX2X_WORKDIR || __dirname;
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const X_PROFILE = process.env.X_PROFILE || 'https://x.com/YOUR_X_HANDLE';
const ARTS_FILE = path.join(WORKDIR, 'wx_articles.json');
const STATE_FILE = path.join(WORKDIR, 'wx2x_state.json');
const LOG_FILE = path.join(WORKDIR, 'wx2x_log.jsonl');
const MEDIA_DIR = path.join(WORKDIR, '_wx2x_media');

// ---- 节奏参数 ----
// 2026-10-05 用户改口：历史欠账先不补了，只搬从现在起新发的文章。
const BACKFILL_ENABLED = false;    // 历史补搬开关（用户叫停）
const RUN_CAP = 2;                 // 单次 run 最多发几篇
const DAILY_CAP_BACKFILL = 6;      // 补账期每日上限（仅 BACKFILL_ENABLED 时生效）
const DAILY_CAP_NORMAL = 4;        // 正常期每日上限（当天新文章全部要发，这里只是安全阀）
const WITHIN_RUN_GAP_MS = 5 * 60 * 1000;
// (1) 不规则节奏：两篇文章之间随机隔 2.5–6 小时，不再跟着整点走
const PUB_GAP_MIN_MS = 2.5 * 3600 * 1000;
const PUB_GAP_MAX_MS = 6.0 * 3600 * 1000;
// (2) 与评论流水线互斥：发文后静默一段时间；评论正在发帖时本轮不发
const HOLD_FILE = path.join(WORKDIR, '_hold_until.txt');
const COMMENT_LOG = path.join(WORKDIR, 'campaign_log.jsonl');
const CAMPAIGN_STATE = path.join(WORKDIR, 'campaign_state.json');
const WX_LOCK = path.join(WORKDIR, 'wx2x.lock');
const WX_ALERT = path.join(WORKDIR, 'wx2x_NEEDS_LOGIN.txt');
// 长文走 Articles 时，发布不成功会留下草稿；写这个告警文件名示“需人工收尾”，
// 并暂停后续长文搬运，避免草稿越堆越多。
const ART_ALERT = path.join(WORKDIR, 'wx2x_NEEDS_MANUAL_ARTICLE.txt');
const REPORTS = path.join(WORKDIR, 'reports');

// ---- 运行锁：防止两个定时器同时跑出重复发文 ----
function takeLock() {
  try {
    const st = JSON.parse(fs.readFileSync(WX_LOCK, 'utf8'));
    if (st && st.ts && Date.now() - st.ts < 20 * 60 * 1000 && isAlive(st.pid)) return false;
  } catch (e) {}
  fs.writeFileSync(WX_LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8');
  return true;
}
function releaseLock() { try { fs.unlinkSync(WX_LOCK); } catch (e) {} }
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
// ---- 掉线告警：登录失效时留痕，恢复后自动清除 ----
function raiseLoginAlert(err) {
  const msg = String(err || '');
  if (!/MP_NO_TOKEN|MP_BAD_JSON|未登录|login/i.test(msg)) return false;
  try { fs.writeFileSync(WX_ALERT, `${new Date().toISOString()}\n${msg}\n`, 'utf8'); } catch (e) {}
  return true;
}
function clearLoginAlert() { try { fs.unlinkSync(WX_ALERT); } catch (e) {} }
function wxReport(line) {
  try {
    if (!fs.existsSync(REPORTS)) fs.mkdirSync(REPORTS, { recursive: true });
    const f = path.join(REPORTS, `wx2x_${localDate().replace(/-/g, '')}.md`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, `# wx2x ${localDate()}\n`, 'utf8');
    fs.appendFileSync(f, line + '\n', 'utf8');
  } catch (e) {}
}
const MAX_TEXT = 24000;            // 长文截断阈值（X Premium 上限 25000）
const MAX_IMAGES = 4;
const IMG_MIN_BYTES = 15 * 1024;   // 小于该尺寸的图视为装饰图，跳过

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p, def) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } };
const PJ = (v) => (typeof v === 'string' ? (v ? JSON.parse(v) : {}) : (v || {}));
function log(obj) { fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf8'); }
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function normTitle(t) {
  return (t || '').toLowerCase().replace(/[\s\u3000《》「」【】（）()【】！？，。：；、"'“”‘’\-—_:：!?,.?…*#|/\\~`@%^&+=\[\]{}<>]/g, '').slice(0, 24);
}

// ---------- Chrome / CDP ----------
async function cdpAlive() {
  try { const res = await fetch(CDP + '/json/version'); return res.ok; } catch { return false; }
}
async function ensureChrome() {
  if (await cdpAlive()) return { ok: true, launched: false };
  const args = [
    '--user-data-dir=' + (process.env.CHROME_USER_DATA_DIR || 'C:/path/to/chrome-user-data'),
    '--profile-directory=' + (process.env.CHROME_PROFILE_DIR || 'Default'),
    '--remote-debugging-port=9222',
    '--no-first-run', '--no-default-browser-check',
    'https://x.com/home',
  ];
  spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args, { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 12; i++) {
    await sleep(2500);
    if (await cdpAlive()) return { ok: true, launched: true };
  }
  return { ok: false, error: 'chrome did not come up on :9222' };
}
async function withBrowser(fn) {
  const browser = await chromium.connectOverCDP(CDP);
  try {
    return await fn(browser.contexts()[0]);
  } finally {
    await browser.close(); // disconnect only
  }
}

// ---------- 公众号文章列表 ----------
function mpPage(ctx) {
  return ctx.pages().find((p) => /mp\.weixin\.qq\.com/.test(p.url()));
}
async function fetchWxArticles(ctx) {
  let page = mpPage(ctx);
  if (!page) {
    page = await ctx.newPage();
    await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
  }
  const token = new URL(page.url()).searchParams.get('token');
  if (!token) throw new Error('MP_NO_TOKEN: 公众号后台未登录，需要重新扫码');
  const call = (qs) => page.evaluate(async ({ qs, token }) => {
    const r = await fetch(`/cgi-bin/appmsgpublish?${qs}&f=json&ajax=1&token=${token}&lang=zh_CN`, {
      credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return await r.text();
  }, { qs, token });

  const arts = [];
  // 源1：发表记录（appmsgpublish type=1，分页）
  for (const begin of [0, 20, 40, 60, 80]) {
    const raw = await call(`sub=list&begin=${begin}&count=20&type=1`);
    let pp;
    try { const j = PJ(raw); pp = PJ(j.publish_page); } catch { throw new Error('MP_BAD_JSON: 后台会话可能过期，需重新扫码'); }
    const items = pp.publish_list || [];
    for (const it of items) {
      const info = PJ(it.publish_info);
      const create = info.publish_info ? PJ(info.publish_info).create_time : null;
      for (const app of info.appmsg_info || []) {
        arts.push({ title: app.title, url: app.content_url, digest: (app.digest || '').slice(0, 200), cover: app.cover, pub_ts: create, source: 'publish' });
      }
    }
    if (items.length < 20) break;
  }
  // 源2：群发历史（masssendpage，分页）
  for (const begin of [0, 20, 40]) {
    const raw = await page.evaluate(async ({ token, begin }) => {
      const r = await fetch(`/cgi-bin/masssendpage?t=masssend/history&action=history&begin=${begin}&count=20&f=json&ajax=1&token=${token}&lang=zh_CN`, {
        credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      return await r.text();
    }, { token, begin });
    let items = [];
    try { items = PJ(PJ(raw).msg_items).msg_item || []; } catch { throw new Error('MP_BAD_JSON: 后台会话可能过期，需重新扫码'); }
    for (const it of items) {
      const multi = PJ(it.multi_item);
      const list = Array.isArray(multi) ? multi : Object.values(multi || {});
      const subs = list.length ? list : [{ title: it.title, content_url: it.content_url, digest: it.desc }];
      for (const s of subs) {
        if (!s || !s.title) continue;
        arts.push({ title: s.title, url: s.content_url, digest: (s.digest || s.desc || '').slice(0, 200), cover: s.cover, pub_ts: it.date_time, source: 'masssend' });
      }
    }
    if (items.length < 20) break;
  }
  // 去重（按规范化标题；同标题同日视为同一篇）
  const seen = new Map();
  for (const a of arts) {
    const key = normTitle(a.title);
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev) { seen.set(key, a); continue; }
    // 保留 URL 更短的（/s/ 短链优先）
    if ((a.url || '').length < (prev.url || '').length) seen.set(key, { ...a, url: a.url, pub_ts: prev.pub_ts || a.pub_ts });
  }
  const list = [...seen.values()].sort((x, y) => (y.pub_ts || 0) - (x.pub_ts || 0));
  fs.writeFileSync(ARTS_FILE, JSON.stringify(list, null, 2), 'utf8');
  return list;
}

// ---------- X 主页扫描（去重用） ----------
async function scanXProfile(ctx, { maxScrolls = 40 } = {}) {
  const page = await ctx.newPage();
  try {
    page.setDefaultTimeout(45000);
    await page.goto(X_PROFILE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    let lastCount = -1, empty = 0;
    const texts = [];
    for (let i = 0; i < maxScrolls; i++) {
      const batch = await page.$$eval('article[data-testid="tweet"]', (arts) =>
        arts.map((a) => {
          const t = a.querySelector('div[data-testid="tweetText"]')?.innerText || '';
          const link = a.querySelector('a[href*="/status/"] time');
          return { text: t.slice(0, 600), statusUrl: link ? link.closest('a').href : '' };
        })
      );
      for (const b of batch) if (b.text && !texts.some((x) => x.statusUrl === b.statusUrl)) texts.push(b);
      if (texts.length === lastCount) { empty++; if (empty >= 3) break; } else empty = 0;
      lastCount = texts.length;
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(2200);
    }
    return texts;
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- 文章正文与图片 ----------
async function extractArticle(ctx, url) {
  const page = await ctx.newPage();
  try {
    page.setDefaultTimeout(60000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const data = await page.evaluate(() => {
      const box = document.querySelector('#js_content') || document.querySelector('.rich_media_content');
      const title = (document.querySelector('#activity-name') || document.querySelector('h1'))?.innerText?.trim() || document.title;
      if (!box) return { title, body: '', imgs: [], noContent: true };
      let body = box.innerText || '';
      const imgs = [];
      for (const img of box.querySelectorAll('img')) {
        const u = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (/mmbiz|qpic\.cn|wx_fmt/i.test(u) && !imgs.includes(u)) imgs.push(u);
      }
      // 公众号的小标题通常是加粗段落：innerText 丢了加粗，得自己捞。
      // 两种写法都要收：<strong>/<b> 标签，以及行内 font-weight>=600 的 span。
      const bolds = [];
      const addBold = (t) => {
        const s = (t || '').replace(/\s+/g, ' ').trim();
        if (s && s.length <= 40 && !bolds.includes(s)) bolds.push(s);
      };
      for (const el of box.querySelectorAll('strong, b')) addBold(el.innerText);
      for (const el of box.querySelectorAll('p, section, div, span')) {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 40) continue;
        const fw = getComputedStyle(el).fontWeight;
        if (fw && (Number(fw) >= 600 || fw === 'bold')) addBold(t);
      }
      return { title, body, imgs, bolds, noContent: false };
    });
    data.body = data.body.replace(/\n{3,}/g, '\n\n').trim();
    // 无正文（音频/视频/图片帖）：跳过
    if (data.noContent || data.body.replace(/\s/g, '').length < 80) {
      data.skip = 'no_text';
    }
    if (data.body.length > MAX_TEXT) data.body = data.body.slice(0, MAX_TEXT) + '\n……（原文过长，正文有截断，请看原文链接）';
    data.url = url;
    return data;
  } finally {
    await page.close().catch(() => {});
  }
}

async function downloadImages(urls) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const out = [];
  for (let i = 0; i < urls.length && out.length < MAX_IMAGES; i++) {
    const u = urls[i];
    try {
      const res = await fetch(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36',
          'Referer': 'https://mp.weixin.qq.com/',
        },
      });
      if (!res.ok) continue;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < IMG_MIN_BYTES) continue;
      let ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : ct.includes('gif') ? '.gif' : '.jpg';
      if (/wx_fmt=png/i.test(u)) ext = '.png';
      else if (/wx_fmt=gif/i.test(u)) ext = '.gif';
      else if (/wx_fmt=webp/i.test(u)) ext = '.webp';
      const p = path.join(MEDIA_DIR, `wx_${Date.now()}_${out.length}${ext}`);
      fs.writeFileSync(p, buf);
      out.push(p);
    } catch (e) {
      log({ action: 'img_fail', url: u, err: e.message.slice(0, 120) });
    }
  }
  return out;
}

// ---------- 版式引擎：公众号正文 → X 推文串 ----------
// X 普通推文不吃 Markdown，公众号那种排版直接搬过去会乱。这里按 X 的可读性重排：
// 短段落 + 空行 + 编号 + 少量 emoji，图片重传，原文链接放最后一条。
const THREAD_MAX_POSTS = 12;   // 一条推文串最多几条（含首条）
const TWEET_SOFT_MAX = 240;    // 单条目标字数（中文按字符）
const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const BOILER_RE = [
  /点击上方.{0,6}(关注|蓝字)/, /点击.{0,4}(卡片|链接|图片)/, /长按.{0,6}(识别|关注)/,
  /扫码|二维码|扫一扫|微信扫一扫/, /阅读原文/, /设为星标|星标一下/,
  /^点(个)?(赞|在看)|点赞|在看|转发|分享|收藏|一键三连/, /关注我们|欢迎关注|敬请关注|请关注/,
  /商务合作|投稿|转载|版权|免责声明|侵权|删文|图片来源/,
  /往期(回顾|推荐)|推荐阅读|更多精彩|点击下方/, /微信号|公众号[:：]|微信号[:：]/,
  /^[-=*·•—_\s]{3,}$/, /^\((来源|编辑|作者|排版)[:：].*\)$/, /^（(来源|编辑|作者|排版)[:：].*）$/,
];
const EMOJI_RULES = [
  [/机器人|具身|人形|机械臂|无人机/, '🤖'],
  [/算力|芯片|GPU|显卡|英伟达|数据中心|推理成本/i, '⚡'],
  [/数据(集|标注|飞轮)|语料/, '📊'],
  [/大模型|模型|LLM|token|智能体|Agent|多模态/i, '🧠'],
  [/代码|编程|开发|开源|GitHub|IDE|框架/i, '💻'],
  [/创业|商业|产品|增长|变现|融资|估值/, '📈'],
  [/政策|监管|合规|裁员|组织/, '📋'],
  [/论文|研究|测评|评测|基准|benchmark/i, '🔬'],
];

function stripMd(t) {
  return String(t || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')       // 粗体
    .replace(/`([^`]+)`/g, '$1')           // 行内代码
    .replace(/^#{1,6}\s*/gm, '')           // 标题井号
    .replace(/^\s*[-*+]\s+/gm, '')         // 无序列表符
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1'); // 链接语法
}
function isBoiler(line) {
  const t = line.trim();
  if (!t) return true;
  return BOILER_RE.some((re) => re.test(t));
}
// 列表编号统一成 emoji 数字（避开 “1.5 倍” 这类小数）
function normalizeNumbering(text) {
  return text
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*(?:[（(]\s*(\d{1,2})\s*[)）]|(\d{1,2})\s*[、.．)）])\s*(\S.*)$/);
      if (!m) return line;
      const n = m[1] ? Number(m[1]) : Number(m[2]);
      const bodyTxt = m[3].trim();
      if (!bodyTxt) return line;
      if (/^\d/.test(bodyTxt)) return line;              // 1.5 / 100.2 这类
      if (n < 1 || n > 9) return `${n}. ${bodyTxt}`;
      return `${NUM_EMOJI[n - 1]} ${bodyTxt}`;
    })
    .join('\n');
}
function pickEmoji(title, body) {
  const hay = `${title}\n${body.slice(0, 1200)}`;
  for (const [re, e] of EMOJI_RULES) if (re.test(hay)) return e;
  return '';
}
// 正文清洗：去噪行、去裸链、归一化空白
function cleanBodyText(body) {
  const lines = stripMd(body)
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/https?:\/\/\S+/g, '')        // 裸链去掉，原文链接统一放最后一条
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !isBoiler(l))
    .filter((l) => l.replace(/[\s。，、,.!！?？~～]/g, '').length > 0);
  return lines.join('\n');
}
function splitLongParagraph(p, max) {
  if (p.length <= max) return [p];
  const parts = p.split(/(?<=[。！？；!?;])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  for (const s of parts) {
    if (buf && (buf + s).length > max) { out.push(buf.trim()); buf = ''; }
    buf += s;
    if (buf.length >= max) { out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  const final = [];
  for (const s of out) {
    if (s.length <= max) { final.push(s); continue; }
    for (let i = 0; i < s.length; i += max) final.push(s.slice(i, i + max));
  }
  return final.filter(Boolean);
}
// 小标题识别：一、/ 二、/ 1️⃣ / 写在最后 / 小结 …… 这类行应当另起一条推文，
// 而且绝不能孤零零留在上一条的末尾（预览时踩过这个坑）。
function isHeading(line) {
  const t = String(line || '').trim();
  if (!t || t.length > 40) return false;
  if (/^[一二三四五六七八九十]{1,3}\s*[、.．)）:]/.test(t)) return true;
  // “第N”必须带显式分隔符才算标题；“第一条，我的是windows…”是正文，别误判
  if (/^第[一二三四五六七八九十\d]{1,3}\s*[、.．)）:：]/.test(t)) return true;
  if (/^[0-9]\uFE0F?\u20E3/.test(t)) return true;
  if (/^(写在(最后|前面|开头)|小结|总结|结语|后记|补充|参考(资料|文献)?|彩蛋)[:：]?$/.test(t)) return true;
  if (/^(写在(最后|前面|开头)|小结|总结|结语|后记|补充|彩蛋)\s*[:：]\s*.{0,16}$/.test(t)) return true;
  return false;
}
function chunkParagraphs(paras, max, isHead = isHeading) {
  const chunks = [];
  let cur = [];
  const lenOf = (arr) => arr.reduce((a, s, i) => a + s.length + (i ? 2 : 0), 0);
  const flush = () => { if (cur.length) chunks.push(cur.join('\n\n')); cur = []; };
  for (const raw of paras) {
    for (const part of splitLongParagraph(raw, max)) {
      if (isHead(part) && cur.length) flush();
      if (cur.length && lenOf(cur) + 2 + part.length > max) {
        let carry = null;
        if (isHead(cur[cur.length - 1])) carry = cur.pop();
        flush();
        if (carry) cur.push(carry);
      }
      cur.push(part);
    }
  }
  flush();
  return mergeTinyChunks(chunks);
}
// 只有几行的碎片（例如刚够算标题的一行）不要单独占一条推文：
// 并入下一条，标题仍然在推文开头。
function mergeTinyChunks(chunks, min = 30, hardMax = 280) {
  const out = [];
  for (const c of chunks) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.length < min && prev.length + 2 + c.length <= hardMax) {
      out[out.length - 1] = `${prev}\n\n${c}`;
    } else {
      out.push(c);
    }
  }
  if (out.length > 1) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.length < min && prev.length + 2 + last.length <= hardMax) {
      out[out.length - 2] = `${prev}\n\n${last}`;
      out.pop();
    }
  }
  return out;
}
function buildThread({ title, body, url, images = [], boldSet = null }) {
  const clean = normalizeNumbering(cleanBodyText(body));
  const paras = clean.split('\n').map((s) => s.trim()).filter(Boolean);
  const t = stripMd(title).replace(/\s+/g, ' ').trim();
  const emoji = pickEmoji(t, clean);
  const isHead = (p) => isHeading(p) || (boldSet ? boldSet.has(p.trim()) : false);
  const chunks = chunkParagraphs(paras, TWEET_SOFT_MAX, isHead);
  const room = THREAD_MAX_POSTS - 1;
  const truncated = chunks.length > room;
  const used = truncated ? chunks.slice(0, room) : chunks;
  const posts = [];
  posts.push({ text: (emoji ? emoji + ' ' : '') + t, images: images.slice(0, MAX_IMAGES) });
  used.forEach((c, i) => {
    let text = c;
    if (i === used.length - 1 && truncated) text += '\n\n……（正文较长，余下看原文）';
    posts.push({ text, images: [] });
  });
  // 外链绝不进推文串：X 对带外链的帖子降权 30–50%（免费号 2025-03 起中位互动几乎归零）。
  // 链接改由发送成功后的**自回复**承载，整串保持零外链。
  return { posts, emoji, truncated, paragraphs: paras.length, paras, linkReply: `原文：${url}` };
}
function threadDigest(posts) {
  return posts.map((p, i) => ({ n: i + 1, chars: p.text.length, imgs: (p.images || []).length, head: p.text.slice(0, 42).replace(/\n/g, ' ⏎ ') }));
}

// ---------- X 发推文串 ----------
// 串式编辑器实测：写入第 N 条后出现 addButton，点击生成 tweetTextarea_(N+1)；
// fileInput 全编辑器共用（不随条数增加），所以图片统一挂首条。
async function composeThread(ctx, posts) {
  const page = await ctx.newPage();
  try {
    page.setDefaultTimeout(60000);
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    for (let i = 0; i < posts.length; i++) {
      if (i > 0) {
        const add = page.locator('button[data-testid="addButton"]').first();
        await add.waitFor({ timeout: 20000 });
        await add.click();
        await page.waitForTimeout(1200);
      }
      const box = page.locator(`div[data-testid="tweetTextarea_${i}"]`).first();
      await box.waitFor({ timeout: 30000 });
      await box.click();
      await page.keyboard.insertText(posts[i].text);
      await page.waitForTimeout(700);
      if (posts[i].images && posts[i].images.length) {
        const fileInput = page.locator('input[data-testid="fileInput"]').first();
        await fileInput.setInputFiles(posts[i].images);
        for (let k = 0; k < 45; k++) {
          const n = await page.locator('div[data-testid="attachments"] img').count();
          if (n >= posts[i].images.length) break;
          await page.waitForTimeout(2000);
        }
        await page.waitForTimeout(2500);
      }
    }
    const submit = page.locator('button[data-testid="tweetButton"]').first();
    const enabled = await submit.isEnabled().catch(() => false);
    if (!enabled) return { ok: false, note: 'tweetButton disabled（超字数/未登录/无 Premium）' };
    await submit.click();
    await page.waitForTimeout(12000);
    let toast = '';
    if (await page.locator('[data-testid="toast"]').count()) {
      toast = (await page.locator('[data-testid="toast"]').first().innerText()).slice(0, 150);
    }
    return { ok: true, toast, note: `thread submitted (${posts.length} posts)` };
  } catch (e) {
    return { ok: false, note: 'error: ' + e.message.split('\n')[0].slice(0, 200) };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- X Articles（长文走这条） ----------
// 实测（2026-10-06）：x.com/compose/articles 点 create 进 compose/articles/edit/<id>；
// 标题 textarea[placeholder="Add a title"]；正文 div[data-testid="composer"][contenteditable=true]（Draft.js）；
// 段落样式按钮 aria-label = Body/Heading/Subheading，菜单项 Heading/Subheading/Body；
// 图片 input[data-testid="fileInput"]；发布 button "Publish"，确认弹窗按钮是 "Yes, delete" 的同族。
// 注意：X 的菜单项吃真实鼠标事件，page.evaluate 里的 element.click() 无效。
// 段落样式按钮**没有 aria-label**，文字就是当前样式（Body/Heading/Subheading），所以按文字选。
async function setArticleStyle(page, name) {
  const cur = page.locator('button').filter({ hasText: /^(Body|Heading|Subheading)$/ }).first();
  if (!(await cur.count())) return false;
  await cur.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const item = page.getByText(name, { exact: true }).first();
  if (await item.count()) {
    await item.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(700);
    return true;
  }
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

// 在可见 dialog 里找确认键并用真实鼠标坐标点击（X 按钮吃真实鼠标事件；
// 文案可能挂在 aria-label 上，innerText 会是空串）。
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

// 点 Publish 并走完发布（实测 2026-10-06）：
// ① 新输入后 Publish 会先 disabled（等自动保存），点 disabled 按钮无效——要等解禁；
// ② 第一次点击常被吞掉，需要重试点击；
// ③ 确认弹窗时有时无（有的话按钮是 ["", "Publish"]，且页面常有隐藏 dialog 干扰 .first() 判定）；
// ④ 发布成功会跳到文章的 /status/ 页——以它为最终判据。
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
  if (!enabled) return { confirmed: false, finalUrl: page.url(), publishedUrl: null, steps: ['publish button stayed disabled (autosave 未完成/内容校验不过)'] };
  let confirmed = false;
  for (let round = 0; round < 3 && !/\/status\//.test(page.url()); round++) {
    await pub.click({ force: true }).catch((e) => steps.push('click err: ' + e.message.split('\n')[0].slice(0, 50)));
    steps.push('publish click #' + (round + 1));
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1500);
      if (/\/status\//.test(page.url())) break; // 没弹窗直接发布了
      const dlgN = await page.locator('[role="dialog"], [role="alertdialog"]').count().catch(() => 0);
      if (dlgN > 0) {
        const label = await clickDialogConfirm(page, /publish|yes|confirm|发布/);
        if (label) {
          confirmed = true;
          steps.push('confirm clicked: ' + label);
          break;
        }
      }
    }
    if (confirmed) break;
    await page.waitForTimeout(1500);
  }
  let finalUrl = page.url();
  for (let i = 0; i < 12 && !/\/status\//.test(finalUrl); i++) {
    await page.waitForTimeout(2000);
    finalUrl = page.url();
  }
  return { confirmed, finalUrl, publishedUrl: /\/status\//.test(finalUrl) ? finalUrl : null, steps };
}

// 兜底自愈：重新打开草稿编辑页，再走一次发布
async function retryPublishArticle(ctx, editUrl) {
  const page = await ctx.newPage();
  try {
    page.setDefaultTimeout(60000);
    await page.goto(editUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    if (!/\/edit\//.test(page.url())) return { ok: false, note: 'editUrl 打不开: ' + page.url() };
    await page.keyboard.press('Escape').catch(() => {});
    // 已经发布过的编辑页没有 Publish 按钮（显示 "Unpublish, move to drafts"），别傻等超时
    const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
    const hasPubBtn = await page.getByRole('button', { name: 'Publish', exact: true }).count().catch(() => 0);
    if (!hasPubBtn && /Unpublish|已发布/i.test(bodyText)) {
      return { ok: true, alreadyPublished: true, steps: ['edit page already published (no Publish button)'] };
    }
    const pubRes = await publishConfirm(page);
    return { ok: !!pubRes.publishedUrl || pubRes.confirmed, ...pubRes };
  } catch (e) {
    return { ok: false, note: 'retryPublish error: ' + e.message.split('\n')[0].slice(0, 120) };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- Articles 正文插图（2026-10-10 跑通） ----------
// 通用：按 DOM 里找到的元素中心点做真实鼠标点击（X 的按钮只吃真实鼠标事件）
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

// 打开 Insert → Media，返回**正文媒体 input** 的下标（accept 含 video/mp4 的那个），失败 -1。
// 踩过的坑：编辑器里常驻的 file input 是封面槽（accept 只有图片、挂 Section details 下），
// 往它上传只会改封面、正文里不会出现图——所以必须走菜单拿到临时生成的那个 input，且每张图都要重走菜单。
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

// 往正文插图：图位跟随光标，先 Ctrl+Home 回正文开头，图会落在开头几段附近（当视觉头图）
async function insertArticleImages(page, files) {
  if (!files || !files.length) return 0;
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
      // 少数情况会弹 Edit media，点 Apply（同样要真实鼠标）
      const dlgN = await page.locator('[role="dialog"], [role="alertdialog"]').count().catch(() => 0);
      if (dlgN > 0) await clickDialogConfirm(page, /apply|应用/);
    }
  }
  return inserted;
}

async function composeArticle(ctx, { title, paras, url, images = [], boldSet = null, dryRun = false }) {
  const page = await ctx.newPage();
  let step = 'boot';
  try {
    page.setDefaultTimeout(60000);
    step = 'goto articles';
    await page.goto('https://x.com/compose/articles', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    step = 'click create';
    // create 按钮也吃真实鼠标事件（evaluate click 无效），用坐标点击 + 重试
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
      else {
        const create = page.locator('button[aria-label="create"]').first();
        if (await create.count()) await create.click({ force: true }).catch(() => {});
      }
      await page.waitForTimeout(5000);
      entered = /\/compose\/articles\/edit\//.test(page.url());
    }
    await page.waitForTimeout(2500);
    if (!/\/compose\/articles\/edit\//.test(page.url())) throw new Error('没能进入 Articles 编辑器: ' + page.url());
    const editUrl = page.url();

    step = 'title';
    const titleBox = page.locator('textarea[placeholder="Add a title"]').first();
    await titleBox.waitFor({ timeout: 30000 });
    try { await titleBox.fill(title); } catch (e) { await titleBox.click(); await page.keyboard.insertText(title); }
    await page.waitForTimeout(1000);

    step = 'focus body';
    const body = page.locator('div[data-testid="composer"][contenteditable="true"]').first();
    await body.click();
    await page.waitForTimeout(600);

    // 正文图片（2026-10-10 跑通）：编辑器里常驻的 file input 是**封面槽**（accept 只有图片、
    // multiple=false、挂在 "Section details" 下）；往正文插图的 input 是点
    // Insert(aria-label="Add Media") → Media 之后临时生成的（accept 含 video/mp4），
    // 每插一张都要重新走一遍菜单（见 openArticleMediaInput）。
    // 原文链接不写进正文，统一由发布后的自回复承载（避免外链降权）。
    let headings = 0;
    const isHead = (p) => isHeading(p) || (boldSet ? boldSet.has(p.trim()) : false);
    for (const p of paras) {
      step = 'body para: ' + p.slice(0, 18);
      const head = isHead(p);
      await page.keyboard.insertText(p);
      await page.waitForTimeout(120);
      if (head && (await setArticleStyle(page, 'Heading'))) headings++;
      await page.keyboard.press('Enter');
      // 关键：Heading 样式会往后串染，换行后必须把新段落恢复成 Body
      if (head) await setArticleStyle(page, 'Body');
      await page.waitForTimeout(150);
    }
    // 原文链接不写进正文：和推文串一样，链接交给发布后的自回复（避免外链降权）
    let imgsInserted = 0;
    if (images.length) {
      step = 'insert images';
      imgsInserted = await insertArticleImages(page, images.slice(0, MAX_IMAGES)).catch(() => 0);
    }
    await page.waitForTimeout(1000);

    // 演练：回读编辑器内容后删掉草稿，绝不发布
    if (dryRun) {
      const snap = await page.evaluate(() => {
        const ed = document.querySelector('div[data-testid="composer"][contenteditable="true"]');
        const blocks = ed
          ? Array.from(ed.querySelectorAll('[data-block="true"]')).map((b) => {
              const st = (b.className.match(/longform-([a-z]+)/) || [])[1] || '?';
              return `${st}: ${(b.innerText || '').trim().slice(0, 24)}`;
            })
          : [];
        return {
          title: document.querySelector('textarea[placeholder="Add a title"]')?.value || '',
          blocks,
          inlineImages: ed ? ed.querySelectorAll('img').length : 0,
          words: (document.body.innerText.match(/(\d+)\s+words/) || [])[1] || null,
        };
      });
      // 演练也把发布弹窗点开看一眼，然后 Close 掉（绝不点 Publish）
      step = 'open publish dialog';
      let dialogText = '';
      try {
        const pubBtn = page.getByRole('button', { name: 'Publish', exact: true }).first();
        if (await pubBtn.count()) {
          await pubBtn.click({ timeout: 20000 });
          await page.waitForTimeout(4000);
          dialogText = await page.evaluate(() => {
            const d = Array.from(document.querySelectorAll('[role="dialog"]')).filter((x) => x.offsetParent !== null)[0];
            return d ? (d.innerText || '').replace(/\s+/g, ' ').slice(0, 160) : '';
          });
          const close = page.getByRole('button', { name: 'Close', exact: true }).first();
          if (await close.count()) await close.click().catch(() => {});
          await page.waitForTimeout(1500);
        }
      } catch (e) {
        dialogText = 'publish dialog error: ' + e.message.split('\n')[0].slice(0, 60);
      }
      const more = page.locator('button[aria-label="More"]').first();
      step = 'cleanup draft';
      let cleaned = 'skipped';
      if (await more.count()) {
        try {
          await more.click({ force: true, timeout: 12000 });
          cleaned = 'menu-open';
          await page.waitForTimeout(1500);
          const del = page.getByText('Delete Article', { exact: true }).first();
          if (await del.count()) {
            await del.click({ timeout: 12000 });
            cleaned = 'delete-clicked';
            await page.waitForTimeout(2000);
            // 确认键文案两种都见过：草稿 "Yes, delete"，已发布 "Delete Article"；统一按 delete 匹配 + 鼠标坐标点
            const label = await clickDialogConfirm(page, /delete|删除/);
            if (label) { await page.waitForTimeout(3000); cleaned = 'deleted'; }
          }
        } catch (e) {
          cleaned = 'failed: ' + e.message.split('\n')[0].slice(0, 60);
        }
      }
      return { ok: true, dryRun: true, note: `dry run (paras=${paras.length}, headings=${headings}, imgs=${imgsInserted} 已插入正文, cleanup=${cleaned})`, snapshot: snap, publishDialog: dialogText, cleanup: cleaned };
    }

    step = 'publish';
    const pubRes = await publishConfirm(page);
    return {
      ok: true,
      editUrl,
      publishedUrl: pubRes.publishedUrl,
      imgsInserted,
      note: `article submitted (paras=${paras.length}, headings=${headings}, imgs=${imgsInserted} 已插入正文) publish: ${pubRes.steps.join(' -> ')}`,
    };
  } catch (e) {
    return { ok: false, step, note: 'error@' + step + ': ' + e.message.replace(/\s+/g, ' ').slice(0, 400) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function verifyArticle(ctx, title) {
  const key = normTitle(title).slice(0, 16);
  const page = await ctx.newPage();
  try {
    page.setDefaultTimeout(60000);
    await page.goto('https://x.com/compose/articles', { waitUntil: 'domcontentloaded' });
    // 发布后条目进 Published 列表有延迟（2026-10-07 实测发布成功但首轮校验没等到），
    // 分 3 轮校验，每轮等 15s 再切一次 Published 标签
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForTimeout(attempt === 0 ? 5000 : 15000);
      const tab = (await page.getByRole('tab', { name: 'Published' }).count())
        ? page.getByRole('tab', { name: 'Published' }).first()
        : page.getByText('Published', { exact: true }).first();
      if (await tab.count()) { await tab.click().catch(() => {}); await page.waitForTimeout(5000); }
      const items = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="/compose/articles/edit/"]')).map((a) => ({
          url: a.href,
          text: (a.innerText || '').replace(/\s+/g, ' '),
        }))
      );
      const hit = items.find((t) => normTitle(t.text).includes(key));
      if (hit) return { found: true, articleUrl: hit.url };
      // 兜底：Published 页正文里出现标题也算（个别版本列表链接结构不同）
      const body = (await page.locator('body').innerText().catch(() => '')) || '';
      if (normTitle(body).includes(key)) return { found: true, articleUrl: '' };
    }
    return { found: false };
  } catch (e) {
    return { found: false, err: e.message.split('\n')[0].slice(0, 100) };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- X 发长文 ----------
async function composePost(ctx, { text, images = [] }) {
  const page = await ctx.newPage();
  try {
    page.setDefaultTimeout(60000);
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const box = page.locator('div[data-testid="tweetTextarea_0"]').first();
    await box.waitFor({ timeout: 30000 });
    await box.click();
    await page.keyboard.insertText(text);
    await page.waitForTimeout(1500);
    if (images.length) {
      const fileInput = page.locator('input[data-testid="fileInput"]').first();
      await fileInput.setInputFiles(images);
      // 等待上传完成
      for (let i = 0; i < 45; i++) {
        const n = await page.locator('div[data-testid="attachments"] img').count();
        const busy = await page.locator('[data-testid="fileInput"]').count();
        if (n >= images.length) break;
        await page.waitForTimeout(2000);
      }
      await page.waitForTimeout(3000);
    }
    const submit = page.locator('button[data-testid="tweetButton"]').first();
    const enabled = await submit.isEnabled().catch(() => false);
    if (!enabled) {
      return { ok: false, note: 'tweetButton disabled（可能超字数或未登录/无 Premium）' };
    }
    await submit.click();
    await page.waitForTimeout(10000);
    const toastCount = await page.locator('[data-testid="toast"]').count();
    let toast = '';
    if (toastCount) toast = (await page.locator('[data-testid="toast"]').first().innerText()).slice(0, 150);
    return { ok: true, toast, note: 'submit clicked' }; // 最终成败由 postOne 主页验证决定
  } catch (e) {
    return { ok: false, note: 'error: ' + e.message.slice(0, 200) };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- 原文链接自回复 ----------
// 为什么单独发一条回复而不是写进串里：见 buildThread 里的注释（外链降权 30–50%）。
// tailOf=true 时会先在同一条会话里找到**串尾**那条再回复，让链接落在读完整串的人脚下；
// 找不到就用传入的 URL 本身兜底。整条路径非致命：失败只记日志，不影响已发成功的串。
async function replyToPost(ctx, targetUrl, text, { tailOf = false, dryRun = false } = {}) {
  const page = await ctx.newPage();
  try {
    page.setDefaultTimeout(60000);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const focalId = (targetUrl.split('/status/')[1] || '').split(/[?/]/)[0];
    let target = targetUrl;
    if (tailOf && focalId) {
      const handle = (targetUrl.match(/x\.com\/([^/]+)\//) || [])[1] || '';
      // 自串的续帖在详情页里是**连续**排下来的，遇到别人的帖子就断。
      // 不能简单取"ID 最大的自己的帖"——我们回复别人的对话帖也会出现在同页、ID 更大（实测踩过）。
      const tailIds = await page.$$eval(
        'article[data-testid="tweet"]',
        (arts, arg) => {
          const [h, focal] = arg;
          const out = [];
          for (let i = 1; i < arts.length; i++) {
            const link = arts[i].querySelector('a[href*="/status/"] time')?.closest('a')?.href || '';
            const id = (link.split('/status/')[1] || '').split(/[?/]/)[0];
            if (!link.includes('/' + h + '/status/') || !/^\d+$/.test(id)) break;
            if (id === focal) continue;   // 详情页会把焦点帖自己再渲染一次，跳过
            if (!out.includes(id)) out.push(id);
          }
          return out;
        },
        [handle, focalId]
      ).catch(() => []);
      if (tailIds.length) target = `https://x.com/${handle}/status/${tailIds[tailIds.length - 1]}`;
    }
    if (target !== targetUrl) {
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
    }
    const replyBtn = page.locator('article[data-testid="tweet"] [data-testid="reply"]').first();
    await replyBtn.waitFor({ timeout: 30000 });
    await replyBtn.click();
    await page.waitForTimeout(2500);
    const box = page.locator('div[data-testid="tweetTextarea_0"]').first();
    await box.waitFor({ timeout: 30000 });
    await box.click();
    await page.keyboard.insertText(text);
    await page.waitForTimeout(1500);
    const submit = page.locator('button[data-testid="tweetButton"]').first();
    const enabled = await submit.isEnabled().catch(() => false);
    if (!enabled) return { ok: false, target, note: '回复按钮不可用（未登录/超字数）' };
    if (dryRun) return { ok: true, target, dryRun: true, note: 'dry run：已打字到回复框，未发送' };
    await submit.click();
    await page.waitForTimeout(8000);
    const dialogLeft = await page.locator('div[role="dialog"]').count();
    const toastCount = await page.locator('[data-testid="toast"]').count();
    const toast = toastCount ? (await page.locator('[data-testid="toast"]').first().innerText()).slice(0, 120) : '';
    const ok = dialogLeft === 0 && !/went wrong|出错|失败|错误|稍后/i.test(toast);
    return { ok, target, toast, note: ok ? 'link reply posted' : `回复未确认 dialog=${dialogLeft} toast=${toast}` };
  } catch (e) {
    return { ok: false, target: targetUrl, note: 'error: ' + e.message.split('\n')[0].slice(0, 160) };
  } finally {
    await page.close().catch(() => {});
  }
}

// 发送后到主页确认推文真的出现了（最终判据）
async function verifyOnProfile(ctx, title) {
  const key = normTitle(title).slice(0, 16);
  const page = await ctx.newPage();
  try {
    await page.goto(X_PROFILE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const texts = await page.$$eval('article[data-testid="tweet"]', (arts) =>
      arts.slice(0, 10).map((a) => ({
        text: (a.querySelector('div[data-testid="tweetText"]')?.innerText || '').slice(0, 200),
        url: a.querySelector('a[href*="/status/"] time')?.closest('a')?.href || '',
      }))
    );
    const hit = texts.find((t) => normTitle(t.text).includes(key));
    return hit ? { found: true, tweetUrl: hit.url } : { found: false };
  } catch (e) {
    return { found: false, err: e.message.slice(0, 100) };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- 发一篇 ----------
async function postOne(ctx, art, state) {
  const art2 = await extractArticle(ctx, art.url).catch((e) => ({ title: art.title, body: '', imgs: [], err: e.message }));
  if (art2.err && !art2.body) return { ok: false, note: 'extract failed: ' + art2.err };
  const title = art.title || art2.title;
  const key = normTitle(title);
  if (art2.skip === 'no_text') {
    state.posted[key] = { title, url: art.url, ts: Date.now(), kind: 'skipped_no_text' };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    log({ action: 'skip_no_text', title: art.title, url: art.url });
    return { ok: false, skipped: 'no_text', title, note: '无正文（音频/视频/图片帖），跳过' };
  }
  const images = await downloadImages(art2.imgs || []);
  const boldSet = new Set(art2.bolds || []);
  const built = buildThread({ title, body: art2.body || '', url: art.url, images, boldSet });
  const thread = built.posts;
  const totalChars = thread.reduce((a, p) => a + p.text.length, 0);
  // 长文（推文串装不下，会被截断）改走 X Articles：富文本、不截断
  const mode = built.truncated ? 'article' : 'thread';
  if (mode === 'article' && fs.existsSync(ART_ALERT)) {
    log({ action: 'post_result', title, ok: false, skipped: 'article_alert' });
    return { ok: false, skipped: 'article_alert', title, note: '上一次 Articles 发布未成功，已暂停长文搬运，等人工收尾（' + ART_ALERT + '）' };
  }
  log({ action: 'post_attempt', title, url: art.url, mode, posts: thread.length, imgs: images.length, chars: totalChars, truncated: built.truncated });
  const res = mode === 'article'
    ? await composeArticle(ctx, { title, paras: built.paras, url: art.url, images: images.slice(0, MAX_IMAGES), boldSet })
    : await composeThread(ctx, thread);
  // Articles 的图是插进正文的，计入实际插入数；推文串的图挂在首条
  const imgsUsed = mode === 'article' ? (res.imgsInserted != null ? res.imgsInserted : 0) : images.length;
  if (!res.ok) {
    if (mode === 'article') {
      fs.writeFileSync(ART_ALERT, `Articles 发布未成功：${title}\n${art.url}\n${new Date().toISOString()}\n${res.note}\n去 x.com/compose/articles 看草稿：要么手动发布，要么删掉草稿，然后删除本文件。\n`, 'utf8');
    }
    log({ action: 'post_result', title, ok: false, note: res.note, mode });
    return { ...res, title, imgs: imgsUsed, posts: thread.length, mode };
  }
  let verify = mode === 'article' ? await verifyArticle(ctx, title) : await verifyOnProfile(ctx, title);
  // Articles 自愈：没验证到且还留着草稿编辑页 → 再走一次发布（确认弹窗），再验一次
  if (!verify.found && mode === 'article' && res.editUrl) {
    log({ action: 'article_retry_publish', title, editUrl: res.editUrl });
    const retry = await retryPublishArticle(ctx, res.editUrl);
    log({ action: 'article_retry_result', title, ok: retry.ok, steps: retry.steps || null, note: retry.note || '' });
    verify = await verifyArticle(ctx, title);
    if (verify.found) verify.retryUsed = true;
    if (!verify.found && retry.publishedUrl) verify = { found: true, tweetUrl: retry.publishedUrl, viaUrl: true };
    if (!verify.found && retry.alreadyPublished) verify = { found: true, articleUrl: res.editUrl, viaUrl: true };
  }
  if (verify.found) {
    const tweetUrl = verify.tweetUrl || res.publishedUrl || verify.articleUrl || null;
    // 原文链接走自回复（整串零外链，避免 X 的外链降权）
    let linkReplyUrl = null;
    if (tweetUrl && art.url) {
      const rr = await replyToPost(ctx, tweetUrl, built.linkReply, { tailOf: mode === 'thread' });
      linkReplyUrl = rr.ok ? rr.target : null;
      log({ action: 'link_reply', title, ok: rr.ok, mode, target: linkReplyUrl, note: rr.note || '' });
      if (!rr.ok) console.error('link reply failed:', rr.note);
    }
    state.posted[key] = { title, url: art.url, ts: Date.now(), kind: 'migrated', mode, imgs: imgsUsed, posts: mode === 'thread' ? thread.length : undefined, tweetUrl, articleUrl: verify.articleUrl, linkReplyUrl };
    const d = localDate();
    state.daily[d] = (state.daily[d] || 0) + 1;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    log({ action: 'post_result', title, ok: true, mode, tweetUrl, articleUrl: verify.articleUrl, linkReplyUrl, imgs: imgsUsed, posts: thread.length, retryUsed: verify.retryUsed || false });
    return { ok: true, title, url: art.url, mode, imgs: imgsUsed, posts: thread.length, tweetUrl, articleUrl: verify.articleUrl, linkReplyUrl, retryUsed: verify.retryUsed || false, note: linkReplyUrl ? 'posted+verified（链接已放自回复）' : 'posted+verified（自回复未成功，见日志）' };
  }
  if (mode === 'article') {
    fs.writeFileSync(ART_ALERT, `Articles 发送后没在 Published 里验证到：${title}\n${art.url}\n${new Date().toISOString()}\n${res.note}\n去 x.com/compose/articles 确认状态，处理完删掉本文件。\n`, 'utf8');
  }
  // 点了发送但主页没找到：不记账，等下次 run 的扫描去重兜底
  log({ action: 'post_result', title, ok: false, note: 'submit clicked but not found', mode, toast: res.toast });
  return { ok: false, title, url: art.url, mode, imgs: imgsUsed, posts: thread.length, note: mode === 'article' ? 'Articles 提交后未验证到，已转人工（见 ' + ART_ALERT + '）' : '发送后主页未验证到，稍后由扫描兜底核对' };
}

// ---------- 主流程 ----------
// (2)(3) 互斥与联动刹车的小工具
function readHoldMs() {
  try {
    const t = Number(fs.readFileSync(HOLD_FILE, 'utf8').trim());
    return isNaN(t) ? 0 : Math.max(0, t - Date.now());
  } catch (e) { return 0; }
}
function writeHold(ms, reason) {
  let cur = 0;
  try { cur = Number(fs.readFileSync(HOLD_FILE, 'utf8').trim()) || 0; } catch (e) {}
  const until = Date.now() + ms;
  if (until > cur) fs.writeFileSync(HOLD_FILE, String(until), 'utf8');
  log({ action: 'hold', ms, reason, until: new Date(until).toISOString() });
}
function commentPipelineBusy() {
  try {
    const lines = fs.readFileSync(COMMENT_LOG, 'utf8').trim().split('\n').slice(-3);
    for (const l of lines.reverse()) {
      const j = JSON.parse(l);
      if (j.ok && Date.now() - Date.parse(j.ts) < 90 * 1000) return true;
    }
  } catch (e) {}
  return false;
}
function pauseCommentPipeline(ms, reason) {
  try {
    const st = readJson(CAMPAIGN_STATE, {});
    st.pausedUntil = Date.now() + ms;
    fs.writeFileSync(CAMPAIGN_STATE, JSON.stringify(st), 'utf8');
    log({ action: 'pause_comment_pipeline', ms, reason });
  } catch (e) {}
}
function loadState() {
  const st = readJson(STATE_FILE, {});
  st.posted = st.posted || {};
  st.daily = st.daily || {};
  return st;
}

function decide(arts, xNorms, state) {
  if (!state.cutoff_ts) {
    // 只搬此刻之后新发的文章（2026-10-05 用户叫停历史补搬）
    state.cutoff_ts = Math.floor(Date.now() / 1000);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  }
  const unposted = [];
  for (const a of arts) {
    const key = normTitle(a.title);
    if (!key) continue;
    if (state.posted[key]) continue;
    if (xNorms.some((n) => (n.length >= 16 && (n.includes(key) || key.includes(n))))) {
      state.posted[key] = { title: a.title, url: a.url, ts: Date.now(), kind: 'preexisting' };
      continue;
    }
    const isNew = (a.pub_ts || 0) >= state.cutoff_ts;
    unposted.push({ ...a, key, isToday: isNew });
  }
  const todays = unposted.filter((a) => a.isToday).sort((x, y) => (y.pub_ts || 0) - (x.pub_ts || 0)); // 新文章先发
  const backlog = BACKFILL_ENABLED
    ? unposted.filter((a) => !a.isToday).sort((x, y) => (x.pub_ts || 0) - (y.pub_ts || 0)) // 最旧优先
    : [];
  return { todays, backlog, oldIgnored: unposted.filter((a) => !a.isToday).length };
}

async function cmdSync() {
  const summary = await withBrowser(async (ctx) => {
    const arts = await fetchWxArticles(ctx);
    const xTweets = await scanXProfile(ctx);
    const state = loadState();
    const xNorms = xTweets.map((t) => normTitle(t.text)).filter(Boolean);
    const { todays, backlog, oldIgnored } = decide(arts, xNorms, state);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    return {
      articles: arts.length,
      xTweetsScanned: xTweets.length,
      markedPreexisting: Object.values(state.posted).filter((p) => p.kind === 'preexisting').length,
      alreadyMigrated: Object.values(state.posted).filter((p) => p.kind === 'migrated').length,
      backfillEnabled: BACKFILL_ENABLED,
      cutoff: state.cutoff_ts ? new Date(state.cutoff_ts * 1000).toISOString() : null,
      todays: todays.map((a) => `${new Date(a.pub_ts * 1000).toISOString().slice(0, 10)} ${a.title}`),
      backlogCount: backlog.length,
      oldIgnored,
      backlogHead: backlog.slice(0, 5).map((a) => `${new Date(a.pub_ts * 1000).toISOString().slice(0, 10)} ${a.title}`),
    };
  });
  console.log(JSON.stringify(summary, null, 2));
  clearLoginAlert();
  return summary;
}

async function cmdRun() {
  // 运行锁：会话内定时和 Windows 任务都可能唤醒它，两个实例同时跑会重复发文
  if (!takeLock()) { console.log(JSON.stringify({ ok: false, skipped: 'another wx2x run is in progress' })); return; }
  try {
    return await cmdRunBody();
  } catch (e) {
    const needsLogin = raiseLoginAlert(e.message);
    const line = `- ${new Date().toTimeString().slice(0, 5)} ❌ 运行失败：${String(e.message).slice(0, 120)}` +
      (needsLogin ? '（公众号登录失效，需要在 bot Chrome 里重新扫码）' : '');
    wxReport(line);
    log({ action: 'fatal', err: String(e.message).slice(0, 300), needsLogin });
    console.log(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200), needsLogin }));
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
}
async function cmdRunBody() {
  const eng = await ensureChrome();
  if (!eng.ok) { console.log(JSON.stringify({ ok: false, error: eng.error })); process.exit(1); }
  const out = await withBrowser(async (ctx) => {
    const arts = await fetchWxArticles(ctx);
    const xTweets = await scanXProfile(ctx, { maxScrolls: 12 });
    const state = loadState();
    const xNorms = xTweets.map((t) => normTitle(t.text)).filter(Boolean);
    const { todays, backlog, oldIgnored } = decide(arts, xNorms, state);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');

    const d = localDate();
    const usedToday = state.daily[d] || 0;
    const backlogLeft = BACKFILL_ENABLED ? backlog.length : oldIgnored;
    const dailyCap = BACKFILL_ENABLED && backlog.length > 0 ? DAILY_CAP_BACKFILL : DAILY_CAP_NORMAL;
    const quotaFull = Math.max(0, Math.min(RUN_CAP, dailyCap - usedToday));

    // (1)(2) 节奏闸门：距上一篇不足随机间隔就不发；被 hold 或评论正在发帖也不发
    const now = Date.now();
    const lastTs = state.last_post_ts || 0;
    const needGap = state.next_gap_ms || 0;
    const gapLeftMs = needGap && lastTs ? (lastTs + needGap) - now : 0;
    const holdMs = readHoldMs();
    // 压了超过 36 小时的新文章不再等节奏，直接发
    const veryOld = todays.some((a) => (now / 1000 - (a.pub_ts || 0)) > 36 * 3600);
    let paceSkip = null;
    if (!veryOld) {
      if (holdMs > 0) paceSkip = `hold ${Math.round(holdMs / 60000)}min`;
      else if (gapLeftMs > 0) paceSkip = `gap ${Math.round(gapLeftMs / 60000)}min`;
      else if (commentPipelineBusy()) paceSkip = 'comment pipeline is posting right now';
    }
    const quota = paceSkip ? 0 : quotaFull;

    const results = [];
    const queue = [...todays, ...backlog].slice(0, quota + 3); // 多拿几篇，跳过无正文的不占额度
    let postedCount = 0;
    for (const art of queue) {
      if (postedCount >= quota) break;
      const r = await postOne(ctx, art, state);
      results.push({ title: r.title, ok: r.ok, skipped: r.skipped || null, note: r.note, imgs: r.imgs, tweetUrl: r.tweetUrl || null });
      if (r.ok) {
        postedCount++;
        // 发完重新随机下一个间隔，并让评论流水线静默 12 分钟
        state.last_post_ts = Date.now();
        state.next_gap_ms = PUB_GAP_MIN_MS + Math.random() * (PUB_GAP_MAX_MS - PUB_GAP_MIN_MS);
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
        writeHold(12 * 60 * 1000, 'article published');
        if (postedCount < quota && queue.length > 1) await sleep(WITHIN_RUN_GAP_MS);
      }
    }
    // (3) 发文侧连续失败 => 认为账号侧有问题，两条流水线一起停 24 小时
    const hardFails = results.filter((r) => !r.ok && !r.skipped && /未验证到|not found|compose|send/i.test(String(r.note || '')));
    let cooldown = null;
    if (hardFails.length >= 2) {
      writeHold(24 * 3600 * 1000, 'wx2x hard failures');
      pauseCommentPipeline(24 * 3600 * 1000, 'wx2x hard failures');
      cooldown = '24h';
    }
    return {
      ok: true,
      articlesTotal: arts.length,
      xTweetsScanned: xTweets.length,
      postedToday: usedToday + results.filter((r) => r.ok).length,
      dailyCap,
      paceSkip,
      nextGapMin: state.next_gap_ms ? Math.round(state.next_gap_ms / 60000) : null,
      holdLeftMin: Math.round(readHoldMs() / 60000),
      cooldown,
      backlogLeft,
      todaysPending: todays.map((a) => a.title),
      queueTitles: queue.map((a) => a.title),
      results,
    };
  });
  console.log(JSON.stringify(out, null, 2));
  log({ action: 'run', out });
  clearLoginAlert();
  const okN = out.results.filter((r) => r.ok).length;
  const tail = out.results.filter((r) => !r.ok && r.note).map((r) => `${r.title || '?'}: ${String(r.note).slice(0, 60)}`).join('；');
  wxReport(`- ${new Date().toTimeString().slice(0, 5)} 运行：今日已发 ${out.postedToday}/${out.dailyCap}，本轮新发 ${okN} 篇` +
    (out.paceSkip ? `，节奏跳过（${out.paceSkip}）` : '') +
    (out.cooldown ? `，触发联动刹车 ${out.cooldown}` : '') +
    (okN === 0 && !out.paceSkip ? '，无待发文章' : '') +
    (tail ? `；未发：${tail}` : ''));
  if (out.cooldown) wxReport(`- ${new Date().toTimeString().slice(0, 5)} ⚠ 连续失败触发 24 小时联动刹车，评论线一并暂停`);
  return out;
}

async function cmdPost(query) {
  const eng = await ensureChrome();
  if (!eng.ok) { console.log(JSON.stringify({ ok: false, error: eng.error })); process.exit(1); }
  const out = await withBrowser(async (ctx) => {
    const arts = readJson(ARTS_FILE, []);
    let hit = arts.find((a) => a.url === query) || arts.find((a) => normTitle(a.title).includes(normTitle(query))) || arts.find((a) => a.title.includes(query));
    if (!hit && /^https?:\/\//i.test(query)) {
      hit = { title: '', url: query, pub_ts: Math.floor(Date.now() / 1000), source: 'manual' }; // 直接按 URL 搬
    }
    if (!hit) return { ok: false, note: 'no article matched: ' + query };
    const state = loadState();
    const r = await postOne(ctx, hit, state);
    return r;
  });
  console.log(JSON.stringify(out, null, 2));
  return out;
}

// 预览版式：不发文、不上图，只把推文串排版结果打出来
async function cmdPreview(query, opts = {}) {
  const eng = await ensureChrome();
  if (!eng.ok) { console.log(JSON.stringify({ ok: false, error: eng.error })); process.exit(1); }
  const out = await withBrowser(async (ctx) => {
    const arts = readJson(ARTS_FILE, []);
    let hit = arts.find((a) => a.url === query) || arts.find((a) => normTitle(a.title).includes(normTitle(query))) || arts.find((a) => a.title.includes(query));
    if (!hit && /^https?:\/\//i.test(query)) hit = { title: '', url: query, pub_ts: Math.floor(Date.now() / 1000), source: 'manual' };
    if (!hit) return { ok: false, note: 'no article matched: ' + query };
    const art2 = await extractArticle(ctx, hit.url);
    const title = hit.title || art2.title;
    const imgs = art2.imgs || [];
    const built = buildThread({ title, body: art2.body || '', url: hit.url, images: imgs.map((_, i) => 'placeholder' + i), boldSet: new Set(art2.bolds || []) });
    const mode = built.truncated ? 'article' : 'thread';
    // --dry-article：把正文真的填进 Articles 编辑器演练一遍（不发布，结束后删草稿）
    if (opts.dryArticle) {
      const realImages = await downloadImages(imgs);
      const dry = await composeArticle(ctx, { title, paras: built.paras, url: hit.url, images: realImages.slice(0, MAX_IMAGES), boldSet: new Set(art2.bolds || []), dryRun: true });
      return { ok: dry.ok, mode: 'article(dry)', title, url: hit.url, bodyChars: (art2.body || '').length, paras: built.paragraphs, images: realImages.length, boldSet: (art2.bolds || []).length, note: dry.note, publishDialog: dry.publishDialog, cleanup: dry.cleanup, snapshot: dry.snapshot };
    }
    const lines = [`# 推文串预览 · ${title}`, '', `原文（**不进串**，发送后作自回复发出）：${hit.url}`, '', `正文 ${(art2.body || '').length} 字 → ${built.posts.length} 条（emoji ${built.emoji || '无'}${built.truncated ? '，有截断' : ''}），图片 ${Math.min(imgs.length, MAX_IMAGES)} 张挂首条`, `走哪条路：${mode === 'article' ? 'X Articles（长文，富文本）' : '推文串'}（整串零外链）`, ''];
    built.posts.forEach((p, i) => {
      const nImg = i === 0 ? Math.min(imgs.length, MAX_IMAGES) : 0;
      lines.push(`--- 第 ${i + 1} 条（${p.text.length} 字${nImg ? `，${nImg} 张图` : ''}）---`);
      lines.push(p.text);
      lines.push('');
    });
    lines.push('--- 自回复（发在串尾之下）---', built.linkReply, '');
    const file = path.join(REPORTS, 'wx2x_preview.md');
    if (!fs.existsSync(REPORTS)) fs.mkdirSync(REPORTS, { recursive: true });
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return {
      ok: true, title, url: hit.url, bodyChars: (art2.body || '').length,
      paras: built.paragraphs, posts: built.posts.length, emoji: built.emoji,
      truncated: built.truncated, mode, images: Math.min(imgs.length, MAX_IMAGES),
      previewFile: file, digest: threadDigest(built.posts),
    };
  });
  console.log(JSON.stringify(out, null, 2));
  return out;
}

function cmdStatus() {
  const state = loadState();
  const arts = readJson(ARTS_FILE, []);
  const posted = Object.entries(state.posted).map(([k, v]) => ({ ...v, key: k }));
  const summary = {
    articlesKnown: arts.length,
    postedMigrated: posted.filter((p) => p.kind === 'migrated').length,
    preexisting: posted.filter((p) => p.kind === 'preexisting').length,
    daily: state.daily,
    backlogRemainingGuess: arts.length - posted.length,
    recentLog: (() => { try { return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-5); } catch { return []; } })(),
  };
  console.log(JSON.stringify(summary, null, 2));
}

(async () => {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'sync') await cmdSync();
  else if (cmd === 'run') await cmdRun();
  else if (cmd === 'preview') await cmdPreview(process.argv[3] || '', { dryArticle: process.argv.includes('--dry-article') });
  else if (cmd === 'post') await cmdPost(process.argv[3] || '');
  // 手动补发自回复（自动那次失败时用）：node wx2x.js reply <推文URL> --text "原文：..." [--tail] [--dry]
  else if (cmd === 'reply') {
    const target = process.argv[3] || '';
    const ti = process.argv.indexOf('--text');
    const text = ti >= 0 ? process.argv[ti + 1] : '';
    if (!target || !text) { console.log('usage: node wx2x.js reply <tweetUrl> --text "原文：https://..." [--tail] [--dry]'); process.exit(2); }
    const out = await withBrowser((ctx) => replyToPost(ctx, target, text, { tailOf: process.argv.includes('--tail'), dryRun: process.argv.includes('--dry') }));
    console.log(JSON.stringify(out, null, 2));
  }
  else if (cmd === 'status') cmdStatus();
  else console.log('usage: node wx2x.js sync|run|preview <url|title> [--dry-article]|post <url|title>|reply <tweetUrl> --text "..." [--tail] [--dry]|status');
})().catch((e) => {
  const needsLogin = raiseLoginAlert(e.message);
  console.error('error:', e.message);
  log({ action: 'fatal', err: e.message, needsLogin });
  if (needsLogin) console.error('ALERT: 公众号登录失效，需要在 bot Chrome 里重新扫码');
  process.exit(1);
});
