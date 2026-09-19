# dsh-notify-hub · 通知集合

[English](README.md) | **简体中文**

把 DSH（DeepSeek Harness）的「回合结束 / 等待回答 / 等待授权」等事件，**同时**推送到 Bark、中国移动「移动新消息」(5G 消息)、桌面通知与多路 Webhook 的通知中枢。Host 端运行，浏览器关掉照常推送。

本插件是一个「合集」：它把两个参考插件的长处合并，并补上一个两者都没有的通道。

| 能力 | 来源 |
| --- | --- |
| Host 端 `session/event` 监听、9 类事件、Bark 推送（level/group）、密钥脱敏 + 专用 loopback RPC + 设置页 | `dsh-notify-bark` |
| 事件聚合（TurnAccumulator）、完成门控（CompletionGate）、去重、include/exclude 内容规则、多路 Webhook（飞书/企微/钉钉/Slack/Discord/自定义）、原生桌面通知、超时与指数退避重试、中英双语渲染 | `dsh-notify-center` |
| **「移动新消息」5G 消息通道**：WebSocket 长连接 + 鉴权 + 心跳 + 自动重连 + 富媒体上传 | 参考 `@openclaw/cmcc-newmsg-channel` 移植 |
| **通道投递历史**、**通道路由**（按会话/内容分流）、旧 Bark 配置一次性迁移 | 本插件新增 |

---

## 功能

### 通知通道

| 通道 | 说明 |
| --- | --- |
| **Bark** | 官方或自建 Bark Server。支持 Group 聚合、推送级别（active / timeSensitive / passive / critical）、自定义提示音 |
| **移动新消息** | 中国移动 5G 消息。长连接推送，支持纯文本与富媒体（图片/文件，见下文协议） |
| **桌面通知** | Windows 聚焦式 Toast（自动注册 AUMID，失败回退气泡通知）、macOS `osascript`、Linux `notify-send` |
| **飞书 / 企业微信 / 钉钉 / Slack / Discord** | 内置各自的 `text` 消息体，复制群机器人 Webhook 地址即可 |
| **自定义 Webhook** | 发送结构化 JSON（kind / title / sessionId / turn / durationMs / reason / tools / time） |

每个通道独立开关；**开关打开且凭据填写完整**才会投递，否则在设置页显示「未配置」。

### 触发事件

`任务完成`、`执行错误`、`执行被阻塞`、`手动中止`、`Token 达到上限`、`异常中断`、`等待我回答`（`ask_user_question`）、`等待授权`（`approval/asked`）、`等待计划确认`（`exit_plan_mode`）。

* 一次回合的正文由**实时聚合**得到（助手回复 + 工具列表 + 耗时），不依赖 `session.events`——DSH 0.1.5 已不再暴露该字段。
* **完成门控**：`turn/end` 的通知会等到 Agent 真正 `idle` 才发出，避免「回合结束」的横幅抢在后续排队工作之前。
* **去重**：按 `会话:seq` 记账（24h 窗口 / 2000 条上限），重载或重复派发都不会重复推送。
* 默认只通知主会话，子 Agent 会话静默（可开关）。

### 策略

* **内容规则**：按顺序匹配「标题 / 摘要 / 原因 / 类型 / 工具名」。`exclude` 命中即静默；存在 `include` 规则时，只有命中的通知才推送。支持正则与大小写敏感。
* **通道路由**：把通知按会话或内容分流到指定通道，例如「标题含 deploy → 只发飞书」「含 mobile → 只发移动新消息」。第一条命中的规则生效；全都不命中时推送到所有已启用通道。
* 语言、正文长度上限、是否附带 AI 最后一段回复，均可配置。

### 设置页

「设置 → 通知集合」一个页面完成全部配置：

* 运行状态（平台、桌面通知后端、投递队列占用）
* 每个通道一张卡片：启用、凭据（写入后不回显，只显示 `••••••••末四位`）、测试按钮
* 移动新消息：连接检测（真实建连 + 鉴权）、富媒体测试（本地图片上传后推送）
* 事件勾选、内容选项、规则与路由编辑器
* **最近投递记录**：时间、通道、成功/失败与失败原因（密钥已脱敏），可一键清空

