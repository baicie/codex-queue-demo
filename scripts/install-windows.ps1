[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$QueuePath,
    [string]$CodexBin,
    [string]$CliBin,
    [string]$TaskName = 'Codex Queue Demo Daily',
    [switch]$DryRun,
    [string]$ExportTaskXml,
    [string]$ExportRunner,
    [string]$PowerShellBin,
    [string]$TaskUserId
)

$ErrorActionPreference = 'Stop'
$AppIdentifier = 'io.github.baicie.codex-queue'
$TaskNamespace = 'http://schemas.microsoft.com/windows/2004/02/mit/task'
$queueWasSpecified = $PSBoundParameters.ContainsKey('QueuePath')

function Add-TaskXmlElement {
    param(
        [Parameter(Mandatory)][System.Xml.XmlDocument]$Document,
        [Parameter(Mandatory)][System.Xml.XmlElement]$Parent,
        [Parameter(Mandatory)][string]$Name,
        [string]$Value
    )

    $element = $Document.CreateElement($Name, $TaskNamespace)
    if ($PSBoundParameters.ContainsKey('Value')) {
        $element.InnerText = $Value
    }
    [void]$Parent.AppendChild($element)
    return $element
}

function New-CodexQueueTaskXml {
    param(
        [Parameter(Mandatory)][string]$UserId,
        [Parameter(Mandatory)][string]$PowerShellPath,
        [Parameter(Mandatory)][string]$RunnerPath,
        [Parameter(Mandatory)][string]$WorkingDirectory
    )

    $document = New-Object System.Xml.XmlDocument
    [void]$document.AppendChild($document.CreateXmlDeclaration('1.0', $null, $null))
    $task = $document.CreateElement('Task', $TaskNamespace)
    $task.SetAttribute('version', '1.3')
    [void]$document.AppendChild($task)

    $registrationInfo = Add-TaskXmlElement -Document $document -Parent $task -Name 'RegistrationInfo'
    [void](Add-TaskXmlElement -Document $document -Parent $registrationInfo -Name 'Description' -Value 'Runs the Codex queue daily at 01:00 local time.')

    $triggers = Add-TaskXmlElement -Document $document -Parent $task -Name 'Triggers'
    $calendarTrigger = Add-TaskXmlElement -Document $document -Parent $triggers -Name 'CalendarTrigger'
    [void](Add-TaskXmlElement -Document $document -Parent $calendarTrigger -Name 'Enabled' -Value 'true')
    $now = [DateTime]::Now
    $nextRun = $now.Date.AddHours(1)
    if ($nextRun -le $now) {
        $nextRun = $nextRun.AddDays(1)
    }
    $startBoundary = $nextRun.ToString('s', [Globalization.CultureInfo]::InvariantCulture)
    [void](Add-TaskXmlElement -Document $document -Parent $calendarTrigger -Name 'StartBoundary' -Value $startBoundary)
    $scheduleByDay = Add-TaskXmlElement -Document $document -Parent $calendarTrigger -Name 'ScheduleByDay'
    [void](Add-TaskXmlElement -Document $document -Parent $scheduleByDay -Name 'DaysInterval' -Value '1')

    $principals = Add-TaskXmlElement -Document $document -Parent $task -Name 'Principals'
    $principal = Add-TaskXmlElement -Document $document -Parent $principals -Name 'Principal'
    $principal.SetAttribute('id', 'Author')
    [void](Add-TaskXmlElement -Document $document -Parent $principal -Name 'UserId' -Value $UserId)
    [void](Add-TaskXmlElement -Document $document -Parent $principal -Name 'LogonType' -Value 'InteractiveToken')
    [void](Add-TaskXmlElement -Document $document -Parent $principal -Name 'RunLevel' -Value 'LeastPrivilege')

    $settings = Add-TaskXmlElement -Document $document -Parent $task -Name 'Settings'
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'MultipleInstancesPolicy' -Value 'IgnoreNew')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'DisallowStartIfOnBatteries' -Value 'false')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'StopIfGoingOnBatteries' -Value 'false')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'AllowHardTerminate' -Value 'true')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'StartWhenAvailable' -Value 'true')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'RunOnlyIfNetworkAvailable' -Value 'false')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'AllowStartOnDemand' -Value 'true')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'Enabled' -Value 'true')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'Hidden' -Value 'false')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'RunOnlyIfIdle' -Value 'false')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'WakeToRun' -Value 'true')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'ExecutionTimeLimit' -Value 'PT4H')
    [void](Add-TaskXmlElement -Document $document -Parent $settings -Name 'Priority' -Value '7')

    $actions = Add-TaskXmlElement -Document $document -Parent $task -Name 'Actions'
    $actions.SetAttribute('Context', 'Author')
    $exec = Add-TaskXmlElement -Document $document -Parent $actions -Name 'Exec'
    [void](Add-TaskXmlElement -Document $document -Parent $exec -Name 'Command' -Value $PowerShellPath)
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $RunnerPath
    [void](Add-TaskXmlElement -Document $document -Parent $exec -Name 'Arguments' -Value $arguments)
    [void](Add-TaskXmlElement -Document $document -Parent $exec -Name 'WorkingDirectory' -Value $WorkingDirectory)

    return $document.OuterXml
}

