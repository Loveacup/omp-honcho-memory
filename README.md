<div align="center">
  <h1>🧠 OMP Honcho Memory</h1>
  <p><strong>一个插件，让 OMP、Claude Code、Codex 与 Hermes 理解同一个你</strong></p>
  <p>基于 <a href="https://honcho.dev">Honcho</a> 的跨 CLI 记忆插件：共享核心 + 每端薄壳，一条命令安装、升级、卸载与冒烟；在模型请求前召回相关历史，只把真人交互写成用户证据。</p>
  <p>
    <a href="https://github.com/can1357/oh-my-pi"><img src="https://img.shields.io/badge/OMP-18.2.5%2B-6f42c1?style=flat-square" alt="OMP 18.2.5+"/></a>
    <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-1.3%2B-000000?style=flat-square&amp;logo=bun&amp;logoColor=white" alt="Bun 1.3+"/></a>
    <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript 5.9"/>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-2ea44f?style=flat-square" alt="MIT License"/></a>
  </p>
</div>

> [!IMPORTANT]
> 本扩展会把获准的对话内容发送到 Honcho。安装前请确认数据范围、凭据存储方式和 Honcho 账户的数据政策；首次验证只使用非敏感的合成数据。

<p align="center">
  <a href="#core">核心能力</a> ·
  <a href="#vision">设计理念</a> ·
  <a href="#architecture">工作原理</a> ·
  <a href="#user-guide">个人用户指南</a> ·
  <a href="#agent-guide">AI／Agent 配置</a> ·
  <a href="#boundaries">可靠性与安全边界</a>
</p>

<a id="core"></a>

## ✨ 核心能力

| 能力 | 行为 |
|---|---|
| 👤 **精确身份** | 保留配置中的 Peer ID，不强制小写，也不添加 `user-`／`ai-` 前缀 |
| 🔗 **原生会话** | 使用 `sessionManager.getSessionId()`；缺少 Session ID 时拒绝回退到共享 `default` |
| 🧭 **跨会话召回** | 推荐 `chat-instance`；请求前注入有预算限制的结构化上下文与 workspace 原始消息 |
| 💾 **确认式持久化** | 串行上传消息，仅在远端确认成功后推进进程内去重状态 |
| 🔄 **生命周期保护** | 在会话切换、压缩和关闭时刷新待处理写入 |
| 🔔 **轻量反馈** | 使用中英双语瞬时通知，不长期占用 OMP 底部状态栏 |
| 🧰 **可观测工具** | 提供搜索、上下文检查、结论写入和健康检查工具 |
| 🔌 **一体化多端** | 同一包覆盖 OMP 扩展、Claude Code／Codex Hook 与 Claude 四工具 MCP；Hermes 走其原生 Honcho provider，共享同一用户与结论视图 |
| 🤖 **机器输入排除** | 按入口判定来源：交互式真人输入才写入；headless、子代理、编排器会话（`HONCHO_AUTOMATION=1`）与宿主注入块只召回不写入，从不按消息关键词判断 |
| 🩺 **低维护** | 宿主升级后跑 `smoke`；失败只改对应一个薄壳；接入异常时降级为无记忆，不阻塞主任务 |

<a id="vision"></a>

## 🌐 设计理念：多设备、多 CLI，理解同一个你

人在不同设备和 CLI 之间切换时，工具可以不同、会话可以独立，但不应每次都从零认识用户。理想状态是：获准接入的客户端共同使用一份**有来源、可纠正、会随时间更新**的用户认知，并只在当前任务需要时取用相关部分。

本仓库是这套拓扑的**一体化接入插件**，不是跨 CLI 控制中心。共享认知不会合并各端会话，也不会让一个客户端继承另一个客户端的工具、权限或指令。

