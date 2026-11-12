#!/usr/bin/env bash
# Remove dsh-git-ai from a DeepSeek Harness profile.
#
#   ./uninstall.sh [--profile desktop] [--dsh-home ~/.dsh] [--keep-files] [--keep-diagnostics]
set -euo pipefail

profile_name="${DSH_PROFILE_NAME:-desktop}"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
keep_files=0
keep_diagnostics=0

usage() {
  cat <<'EOF'
用法: ./uninstall.sh [选项]

  --profile <name>      DSH profile 名称（默认 desktop）
  --dsh-home <dir>      DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --keep-files          保留 <profile>/plugins/dsh-git-ai 插件副本
  --keep-diagnostics    保留 $DSH_HOME/dsh-git-ai 诊断目录
  -h, --help            显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile_name="$2"; shift 2 ;;
    --dsh-home) dsh_home="$2"; shift 2 ;;
    --keep-files) keep_files=1; shift ;;
    --keep-diagnostics) keep_diagnostics=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

profile_dir="$dsh_home/profiles/$profile_name"
patch="$profile_dir/cordis.patch.yml"
if [ ! -f "$patch" ]; then
  echo "找不到 profile 配置: $patch" >&2
  exit 1
fi

if ! grep -q '# >>> dsh-git-ai' "$patch"; then
  echo "==> 未发现 dsh-git-ai 片段，无需卸载"
else
  mkdir -p "$profile_dir/backups"
  backup="$profile_dir/backups/cordis.patch.yml.$(date +%Y%m%d-%H%M%S).uninstall.bak"
  cp "$patch" "$backup"
  echo "==> 已备份   $backup"

  tmp="$(mktemp)"
  awk '
    /# >>> dsh-git-ai/ { skipping = 1; next }
    /# <<< dsh-git-ai <<</ { skipping = 0; next }
    skipping == 0 { print }
  ' "$patch" > "$tmp"
  mv "$tmp" "$patch"
  echo "==> 已移除   $patch 中的插件片段"
fi

if [ "$keep_files" -eq 0 ] && [ -d "$profile_dir/plugins/dsh-git-ai" ]; then
  rm -rf "$profile_dir/plugins/dsh-git-ai"
  echo "==> 已删除插件副本 $profile_dir/plugins/dsh-git-ai"
fi

if [ "$keep_diagnostics" -eq 0 ] && [ -d "$dsh_home/dsh-git-ai" ]; then
  rm -rf "$dsh_home/dsh-git-ai"
  echo "==> 已删除诊断目录 $dsh_home/dsh-git-ai"
fi

echo
echo "卸载完成。重启 DSH 或新建会话即可生效。"
