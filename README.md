# wx2x-skill

把微信公众号的文章搬运到 X（推特）的完整 Skill：抓取、排版、发布、去重、定时巡检。

- 发帖形式自适应：短文走**推文串**（首条＝emoji＋标题＋前 4 张图，整串零外链，原文链接用自回复承载）；长文走 **X Articles**（富文本、不截断）。
- 全程幂等：标题归一化去重（本地状态 + 扫 X 主页双保险），重复运行不会重复发。
- 无人值守：定时巡检 + 告警文件呼救（掉登录 / 发布转人工）+ 运行锁 + 联动刹车。
- 踩坑手册是核心价值：X 按钮只吃真实鼠标事件、Publish 三连坑、Articles 插不进图、Published 列表延迟……都写在文档里了。

## 结构

```
SKILL.md                 技能入口（决策、环境、命令、文档索引）
docs/
  formatting.md          排版规则：推文串拆条、小标题、emoji、去噪、零外链＋自回复
  x-articles.md          X Articles 发布通道：选择器 + 6 个实测坑 + 自检闭环
  wechat-mp.md           公众号后台抓取：接口、解析坑、图片下载、掉登录处理
  ops.md                 去重、限额、节奏、告警、锁、调度
scripts/
  wx2x.js                参考实现（sync / run / post / preview / reply / status）
  x_article_selftest.js  Articles 发布通道自检：建稿→发布→验证→删除
  x_article_delete.js    删除草稿/文章的小工具
  mp_open_login.js       打开公众号后台登录页（让用户扫码）
  run.bat.example        Windows 计划任务入口示例
```

## 快速开始

```powershell
npm i playwright
# 用自己登录好公众号后台和 X 的 Chrome 开 CDP：
chrome.exe --user-data-dir="C:/path/to/chrome-user-data" --profile-directory=Default --remote-debugging-port=9222

$env:X_PROFILE = "https://x.com/your_handle"
node scripts/wx2x.js sync        # 先验证抓取和去重
node scripts/wx2x.js preview "标题片段"   # 看排版
node scripts/wx2x.js run         # 跑一轮巡检
```

配置（环境变量）与命令详见 [SKILL.md](SKILL.md)。

## 免责声明

自动化发帖可能违反平台服务条款，本项目仅供学习与个人账号管理，请自行承担风险，节奏参数请保守。
X / 微信的页面结构随时会变，选择器失效时按 `docs/x-articles.md` 的自检流程排查。
