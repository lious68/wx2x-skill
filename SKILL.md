---
name: "wx2x"
description: "公众号文章搬运到 X（推特）的完整流水线：从 mp.weixin.qq.com 抓取文章、按 X 习惯排版（推文串 / X Articles 长文）、自动发布、标题去重、定时巡检。当用户要「把公众号文章搬到 X」「迁移公众号内容到推特」「把这篇文章发到 X」「排版成推文串」「发 X Articles 长文」「定时检查公众号新文章并转发」时使用。"
---

# wx2x：公众号 → X 文章搬运

把微信公众号的文章搬到 X 账号上：抓取 → 排版 → 发布 → 去重 → 定时巡检，全程幂等（重复运行不会重复发）。

## 核心决策（先确定这 4 件事再动手）

1. **发帖形式**：
   - 正文能被推文串装下（≤12 条）→ **推文串**（首条＝emoji＋标题＋前 4 张图，整串零外链）；
   - 装不下（会截断）→ **X Articles 长文**（富文本、小标题、不截断，需要 X Premium）。
   - 详细排版规则见 [docs/formatting.md](docs/formatting.md)。
2. **去重**：扫 X 主页历史推文按标题自动比对 + 本地 `wx2x_state.json` 双保险。标题归一化后取前 24 字符做 key。
3. **搬运范围**：只搬 cutoff 时间戳之后新发的文章（`cutoff_ts` 写在状态文件里）；历史欠账补不补由用户定（`BACKFILL_ENABLED`）。
4. **节奏**：每日上限（`DAILY_CAP_NORMAL`）+ 单次 run 上限（`RUN_CAP`）+ 发帖间隔，防封号安全阀。

## 环境要求

- Node.js 18+（用到内置 `fetch`）+ `playwright`（`npm i playwright`）。
- 一个**用户自己登录好**公众号后台（mp.weixin.qq.com）和 X 的 Chrome，以 CDP 远程调试方式挂上去：

```powershell
chrome.exe --user-data-dir="C:/path/to/chrome-user-data" --profile-directory=Default --remote-debugging-port=9222
```

CDP 方式继承真实登录态和浏览器指纹，比自动化浏览器裸奔可靠得多。相关变量：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CDP_URL` | `http://127.0.0.1:9222` | Chrome 调试端口 |
| `CHROME_USER_DATA_DIR` | — | Chrome 用户数据目录（脚本自动拉起 Chrome 时用） |
| `CHROME_PROFILE_DIR` | `Default` | Chrome profile |
| `X_PROFILE` | — | X 主页 URL，如 `https://x.com/your_handle` |
| `WX2X_WORKDIR` | 脚本目录 | 状态/日志/图片的工作目录 |
| `WX2X_SINGLE_MAX` | `4000` | 单条长推的字数上限：`emoji+标题+正文` 不超过它就发一条，超过才拆串 |

## 命令

```powershell
node scripts/wx2x.js sync                       # 只抓取+去重，不发帖（用来验证登录态）
node scripts/wx2x.js run                        # 巡检一轮：抓新文 → 去重 → 按节奏发 0–2 篇
node scripts/wx2x.js post <文章URL|标题片段>     # 立即搬指定一篇
node scripts/wx2x.js preview <标题片段|URL>      # 只看排版结果（不发帖）
node scripts/wx2x.js preview <标题片段> --dry-article  # Articles 演练（不发布、自动删草稿）
node scripts/wx2x.js reply <推文URL> --text "原文：<链接>" --tail   # 给已发的串补原文链接自回复
node scripts/wx2x.js status                     # 看进度
```

## 发布通道的坑（本 skill 最值钱的部分）

X 的前端按钮**吃真实鼠标事件**、Publish 按钮有 disabled 期、确认弹窗时有时无、发布结果进 Published 列表有延迟——每一个都实际踩过。完整的坑位清单和对策见 [docs/x-articles.md](docs/x-articles.md)，动手改发布逻辑前必读。

发布通道改动后跑自检（建稿 → 发布 → 验证 → 删除，全自动闭环）：

```powershell
node scripts/x_article_selftest.js
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/formatting.md](docs/formatting.md) | 排版规则：推文串拆条、首条、小标题、emoji、去噪、零外链＋自回复 |
| [docs/x-articles.md](docs/x-articles.md) | X Articles 发布通道：选择器、正文插图（两个 file input 的陷阱）、publishConfirm 语义、6 个坑、自检/删除 |
| [docs/wechat-mp.md](docs/wechat-mp.md) | 公众号后台抓取：两个接口、object-or-string 解析坑、图片下载、掉登录处理 |
| [docs/ops.md](docs/ops.md) | 去重、限额、节奏、告警文件、锁、定时调度 |

## 重要提醒

- 自动化发帖可能违反平台服务条款，**只在自己的账号上用**，节奏参数保守一点。
- X / 公众号的 DOM 选择器随时会变，坏了先跑 `preview` / 自检脚本定位是哪一步。
- 公众号后台会话过期是常态：脚本探测到掉登录就**跳过并留告警文件**，不自动登录、不硬重试（自动登录 = 风控高危动作）。