```mermaid
flowchart LR
    subgraph Devices["不同设备"]
        D1["设备 A"]
        D2["设备 B"]
    end

    subgraph Clients["独立 CLI 与会话"]
        C1["CLI A<br/>Session 1"]
        C2["CLI B<br/>Session 2"]
        C3["CLI C<br/>Session 3"]
    end

    D1 --> C1
    D1 --> C2
    D2 --> C3

    C1 <-->|"相关召回／获准写入"| M[("共享认知<br/>来源 · 时间 · 适用范围")]
    C2 <-->|"相关召回／获准写入"| M
    C3 <-->|"相关召回／获准写入"| M
    U["用户明确纠正"] -->|"覆盖匹配范围内的旧认识"| M
```

| 统一什么 | 保持独立什么 |
|---|---|
| 用户身份、已确认偏好、长期背景及其来源 | 每个设备和 CLI 的会话、模型与工具 |
| 明确纠正及其适用范围 | 本地配置、凭据和访问权限 |
| 按任务相关性取用的精简上下文 | 各端的表达、推理过程和最终建议 |

> [!NOTE]
> **统一认知不等于统一答案。**它也不代表共享会话、共享权限、完整复制历史、强一致或 exactly-once。冲突无法裁决时应保留不确定性；记忆只能提供上下文，不能提升执行权限。

<a id="architecture"></a>

## ⚙️ 工作原理

```mermaid
flowchart LR
    A["💬 OMP Prompt"] --> B{"🔎 并行召回"}
    B --> C["结构化 Context"]
    B --> D["Workspace 原始消息"]
    C --> E["📦 有界注入<br/>System Prompt"]
    D --> E
    E --> F["🤖 Agent 回答"]
    F --> G["🔐 消息指纹去重"]
    G --> H["☁️ 串行写回 Honcho"]
```

| 阶段 | 核心逻辑 |
|---|---|
| **绑定** | 使用配置中的原始 Peer ID，并用 OMP 原生 Session ID 生成 Honcho Session；缺少原生 ID 时停止工作，避免聊天串线 |
| **水合** | 会话启动时读取 Peer Representation、Peer Card 和 Session Summary，建立可刷新的上下文缓存 |
| **召回** | 每个有效 Prompt 并行刷新结构化上下文，并查询最多 10 条 workspace 原始消息 |
| **注入** | 召回结果带来源与完整性标记，只进入本轮 System Prompt 的固定预算区域，不回写缓存或 Honcho |
| **持久化** | 每轮结束后按原生消息身份生成指纹，过滤已确认消息并串行上传；远端成功后才更新进程内确认集 |
| **生命周期** | 会话切换、压缩和关闭前等待已排队上传；压缩前重新水合长期记忆，关闭标记在 OMP 时限内尽力写入 |

> [!NOTE]
> 原始召回是有界的历史证据，不是当前指令或完整数据库视图；确认式重试降低丢失风险，但不承诺 exactly-once。

### 多端组成

| 端 | 接入方式 | 写入 | 召回 |
|---|---|---|---|
| OMP | `extensions/` → `~/.omp/agent/extensions/honcho-memory.js` | 仅 `mode=tui` 且有 UI 的会话 | 每轮 system prompt 注入 |
| Claude Code | `hooks/honcho-hook.ts`（SessionStart、UserPromptSubmit、Stop）+ `hooks/honcho-mcp.ts` 四工具 | 交互会话；带 `agent_id` 的子代理、`-p`／SDK 不写 | `additionalContext` 注入；MCP 搜索／列出／新增／删除结论 |
| Codex | 同一 Hook（`--host codex`） | 交互会话；`exec`／`review` 等不写 | `additionalContext` 注入 |
| Hermes | 原生 Honcho provider，仅配置（`observation.ai.observeOthers=false`、`recallSync: true`） | 由 Hermes 机器作者门排除通知、loop、heartbeat、goal 续跑 | 同步首轮召回 |

所有写入消息带 `host`、`entry_class`、`host_session_id` 元数据，任一召回条目都可追到客户端、会话与时间。共享核心位于 `core/source.ts`（入口分类与注入剥离）和 `extensions/config.ts`（按宿主解析 `~/.honcho/config.json`）。

