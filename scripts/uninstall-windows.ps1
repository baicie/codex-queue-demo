[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TaskName = 'Codex Queue Demo Daily'
)

$ErrorActionPreference = 'Stop'
$appIdentifier = 'io.github.baicie.codex-queue'
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$roamingAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
$runtimeDirectory = Join-Path (Join-Path $localAppData $appIdentifier) 'bin'
$appDataDirectory = Join-Path $roamingAppData $appIdentifier
$installedBinary = Join-Path $runtimeDirectory 'codex-queue-demo.exe'
$runnerPath = Join-Path $runtimeDirectory 'run-queue.ps1'

if ($PSCmdlet.ShouldProcess($TaskName, 'Uninstall Codex queue task and scheduler files')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $installedBinary, $runnerPath -Force -ErrorAction SilentlyContinue
    if ((Test-Path -LiteralPath $runtimeDirectory -PathType Container) -and
        (Get-ChildItem -LiteralPath $runtimeDirectory -Force | Select-Object -First 1).Count -eq 0) {
        Remove-Item -LiteralPath $runtimeDirectory -Force
    }

    Write-Host "Uninstalled $TaskName and its scheduler files."
    Write-Host "Preserved queue and logs in: $appDataDirectory"
}
