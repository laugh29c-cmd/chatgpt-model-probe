# ChatGPT Model Probe｜Tampermonkey 安装与使用教程

适用版本：`v1.3.1`

这个脚本只在 `https://chatgpt.com/*` 生效。它不通过 DOM、模型选择器或聊天文字猜模型，而是在页面网络层观察 ChatGPT 自己的 conversation 请求与 SSE 返回。

---

## 1. “油猴”是什么

“油猴”通常指 Tampermonkey：一个浏览器 userscript 管理扩展。

脚本安装在 Tampermonkey 里之后，每次打开匹配的网站，它会按 userscript 头部配置自动运行。

本脚本使用：

```text
@match   https://chatgpt.com/*
@run-at  document-start
@sandbox raw
```

也就是只匹配 ChatGPT 网页，并尽量在文档最早阶段 hook `fetch`。

---

## 2. 安装 Tampermonkey

在 Chrome / Chromium 系浏览器安装 Tampermonkey。

安装完成后，浏览器工具栏通常会出现 Tampermonkey 图标；如果没看到，可以在扩展程序菜单里把它固定到工具栏。

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

找到并打开：

```text
允许用户脚本
Allow User Scripts
```

如果 Tampermonkey Dashboard 顶部直接出现蓝色提示“请启用允许用户脚本扩展设置”，按提示点进去打开即可。

如果这个开关没开，脚本可能看起来已经保存和启用，但不会真正注入页面。

---

## 4. Tampermonkey 的 Content Script API

如果你的 Tampermonkey 版本提供这个选项：

```text
Tampermonkey Dashboard
→ Settings / 设置
→ Config mode / 配置模式：Advanced / 高级
→ Content Script API
```

优先选择支持即时 `document-start` 的模式，例如：

```text
UserScripts API Dynamic
```

不同 Chrome / Tampermonkey 版本的名称可能略有差异；如果你的版本没有该项，不必为了找它卡住，先按后面的安装步骤实际测试。

---

## 5. 安装 ChatGPT Model Probe

### 方法 A：复制脚本

打开 Tampermonkey：

```text
Tampermonkey
→ Dashboard / 管理面板
→ + / 添加新脚本
```

把编辑器默认内容全部删掉。

打开仓库根目录的：

```text
ChatGPT_Model_Slug_Probe.user.js
```

复制全部内容到 Tampermonkey 编辑器。

保存：

- macOS：`⌘S`
- Windows：`Ctrl+S`

然后回到：

```text
https://chatgpt.com/
```

整页刷新一次。

### 方法 B：直接从 Raw 页面安装

如果浏览器和 Tampermonkey 能识别 `.user.js`：

打开脚本文件的 Raw 页面，Tampermonkey 通常会弹出安装确认页。

如果没有弹出，就用方法 A。

---

## 6. 怎么确认已经运行

刷新 ChatGPT 后，不需要先发消息，页面应该先出现一个小悬浮窗：

```text
ChatGPT metadata · v1.3.1
```

如果看到这个框，说明 userscript 注入已经 PASS。

第一次没有新回复时，字段出现 `—` 是正常的。

---

## 7. 悬浮窗怎么移动和收起

最新版支持拖动。

按住顶部标题：

```text
ChatGPT metadata · v1.3.1
```

直接拖到屏幕其他位置即可。

右上角有：

```text
收起 / 展开
```

脚本会在当前浏览器 `localStorage` 里只保存：

```text
悬浮窗位置
收起/展开状态
```

不会因为这个 UI 功能持久化聊天正文或模型 metadata。

---

## 8. 怎么测试

刷新 ChatGPT 后，正常发一句消息，例如：

```text
1
```

等回复完成，再看悬浮窗。

通常会看到：

```text
requested (body.model)
message.model_slug
resolved_model_slug
server STE model_slug
```

---

## 9. 四个模型字段分别是什么

### requested (body.model)

本轮 conversation POST 请求里提交的 `body.model`。

它回答的是：

> 客户端这一轮请求时提交了什么模型字段？

### message.model_slug

assistant message metadata 里的：

```text
metadata.model_slug
```

### resolved_model_slug

如果当前 conversation/message metadata 返回：

```text
resolved_model_slug
```

脚本就显示它。

有些轮次或当前接口版本可能没有这个字段；显示 `—` 不等于脚本坏了。

### server STE model_slug

脚本会显式识别：

```json
{
  "type": "server_ste_metadata",
  "metadata": {
    "model_slug": "..."
  }
}
```

也兼容 SSE 把 `server_ste_metadata` 放在 `event:` 名称里的情况。

