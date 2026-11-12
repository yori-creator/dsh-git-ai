# dsh-git-ai

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）支持
[Git AI](https://github.com/git-ai-project/git-ai)：Agent 写下的每一行代码、用到的模型、
所属会话都会在提交时变成可追溯的 AI 归属，`git ai blame` / `git ai stats` / `git ai log`
即可查看。

Git AI 官方目前没有 DSH 集成（官方预设列表里没有 DeepSeek Harness），本插件通过
Git AI 的通用 `agent-v1` checkpoint 预设补齐这一能力。

- 无第三方依赖，只使用 Node 内置模块
- 不修改 DSH 源码，作为普通 Cordis 插件加载
- 归因失败绝不阻塞 Agent：任何异常都被吞掉并只写诊断信息
- 不新增任何模型可见工具，提示词成本为 0

## 能力

| DSH 工具调用 | Git AI checkpoint | 作用 |
| --- | --- | --- |
| `write` / `edit` / `str_replace_editor`（写操作）执行前 | `human` + `will_edit_filepaths` | 保存编辑前基线，避免把人类已有的未提交修改算成 AI |
| 上述工具成功执行后 | `ai_agent` + `edited_filepaths` | 把该文件标记为 AI 修改，并带上 agent、模型、会话与对话记录 |
| `pwsh` / `bash` 执行前 | `human`（空路径，初始化工作日志）+ `pre_shell_command` | 记录命令执行前的快照，并等待 Git AI 落盘 |
| 上述命令执行后 | `post_shell_command` | 命令产生的文件改动整体归属为 AI |

其它工具（`read`、`glob`、`grep`、`todo_write`、`present` 等）完全不触发 checkpoint。

支持的归因信息：

- 行级 AI / 人类归属（`git ai blame`）
- 按模型统计（`git ai stats --json` 的 `tool_model_breakdown`，例如
  `deepseek-harness::deepseek-flash`）
- 会话 ID 关联（Git Note 中的 `sessions[].agent_id.id`）
- 对话记录（`transcript`，可在 Git AI 侧用于 prompt 关联；默认开启并限制大小）

## 前置条件

1. 已安装 Git AI，且 `git-ai` 可执行：

   ```sh
   git-ai --version
   ```

2. 已执行 `git-ai install`，让 Git 通过 Trace2 把提交事件交给 Git AI
   （否则 Git Note 不会写入提交）：

   ```sh
   git-ai install
   ```

3. DSH 桌面版或 Web 版（profile 机制 + HMR）。

## 安装

### 方式一：脚本安装（推荐）

```powershell
# Windows（Windows PowerShell 或 PowerShell 7 均可）
powershell -ExecutionPolicy Bypass -File <插件目录>\install.ps1
```

```bash
# macOS / Linux
./install.sh
```

脚本会：

1. 把插件复制到 `<DSH_HOME>/profiles/desktop/plugins/dsh-git-ai`；
2. 备份 `<DSH_HOME>/profiles/desktop/cordis.patch.yml`；
3. 写入带标记的 patch 片段，指向副本的 `lib/index.js`（幂等，重复执行不会重复插入）；
4. 打印后续验证步骤。

默认 profile 为 `desktop`，可用 `-ProfileName` / `--profile` 覆盖。
开发调试时可用 `-LinkSource` / `--link`，让 profile 直接引用本仓库的
`lib/index.js`，避免每次修改都重新复制。

安装到 profile 目录内是有意为之：DSH 的 HMR 会比较 profile 目录下的已加载文件，
因此更新副本后无需重启即可热替换；引用 profile 之外的路径时，改动需要重启 DSH
才会生效。

### 方式二：手动安装

编辑 `<DSH_HOME>/profiles/desktop/cordis.patch.yml`（Windows 通常为
`C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml`），追加：

```yaml
# >>> dsh-git-ai (managed by dsh-git-ai/install.ps1) >>>
- insert:
    - id: git-ai
      name: 'C:/Users/<你>/.dsh/profiles/desktop/plugins/dsh-git-ai/lib/index.js'
      config:
        agentName: deepseek-harness
# <<< dsh-git-ai <<<
```

`name` 必须指向插件入口 `lib/index.js`（绝对路径或 `file://` URL 均可）。

DSH 的 HMR 会立即重组 profile 并挂载插件（新会话或重启后同样生效）。

### 更新插件

修改源码后重新执行安装脚本即可（会覆盖副本并重新写入 patch 片段）：

```powershell
powershell -ExecutionPolicy Bypass -File <插件目录>\install.ps1
```

### 验证安装

查看诊断文件是否出现（说明插件已挂载）：

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-git-ai\state.json"
```

```json
{
  "mountedAt": "2026-11-12T02:03:03.836Z",
  "pre": 2,
  "post": 2,
  "failures": 0,
  "skipped": 0,
  "lastCheckpointAt": "2026-11-12T02:03:19.464Z",
  "lastError": null,
  "binary": "git-ai"
}
```

然后让 Agent 在一个 Git 仓库里改点东西并提交：

```sh
git add -A
git commit -m "test dsh-git-ai"
git ai stats HEAD --json
git ai blame <改过的文件>
```

预期看到 `"tool_model_breakdown": {"deepseek-harness::<模型>": {...}}`，
以及 `git ai blame` 中显示 `deepseek-harness`。

## 配置

在 patch 片段的 `config:` 下覆盖任意字段：

```yaml
# >>> dsh-git-ai (managed by dsh-git-ai/install.ps1) >>>
- insert:
    - id: git-ai
      name: 'C:/Users/<你>/.dsh/profiles/desktop/plugins/dsh-git-ai/lib/index.js'
      config:
        agentName: deepseek-harness
        includeTranscript: true
        maxTranscriptMessages: 24
        timeoutMs: 20000
# <<< dsh-git-ai <<<
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `agentName` | `deepseek-harness` | 写入 Git AI 的 agent 名称，也是 blame/stats 的归属标识 |
| `binary` | `git-ai` | git-ai 可执行文件；`GIT_AI_BINARY` 环境变量优先级更高 |
| `timeoutMs` | `20000` | 单次 checkpoint 超时 |
| `gitTimeoutMs` | `5000` | `git rev-parse` 仓库探测超时 |
| `settleShellCommands` | `true` | 命令执行前等待 Git AI 落盘（保证快照早于命令写入） |
| `awaitTimeoutSeconds` | `10` | `git-ai await --timeout` 的值 |
| `trackBackgroundCommands` | `false` | 是否记录 `run_in_background` 命令（其效果在命令返回后才出现） |
| `includeTranscript` | `true` | 是否附带会话对话记录 |
| `maxTranscriptMessages` | `24` | 对话记录最多条数 |
| `maxTranscriptBytes` | `32768` | 对话记录字节上限 |
| `extraFileTools` | `{}` | 额外需要归因的文件工具，如 `{ apply_patch: path }` |
| `extraShellTools` | `[]` | 额外需要归因的 shell 工具，如 `["terminal_send"]` |
| `repoCacheMs` | `30000` | 仓库根目录缓存时长 |
| `diagnostics` | `true` | 是否写 `$DSH_HOME/dsh-git-ai/state.json` |
| `debug` | `false` | 在宿主日志中打印 checkpoint 内容 |

## 工作原理

DSH 是 Cordis 插件体系：`@deepseek-ai/dsh-tools` 暴露了一条工具执行流水线，
插件可以监听 `tools/pre-execute`（工具执行前，waterfall，可放行）与
`tools/post-execute`（工具执行后，可观察/改写结果）。本插件注册这两个监听器：

```text
tools/pre-execute  ──► human / pre_shell_command
        │
        ▼
   工具真正执行（写文件 / 跑命令）
        │
        ▼
tools/post-execute ──► ai_agent / post_shell_command
```

会话信息来自 `exec.agent.session`：

- 会话 ID：`session.id`（写入 `conversation_id`）
- 模型：`session.requestHeader()?.config.model`
- 工作目录：`workingDirectory` 服务（`ensure()`），回退到 `session.header.cwd`

路径统一转换为**相对仓库根目录**的形式再交给 Git AI，避免 Windows 盘符大小写、
反斜杠与符号链接带来的差异。

每个 checkpoint 都串行排队执行，进程内不会交错。

### 为什么 shell 命令要额外 `git-ai await`

`git-ai checkpoint` 只是把请求交给后台守护进程，命令返回时快照未必已经落盘。
如果命令在快照之前就改写了文件，`pre`/`post` 这对 checkpoint 会得到空 diff，归因丢失。
因此插件在 `pre_shell_command` 之后调用 `git-ai await --timeout N`，等守护进程处理完
再放行命令。实测未加 `await` 时 0/3 成功，加了之后 3/3 成功。

### 为什么第一次 shell 命令要先发一个空路径 `human`

Git AI 需要一个已存在的“工作日志”才会处理 shell checkpoint 配对。空的
`will_edit_filepaths: []` 既能初始化工作日志，又不会把任何既有改动算作人类改动
（实测不会抢走此前 `ai_agent` 的归属）。文件编辑本身会带路径的 `human` checkpoint，
等价于初始化，因此不会再额外发。

## 已知限制

- 只覆盖 DSH 自带的文件工具与 shell 工具；MCP 工具默认不记录，可用
  `extraFileTools` / `extraShellTools` 补。`run_code`（PTC）内部调用的
  `write` / `edit` 同样经过流水线，因此会被记录。
- `transcript` 采用截断策略（保留首条用户消息 + 最近若干条），避免超大 payload；
  Git AI 1.7.5 的 `agent-v1` 预设会把对话记录存入本地 `transcripts-db`，但提交
  Note 里的 `prompts` 目前仍为空，这是预设本身的行为。
- 只记录通过 DSH 工具产生的改动；用户在 DSH 之外对文件的修改不会被标记为 AI
  （这正是预期行为，且编辑前的 `human` 基线会保护这些人类改动）。
- `run_in_background` 命令默认不记录：它在返回后仍在写文件，无法与 checkpoint 配对。
- Git AI 的后台守护进程是异步的：`git ai status` 可能滞后数秒，提交本身不受影响。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `git ai stats` 中没有任何 AI 归属 | 确认 `git-ai install` 已执行、`git-ai --version` 可用；查看 `$DSH_HOME/dsh-git-ai/state.json` 的 `lastError` |
| state.json 不出现 | 插件未挂载：检查 profile patch 语法（YAML 缩进、绝对路径），必要时重启 DSH |
| 只有文件编辑被记录、命令没有 | 确认 `settleShellCommands` 未被关闭；查看 Git AI 守护进程是否在被反复重启 |
| 归因到错误仓库 | 该会话的工作目录不在目标仓库内；先 `cd` 到目标仓库再操作 |

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File <插件目录>\uninstall.ps1
```

```bash
./uninstall.sh
```

脚本会删除 `# >>> dsh-git-ai` 到 `# <<< dsh-git-ai` 之间的片段、
`<profile>/plugins/dsh-git-ai` 副本与 `$DSH_HOME/dsh-git-ai` 诊断目录，
其余 profile 配置保持不变；加 `-KeepFiles` / `-KeepDiagnostics`
（或 `--keep-files` / `--keep-diagnostics`）可保留其中一部分。

## 开发

```sh
cd dsh-git-ai
node --test        # 单元测试 + 真实 git-ai 端到端测试
```

端到端测试会在临时目录建 Git 仓库，调用插件真实的流水线监听器，然后校验
`git ai status` 的归属结果；未安装 git-ai 时自动跳过。

修改代码后，用 `-LinkSource` / `--link` 安装可让 profile 直接引用本目录，
DSH 重启后即生效；或重新执行普通安装脚本，覆盖 profile 内的副本。

## 兼容性

- Git AI 1.7.5（`agent-v1` 预设 `human` / `ai_agent` / `pre_shell_command` /
  `post_shell_command`）
- DSH 0.2.x（Cordis 插件体系，`tools/pre-execute` 与 `tools/post-execute` 事件）
- Node.js 20+
- Windows / macOS / Linux

## 参考

- [Git AI：Add a coding agent](https://usegitai.com/docs/agents/add-your-agent)
- [Git AI 仓库](https://github.com/git-ai-project/git-ai)
- DSH 插件体系：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、
  `@deepseek-ai/dsh-hmr`、`@deepseek-ai/dsh-app-boot`

## License

[MIT](./LICENSE)