### OMP 来源与逐事件收据边界

- 当前 `agent_end` 没有可区分机器与真人的可信逐回合来源字段；实测二者的 `attribution` 都是 `user`。OMP 捕获和结论工具使用专属格式门，Claude Code/Codex 的共享注入剥离合同不变。dispatch 要求精确固定首行及两条锚定非空行 `Your coordinator's terminal handle is:`、`Your task ID is:`；continuation 要求精确固定首行、锚定 `Original agent:`、`The prior provider session is read-only context`，以及 `Original working directory:` 或 `Prior [session] transcript:` 路径行。完整签名判为机器，部分结构拒绝并记为 `ambiguous`。普通提及和解释性正文不按关键词丢弃；相同、未加引用边界的完整 envelope 无法与机器内容区分，格式匹配不是不可伪造的来源证明。
- OMP 每条写入消息增加 `native_event_key`（SHA-256 原生身份指纹）和 `native_identity_kind`。可用时，`agent_end` 消息按原始 role、timestamp 与正文精确匹配当前 branch entry，并以唯一的 branch-entry ID 作为事件身份；无法唯一匹配时依次退回 `message.id`、timestamp/content 指纹。迁移快照和上传共用该身份规则。无 branch id 的 fallback 识别能力较弱；并保留部署中的 r1/r2 message-key 作为兼容去重收据。
- 收据 JSONL 新记录使用 `legacy_seed` 或 `remote_confirmed`。只有 `queueMessageBatch` 成功后才尝试写 `remote_confirmed`；首次历史快照写 `legacy_seed`，只用于延续旧去重，不代表远端上传。升级前的裸字符串收据仍阻止重传，但统一标为 `legacy_unclassified`，不能追认其上传成功。
- 新增 OMP capture 日志关联 `branch_read`、`legacy_seed`、`source_classification`、`remote_write`、`local_receipt_append` 阶段；session anchor 与 event key 使用 SHA-256 指纹，异常只记类别。这不是其他既有读取日志或 Claude Code/Codex hook 的完整审计声明。隔离的真实 SDK/API smoke 已读回新增事件 metadata、区分历史种子和上传确认，并保留了两条内容相同但事件不同的输入；完整 OMP 原生 TUI 候选消费仍未验收。
- 插件没有宿主支持的 self-reported loaded-byte fingerprint。安装目录或构建文件 hash 单独不足以证明常驻进程内代码身份；当前源码不向云端声明运行时修订号。构建与隔离 API 验证不等于已部署，生产加载身份仍需独立动作门和实际运行证据。
- 已知崩溃窗口：远端接受 batch 后、本地 append 前中断，恢复时仍可能重传。隔离 smoke 使用真实远端确认、实际本地 append 拒绝和全新易失状态，观察到同一事件的两条云端记录；这不是 OS 崩溃实测，也不存在已证明的服务端幂等保证，因此不承诺 exactly-once。

---

<a id="user-guide"></a>

## 👤 第一部分：个人用户指南

### 1. 适用条件

- OMP 18.2.5 或更新版本。
- Bun 1.3 或更新版本。
- 可用的 Honcho workspace 和 API key。
- 你理解并接受：获准会话内容会发送到 Honcho。

OMP 的扩展 API 可能随版本变化。每次升级 OMP 后都应重新执行本文的验证步骤。

### 2. 构建

```sh
git clone https://github.com/Loveacup/omp-honcho-memory.git
cd omp-honcho-memory
bun install --frozen-lockfile
bun run check
bun run build
```

不要安装来历不明的预构建文件。当前仓库默认要求从源码构建。

### 3. 配置 Honcho

创建 `~/.honcho/config.json`。示例中的身份和 workspace 都必须替换成你自己的值：

```json
{
  "peerName": "YOUR_USER_PEER",
  "apiKey": "${HONCHO_API_KEY}",
  "hosts": {
    "omp": {
      "enabled": true,
      "workspace": "YOUR_WORKSPACE",
      "aiPeer": "omp",
      "sessionStrategy": "chat-instance",
      "sessionPeerPrefix": false,
      "observationMode": "unified",
      "saveMessages": true
    }
  }
}
```

