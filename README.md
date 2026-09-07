# ChatGPT Model Probe

一个只运行在 `chatgpt.com` 的 Tampermonkey userscript，用来把浏览器实际收到的 ChatGPT 模型 metadata、客户端 timing 和连续多轮 Daily Ledger 摆到页面上。

当前版本：`v1.4.0`

> 它不是“模型测谎仪”。它记录的是客户端可观察证据：请求字段、message metadata、`server_ste_metadata`、SSE/timing，以及本地连续样本。单个字段或单轮速度都不能独立证明服务器内部完整 routing / serving 行为。

## v1.4.0 新增：Daily Ledger

v1.3.x 只能看当前一轮。v1.4.0 开始，每轮结束会自动在浏览器本地 IndexedDB 留下一条无正文记录，便于做一整天或多天的纵向分析。

每轮记录：

- 时间戳、conversation id、session turn
- `requested_model`
- `message_model_slug`
- `resolved_model_slug`
- `server_ste_model_slug`
- `slug_mismatch` / `ste_mismatch`
- headers / first byte / first text / first answer / total timing
- 已识别正文字符数、近似字符速率、SSE KiB/s
- parser miss 数量与文本统计完整性
- 可选人工行为标签：`normal / suspicious / drift`

不保存聊天正文，不上传第三方。默认只保留最近 14 天。

面板新增：

- `导出今日 JSON`
- `CSV`
- `复制今日摘要`
- `清空日志`
- 当前轮 `正常 / 可疑 / 明显漂移` 标签

## 安装

### 1. 安装 Tampermonkey

在 Chrome / Chromium 浏览器安装 Tampermonkey（俗称“油猴”）。

### 2. 开启 Chrome「允许用户脚本」

进入：

```text
Chrome
→ 扩展程序
→ 管理扩展程序
→ Tampermonkey
→ 详细信息
→ 允许用户脚本 / Allow User Scripts
```

如果 Tampermonkey 顶部提示需要开启该设置，按提示打开即可。

### 3. 安装脚本

打开：

```text
ChatGPT_Model_Slug_Probe.user.js
```

可以从 GitHub Raw 页面交给 Tampermonkey 安装；如果浏览器没有自动唤起 Tampermonkey，就：

```text
Tampermonkey
→ Dashboard / 管理面板
→ 添加新脚本
→ 删除默认内容
→ 粘贴完整 userscript
→ 保存
```

然后刷新 `https://chatgpt.com/`。

看到：

```text
ChatGPT metadata · v1.4.0
```

即代表脚本已注入。

完整中文教程见 [`docs/INSTALL_zh-CN.md`](docs/INSTALL_zh-CN.md)。

## 四个模型字段

```text
requested (body.model)
message.model_slug
resolved_model_slug
server STE model_slug
```

### requested (body.model)

本轮 conversation POST 中客户端提交的 model 字段。它表示“请求了什么”，不等于实际最终执行证明。

### message.model_slug

assistant message metadata 中的 `model_slug`。

### resolved_model_slug

如果当前 response/message metadata 暴露该字段则显示；不存在时保持 `—`，不会拿其他字段替代。

### server STE model_slug

显式识别：

```json
{
  "type": "server_ste_metadata",
  "metadata": {
    "model_slug": "..."
  }
}
```

也兼容 SSE 使用 `event: server_ste_metadata` 的形式。

## 怎么判断“是否路由”

优先级建议：

```text
server STE / resolved / message 的显式 slug mismatch
    >
连续多轮性能分布变化
    >
人工行为标签共现
    >
单轮速度异常
```

如果同一轮 `requested / message / resolved / STE` 出现不同 slug，属于明确值得调查的客户端 metadata mismatch。

如果 slug 长期一致，但“可疑/明显漂移”的轮次稳定集中在另一套 TTFT、总耗时或生成分布里，更适合描述为：

```text
MODEL SLUG ROUTING = NOT OBSERVED
SERVING / REASONING POLICY SHIFT = SUSPECTED
```

而不是直接断言换成了某个没有证据的模型。

## Timing 的边界

- 响应头到达：浏览器 fetch 得到 headers 的时间
- 首数据块：第一个 SSE 数据块，不是首 token
- 首段文本：parser 首次识别 assistant text
- 首段正文：parser 首次识别 final answer，属于 TTFT 近似
- 正文速度：Unicode 字符/s，不是 tokens/s
- SSE 数据速率：包含协议和 metadata，不是模型 token speed

如果出现：

```text
存在未解析事件，文本统计可能不完整
```

则对应轮次的正文字符数、TTFT、正文速度应谨慎使用；模型 metadata 仍可能已经正确抓到。

## 隐私

脚本不会：

- 上传聊天到第三方
- 要求 OpenAI API token
- 发送 telemetry
- 持久化聊天正文

`localStorage` 只保存悬浮窗位置和折叠状态。

`IndexedDB` 只保存 Daily Ledger 的模型字段、conversation id、timing、计数、parser 状态和人工标签，默认保留 14 天。

导出的 JSON/CSV 会包含 `conversation_id`，转发给别人前请自行判断是否需要脱敏。

## 数据导出后怎么分析

优先用 JSON。至少积累 20–50 个相似任务轮次后，再比较：

- mismatch 与人工行为漂移是否共现
- slug 一致时，可疑样本是否形成另一套 timing cluster
- TTFT / total / char rate 的 median、P90、分布变化
- `parse_misses > 0` 的轮次单独排除或降权

## 文件

```text
ChatGPT_Model_Slug_Probe.user.js
README.md
docs/INSTALL_zh-CN.md
```

## Disclaimer

此工具依赖 ChatGPT 当前网页内部网络格式。相关 endpoint、SSE event 或 metadata 字段属于非稳定公开接口，未来变更可能导致 parser 需要更新。