### 安全

* 所有密钥（Bark 地址、Webhook 地址、移动新消息 API Key）都在 Host 端，schema 中标记为 `secret`；浏览器**永远拿不到明文**，只能在设置页写入新值。
* 设置页走 `/dsh-notify-hub` loopback RPC：复用 Connection 的 Host/Origin 校验（401/403），请求体上限 256 KiB，patch 做白名单 + 类型校验。
* 日志与错误信息统一脱敏：任何出现的密钥都会被替换为 `[redacted]`，投递历史同样脱敏。

---

## 安装

前提：DSH ≥ 0.1.5-rc.2（Web profile）。插件不需要编译，`lib/` 即为可直接运行的 ESM 与浏览器 bundle。

### 方式 A：打成 tgz 后安装（推荐）

`link:` 安装时 Node 会从**链接的真实路径**解析依赖，因此工作区外的目录可能找不到 `@deepseek-ai/schemastery`；打成 tarball 由 pnpm 复制进 profile 目录即可，`dsh-notify-bark` 用的就是这种方式。

```powershell
cd /path/to/dsh-notify-hub
npm pack                      # 生成 dsh-notify-hub-0.1.0.tgz
dsh plugin --profile web add .\dsh-notify-hub-0.1.0.tgz
```

### 方式 B：手动加入 Web profile

编辑 `%USERPROFILE%\.dsh\profiles\web\package.json`：

```jsonc
{
  "dsh": { "profile": { "bundles": [ /* …既有… */ "dsh-notify-hub" ] } },
  "dependencies": {
    "dsh-notify-hub": "file:/path/to/dsh-notify-hub/dsh-notify-hub-0.1.0.tgz"
  }
}
```

然后在 `%USERPROFILE%\.dsh\profiles\web` 下执行 `pnpm install`。

### 生效

新增 bundle 需要**重启 dsh web**；之后安装/更新只需再次 `pnpm install` + 重启（`cordis.patch.yml` 自身的改动可热加载）。

### 与 dsh-notify-bark 共存

* 首次启动时，若本插件的 Bark 地址为空，会自动从 `$DSH_HOME/settings.yaml` 的旧 `bark:` 段**迁移一次**（只读旧文件、写入新命名空间），日志会打印一行提示。设置 `migrateLegacyBark: false` 可关闭。
* 迁移后建议移除 `dsh-notify-bark`，否则同一个回合会收到两条 Bark 推送。

---

## 配置

设置页覆盖了全部选项；下面是 composition 层（`cordis.patch.yml` 条目 config 或 profile 补丁）写法：

```yaml
- insert:
    - id: notify-hub
      name: dsh-notify-hub
      config:
        locale: zh
        notifySubagents: false
        events: { completed: true, error: true, aborted: false, planReview: false }
        bark: { enabled: true, url: 'https://api.day.app/你的Key', group: DSH, level: active }
        local: { enabled: true, sound: true }
        cmcc:
          enabled: true
          apiKey: ak_xxxx
          to: '13800138000'
          prefix: DSH
        webhooks:
          feishu: { enabled: true, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx' }
        delivery: { timeoutMs: 5000, retries: 2, retryBaseMs: 500 }
        rules:
          - { mode: exclude, pattern: '心跳检测' }
        routes:
          - { pattern: mobile, channels: [cmcc] }
```

密钥字段同样可以只放在 `$DSH_HOME/settings.yaml`（设置页写入的位置），二者按「schema 默认 → composition base → 用户层」合并。

---

## 移动新消息（中国移动 5G 消息）协议

移植自参考实现 `@openclaw/cmcc-newmsg-channel`，默认网关地址取自其 `config.json`：

```
WebSocket : wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg
上传接口  : https://5gvas01.cmicmaap.com/gtw-ai/openclaw/api/upload
版本      : 2.0
```

