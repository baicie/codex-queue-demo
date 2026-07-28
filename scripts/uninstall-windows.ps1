[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TaskName = 'Codex Queue Demo Daily'
)

$ErrorActionPreference = 'Stop'

if ($PSCmdlet.ShouldProcess($TaskName, 'Uninstall Codex queue task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Uninstalled $TaskName. Existing logs and queue results were preserved."
}
