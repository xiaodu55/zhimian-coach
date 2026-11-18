# 开机自启保活脚本（Windows）
#
# 做两件事：
#  1) 注册一个计划任务：系统登录后自动跑 scripts/dev/keepalive.mjs（BFF + 隧道自动重启）
#  2) 禁止电脑进入睡眠/休眠 —— 演示期间电脑睡了，链接就断了
#
# 用法（管理员或普通权限均可，建议普通权限）：
#   powershell -ExecutionPolicy Bypass -File scripts/dev/install-autostart.ps1
#
# 撤销：
#   powershell -ExecutionPolicy Bypass -File scripts/dev/install-autostart.ps1 -Uninstall
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$keepalive = Join-Path $root 'scripts\dev\keepalive.mjs'
$taskName = 'ZhimianKeepAlive'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已移除计划任务 $taskName"
  powercfg /change standby-timeout-ac 10
  powercfg /change hibernate-timeout-ac 60
  Write-Host "已恢复默认睡眠设置"
  exit 0
}

if (-not $node) {
  Write-Error "找不到 node，请先确认 Node.js 已安装并在 PATH 中"
}

# 1) 计划任务：登录后运行
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$keepalive`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "已注册计划任务：$taskName（登录后自动保活 BFF + 隧道）"

# 2) 禁止睡眠/休眠（演示期间必须）
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /change standby-timeout-dc 0 | Out-Null
Write-Host "已禁止电脑睡眠与休眠（演示结束后可用 powercfg /change standby-timeout-ac 10 恢复）"

Write-Host ""
Write-Host "下一步："
Write-Host "  1) 手动跑一次 node scripts\dev\keepalive.mjs，确认公网地址能打开"
Write-Host "  2) 把公网地址填进提报表单（注意：隧道重启后地址会变，提交前再确认一次）"
Write-Host "  3) 正式提交建议改用 AiWorks / CloudBase / 云主机部署 —— 见 docs\部署指南.md"