设置环境变量并限制配置权限：

```sh
export HONCHO_API_KEY='YOUR_REAL_KEY'
chmod 600 ~/.honcho/config.json
```

环境变量优先于配置文件。`HONCHO_CONFIG_DIR` 可把配置文件位置改为
`$HONCHO_CONFIG_DIR/config.json`。其他支持项：

- `HONCHO_API_KEY`
- `HONCHO_URL`
- `HONCHO_WORKSPACE`
- `HONCHO_PEER_NAME`
- `HONCHO_USERNAME`
- `HONCHO_AI_PEER`

不要把真实 key 写入本仓库、聊天记录、截图、Issue 或公开日志。

### 4. 一条命令安装

先预览所有文件操作和 JSON 条目差异，再执行安装：

```sh
bun scripts/cognition.ts install --dry-run
bun scripts/cognition.ts install
```

命令会幂等地安装 OMP 扩展与 Claude Code／Codex Hook、安装 Claude 的四工具 stdio MCP、停用 Claude 官方 Honcho writer，并备份被替换的文件和条目。Hook 与 MCP 的 manifest 会记录安装时解析出的绝对 Node 路径。它不会重启 Hermes gateway；按命令提示自行重启相关 CLI。

### 5. 验证

```sh
bun scripts/cognition.ts smoke
```

`smoke` 不写入 Honcho；它核对安装 hash、唯一 Hook writer、Claude MCP 注册、MCP 的四工具清单、配置是否可解析，并以 `--dry-run` 合成载荷调用 Hook 与 MCP。manifest 中的 Node 路径丢失时，受影响的宿主报告 `DEGRADED`。正式跨会话验收仍应只使用不敏感的合成事实，并在 Honcho 中核对作者 Peer、Session、来源 metadata 与内容。

### 6. 界面提示

扩展不会长期显示 `connected` 状态，而是显示瞬时通知：

- `✓ Honcho 记忆已连接 · Memory connected`
- `⌕ 正在检索相关记忆 · Searching relevant memory`
- `✓ 相关记忆已载入 · Relevant memory loaded`
- `↑ 正在保存本轮记忆 · Saving turn memory`
- `✓ 本轮记忆已保存 · Turn memory saved`
- `! Honcho 记忆同步失败 · Memory sync failed`

失败通知表示本轮同步不能被视为成功。不要仅因后续对话仍可继续，就忽略同步失败。

### 7. 更新

```sh
cd omp-honcho-memory
git pull --ff-only
bun install --frozen-lockfile
bun run check
bun run build
bun scripts/cognition.ts upgrade --dry-run
bun scripts/cognition.ts upgrade
bun scripts/cognition.ts smoke
```

每次 OMP、Claude Code、Codex 或 Hermes 更新后都运行一次 `smoke`；失败时只修对应薄壳，不增加旁路 writer。

### 8. 回滚或卸载

```sh
bun scripts/cognition.ts uninstall --dry-run
bun scripts/cognition.ts uninstall
```

卸载按最新 manifest 做冲突检测和外科式还原；若目标自安装后被修改，它会明确失败而不会覆盖。卸载本地插件不会删除已经写入 Honcho 的远端数据。

---

<a id="agent-guide"></a>

## 🤖 第二部分：AI／Agent 配置

本节是执行契约，不是“看到文件存在就算完成”的安装清单。

### 1. 目标

在不泄露密钥、不覆盖其他客户端配置、不制造第二写入器的前提下：

1. 固定源码提交并从源码构建。
2. 合并 `hosts.omp`，保留配置文件中的其他 host 和未知字段。
3. 只选择一个 OMP 扩展发现入口。
4. 用合成数据证明配置解析、扩展加载、远端捕获和跨会话召回。
5. 输出可定位证据和未覆盖边界。

### 2. 必须先取得的输入

