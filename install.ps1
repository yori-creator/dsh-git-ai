#Requires -Version 5.1
<#
.SYNOPSIS
    把 dsh-git-ai 插件安装到指定的 DeepSeek Harness profile。

.DESCRIPTION
    把插件文件复制到 <profile>/plugins/dsh-git-ai，然后在 profile 的
    cordis.patch.yml 中写入一个带标记的 insert 片段，指向该副本的 lib/index.js。
    插件位于 profile 目录内，因此 DSH 的 HMR 在插件文件变化时也能热替换。

    脚本幂等：重复执行只会更新副本与已有片段。修改配置前会备份原文件。

.PARAMETER ProfileName
    DSH profile 名称，默认 desktop。

.PARAMETER DshHome
    DSH 主目录，默认取 $env:DSH_HOME，否则 ~/.dsh。

.PARAMETER AgentName
    写入 Git AI 的 agent 名称，默认 deepseek-harness。

.PARAMETER LinkSource
    不复制文件，直接引用本脚本所在目录的 lib/index.js（适合开发调试）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -LinkSource
#>
[CmdletBinding()]
param(
    [string]$ProfileName = 'desktop',
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
    [string]$AgentName = 'deepseek-harness',
    [switch]$LinkSource
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note([string]$Message) {
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-WarningLine([string]$Message) {
    Write-Host "warning: $Message" -ForegroundColor Yellow
}

function Write-Utf8File([string]$Path, [string]$Content) {
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Path, $Content, $utf8)
    }
    catch {
        # ConstrainedLanguage 下没有 .NET 反射权限，退回 cmdlet。
        Set-Content -Path $Path -Value $Content -Encoding utf8 -NoNewline
    }
}

# --- 校验源目录与 profile -----------------------------------------------------
$sourceDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$sourceEntry = Join-Path (Join-Path $sourceDir 'lib') 'index.js'
if (-not (Test-Path -LiteralPath $sourceEntry)) {
    throw "找不到插件入口：$sourceEntry（请在 dsh-git-ai 目录内运行本脚本）"
}

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $patchPath)) {
    throw "找不到 profile 配置：$patchPath（请用 -ProfileName 指定正确的 profile）"
}

# --- 复制插件到 profile 内（或使用源目录） -----------------------------------
if ($LinkSource) {
    $targetDir = $sourceDir
    Write-Step "开发模式  引用源目录 $targetDir"
}
else {
    $targetDir = Join-Path (Join-Path $profileDir 'plugins') 'dsh-git-ai'
    if (Test-Path -LiteralPath $targetDir) {
        Remove-Item -LiteralPath $targetDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

    foreach ($file in @('package.json', 'cordis.patch.yml', 'README.md', 'LICENSE')) {
        $from = Join-Path $sourceDir $file
        if (Test-Path -LiteralPath $from) {
            Copy-Item -LiteralPath $from -Destination (Join-Path $targetDir $file) -Force
        }
    }
    Copy-Item -LiteralPath (Join-Path $sourceDir 'lib') -Destination (Join-Path $targetDir 'lib') -Recurse -Force
    Write-Step "已复制插件 $targetDir"
}

$entry = Join-Path (Join-Path $targetDir 'lib') 'index.js'
if (-not (Test-Path -LiteralPath $entry)) {
    throw "安装后找不到插件入口：$entry"
}
$entryYamlPath = (Resolve-Path -LiteralPath $entry).Path -replace '\\', '/'

# --- 备份 patch ---------------------------------------------------------------
$backupDir = Join-Path $profileDir 'backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $backupDir "cordis.patch.yml.$stamp.bak"
Copy-Item -LiteralPath $patchPath -Destination $backupPath -Force
Write-Step "已备份     $backupPath"

# --- 写入 patch 片段 ----------------------------------------------------------
$newline = "`n"
$block = @(
    '# >>> dsh-git-ai (managed by dsh-git-ai/install.ps1) >>>'
    '- insert:'
    '    - id: git-ai'
    "      name: '$entryYamlPath'"
    '      config:'
    "        agentName: $AgentName"
    '# <<< dsh-git-ai <<<'
) -join $newline
$block += $newline

$text = Get-Content -LiteralPath $patchPath -Raw
if ($null -eq $text) { $text = '' }

$pattern = [regex]'(?s)# >>> dsh-git-ai.*?# <<< dsh-git-ai <<<\r?\n?'
if ($pattern.IsMatch($text)) {
    $updated = $pattern.Replace($text, $block, 1)
    $action = '已更新'
}
else {
    $trimmed = $text.TrimEnd()
    $updated = if ($trimmed.Length -eq 0) { $block } else { $trimmed + $newline + $newline + $block }
    $action = '已安装'
}

Write-Utf8File -Path $patchPath -Content $updated
Write-Step "$action   $patchPath"

# --- 环境检查 -----------------------------------------------------------------
$gitAi = Get-Command git-ai -ErrorAction SilentlyContinue
if (-not $gitAi) {
    Write-WarningLine '未找到 git-ai，请先安装 Git AI：https://github.com/git-ai-project/git-ai'
}
else {
    $version = & git-ai --version 2>$null
    Write-Step "git-ai     $($gitAi.Source) ($version)"
}

$trace2 = & git config --global --get trace2.eventtarget 2>$null
if (-not $trace2 -or $trace2 -notmatch 'git-ai') {
    Write-WarningLine 'git 尚未接入 Git AI（trace2.eventtarget 不含 git-ai）。'
    Write-Note '请执行：git-ai install'
}

# --- 下一步 -------------------------------------------------------------------
Write-Host ''
Write-Host '安装完成。接下来：' -ForegroundColor Green
Write-Note '1. DSH 的 HMR 会立即重组 profile；如未生效，请重启 DSH 或新建会话。'
Write-Note "2. 查看插件诊断：Get-Content $(Join-Path (Join-Path $DshHome 'dsh-git-ai') 'state.json')"
Write-Note '3. 让 Agent 修改 Git 仓库并提交，然后执行：git ai stats HEAD --json'
Write-Note '4. 查看行级归属：git ai blame <文件>'
Write-Host ''
