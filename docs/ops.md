# 运维：去重、限额、节奏、告警、调度

## 去重（宁可少发，不可重发）

双保险：

1. **本地状态** `wx2x_state.json`：`posted` 里每篇一个 key（标题归一化后取前 24 字符）+ 计数器；
2. **扫 X 主页历史推文**：抓最近若干条推文文本，标题归一化后比对。

归一化规则（`normTitle()`）：小写 → 删所有空白和中英文标点 → 取前 24 字符。
匹配要求 key 长度 ≥16 且互相包含（`a.includes(b) || b.includes(a)`），避免短标题误伤。

**发送成功以「X 主页出现该推文」/「Published 列表出现该长文」为最终判据**；点了发送但没验证到的**不记账**，下一轮扫描自动兜底去重。

## 限额与节奏（防封安全阀）

| 参数 | 建议值 | 说明 |
|---|---|---|
| `RUN_CAP` | 2 | 单次 run 最多发几篇 |
| `WITHIN_RUN_GAP_MS` | 5 分钟 | 同一轮两篇之间的间隔 |
| `DAILY_CAP_NORMAL` | 4 | 每日上限（正常每天 1–3 篇） |
| 发文间隔 | 2.5–6 小时随机 | 每次发完重新随机，不跟整点走；积压超 36 小时的文章不再等 |
| `cutoff_ts` | 用户指定 | 只搬这个时间戳之后的文章；历史欠账补不补由用户定（`BACKFILL_ENABLED`） |

## 与其他自动化共用同一账号时的互斥

如果同一 Chrome/账号上还有别的发帖流水线（比如评论引流），必须互斥，否则"同一分钟既发文章又回评论"是明显的机器特征：

- **发文后自动静默**：发成功一篇后写 `_hold_until.txt`（+12 分钟），其他流水线读到就暂停；
- **对方正在发帖时本轮不发**：看对方的日志文件（如 `campaign_log.jsonl`），90 秒内有活动就整轮跳过（输出 `paceSkip`）；
- **联动刹车**：一轮里出现两次"发送后没验证到"这类硬失败 → 自动写 24 小时 hold + 暂停对方 24 小时（`cooldown: "24h"`）。

输出 JSON 带上 `paceSkip / nextGapMin / holdLeftMin / cooldown` 字段方便排查。

## 告警文件（无人值守时的呼救机制）

| 文件 | 含义 | 处理 |
|---|---|---|
| `wx2x_NEEDS_LOGIN.txt` | 公众号后台掉登录 | 打开 mp.weixin.qq.com 让用户扫码；登录恢复后自动删除 |
| `wx2x_NEEDS_MANUAL_ARTICLE.txt` | Articles 发布失败转人工 | 去 `x.com/compose/articles` 看草稿：手动发布或删掉，然后删除本文件；**存在期间暂停长文搬运** |

## 并发锁

`wx2x.lock`（20 分钟视为失效）：防止多个调度器/会话同时跑导致重复发帖。清理残留锁可以用保洁脚本（杀掉卡住 >25 分钟的 node、清 >20 分钟的旧锁）。

## 定时调度

两种方式选一（**别两个都上**，锁能防重复发文但没必要）：

**Windows 任务计划程序**（无人值守推荐）：

```powershell
schtasks /Create /TN wx2x /TR "cmd /c cd /d <目录> && node scripts\wx2x.js run >> reports\wx2x_boot.log 2>&1" /SC DAILY /ST 09:00
# 或按每 3 小时一轮：/SC HOURLY /MO 3
```

**cron / CI 定时**（Linux）：

```cron
0 8-23/3 * * *  cd /path/to/wx2x && node scripts/wx2x.js run >> reports/wx2x_boot.log 2>&1
```

每轮 run 自己写日报（`reports/wx2x_YYYYMMDD.md`，一句话摘要）和原始日志（`wx2x_log.jsonl`，JSONL）。

## 巡检一轮做什么（`run` 命令）

1. 拉公众号文章列表（两个接口）→ 刷新 `wx_articles.json`；
2. 扫 X 主页历史推文 → 双保险去重；
3. 按 cutoff + 限额 + 节奏挑 0–2 篇 → 提取 → 排版 → 发布（推文串或 Articles）→ 验证；
4. 写状态、日志、日报；该呼救就留告警文件。

整个流程**幂等**：任何一步重跑都不会重复发。