AI 在执行前必须确认以下值；不得从用户名、目录名或旧日志猜测：

```yaml
repository: https://github.com/Loveacup/omp-honcho-memory
revision: 用户指定的 tag 或 commit；未指定时记录实际 HEAD
omp_version: 目标机器实测值
omp_extension_directory: 目标机器实测发现路径
honcho_workspace: 用户明确提供
honcho_user_peer: 用户明确提供
honcho_ai_peer: omp
credential_source: 环境变量或用户批准的受保护配置
allowed_data_scope: 用户明确批准的捕获和召回范围
```

缺少 workspace、用户 Peer、凭据来源或数据授权时，停止生产接入；可以继续做不联网的构建和离线验证。

### 3. 禁止事项

AI 不得：

- 输出、回显、提交或转存真实 API key。
- 整文件覆盖 `~/.honcho/config.json`。
- 修改与 `hosts.omp` 无关的 host、目录覆盖或根级字段。
- 把 `${HONCHO_API_KEY}` 替换成真实 key 后提交。
- 同时安装项目级和用户级两份扩展。
- 使用 `default` 代替缺失的 OMP Session ID。
- 用手工 Honcho API 写入伪装成 OMP 自动捕获成功。
- 用模型“回答正确”代替远端消息读回。
- 把独立 Peer 或 Session 当作访问控制。
- 宣称 exactly-once、崩溃持久队列或跨设备兼容已经得到保证。

### 4. 推荐执行流程

#### A. 固定源码

```sh
git clone https://github.com/Loveacup/omp-honcho-memory.git
cd omp-honcho-memory
git rev-parse HEAD
bun install --frozen-lockfile
```

把实际 commit 记录到验收回执。不要只写 `main`。

#### B. 离线验证

```sh
bun run check
bun run build
bun run verify
bun -e 'const m = await import("./dist/index.js"); if (typeof m.default !== "function") throw new Error("missing extension export")'
```

任一命令非零退出即停止安装，不得跳过失败步骤。

#### C. 安全合并配置

目标 `hosts.omp`。用户 Peer 由根级 `peerName` 或环境变量 `HONCHO_PEER_NAME` 提供，不写入 host scope：

```json
{
  "enabled": true,
  "workspace": "USER_APPROVED_WORKSPACE",
  "aiPeer": "omp",
  "sessionStrategy": "chat-instance",
  "sessionPeerPrefix": false,
  "observationMode": "unified",
  "saveMessages": true
}
```

合并要求：

1. 修改前创建权限受限的备份。
2. 解析现有 JSON 后只更新 `hosts.omp`。
3. 保留其他 host、未知字段和根级配置。
4. 写入临时文件，验证 JSON 后原子替换。
5. 配置文件权限设为 `0600`。
6. 使用扩展的有效配置读回或健康检查确认最终 workspace 与 Peer；日志中不得出现 key。

#### D. 安装单一扩展

优先使用目标 OMP 已验证的用户级目录：

```sh
mkdir -p ~/.omp/agent/extensions
cp dist/index.js ~/.omp/agent/extensions/honcho-memory.js
```

安装前备份同名文件；安装后重启 OMP。若目标机器实际使用其他发现路径，以实测路径为准，不机械照抄。

#### E. 运行时验收

使用唯一、非敏感、可删除的合成标记，完成以下检查：

| 检查 | 通过条件 |
|---|---|
| 配置解析 | workspace、用户 Peer、AI Peer 与会话策略精确匹配批准值 |
| 扩展加载 | 新 OMP 会话出现一次连接通知，无重复 Honcho 扩展 |
| 请求前召回 | 出现检索与载入通知；注入内容有界且属于批准范围 |
| 自动捕获 | Honcho 远端读回用户与助手消息，作者和 Session 正确 |
| 跨会话召回 | 新会话问题不含答案，但能召回会话 A 的合成事实 |
| 失败行为 | 无凭据或网络失败时明确降级，不把失败记为成功 |
| 隔离 | 没有创建带错误前缀、错误大小写或 `default` 的身份／Session |

