# ChatGPT Model Probe｜Tampermonkey 安装与使用教程

适用版本：`v1.4.0`

这个脚本只在 `https://chatgpt.com/*` 生效。它不通过 DOM、模型选择器或聊天文字猜模型，而是在页面网络层观察 ChatGPT 自己的 conversation 请求、SSE 返回和客户端 timing。

v1.4.0 还会把每轮的“无正文统计记录”自动保存到浏览器本地 Daily Ledger，方便一天或多天以后统一分析。

---

## 1. “油猴”是什么

“油猴”通常指 **Tampermonkey**：一个浏览器 userscript 管理扩展。

userscript 可以指定只在哪些网站运行、什么时候注入。本脚本头部限定：

```text
@match   https://chatgpt.com/*
@run-at  document-start
@sandbox raw
```

也就是只在 ChatGPT 网页运行，并尽量在文档最早阶段 hook `fetch`。

---

## 2. 安装 Tampermonkey

在 Chrome / Chromium 系浏览器安装 Tampermonkey。

安装后，如果工具栏没看到图标，可以打开浏览器扩展程序菜单，把 Tampermonkey 固定到工具栏。

---

## 3. Chrome 必须开启「允许用户脚本」

进入：

```text
Chrome
→ 扩展程序
→ 管理扩展程序
→ Tampermonkey
→ 详细信息
```

找到并开启：

```text
允许用户脚本
Allow User Scripts
```

如果 Tampermonkey Dashboard 顶部出现蓝色提示要求开启用户脚本权限，直接按提示进入扩展设置打开即可。

这个开关没开时，脚本可能看起来“已经保存并启用”，但实际不会注入 `chatgpt.com`。

---

## 4. Content Script API（有这个选项再设置）

部分 Tampermonkey / Chrome 版本会提供：

```text
Tampermonkey Dashboard
→ Settings / 设置
→ Config mode / 配置模式：Advanced / 高级
→ Content Script API
```

如果存在，可以优先使用支持及时 `document-start` 的 UserScripts API 模式，例如：

```text
UserScripts API Dynamic
```

不同版本名称可能不同。没有这项时，不要卡在这里，先按后面的步骤实际安装测试。

---

## 5. 安装 ChatGPT Model Probe

### 方法 A：Tampermonkey 里直接粘贴

```text
Tampermonkey
→ Dashboard / 管理面板
→ + / 添加新脚本
```

把编辑器默认内容全部删掉。

打开仓库根目录：

```text
ChatGPT_Model_Slug_Probe.user.js
```

复制全部代码粘进去，然后保存：

- macOS：`⌘S`
- Windows：`Ctrl+S`

回到：

```text
https://chatgpt.com/
```

整页刷新一次。

### 方法 B：Raw 页面安装

打开 `.user.js` 的 GitHub Raw 页面。如果浏览器和 Tampermonkey 正常识别 userscript，会出现安装确认页。

如果没有自动弹出，就使用方法 A。

---

## 6. 怎么确认已经运行

刷新 ChatGPT 后，页面应该出现悬浮窗：

```text
ChatGPT metadata · v1.4.0
```

看到它代表 userscript 注入 PASS。

还没新发消息时字段显示 `—` 是正常的。

---

## 7. 悬浮窗怎么移动 / 收起

按住顶部：

```text
ChatGPT metadata · v1.4.0
```

可以拖动到屏幕其他位置。

右上角：

```text
收起 / 展开
```

脚本会在 `localStorage` 里只保存：

```text
悬浮窗位置
收起/展开状态
```

---

## 8. 正常测试一轮

刷新以后正常发一句话，例如：

```text
1
```

等回复结束，看面板：

```text
requested (body.model)
message.model_slug
resolved_model_slug
server STE model_slug
```

以及：

```text
响应头到达
首数据块（非 TTFT）
首段文本（含可见思考）
首段正文（TTFT 近似）
本轮耗时
正文速度（近似）
已识别正文字符
SSE 数据速率（含协议）
```

