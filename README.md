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
