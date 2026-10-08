# X Articles 发布通道（长文）：选择器 + 坑位手册

正文超过约 2.6k 字、推文串装不下时走 X Articles（富文本长文，需要 X Premium）。
**动手改这条通道前必读本页**——以下每个坑都是 2026-10 实测踩出来的，不看会再踩一遍。

## 选择器速查

| 部件 | 选择器 / 做法 |
|---|---|
| 入口 | `x.com/compose/articles` → create 按钮（`button[aria-label="create"]`，或文字含 "create article"）→ 进 `compose/articles/edit/<id>` |
| 标题 | `textarea[placeholder="Add a title"]` |
| 正文 | `div[data-testid="composer"][contenteditable="true"]`（Draft.js）：`keyboard.insertText` + `Enter` 逐段写 |
| 段落样式 | 按钮**没有 aria-label**，文字就是当前样式（`Body`/`Heading`/`Subheading`），点开后选菜单项 `Heading` |
| 图片 | `input[data-testid="fileInput"]` —— **插不进正文，见坑 2** |
| 发布 | `button "Publish"` → `publishConfirm()`（见下） |
| 删草稿/删文章 | `button[aria-label="More"]` → `Delete Article` → 确认按钮 **`Yes, delete`（草稿）或 `Delete Article`（已发布）**，统一按 delete 匹配 |
| 公开链接 | 编辑页 More 菜单里 "View Article" 的 href，或 `article[data-testid="tweet"]` 里 `a[href*="/status/"]` |
| Published 列表 | `x.com/compose/articles` 切 `Published` 标签（`[role="tab"]` name=Published），条目链接是 `a[href*="/compose/articles/edit/"]` |

## publishConfirm() 的语义（发布就靠它）

```
1. 等 Publish 按钮出现且 isEnabled（新输入后按钮先 disabled——等自动保存，最多 60s）
2. 点击 Publish（force），最多重试 3 轮，每轮轮询 12s：
   - URL 变成 /status/ → 成功（有的版本不弹确认框，直接发）
   - 出现可见 role=dialog → 在弹窗里找确认键，DOM 坐标 + page.mouse.click 点它
3. 最后再等最多 24s 落到 /status/，把 URL 作为 publishedUrl 返回
```

发布**最终判据**是两条都过：
- 跳到文章的 `/status/` 页；且
- `x.com/compose/articles` 的 Published 列表里出现该标题（**注意延迟，分 3 轮校验、每轮隔 15s**）。

失败自愈：`retryPublishArticle()` 重开草稿编辑页再走一次发布；编辑页已无 Publish 按钮（显示 "Unpublish, move to drafts"）= 已发布过，直接算成功。仍失败才写告警文件 `wx2x_NEEDS_MANUAL_ARTICLE.txt` 并暂停后续长文，人工收尾后删除该文件。

## 坑（都踩过，别再踩）

### 1. X 的按钮/菜单项只吃真实鼠标事件

`page.evaluate` 里的 `element.click()` 无效；`locator.click({force:true})` 也可能被吞、被遮罩吃掉（页面常有 `div[data-testid="mask"]`）。
**最稳方案**：`getBoundingClientRect()` 拿中心点 → `page.mouse.click(x, y)`。

### 2. 图片插不进 Articles 正文

`setInputFiles` 和工具栏 `filechooser` 都会弹 "Edit media"，点 Apply 后正文里依然没有图（Draft.js blocks 不变、`img` 数 0），
**同一个文件在推文串编辑器里却能正常上传**。
结论：Articles 只搬文字 + 小标题；图片留给推文串那条路；原文链接也不写进正文（零外链原则，由自回复承载）。

### 3. Heading 样式会往后串染

设完小标题换行后**必须把新段落设回 `Body`**，否则后面全部变成大标题。

### 4. Publish 点击三连坑

- ①新输入后按钮先 **disabled**（等自动保存），点 disabled 按钮等于没点——要等 `isEnabled`；
- ②**首次点击常被吞**，要带轮询重试（实测第 1 次点击没反应，第 2 次才生效）；
- ③确认弹窗**时有时无**，且页面常有隐藏 `role="dialog"` 干扰 `locator(...).first()` 的可见性判定——
  弹窗存在就点确认键（按钮文案可能**只挂在 aria-label**，innerText 是空串，匹配时要 `innerText + ' ' + aria-label`），
  不存在就当直接发布；最终以 `/status/` 落地为准。

### 5. 校验抢跑会把成功误判成失败

发布成功后条目进 Published 列表**有延迟**。第一轮没扫到 ≠ 失败：分 3 轮、每轮等 15s 再切一次标签。
曾因此把已发布成功的文章误报"转人工"。

### 6. 删除确认键有两种文案

草稿是 "Yes, delete"，已发布是 "Delete Article"，还有版本是纯图标 + aria-label。统一按 `/delete|删除/i` 匹配（排除 Cancel），同样用鼠标坐标点。

## 自检闭环（改完发布逻辑必跑）

```powershell
node scripts/x_article_selftest.js   # 建稿 → 发布 → Published 验证 → 删除，全绿才算修好
node scripts/x_article_delete.js <compose/articles/edit/ID>   # 手动清残留草稿/文章
```

## 演练模式

`scripts/wx2x.js preview "<标题片段>" --dry-article`：走完整 Articles 编辑器流程（标题/正文/小标题/发布弹窗都过一遍），
回读编辑器内容做快照后**删掉草稿，绝不发布**。改段落样式逻辑后先跑这个。