### 5. AI 回执模板

```yaml
repository: https://github.com/Loveacup/omp-honcho-memory
commit: 完整40位SHA
omp_version: 实测版本
install_path: 实际扩展路径
config_path: 实际配置路径
config_backup: 备份路径
workspace: 非秘密值
user_peer: 非秘密值
ai_peer: omp
session_strategy: chat-instance
checks:
  typecheck: PASS|FAIL
  build: PASS|FAIL
  verify: PASS|FAIL
  extension_load: PASS|FAIL
  remote_capture_readback: PASS|FAIL
  cross_session_recall: PASS|FAIL
  failure_path: PASS|FAIL|NOT_RUN
secret_exposure: false
uncovered:
  - 未覆盖边界
rollback: 已验证的回滚命令或步骤
```

只有适用检查全部有实际证据时才能报告完成。`NOT_RUN` 必须解释原因，不能按 PASS 处理。

---

<a id="boundaries"></a>

## 🛡️ 可靠性边界

- 已上传的原生消息按会话记录确认（`~/.omp/agent/honcho-message-acks/`），会话恢复或扩展重载后不会重放；但远端已成功、本地确认尚未写入时崩溃，仍可能重复一次，服务端路径不是 exactly-once。
- 首次升级到该机制时，会话里已有的历史按 session_start / session_switch 时的分支快照视为已上传；升级前就上传失败的旧消息不会补传。
- 上传队列仅存在于当前进程，不是崩溃后可恢复的持久 journal。
- OMP 会限制 shutdown hook 的执行时间，正常轮次持久化不能只依赖关闭事件。
- OMP 扩展不再按关键词从用户消息自动提取长期结论；本插件只通过显式写入工具（OMP `honcho_add_conclusion`／`honcho_remember`、Claude MCP 新增结论）写结论。工具存在不代表系统能识别用户对每条结论的明确批准；Honcho 服务端仍可能从已上传消息自行推理派生结论，本插件不控制其质量。
- Peer、Session 和 scope 不等于强制访问控制。

## 🔐 安全边界

- 永远不要提交 `~/.honcho/config.json`、`.env`、API key、会话转录、云端导出或运行日志。
- 首次验证只使用合成、非敏感数据。
- 每次 OMP 升级后重新检查扩展 API 和生命周期行为。
- 公开 Issue 中只放脱敏复现，不上传真实会话或配置。


### OMP 隔离运行（可选）

零模型本地验证可在启动 OMP 前同时设置以下两个环境变量；两者缺一即拒绝初始化。目录必须已存在、为有效用户拥有的真实目录，并且不允许 group/world 可写：

```sh
export HONCHO_ISOLATED_RUN_DIR="/absolute/path/to/private-run-directory"
export HONCHO_ISOLATED_ACTIVE_TOOLS='["read","bash"]'
```

这两个标志本身不切换 Honcho base URL、不清除凭据，也不保证不会访问云端；执行前必须独立确认客户端指向本地 HTTP fixture 且进程处于获准的隔离环境。

`HONCHO_ISOLATED_ACTIVE_TOOLS` 必须是无重复、非空工具名组成的 JSON 字符串数组；空数组表示不启用任何工具。扩展会在 `session_start` 和 `session_switch` 时通过 OMP 公共 API 检查名称、设置并逐项核对激活集合。`getAllTools()` 的名称清单按 OMP v18.4.6 返回工具对象读取。策略控制的是工具暴露，不绕过工具自身 approval，也不证明工具运行安全或形成模型/请求硬上限。未设置两个变量时，扩展不更改现有工具状态。

扩展以独占创建方式在该目录写 `honcho-plugin.jsonl`（文件权限 `0600`）；已有文件或符号链接均拒绝，不覆盖、不退回共享 `/tmp`。隔离模式下既有扩展日志仅保留类别和消息 SHA-256，不写出原始消息。Honcho SDK 每个 client 将 `maxRetries` 固定为 `0`：可避免 SDK 自动重试，但网络失败更直接交由调用方处理，不代表整个应用只有一次请求，也不改变上游其他重试/回退路径。

