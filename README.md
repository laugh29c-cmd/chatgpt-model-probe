# ChatGPT Account Route Probe 1.5.1

这是 v1.5.0 的轻量试用修订。保留原版 Chrome Chat 的模型字段、计时和 Daily Ledger，扩展 Work 回包观察，并增加桌面本地回执窗口。不是后台真实模型的审计接口，也不改变账号、节点或模型路由。

## 最快开始：Chrome / Edge / Mac 浏览器

1. 在篡改猴中停用旧版探针。
2. 导入 `ChatGPT_Model_Slug_Probe.user.js`，启用后刷新 ChatGPT 页面。原来的 IndexedDB 日志保留。
3. 正常使用 Chat 或 Work。右下角可拖动、收缩；“观察”勾选框控制采集。收缩后仍显示返回模型字段与证据状态。
4. 需要对照时，设置“对照标签”，例如 `账号A / 网线 / 节点1`；刚重新登录后点“标记刚登录”。标签不读取账号或认证信息。
5. 使用一段时间后导出 JSON。JSON 包含完整诊断；CSV 是便于浏览的子集。

不需要 Node、终端或桌面程序。已在使用篡改猴时，不要同时加载本包的 `extension`，避免重复观察。

不使用篡改猴的 Chromium 浏览器可在扩展管理页开启开发者模式，加载 `extension` 文件夹。它只匹配 `https://chatgpt.com/*`，在页面主执行环境注入脚本。

## Work 回执空白：新版增加什么

- 保留 assistant metadata 和 `server_ste_metadata`；增加 Responses 响应信封、JSON-RPC 嵌套结果、显式 `model/rerouted` 事件和完整路径的模型 metadata 补丁。
- 网页观察 fetch SSE / JSON / NDJSON，以及页面主执行环境中的 WebSocket、EventSource、完成后的 XHR。XHR 不声明逐字实时计时。
- 每次请求保留事件数、事件类型、模型字段路径、解析缺失数、HTTP 状态和 Content-Type。不会保存一般 JSON 叶子值或聊天正文。
- `其他 model 字段` 是回包中实际出现的候选字段，语义标记为 `NOT_VERIFIED`；不自动当成后台有效模型。
- `requested_only` 表示目前只获得了请求模型；`metadata_unavailable` 表示没有得到已识别的模型证据。这两种情况都不是“正常路由 PASS”。
- Worker、Service Worker、原生 IPC、另一个进程、其他域请求或后台未暴露的数据，不会因为注入了网页脚本就变得可见。遇到它们，先看诊断，不能承诺所有 Work 版本都能读到实际模型。

## Windows / Mac 桌面回执

在解压目录中运行，需要 Node.js 22 或更新版，无 npm 依赖：

```text
node ChatGPT_Account_Route_Probe.mjs
```

程序打印 `http://127.0.0.1:随机端口`，打开就是回执窗口。初始不附加任何目标。点击“查找目标”，选择当前已授权的页面或进程，再“连接”。可暂停、标记正常/可疑/漂移、设置网络标签和账号代号、导出 JSON。窗口支持手机尺寸布局，但这个本机地址不供另一台手机远程连接。

- Windows 也有 `ChatGPT_Account_Route_Probe.ps1`。系统禁止执行 `.ps1` 时直接使用上述 `node` 命令，无需修改系统策略。
- Mac 在终端运行 `zsh ChatGPT_Account_Route_Probe.command`。启动器不强制退出或重新启动 ChatGPT/Codex。
- 指定已有调试端口：`node ChatGPT_Account_Route_Probe.mjs --cdp http://127.0.0.1:9223`。
- 指定本地日志目录：`node ChatGPT_Account_Route_Probe.mjs --data-dir /your/local/path`。
- Windows 的 Node 进程可用 Ctrl-C 停止。面板“暂停”会断开采集，面板自身仍保持打开。

### 桌面 App 的前提

目标程序必须支持并开启 Chromium CDP。对支持这些参数的 Electron/Chromium 应用，在正常退出应用后，可手动从终端使用实际可执行文件启动：