* **连接**：`ws` 包可用时优先（可带 `X-API-Key` 握手头），否则回退 Node ≥ 22 内置 WebSocket；两条路径都会发送 `{ type: 'auth', apiKey, version }` 并等待 `auth_ok`（超时 10s）。
* **心跳**：每 15s 发 `{ type: 'ping' }`，10s 内未收到 `pong` 则断开重连。
* **重连**：指数退避 3s → 60s，带 ±10% 抖动。
* **文本**：`{ type: 'send', apiKey, to, content, messageId }`，正文会先做 Markdown → 纯文本降级（`**粗体**`、`` `code` ``、列表符号等）。
* **富媒体**：先 `POST {uploadUrl}/upload`（multipart：`file` + `apiKey`），服务端返回 `{ code: 10200, data: mediaUrl }`；随后 `{ type: 'send', apiKey, to, mediaType, mediaUrl, content, messageId, … }`。设置页的「发送图片」按钮走这条链路，用于自检。
* 当前只做**出站推送**，不消费入站消息（通知场景不需要）。

---

## 架构

```
lib/
  index.js             Host 入口：settings 命名空间 / Agent 集成 / 监听 / hub / RPC 装配
  types.js             事件与通道词汇表（kind、flag、通道 id、cmcc 默认端点）
  settings.js          notify-hub 命名空间 schema、默认值、规则编译、脱敏视图
  events.js            实时事件折叠 + 去重账本 + 完成门控
  policy.js            事件开关 → 内容规则 → 通道路由
  render.js            本地 / 文本 / Bark 三种渲染 + Markdown 降级
  hub.js               扇出调度、并发上限、投递记账
  history.js           有界投递历史（供设置页展示）
  status.js            通道状态投影（浏览器安全）
  migration.js         旧 bark: 段落的一次性迁移（无依赖 YAML 片段解析）
  rpc-contract.js      /dsh-notify-hub 契约 + patch 校验/归一化
  rpc.js               loopback RPC 路由（client-request / server-response）
  channels/
    http.js            统一 POST + 超时 + 重试阶梯 + 密钥脱敏
    bark.js            Bark V2
    webhook.js         六种 Webhook 预设
    local.js           Windows Toast / osascript / notify-send
    cmcc.js            移动新消息长连接通道
  client.js            浏览器半边：module-loader bundle + 「通知集合」设置页
```

Host 端只依赖 Node 内置模块与 `@deepseek-ai/schemastery`（peer），客户端 bundle 只用 shell 已 seed 的 `react` 与 `@deepseek-ai/dsh-client-store`。

---

## 测试

```powershell
npm test          # 10 个文件 / 103 个用例（脚本串行跑，兼容受限环境）
npm run check     # 先校验客户端 bundle，再跑测试
```

覆盖范围：设置 schema 与脱敏视图、事件折叠与完成门控、规则与路由、HTTP 重试与脱敏、Bark/Webhook 载荷、Windows Toast 脚本转义、移动新消息握手/发送/心跳/重连/上传、hub 扇出与投递历史、RPC 校验，以及**客户端 bundle 的真实加载与渲染**，最后还有一组 `apply()` 级别的端到端用例（监听 → 采集 → 扇出 → RPC 读回）。

---

## 已知限制

* 桌面通知在 Windows 通过 `powershell.exe` 弹 Toast（首次会注册 AUMID 与快捷方式）；脚本站写入临时 `.ps1` 后以 `-File` 启动，**不经过任何管道**，因此在限制管道/进程句柄的沙箱环境里同样可用。企业策略禁用 WinRT Toast 时自动回退气泡通知。
* 富媒体推送需网关支持 `/upload`；失败会在设置页显示服务端返回的原因。
* 移动新消息为出站单向通道；不接受手机侧回复。
* 设置页的「发送图片」需要填写**本机**绝对路径（Host 侧读取）。

## 致谢

* [dsh-notify-bark](https://github.com/pc439527/dsh-notify-bark)（MIT）——Host 端事件监听、Bark 推送、脱敏设置页与 loopback RPC 的形态。
* [dsh-notify-center](https://github.com/SingleOne/dsh-notify-center)（MIT）——事件聚合、完成门控、内容规则、多路 Webhook 与跨平台桌面通知。
* `@openclaw/cmcc-newmsg-channel`——中国移动新消息传输协议。

## License

MIT