隔离 JSONL 记录扩展自有日志的哈希/类别，以及 SDK 公共 `http.request`、`stream`、`upload` 操作的开始、完成或固定错误类别、HTTP method、请求 ID 和 path 哈希；不记录 URL、请求头、凭据、正文、响应内容或 HTTP 状态。这里的 `completed` 只表示 SDK 操作 Promise 完成，不等同于 HTTP 状态成功或 Honcho 业务确认；GET/HEAD 标为 `method_read`，其他方法标为 `method_write`，这是 HTTP 方法分类而非语义副作用判断（SDK 的搜索类 POST 也会标成 `method_write`）。该日志不是每次底层 fetch/网络 attempt 的遥测：HTTP 响应状态、重试次数、原始 raw-search 直接 fetch、OMP 原生模型传输及 provider fallback 均不在此覆盖范围。故本隔离模式不得据此宣称 fail-closed transport budget 或单请求硬上限；原生 OMP/模型验收仍为 **NO_GO**，必须由单独授权的验证流程处理。

隔离模式关闭时等待此扩展已跟踪的 SDK HTTP 操作、启动时后台 chat／Git 观察及其最终日志回调、session-end marker 写入，再关闭日志文件；等待期间允许这些已跟踪高层操作继续调用 SDK。stream 完成记录仅表示获得 Response，不代表流体读完。OMP shutdown handler 有宿主执行时限，因此这不构成所有后台/原生传输均已排空的证明。

### 记忆候选判别（可选，默认关闭）

`scripts/memory-judge.ts` 是独立评估入口，不被任何捕获或召回路径调用，也不导入 Honcho：

```sh
bun scripts/memory-judge.ts --provider off|typesafe|openai-compatible [--endpoint URL] [--model ID] --input PATH
```

- `PATH` 为恰含 `id`、`text` 两个非空白字符串字段的 JSON 对象；省略 `--provider` 等同 `off`，`off` 不发请求、不读密钥。
- 对已通过来源准入的文本并列给出两个信号：`taskRequest`（是否主要是当前任务的请求／命令／授权／状态）与 `stableUserFact`（是否明确陈述跨任务的个人事实或长期偏好）。两者不合成作者分数，没有生产阈值，不判断真人身份，也不创建结论。
- `typesafe`：默认 `https://api.typesafe.ai/v1/systemone`、模型 `jev-1.13.0`，密钥只取 `TYPESAFE_API_KEY`；返回模型给出的 0–1 `noul` 值，响应模型必须与请求一致。
- `openai-compatible`：必须显式给出完整 chat/completions URL 与模型，密钥只取 `MEMORY_JUDGE_API_KEY`（本地端可省）；只接受恰含两个布尔字段的 JSON 回复，记为 `binary` 0/1，不是校准概率。这是本地 HTTP 兼容入口，不保证任意本地模型原生兼容。
- 每次最多一次 HTTP 请求、无重试或回退、拒绝重定向，2000 ms 总时限覆盖请求与读取正文；输入超过 32 KiB UTF-8 直接报错。明文 HTTP 只允许 loopback 主机。
- 参数或输入无效：stderr 输出 `Invalid arguments or input.`、exit 2、无网络；其余情况 stdout 输出一行结果 JSON，`ok`／`disabled` exit 0，`error`／`timeout` exit 1。
- 接口正确不等于模型质量合格；当前判别质量未建立，不应据此启用生产路由。

## 🌱 上游归属

本项目派生自 `@citywalki/oh-my-pi-honcho-memory` 0.2.0，并针对身份精确保留、OMP 原生 Session、可靠轮次持久化、有界来源感知召回和中英双语运行通知进行了较大调整。

详见 [NOTICE](NOTICE)。

## 📄 License

MIT，详见 [LICENSE](LICENSE)。