function Write-Utf8WithoutBom {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )

    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Test-CodexCli {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$LaunchPath
    )

    $originalPath = $env:PATH
    $failure = $null
    try {
        if ([string]::IsNullOrWhiteSpace($originalPath)) {
            $env:PATH = $LaunchPath
        }
        else {
            $env:PATH = $LaunchPath + [System.IO.Path]::PathSeparator + $originalPath
        }

        try {
            & $Path --version *> $null
            if ($LASTEXITCODE -ne 0) {
                $failure = "exit code $LASTEXITCODE"
            }
        }
        catch {
            $failure = $_.Exception.Message
        }
    }
    finally {
        $env:PATH = $originalPath
    }

    if ($null -ne $failure) {
        throw "Codex CLI could not run with the scheduler PATH: $Path ($failure)"
    }
}

function Get-PathEntryKind {
    param(
        [Parameter(Mandatory)][string]$Path
    )

    try {
        $attributes = [System.IO.File]::GetAttributes($Path)
    }
    catch {
        $exception = $_.Exception
        while ($null -ne $exception.InnerException) {
            $exception = $exception.InnerException
        }
        if (
            $exception -is [System.IO.FileNotFoundException] -or
            $exception -is [System.IO.DirectoryNotFoundException]
        ) {
            return 'Missing'
        }
        throw
    }

    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        return 'ReparsePoint'
    }
    if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
        return 'Directory'
    }
    return 'RegularFile'
}

function Write-DefaultQueueTemporaryFile {
    param(
        [Parameter(Mandatory)][System.IO.FileStream]$Stream,
        [Parameter(Mandatory)][string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    $bytes = $encoding.GetBytes($Content)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush($true)
}

function Move-FileWithoutOverwrite {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$DestinationPath
    )

    [System.IO.File]::Move($SourcePath, $DestinationPath)
}

function Initialize-DefaultQueue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content,
        [scriptblock]$TemporaryFileWriter,
        [scriptblock]$AtomicMover
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $parentDirectory = Split-Path -Parent $fullPath
    [void](New-Item -ItemType Directory -Path $parentDirectory -Force)

    $targetKind = Get-PathEntryKind -Path $fullPath
    if ($targetKind -eq 'RegularFile') {
        return
    }
    if ($targetKind -ne 'Missing') {
        throw "Refusing to initialize the default queue over a $targetKind path: $fullPath"
    }

    $queueFileName = [System.IO.Path]::GetFileName($fullPath)
    $temporaryName = '.{0}.{1}.tmp' -f $queueFileName, [guid]::NewGuid().ToString('N')
    $temporaryPath = Join-Path $parentDirectory $temporaryName
    $stream = $null
    $temporaryFileCreated = $false
    try {
        $stream = [System.IO.File]::Open(
            $temporaryPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $temporaryFileCreated = $true
        try {
            if ($null -eq $TemporaryFileWriter) {
                Write-DefaultQueueTemporaryFile -Stream $stream -Content $Content
            }
            else {
                & $TemporaryFileWriter -Stream $stream -Content $Content
            }
        }
        finally {
            $stream.Dispose()
            $stream = $null
        }

        try {
            if ($null -eq $AtomicMover) {
                Move-FileWithoutOverwrite -SourcePath $temporaryPath -DestinationPath $fullPath
            }
            else {
                & $AtomicMover -SourcePath $temporaryPath -DestinationPath $fullPath
            }
        }
        catch {
            $exception = $_.Exception
            while ($null -ne $exception.InnerException) {
                $exception = $exception.InnerException
            }
            if (-not ($exception -is [System.IO.IOException])) {
                throw
            }

            $targetKind = Get-PathEntryKind -Path $fullPath
            if ($targetKind -eq 'RegularFile') {
                return
            }
            if ($targetKind -ne 'Missing') {
                throw "Refusing to accept a concurrently created $targetKind queue target: $fullPath"
            }
            throw
        }
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if ($temporaryFileCreated) {
            [System.IO.File]::Delete($temporaryPath)
        }
    }
}

$roamingAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$appDataDirectory = Join-Path $roamingAppData $AppIdentifier
if ([string]::IsNullOrWhiteSpace($QueuePath)) {
    $QueuePath = Join-Path $appDataDirectory 'queue.json'
}

if ([string]::IsNullOrWhiteSpace($CliBin)) {
    $CliBin = Join-Path $PSScriptRoot 'codex-queue-demo.exe'
    if (-not (Test-Path -LiteralPath $CliBin -PathType Leaf)) {
        $CliBin = Join-Path ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) 'target\release\codex-queue-demo.exe'
    }
}