```text
"实际的应用可执行文件路径" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

这不是所有 ChatGPT/Codex 版本都支持的公共契约。若 `/json/list` 不可用，面板会明确显示 `CDP_NOT_AVAILABLE`，不会自动改用私有凭据、重启应用或修改代理。开启本地调试端口会允许同机进程访问调试目标，用完应关闭该调试实例；不把端口开放到局域网。

即使成功附加渲染进程，Codex 的实际模型请求也可能在主进程/独立 app-server 中完成。此时面板只显示它观察到的证据，不能把“无改路由事件”当成实际模型相同。原包的 CLI 主动测试是另一条测试请求，不能代表当前前台任务，本次发行不默认启动或循环调用它。

桌面新版支持 CDP 实时流读取；不支持 `Network.streamResourceContent` 的程序会明确记为 `body_after_finish_only`。拿不到响应体会写 `body_unavailable`，不再静默吞掉失败。页面、Worker 都需要按目标明确选择，每个实例一次观察一个目标。

“浮窗”使用浏览器提供的 Document Picture-in-Picture；受支持的桌面 Chromium 浏览器中可独立浮在其他应用上方。不支持的客户端保留普通窗口和收缩视图。Codex 中可把本地 URL 打开在浏览器侧栏，它是本地探针的回执页面，不是 Codex 原生工具栏插件。

## iPhone / iPad

使用 Safari + Userscripts 扩展，在 Userscripts 设定的脚本目录中安装同一份 `.user.js`，为 `chatgpt.com` 授权，并在 Safari 中重新打开网页。只需授权这个站点。支持页面内浮窗和收缩。

这是手机网页采集方案；不注入官方 ChatGPT iOS App，不提供跨 App 的通用系统悬浮窗。无独立原生 App、后台 VPN 或证书安装。

官方项目安装步骤：[Userscripts](https://github.com/quoid/userscripts#usage)。本轮没有连接 iPhone/iPad 真机，Safari 注入及站点策略兼容性仍待实机试用。

## Android

使用支持用户脚本扩展的浏览器，例如 Firefox Android + Tampermonkey，导入同一份 `.user.js`，在浏览器内打开 ChatGPT。不要假设 Android 默认 Chrome 与桌面 Chrome 拥有相同扩展能力。

这是 Android 网页采集方案，不读取官方 Android App 的内部网络流量。系统级悬浮窗是另一种原生 App 功能，不等于取得模型字段；本包不申请该权限。

扩展入口：[Tampermonkey](https://www.tampermonkey.net/index.php?browser=firefox)。本轮 Android 真机未验证。

## 网络、账号与“30~60 分钟后变化”的对照

- 网页：online、连接类型（若浏览器提供）、effectiveType、RTT/下行估计、网络变化次数、请求开始/结束时快照、探针运行时长、人工登录标记、对照标签。
- Windows：启用接口类型、链路速度、IPv4/IPv6 可用性、网关/DNS/路由表/系统代理配置的摘要 ID。无需 WMI 管理员权限。
- Mac：默认路由接口和路由/DNS/系统代理摘要。接口名不能单独证明 Wi-Fi/网线类型。
- 桌面快照按请求触发、缓存 15 秒；不是后台持续轮询。网关/DNS/代理地址不写入日志，SSID、MAC、账号邮箱、cookies、tokens 不采集。
- `effectiveType=4g` 是网络质量等级，不代表手机流量；接口启用不代表这条连接的实际出口；远端服务器地址摘要不代表本机公网出口。
- 不自动查询公网 IP、代理节点名称、套餐配额、账号年龄或完整登录时间。这些字段保持未知，节点/账号使用代号人工标记。

推荐在同一账号、相同请求模型和同一节点下先比较网线/Wi-Fi，再固定网络比较其他因素。对每轮用“正常/可疑/明显漂移”标记体验，并保留原始模型字段。一次网络切换的时间相关性不能证明因果。没有官方材料确认“新登录固定一小时后必然路由到 5.5 mini”，本包不会通过换号、反复登录或保活尝试规避路由。

官方说明区分产品入口、认证方式和 workspace 的模型权限：[Workspace model availability](https://learn.chatgpt.com/docs/enterprise/workspace-model-availability)。模型选择不等于实际返回模型；当前探针只证明客户端可见字段。

## 资源边界与验证

网页：每个流最多观察 8 MB；单个流事件最多 256 KB；JSON 响应最多 2 MB；请求体最多解析 128 KB。超限停止本次观察，原回复继续。活跃时 UI 至多每秒刷新一次，页面隐藏时暂停计时刷新。日志最多 1000 条，超过 14 天的记录启动时清理；高频重复传输事件去重、每秒最多存 4 条。

桌面：最多 64 个 HTTP 请求和 32 个 WebSocket 元数据状态；每次最多 4 秒 CDP 命令等待；内存最多 1000 条回执，面板最多展示 100 条；日志约 2 MB 时滚动保留近期记录。没有定时模型测试、测速、账号保活、全盘扫描或远端上传。

本轮通过：解析器定向测试；Chromium 实际浏览器中的 Chat/Work 模拟回包、停止观察不打断回复、正文不入日志、小屏布局；实际 CDP 长连接结束前收到模型回执；本地窗口、导入、开关、浮窗、来源/控制令牌校验；本机 Windows 网络摘要读取。

未验证：用户账号实际 Work 回包、ChatGPT/Codex 原生进程覆盖、Mac/iPhone/iPad/Android 真机。它们是本包的实机试用项，不能以本地测试代替。

开发验证：`node --test tests/core.test.mjs`。浏览器测试使用 Playwright，仅开发验证需要它；日常运行无 npm 依赖。

参考：[Document Picture-in-Picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture)。