---

## 9. 四个模型字段是什么意思

### requested (body.model)

本轮 conversation POST 请求中客户端提交的 `body.model`。

它只能回答“客户端请求了什么”。

### message.model_slug

assistant message metadata 里的：

```text
metadata.model_slug
```

### resolved_model_slug

如果当前 response/message metadata 返回：

```text
resolved_model_slug
```

脚本显示它。

字段不存在时显示 `—`，不会拿别的字段填充。

### server STE model_slug

脚本显式识别：

```json
{
  "type": "server_ste_metadata",
  "metadata": {
    "model_slug": "..."
  }
}
```

也兼容 SSE 把 `server_ste_metadata` 放在 `event:` 名称里的形式。

这是当前客户端可见模型证据里最值得重点观察的一项，但仍然属于“服务器主动向客户端报告的 metadata”，不是底层 inference worker 的密码学证明。

---

## 10. 怎么读 mismatch

例如：

```text
requested                gpt-a
message.model_slug       gpt-a
resolved_model_slug      gpt-a
server STE model_slug    gpt-b
```

说明本轮出现客户端可观察到的 metadata mismatch，值得进一步调查。

如果四项一致，只能说明：

> 当前客户端可见字段没有发现显式 slug mismatch。

不能进一步证明服务器内部绝对不存在其它 routing、serving、reasoning allocation 或执行策略变化。

---

## 11. v1.4.0 Daily Ledger 是什么

从 v1.4.0 开始，每轮结束后，脚本会自动向浏览器本地 **IndexedDB** 写入一条记录。

不会保存聊天正文。

记录字段包括：

```text
timestamp
ended_at
local_day
session_turn
conversation_id

requested_model
message_model_slug
resolved_model_slug
server_ste_model_slug
slug_mismatch
ste_mismatch

headers_ms
first_byte_ms
first_text_ms
first_answer_ms
total_ms

answer_chars
chars_per_sec
sse_kib_per_sec
parse_misses
text_stats_complete
status
behavior_label
```

默认只保留最近 **14 天**，旧数据会自动清理。

注意：升级 v1.4.0 之前没有被记录的旧轮次，脚本无法从浏览器历史中还原出当时完整 timing；Ledger 从安装 v1.4.0 后开始积累。

---

## 12. 怎么看“今日 Ledger”

面板底部会显示类似：

```text
今日 Ledger · 2026-09-07 · 27 轮 · mismatch 1 · STE mismatch 1 · 标记异常 4
```

其中：

- `mismatch`：本轮可比较的 model identifier 存在差异
- `STE mismatch`：STE 与请求/resolve/message 基线至少一项不同
- `标记异常`：人工打了“可疑”或“明显漂移”的轮数

---

## 13. 怎么人工标记“今天这轮不对劲”

回复完成并写入 Ledger 后，面板会出现：

```text
正常
可疑
明显漂移
```

按你的体感标记即可。

推荐标准：

### 正常

判断力、上下文、约束跟随和工程主线都在正常区间。

### 可疑

出现明显变浅、漏约束、机械复述、过度顺从、风格突然漂移等情况，但还不足以下结论。

### 明显漂移

出现非常明显的连续性/判断能力变化，足以作为后续统计中的强行为标签。

标签只是人工证据，不等于自动证明发生了 routing。

---

## 14. 怎么导出一天数据

面板提供：

```text
导出今日 JSON
CSV
复制今日摘要
```

### JSON

最适合后续交给 ChatGPT、Python、R 或其它统计工具分析。包含字段完整、类型不会因为 CSV 文本化丢失。

文件名类似：

```text
chatgpt-model-probe_2026-09-07.json
```

### CSV

适合 Excel / Numbers / Google Sheets。

### 复制今日摘要

会复制类似：

