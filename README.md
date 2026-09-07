# ChatGPT Model Probe

一个只在 `chatgpt.com` 生效的 Tampermonkey userscript，用浏览器网络层观察 ChatGPT 对话请求与 SSE 返回中的模型 metadata，并显示客户端可观测的响应时间与文本吞吐。

> 这是非官方调试/观察工具，与 OpenAI 无隶属关系。它显示的是 **ChatGPT 服务器向当前浏览器暴露的 metadata**，不是对底层 inference worker 的密码学证明。

## 能看到什么

悬浮窗会显示：

- `requested (body.model)`：本轮请求提交的模型字段
- `message.model_slug`：assistant message metadata 中的 `model_slug`
- `resolved_model_slug`：可用时显示 resolved model
- `server STE model_slug`：显式识别 SSE 中的：

```json
{
  "type": "server_ste_metadata",
  "metadata": {
    "model_slug": "..."
  }
}
```

同时显示：

- 响应头到达
- 首 SSE 数据块
- 首段文本
- 首段正文（TTFT 近似）
- 本轮总耗时
- 已识别正文字符与近似字符速度
- SSE 数据速率

v1.3.1 的面板支持 **拖动、收起/展开、记住位置**。

## 安装

### 1. 安装 Tampermonkey

在 Chrome / Chromium 浏览器安装 Tampermonkey（俗称“油猴”）。

### 2. Chrome 开启「允许用户脚本」

进入：

`Chrome → 扩展程序 → 管理扩展程序 → Tampermonkey → 详细信息`

开启：

`允许用户脚本 / Allow User Scripts`

如果 Tampermonkey 顶部出现蓝色提示要求开启该设置，直接按提示打开即可。

### 3. 新建脚本

Tampermonkey → Dashboard / 管理面板 → `+` / 添加新脚本。

把默认内容全部删除，然后粘贴：

[`ChatGPT_Model_Slug_Probe.user.js`](./ChatGPT_Model_Slug_Probe.user.js)

保存后回到 `https://chatgpt.com/`，整页刷新一次。

详细图文/排错说明见：

[`docs/INSTALL_zh-CN.md`](./docs/INSTALL_zh-CN.md)

## 怎么用

刷新 ChatGPT 后，页面会出现 `ChatGPT metadata` 悬浮窗。

正常发送一条消息，等回复完成后观察四个模型字段。例如：

```text
requested                gpt-x-x-thinking
message.model_slug       gpt-x-x-thinking
resolved_model_slug      gpt-x-x-thinking
server STE model_slug    gpt-x-x-thinking
```

如果字段不同，脚本会把差异标出来。但 **字段差异本身不能直接证明“降级”**：内部 slug 可能存在 alias、routing 或其他 serving 层差异。

同样，四项一致只表示：

> 当前浏览器可见的这些字段没有显示出 model slug mismatch。

它不能证明服务器内部从头到尾绝无其他 routing / serving policy / reasoning allocation 变化。

## 为什么重点看 `server STE model_slug`

这个字段来自服务端返回的 `server_ste_metadata` SSE 事件，因此比读取页面 DOM、模型选择器或询问模型自身更接近当前浏览器实际收到的服务端执行 metadata。

但它仍然只是服务端主动返回的 metadata，不应被描述成“底层模型鉴定器”。

## 隐私

脚本：

- 不上传 telemetry
- 不要求 API token
- 不把聊天正文发送到第三方
- 不持久化 conversation text
- v1.3.1 的 `localStorage` 只保存悬浮窗的位置与收起/展开状态

网络解析仅发生在当前 `chatgpt.com` 页面内。

## 性能数据的边界

`首数据块` 不是首 token；`首段正文` 只是客户端解析到 final answer 文本的 TTFT 近似值；`字符/s` 不是 tokens/s；`SSE 数据速率` 还包含协议和 metadata。

网络、排队、缓冲、服务负载和当前内部响应格式都会影响这些数字。

如果底部出现：

```text
存在未解析事件，文本统计可能不完整
```

则该轮 TTFT / 正文字符数 / 正文速度需要谨慎解读。

## 文件

```text
chatgpt-model-probe/
├── README.md
├── ChatGPT_Model_Slug_Probe.user.js
├── docs/
│   └── INSTALL_zh-CN.md
└── dist/
    └── ChatGPT_Model_Probe_v1.3.1_bundle.zip
```

## 当前版本

`v1.3.1`

- 网络层 `fetch` hook
- conversation history metadata 读取
- `/backend-api/conversation` 与 `/backend-api/f/conversation` SSE 观察
- `server_ste_metadata.metadata.model_slug` 显式解析
- 新 turn 清空旧 STE
- SPA 切换会话状态隔离
- 客户端 timing / throughput 观察
- 可拖动、可折叠、记忆位置的悬浮窗
