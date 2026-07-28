[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$QueuePath = (Join-Path $PSScriptRoot '..\demo\queue.json'),
    [string]$CodexBin,
    [string]$TaskName = 'Codex Queue Demo Daily'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$binaryPath = Join-Path $projectRoot 'target\release\codex-queue-demo.exe'
$queuePath = [System.IO.Path]::GetFullPath($QueuePath)

if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw "Release binary not found. Run: cargo build --release"
}
if (-not (Test-Path -LiteralPath $queuePath -PathType Leaf)) {
    throw "Queue file not found: $queuePath"
}
if ([string]::IsNullOrWhiteSpace($CodexBin)) {
    $CodexBin = (Get-Command codex -CommandType Application -ErrorAction Stop).Source
}
$codexPath = [System.IO.Path]::GetFullPath($CodexBin)
if (-not (Test-Path -LiteralPath $codexPath -PathType Leaf)) {
    throw "Codex CLI not found: $codexPath"
}

$runtimeDirectory = Join-Path $env:LOCALAPPDATA 'CodexQueueDemo'
$logDirectory = Join-Path $runtimeDirectory 'logs'
$runnerPath = Join-Path $runtimeDirectory 'run-queue.ps1'
$logPath = Join-Path $logDirectory 'queue.log'
$escapedBinary = $binaryPath.Replace("'", "''")
$escapedQueue = $queuePath.Replace("'", "''")
$escapedCodex = $codexPath.Replace("'", "''")
$escapedLog = $logPath.Replace("'", "''")
$runner = @"
`$ErrorActionPreference = 'Stop'
& '$escapedBinary' run --queue '$escapedQueue' --codex-bin '$escapedCodex' *>> '$escapedLog'
exit `$LASTEXITCODE
"@

if ($PSCmdlet.ShouldProcess($TaskName, 'Install daily 01:00 Codex queue task')) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    Set-Content -LiteralPath $runnerPath -Value $runner -Encoding Unicode

    $powershell = (Get-Command powershell.exe -CommandType Application).Source
    $actionArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $runnerPath
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $actionArguments -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]'01:00')
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -WakeToRun `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Hours 4)
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'Runs the Codex queue daily at 01:00 local time.' `
        -Force | Out-Null

    Write-Host "Installed daily 01:00 task: $TaskName"
    Write-Host "Run now: Start-ScheduledTask -TaskName '$TaskName'"
    Write-Host "Inspect: Get-ScheduledTaskInfo -TaskName '$TaskName'"
}
