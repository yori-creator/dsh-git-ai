#!/usr/bin/env bash
# Install dsh-git-ai into a DeepSeek Harness profile.
#
#   ./install.sh [--profile desktop] [--dsh-home ~/.dsh] [--agent-name deepseek-harness] [--link]
set -euo pipefail

profile_name="${DSH_PROFILE_NAME:-desktop}"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
agent_name="deepseek-harness"
link_source=0

usage() {
  cat <<'EOF'
用法: ./install.sh [选项]

  --profile <name>      DSH profile 名称（默认 desktop）
  --dsh-home <dir>      DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --agent-name <name>   写入 Git AI 的 agent 名称（默认 deepseek-harness）
  --link                不复制文件，直接引用源目录（开发调试）
  -h, --help            显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile_name="$2"; shift 2 ;;
    --dsh-home) dsh_home="$2"; shift 2 ;;
    --agent-name) agent_name="$2"; shift 2 ;;
    --link) link_source=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_entry="$script_dir/lib/index.js"
if [ ! -f "$source_entry" ]; then
  echo "找不到插件入口: $source_entry" >&2
  exit 1
fi

profile_dir="$dsh_home/profiles/$profile_name"
patch="$profile_dir/cordis.patch.yml"
if [ ! -f "$patch" ]; then
  echo "找不到 profile 配置: $patch" >&2
  exit 1
fi

if [ "$link_source" -eq 1 ]; then
  target_dir="$script_dir"
  echo "==> 开发模式  引用源目录 $target_dir"
else
  target_dir="$profile_dir/plugins/dsh-git-ai"
  rm -rf "$target_dir"
  mkdir -p "$target_dir/lib"
  cp "$script_dir/lib/index.js" "$target_dir/lib/index.js"
  for file in package.json cordis.patch.yml README.md LICENSE; do
    [ -f "$script_dir/$file" ] && cp "$script_dir/$file" "$target_dir/$file"
  done
  echo "==> 已复制插件 $target_dir"
fi

entry="$target_dir/lib/index.js"
if [ ! -f "$entry" ]; then
  echo "安装后找不到插件入口: $entry" >&2
  exit 1
fi

echo "==> 插件入口 $entry"
echo "==> profile   $patch"

mkdir -p "$profile_dir/backups"
backup="$profile_dir/backups/cordis.patch.yml.$(date +%Y%m%d-%H%M%S).bak"
cp "$patch" "$backup"
echo "==> 已备份   $backup"

block="$(cat <<EOF
# >>> dsh-git-ai (managed by dsh-git-ai/install.sh) >>>
- insert:
    - id: git-ai
      name: '$entry'
      config:
        agentName: $agent_name
# <<< dsh-git-ai <<<
EOF
)"

tmp="$(mktemp)"
BLOCK="$block" awk '
  BEGIN { block = ENVIRON["BLOCK"]; skipping = 0; replaced = 0 }
  /# >>> dsh-git-ai/ {
    if (!replaced) { print block; replaced = 1 }
    skipping = 1
    next
  }
  /# <<< dsh-git-ai <<</ { skipping = 0; next }
  skipping == 0 { print }
' "$patch" > "$tmp"

if grep -q '# >>> dsh-git-ai' "$patch"; then
  action="已更新"
  mv "$tmp" "$patch"
else
  rm -f "$tmp"
  printf '\n%s\n' "$block" >> "$patch"
  action="已安装"
fi

echo "==> $action $patch"

if command -v git-ai >/dev/null 2>&1; then
  echo "==> git-ai   $(command -v git-ai) ($(git-ai --version 2>/dev/null || true))"
else
  echo "warning: 未找到 git-ai，请先安装 Git AI: https://github.com/git-ai-project/git-ai" >&2
fi

if ! git config --global --get trace2.eventtarget 2>/dev/null | grep -q 'git-ai'; then
  echo "warning: git 尚未接入 Git AI（trace2.eventtarget 不含 git-ai），请执行 git-ai install" >&2
fi

cat <<EOF

安装完成。接下来：
  1. DSH 的 HMR 会立即重组 profile；如未生效，请重启 DSH 或新建会话。
  2. 查看插件诊断: cat "$dsh_home/dsh-git-ai/state.json"
  3. 让 Agent 修改 Git 仓库并提交，然后执行: git ai stats HEAD --json
  4. 查看行级归属: git ai blame <文件>
EOF
