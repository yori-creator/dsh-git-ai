# dsh-git-ai

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接入
[Git AI](https://github.com/git-ai-project/git-ai)：Agent 改过的代码在提交后可以用
`git ai blame` / `git ai stats` 查到 AI 归属（哪行是谁写的、哪个模型、哪个会话）。

Git AI 官方没有 DSH 集成，本插件通过它的 `agent-v1` checkpoint 预设补齐。

## 安装

先确认 Git AI 已就绪：

```sh
git-ai --version
git-ai install
```

然后安装插件：

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File <插件目录>\install.ps1
```

```bash
# macOS / Linux
./install.sh
```

DSH 会自动热加载插件，没生效就重启 DSH。

验证：让 Agent 改一个 Git 仓库里的文件并提交，然后

```sh
git ai stats HEAD --json   # tool_model_breakdown 里出现 deepseek-harness::<模型>
git ai blame <改过的文件>   # 显示 deepseek-harness
```

## 可选配置

默认不用配，装完即用。要调整的话，在 `<DSH_HOME>/profiles/desktop/cordis.patch.yml`
里安装脚本写入的那段 `config:` 下加字段（改完 DSH 会热加载）：

```yaml
      config:
        agentName: deepseek-harness
        extraFileTools:
          apply_patch: path
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `agentName` | `deepseek-harness` | `git ai blame` 里显示的归属名 |
| `binary` | `git-ai` | git-ai 路径（也可用 `GIT_AI_BINARY` 环境变量） |
| `extraFileTools` | `{}` | 额外要归因的文件工具，如 MCP 的 `apply_patch: path` |
| `extraShellTools` | `[]` | 额外要归因的 shell 工具，如 `["terminal_send"]` |
| `trackBackgroundCommands` | `false` | 是否记录 `run_in_background` 启动的命令 |
| `debug` | `false` | 在 DSH 日志里打印每次 checkpoint |

注意：重新执行安装脚本会重写这段片段，手改的 `config:` 需要自己保留。

## 卸载

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File <插件目录>\uninstall.ps1
```

```bash
# macOS / Linux
./uninstall.sh
```

卸载只移除插件本身，不会动 profile 里的其他配置。
