#Requires -Version 5.1
<#
.SYNOPSIS
    从 DeepSeek Harness profile 中卸载 dsh-git-ai 插件。

.DESCRIPTION
    只删除 install.ps1 写入的 # >>> dsh-git-ai ... # <<< dsh-git-ai 片段，
    并清理 <profile>/plugins/dsh-git-ai 副本；profile 里的其它配置原样保留。
    修改前会备份文件。

.PARAMETER ProfileName
    DSH profile 名称，默认 desktop。

.PARAMETER DshHome
    DSH 主目录，默认取 $env:DSH_HOME，否则 ~/.dsh。

.PARAMETER KeepFiles
    保留 <profile>/plugins/dsh-git-ai 插件副本。

.PARAMETER KeepDiagnostics
    保留 $DSH_HOME/dsh-git-ai 诊断目录。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileName = 'desktop',
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
    [switch]$KeepFiles,
    [switch]$KeepDiagnostics
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Utf8File([string]$Path, [string]$Content) {
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Path, $Content, $utf8)
    }
    catch {
        Set-Content -Path $Path -Value $Content -Encoding utf8 -NoNewline
    }
}

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$patchPath = Join-Path $profileDir 'cordis.patch.yml'

if (-not (Test-Path -LiteralPath $patchPath)) {
    throw "找不到 profile 配置：$patchPath"
}

$text = Get-Content -LiteralPath $patchPath -Raw
if ($null -eq $text) { $text = '' }

$pattern = [regex]'(?s)\r?\n?# >>> dsh-git-ai.*?# <<< dsh-git-ai <<<\r?\n?'
if (-not $pattern.IsMatch($text)) {
    Write-Step '未发现 dsh-git-ai 片段，无需卸载'
}
else {
    $backupDir = Join-Path $profileDir 'backups'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = Join-Path $backupDir "cordis.patch.yml.$stamp.uninstall.bak"
    Copy-Item -LiteralPath $patchPath -Destination $backupPath -Force
    Write-Step "已备份     $backupPath"

    $updated = $pattern.Replace($text, "`n", 1).TrimEnd() + "`n"
    Write-Utf8File -Path $patchPath -Content $updated
    Write-Step "已移除     $patchPath 中的插件片段"
}

if (-not $KeepFiles) {
    $installDir = Join-Path (Join-Path $profileDir 'plugins') 'dsh-git-ai'
    if (Test-Path -LiteralPath $installDir) {
        Remove-Item -LiteralPath $installDir -Recurse -Force
        Write-Step "已删除插件副本 $installDir"
    }
}

if (-not $KeepDiagnostics) {
    $stateDir = Join-Path $DshHome 'dsh-git-ai'
    if (Test-Path -LiteralPath $stateDir) {
        Remove-Item -LiteralPath $stateDir -Recurse -Force
        Write-Step "已删除诊断目录 $stateDir"
    }
}

Write-Host ''
Write-Host '卸载完成。重启 DSH 或新建会话即可生效。' -ForegroundColor Green
Write-Host ''
