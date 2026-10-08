# 公众号后台抓取（mp.weixin.qq.com）

文章清单从公众号后台拉（比公开页抓取可靠、覆盖未群发草稿之外的所有历史），正文从公开文章页抓。

## 前置：登录态

用已登录公众号后台的 Chrome（CDP 挂上去）。**会话会周期性过期**，掉登录的信号：

- fetch 文章列表报 `MP_NO_TOKEN` / `MP_BAD_JSON`（返回的不是 JSON 而是登录页）。

**处理原则（重要）**：什么都别做——本轮直接跳过（不发文、不重试、**不尝试自动登录**），写一个 `wx2x_NEEDS_LOGIN.txt` 告警文件，
等下轮探测到登录态回来自动继续并删除告警。自动登录公众号 = 风控高危动作，别碰。
要恢复登录时：打开 `https://mp.weixin.qq.com/` 标签页让用户扫码（`scripts/mp_open_login.js` 就干这个）。

## 接口一：群发/发布记录（publish）

```
GET /cgi-bin/appmsgpublish?sub=list&begin=0&count=20&type=1&f=json&ajax=1&token=<会话token>&lang=zh_CN
Header: X-Requested-With: XMLHttpRequest
```

- `type=1` 是图文；`type=10` 会返回空列表（别用）。
- **必须带 `f=json&ajax=1` + XHR 头**，否则返回 HTML，`JSON.parse` 直接炸。
- 分页：`begin=0,20,40...`，`count=20`，翻到空为止。
- token 不是硬编码的密钥，是登录会话 token，从后台页面 URL `token=xxxx` 里动态取。

## 接口二：群发历史（masssend）

```
GET /cgi-bin/masssendpage?t=masssend/history&action=history&begin=N&count=20&f=json&ajax=1&token=<token>&lang=zh_CN
```

和接口一互补（不同类型的群发记录落在不同桶里），两边都拉、按文章 URL 去重合并。

## 解析坑：object-or-string

响应里的 `publish_info` / `publish_page` / `msg_items` 等字段**可能是对象也可能是 JSON 字符串**（`[object Object]` 直接 `JSON.parse` 会炸）。统一用：

```js
const PJ = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
```

## 正文抓取（公开文章页）

文章 URL 形如 `https://mp.weixin.qq.com/s/<key>`：

- 标题：`#activity-name`；正文：`#js_content` 的 innerText（每行一段）；
- 加粗小标题：收集 `#js_content` 里 `font-weight:700`（或 `strong/b`）的行，进排版的小标题集合；
- 图片：`img[data-src]`（微信懒加载，src 是占位符），取正文前 4 张；
- 图片下载：从 mmbiz CDN 拉时**必须带 `Referer: https://mp.weixin.qq.com/`**，否则 403；<15KB 的是装饰图/表情，跳过；
- 超长正文截断（参考实现 24000 字符）并在末条注明；
- 无正文判定：去空白后 <80 字 → 音频/视频/图片帖，记 `skipped_no_text` 跳过。

## 合并结果

两个接口拉回的文章列表按 URL 去重合并成一个清单（参考实现存 `wx_articles.json`），
每条带 `title / url / publish_ts`。搬运范围按 `publish_ts > cutoff_ts` 过滤。
