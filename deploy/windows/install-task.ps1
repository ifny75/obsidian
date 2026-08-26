<#
    Автозапуск сервера на Windows через запланированную задачу.

        .\install-task.ps1 -Root C:\obsidian

    Служба Windows тут не нужна: задача при старте системы делает то же самое
    и не требует стороннего обёртчика вроде NSSM.
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$TaskName = "Obsidian"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $Root "src\index.ts"))) {
    throw "В $Root нет src\index.ts — это не каталог сервера"
}

$node = (Get-Command node.exe).Source
$action = New-ScheduledTaskAction -Execute $node `
    -Argument "--env-file-if-exists=.env src\index.ts" -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero)

# SYSTEM, потому что задача стартует до входа пользователя.
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null

Write-Host "Задача '$TaskName' создана. Запуск: Start-ScheduledTask -TaskName $TaskName"
Write-Host "Логи задача не пишет — при отладке запускайте сервер вручную из $Root"