这是这个脚本里最值得重点观察的一项。

---

## 10. 怎么读结果

如果四项一致，例如：

```text
requested                gpt-x-x-thinking
message.model_slug       gpt-x-x-thinking
resolved_model_slug      gpt-x-x-thinking
server STE model_slug    gpt-x-x-thinking
```

正确结论是：

> 本轮浏览器能观察到的这些模型字段一致，没有发现显式 model slug mismatch。

不能进一步宣称：

> 已经绝对证明服务器内部从头到尾没有任何 routing / serving / reasoning policy 变化。

因为这些值仍然是服务器主动返回给客户端的 metadata。

如果出现：

```text
requested                A
message.model_slug       A
resolved_model_slug      A
server STE model_slug    B
```

说明本轮出现了值得研究的 metadata mismatch。

脚本会用黄色边框/提示标出字段差异。

但不同 identifier 也可能是 alias、router、内部命名差异，所以：

> mismatch 是证据，不是自动等于“降级”的结论。

---

## 11. 下面的速度数据是什么意思

### 响应头到达

从客户端发起 fetch 到拿到 Response headers 的时间。

### 首数据块（非 TTFT）

脚本 clone 的 SSE response 第一次读到字节块的时间。

它不是首 token。

### 首段文本（含可见思考）

脚本第一次从已识别的 assistant text message 中看到文本。

### 首段正文（TTFT 近似）

脚本第一次识别到 final answer 正文的时间。

这是客户端近似值，不是服务器内部原生 TTFT 指标。

### 正文速度（近似）

按脚本识别到的 Unicode 字符计算：

```text
字符/s
```

不是 tokens/s。

### SSE 数据速率

按整个 SSE 字节流计算，里面还包括协议结构、metadata 等内容。

因此也不是模型 token generation speed。

---

## 12. “存在未解析事件”是什么意思

如果底部出现：

```text
存在未解析事件，文本统计可能不完整
```

说明当前 SSE 中存在脚本没有完整重建的 patch/event。

此时：

- 模型 metadata 仍可能已经正确抓到；
- 但正文字符数、TTFT、正文速度需要谨慎解读。

ChatGPT 内部 response schema 不是稳定的公开 API，后续如果改格式，parser 可能需要跟着更新。

---

## 13. 新一轮为什么会清空旧值

脚本每次观察到新的 conversation POST 时，会立即清空上一轮：

```text
requested
message
resolved
STE
```

尤其是旧的 STE 不会留着冒充新一轮结果。

所以回复生成过程中暂时出现 `—` 是正常的，等对应 metadata 到达后再更新。

---

## 14. 切换 ChatGPT 对话

ChatGPT 是 SPA。

脚本监听：

```text
pushState
replaceState
popstate
```

切到另一条 `/c/<conversation-id>` 时会切换 conversation state，避免上一条对话的数据直接串进来。

历史会话只读取当前 active branch 上最新 assistant message 的 metadata，不通过 DOM 猜模型。

---

## 15. 隐私说明

脚本不会：

- 把聊天上传到第三方服务器
- 要求 OpenAI API token
- 发送 telemetry
- 持久化聊天正文
- 持久化 conversation model metadata

为了计算当前回复的字符数和 timing，运行时会在内存中重建当前 response 的部分 message snapshot；回复结束后会释放这些临时文本结构。

`localStorage` 只保存悬浮窗 UI 位置和折叠状态。

---

## 16. 常见问题

### 刷新后完全没有悬浮窗

优先检查：

1. Tampermonkey 是否启用；
2. 当前脚本是否启用；
3. Chrome 的「允许用户脚本」是否打开；
4. 当前网址是否确实是 `https://chatgpt.com/`；
5. 保存脚本后有没有整页刷新。

### 悬浮窗有，但全是 `—`

先新发一轮消息。

历史页面不保证包含所有模型字段。

### resolved_model_slug 是 `—`

字段本身可能没有返回，不一定是脚本故障。

### STE 一直是 `—`

当前轮可能没返回该 event，或者 ChatGPT 又调整了 SSE schema。

可以先确认其他三项是否正常，再等待 parser 更新。

### 面板挡屏幕

拖顶部标题到别处，或者点「收起」。

---

## 17. 一句话理解这个工具

它不是“模型测谎仪”。

更准确的定义是：

> 把 ChatGPT 当前浏览器本来就能收到、但 UI 通常不直接展示的模型 metadata 和网络观测数据摆出来，方便连续观察和留证。

有异常，再拿数据讨论；没有异常，也不要仅凭单个速度数字硬推导服务器内部发生了什么。