$sourceBinary = [System.IO.Path]::GetFullPath($CliBin)
$queuePath = [System.IO.Path]::GetFullPath($QueuePath)
if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) {
    throw "Scheduler CLI not found: $sourceBinary. Pass -CliBin C:\path\to\codex-queue-demo.exe."
}
if ($queueWasSpecified -and -not (Test-Path -LiteralPath $queuePath -PathType Leaf)) {
    throw "Queue file not found: $queuePath"
}

if ([string]::IsNullOrWhiteSpace($CodexBin)) {
    $CodexBin = (Get-Command codex -CommandType Application -ErrorAction Stop).Source
}
$codexPath = [System.IO.Path]::GetFullPath($CodexBin)
if (-not (Test-Path -LiteralPath $codexPath -PathType Leaf)) {
    throw "Codex CLI not found: $codexPath"
}

$runtimeDirectory = Join-Path (Join-Path $localAppData $AppIdentifier) 'bin'
$logDirectory = Join-Path $appDataDirectory 'logs'
$installedBinary = Join-Path $runtimeDirectory 'codex-queue-demo.exe'
$runnerPath = Join-Path $runtimeDirectory 'run-queue.ps1'
$logPath = Join-Path $logDirectory 'queue.log'

$pathEntries = @((Split-Path -Parent $codexPath))
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if ($null -ne $nodeCommand) {
    $nodeDirectory = Split-Path -Parent $nodeCommand.Source
    if ($pathEntries -notcontains $nodeDirectory) {
        $pathEntries += $nodeDirectory
    }
}
$launchPath = $pathEntries -join [System.IO.Path]::PathSeparator

Test-CodexCli -Path $codexPath -LaunchPath $launchPath

$escapedBinary = $installedBinary.Replace("'", "''")
$escapedQueue = $queuePath.Replace("'", "''")
$escapedCodex = $codexPath.Replace("'", "''")
$escapedLog = $logPath.Replace("'", "''")
$escapedLaunchPath = $launchPath.Replace("'", "''")
$runner = @"
`$ErrorActionPreference = 'Stop'
`$env:PATH = '$escapedLaunchPath' + [System.IO.Path]::PathSeparator + `$env:PATH
& '$escapedBinary' run --queue '$escapedQueue' --codex-bin '$escapedCodex' *>> '$escapedLog'
exit `$LASTEXITCODE
"@

if ([string]::IsNullOrWhiteSpace($PowerShellBin)) {
    $PowerShellBin = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source
}
if ([string]::IsNullOrWhiteSpace($TaskUserId)) {
    $TaskUserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}
$taskXml = New-CodexQueueTaskXml `
    -UserId $TaskUserId `
    -PowerShellPath $PowerShellBin `
    -RunnerPath $runnerPath `
    -WorkingDirectory $runtimeDirectory

if (-not [string]::IsNullOrWhiteSpace($ExportTaskXml)) {
    Write-Utf8WithoutBom -Path ([System.IO.Path]::GetFullPath($ExportTaskXml)) -Content $taskXml
}
if (-not [string]::IsNullOrWhiteSpace($ExportRunner)) {
    Write-Utf8WithoutBom -Path ([System.IO.Path]::GetFullPath($ExportRunner)) -Content $runner
}
if ($DryRun) {
    if ([string]::IsNullOrWhiteSpace($ExportTaskXml)) {
        Write-Output $taskXml
    }
    return
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Install daily 01:00 Codex queue task')) {
    if ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
        throw "Scheduler is already installed: $TaskName. Run .\uninstall-windows.ps1 -TaskName '$TaskName' first; queue and logs will be preserved."
    }
    [void](New-Item -ItemType Directory -Path $runtimeDirectory, $logDirectory -Force)
    $defaultQueue = '{"version":1,"launchApp":true,"retryPolicy":{"maxAttempts":4,"initialDelaySeconds":30,"maxDelaySeconds":900},"tasks":[]}'
    Initialize-DefaultQueue -Path $queuePath -Content $defaultQueue
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($sourceBinary, $installedBinary)) {
        Copy-Item -LiteralPath $sourceBinary -Destination $installedBinary -Force
    }
    Set-Content -LiteralPath $runnerPath -Value $runner -Encoding Unicode

    Register-ScheduledTask -TaskName $TaskName -Xml $taskXml | Out-Null

    Write-Host "Installed daily 01:00 task: $TaskName"
    Write-Host "Queue: $queuePath"
    Write-Host "Run now: Start-ScheduledTask -TaskName '$TaskName'"
    Write-Host "Inspect: Get-ScheduledTaskInfo -TaskName '$TaskName'"
}