```text
ChatGPT Model Probe · 2026-09-07
turns: 42
slug mismatch: 1
STE mismatch: 1
behavior suspicious/drift: 7
parse-miss turns: 4
median TTFT: 8.21 s
median total: 26.40 s
median chars/s: 98.2
```

---

## 15. 导出文件有没有隐私信息

没有聊天正文，但 JSON / CSV **会包含 `conversation_id`**。

这个 id 本身不是聊天文本，但仍然属于会话标识。若要公开发布原始数据，建议先删除或哈希 `conversation_id`。

脚本本身不会把这些数据上传到任何服务器。

---

## 16. 怎么清空日志

点：

```text
清空日志
```

会弹确认框。

确认以后只会清除 ChatGPT Model Probe 自己在 IndexedDB 里的本地 Ledger，不会删除 ChatGPT 对话。

---

## 17. Timing 怎么看

### 响应头到达

客户端发起 fetch 到拿到 Response headers 的时间。

### 首数据块（非 TTFT）

脚本 clone 的 SSE response 第一次读到字节块。

不是首 token。

### 首段文本（含可见思考）

parser 第一次识别 assistant text。

### 首段正文（TTFT 近似）

parser 第一次识别 final answer 正文。

只能作为客户端近似 TTFT。

### 正文速度（近似）

Unicode 字符/s，不是 tokens/s。

### SSE 数据速率

整个 SSE 数据流的 KiB/s，包含协议、metadata 等，不是模型生成速度。

---

## 18. “存在未解析事件”是什么意思

如果出现：

```text
存在未解析事件，文本统计可能不完整
```

说明当前 SSE 中有 parser 没有完整重建的 patch/event。

这种轮次：

- 模型 metadata 仍可能有效
- 但正文字符数、正文速度、TTFT 要降权
- Ledger 会写 `parse_misses > 0`
- `text_stats_complete = false`

做长期统计时，建议把这些轮次的文本类 timing 单独排除或降权。

---

## 19. 真正分析“是否发生路由”时怎么用

不要拿单轮速度下结论。

建议至少积累 20–50 个相似任务轮次，优先看：

```text
1. STE / resolved / message 是否出现显式 slug mismatch
2. mismatch 是否和“可疑/明显漂移”行为标签共现
3. slug 一致时，可疑样本是否形成另一套 TTFT / total / chars/s 分布
4. parser miss 轮次是否污染统计
5. 单轮异常最后再看
```

如果 slug 一直一致，但异常行为稳定形成另一套性能 cluster，更准确的表达是：

```text
MODEL SLUG ROUTING = NOT OBSERVED
SERVING / REASONING POLICY SHIFT = SUSPECTED
```

而不是凭体感指定一个没有 metadata 支持的具体模型。

---

## 20. 常见问题

### 刷新后完全没有悬浮窗

检查：

1. Tampermonkey 是否启用
2. 当前 userscript 是否启用
3. Chrome「允许用户脚本」是否打开
4. 当前网址是不是 `https://chatgpt.com/`
5. 保存脚本后有没有整页刷新

### 悬浮窗有，但字段全是 `—`

先新发一轮消息。历史会话不保证具备全部字段。

### resolved_model_slug 是 `—`

字段本身可能没返回，不等于脚本坏了。

### server STE 一直是 `—`

当前轮可能没返回该 event，也可能 ChatGPT 更改了 SSE schema。

### Daily Ledger 显示 0

v1.4.0 只从升级后新产生的回复开始记录，不会补录之前的 timing 历史。

### 面板挡屏幕

拖顶部标题，或者点「收起」。

---

## 21. 一句话理解这个工具

它不是模型测谎仪。

更准确地说，它是一个：

> **ChatGPT 客户端模型 metadata + SSE timing + 本地连续留证黑匣子。**

单轮负责看发生了什么，Daily Ledger 负责回答“今天/这几天是否出现了稳定分档或共现”。
