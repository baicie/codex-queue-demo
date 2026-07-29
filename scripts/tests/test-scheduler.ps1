[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$isWindowsPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

function Assert-Equal {
    param(
        [Parameter(Mandatory)]$Expected,
        [Parameter(Mandatory)]$Actual,
        [Parameter(Mandatory)][string]$Message
    )

    if ($Expected -ne $Actual) {
        throw "$Message (expected '$Expected', got '$Actual')"
    }
}

function Assert-Contains {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$ExpectedSubstring,
        [Parameter(Mandatory)][string]$Message
    )

    if (-not $Value.Contains($ExpectedSubstring)) {
        throw "$Message ('$ExpectedSubstring' missing from '$Value')"
    }
}

function Assert-NoQueueTemporaryFiles {
    param(
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][string]$Message
    )

    $temporaryFiles = @(
        Get-ChildItem -LiteralPath $Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '.queue.json.*.tmp' }
    )
    if ($temporaryFiles.Count -ne 0) {
        $temporaryPaths = $temporaryFiles.FullName -join "', '"
        throw "$Message (found '$temporaryPaths')"
    }
}

function Test-DefaultQueueInitialization {
    param(
        [Parameter(Mandatory)][string]$InstallerPath,
        [Parameter(Mandatory)][string]$TestDirectory
    )

    $tokens = $null
    $parseErrors = $null
    $installerAst = [System.Management.Automation.Language.Parser]::ParseFile(
        $InstallerPath,
        [ref]$tokens,
        [ref]$parseErrors
    )
    if ($parseErrors.Count -gt 0) {
        throw "Cannot load installer functions:`n$($parseErrors | Out-String)"
    }

    $functionDefinitions = @(
        $installerAst.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
            },
            $false
        ) | ForEach-Object { $_.Extent.Text }
    )
    if ($functionDefinitions.Count -eq 0) {
        throw 'Windows installer should expose testable function boundaries'
    }
    . ([scriptblock]::Create($functionDefinitions -join [Environment]::NewLine))

    $defaultQueue = '{"version":1,"launchApp":true,"retryPolicy":{"maxAttempts":4,"initialDelaySeconds":30,"maxDelaySeconds":900},"tasks":[]}'
    $alternateQueue = '{"version":1,"launchApp":false,"retryPolicy":{"maxAttempts":2,"initialDelaySeconds":5,"maxDelaySeconds":20},"tasks":[]}'
    $encoding = New-Object System.Text.UTF8Encoding($false)

    $successDirectory = Join-Path $TestDirectory 'success'
    $successPath = Join-Path $successDirectory 'queue.json'
    Initialize-DefaultQueue -Path $successPath -Content $defaultQueue
    Assert-Equal $defaultQueue ([System.IO.File]::ReadAllText($successPath)) 'A missing default queue should be initialized completely'
    Assert-NoQueueTemporaryFiles -Directory $successDirectory -Message 'Successful initialization should consume its temporary file'

    [System.IO.File]::WriteAllText($successPath, $alternateQueue, $encoding)
    Initialize-DefaultQueue -Path $successPath -Content $defaultQueue
    Assert-Equal $alternateQueue ([System.IO.File]::ReadAllText($successPath)) 'An existing regular queue should be preserved'

    $writeFailureDirectory = Join-Path $TestDirectory 'write-failure'
    [void](New-Item -ItemType Directory -Path $writeFailureDirectory -Force)
    $writeFailurePath = Join-Path $writeFailureDirectory 'queue.json'
    $partialWriteFailure = {
        param(
            [Parameter(Mandatory)][System.IO.FileStream]$Stream,
            [Parameter(Mandatory)][string]$Content
        )

        $bytes = $encoding.GetBytes($Content)
        $Stream.Write($bytes, 0, [Math]::Min(8, $bytes.Length))
        throw (New-Object System.IO.IOException('Injected write failure'))
    }.GetNewClosure()
    $writeFailureWasReported = $false
    try {
        Initialize-DefaultQueue `
            -Path $writeFailurePath `
            -Content $defaultQueue `
            -TemporaryFileWriter $partialWriteFailure
    }
    catch {
        $writeFailureWasReported = $true
    }
    if (-not $writeFailureWasReported) {
        throw 'A temporary queue write failure should be reported'
    }
    if (Test-Path -LiteralPath $writeFailurePath) {
        throw 'A temporary queue write failure should not leave a target queue'
    }
    Assert-NoQueueTemporaryFiles -Directory $writeFailureDirectory -Message 'A temporary queue write failure should clean up partial data'

    $flushFailureDirectory = Join-Path $TestDirectory 'flush-failure'
    [void](New-Item -ItemType Directory -Path $flushFailureDirectory -Force)
    $flushFailurePath = Join-Path $flushFailureDirectory 'queue.json'
    $flushFailure = {
        param(
            [Parameter(Mandatory)][System.IO.FileStream]$Stream,
            [Parameter(Mandatory)][string]$Content
        )

        $bytes = $encoding.GetBytes($Content)
        $Stream.Write($bytes, 0, $bytes.Length)
        throw (New-Object System.IO.IOException('Injected flush failure'))
    }.GetNewClosure()
    $flushFailureWasReported = $false
    try {
        Initialize-DefaultQueue `
            -Path $flushFailurePath `
            -Content $defaultQueue `
            -TemporaryFileWriter $flushFailure
    }
    catch {
        $flushFailureWasReported = $true
    }
    if (-not $flushFailureWasReported) {
        throw 'A temporary queue flush failure should be reported'
    }
    if (Test-Path -LiteralPath $flushFailurePath) {
        throw 'A temporary queue flush failure should not leave a target queue'
    }
    Assert-NoQueueTemporaryFiles -Directory $flushFailureDirectory -Message 'A temporary queue flush failure should clean up its temporary file'

    $concurrentDirectory = Join-Path $TestDirectory 'concurrent-file'
    [void](New-Item -ItemType Directory -Path $concurrentDirectory -Force)
    $concurrentPath = Join-Path $concurrentDirectory 'queue.json'
    $concurrentFileMover = {
        param(
            [Parameter(Mandatory)][string]$SourcePath,
            [Parameter(Mandatory)][string]$DestinationPath
        )

        [System.IO.File]::WriteAllText($DestinationPath, $alternateQueue, $encoding)
        throw (New-Object System.IO.IOException('Injected concurrent file creation'))
    }.GetNewClosure()
    Initialize-DefaultQueue `
        -Path $concurrentPath `
        -Content $defaultQueue `
        -AtomicMover $concurrentFileMover
    Assert-Equal $alternateQueue ([System.IO.File]::ReadAllText($concurrentPath)) 'A concurrently created regular queue should win without being overwritten'
    Assert-NoQueueTemporaryFiles -Directory $concurrentDirectory -Message 'A concurrent regular queue should not leave the losing temporary file'

    if ($isWindowsPlatform) {
        $reparseDirectory = Join-Path $TestDirectory 'concurrent-reparse'
        $reparseBackingDirectory = Join-Path $TestDirectory 'reparse-backing'
        [void](New-Item -ItemType Directory -Path $reparseDirectory, $reparseBackingDirectory -Force)
        $reparsePath = Join-Path $reparseDirectory 'queue.json'
        $concurrentReparseMover = {
            param(
                [Parameter(Mandatory)][string]$SourcePath,
                [Parameter(Mandatory)][string]$DestinationPath
            )

            [void](New-Item -ItemType Junction -Path $DestinationPath -Target $reparseBackingDirectory)
            throw (New-Object System.IO.IOException('Injected concurrent reparse point creation'))
        }.GetNewClosure()
        $reparseWasRejected = $false
        try {
            Initialize-DefaultQueue `
                -Path $reparsePath `
                -Content $defaultQueue `
                -AtomicMover $concurrentReparseMover
        }
        catch {
            $reparseWasRejected = $true
        }
        if (-not $reparseWasRejected) {
            throw 'A concurrently created reparse point should be rejected'
        }
        $reparseAttributes = [System.IO.File]::GetAttributes($reparsePath)
        if (($reparseAttributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
            throw 'The rejected concurrent target should remain a reparse point'
        }
        Assert-NoQueueTemporaryFiles -Directory $reparseDirectory -Message 'A rejected reparse target should not leave the losing temporary file'

        $existingReparseWasRejected = $false
        try {
            Initialize-DefaultQueue -Path $reparsePath -Content $defaultQueue
        }
        catch {
            $existingReparseWasRejected = $true
        }
        if (-not $existingReparseWasRejected) {
            throw 'An existing reparse point should be rejected'
        }
        Remove-Item -LiteralPath $reparsePath -Force
        if (-not (Test-Path -LiteralPath $reparseBackingDirectory -PathType Container)) {
            throw 'Rejecting a reparse target should not remove its backing directory'
        }
    }
}

$syntaxErrors = @()
Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'scripts') -Filter '*.ps1' -Recurse | ForEach-Object {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors)
    $syntaxErrors += $errors
}
if ($syntaxErrors.Count -gt 0) {
    throw "PowerShell syntax errors:`n$($syntaxErrors | Out-String)"
}

$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-queue-scheduler-{0}" -f [guid]::NewGuid())
try {
    $packageDirectory = Join-Path $tempDirectory 'release-package'
    $fakeCodexDirectory = Join-Path $tempDirectory 'npm-bin'
    $fakeNodeDirectory = Join-Path $tempDirectory 'node-bin'
    $queuePath = Join-Path $tempDirectory 'queue.json'
    $taskXmlPath = Join-Path $tempDirectory 'task.xml'
    $runnerExportPath = Join-Path $tempDirectory 'run-queue.ps1'
    $defaultTaskXmlPath = Join-Path $tempDirectory 'default-task.xml'
    $defaultRunnerExportPath = Join-Path $tempDirectory 'default-run-queue.ps1'
    $packagedCli = Join-Path $packageDirectory 'codex-queue-demo.exe'
    $packagedInstaller = Join-Path $packageDirectory 'install-windows.ps1'
    $codexPath = Join-Path $fakeCodexDirectory 'codex.cmd'
    $nodePath = Join-Path $fakeNodeDirectory 'node.exe'

    [void](New-Item -ItemType Directory -Path $packageDirectory, $fakeCodexDirectory, $fakeNodeDirectory -Force)
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'scripts\install-windows.ps1') -Destination $packagedInstaller
    [System.IO.File]::WriteAllText($packagedCli, 'test executable')
    [System.IO.File]::WriteAllText($codexPath, '@exit /b 0')
    [System.IO.File]::WriteAllText($nodePath, 'test executable')
    if (-not $isWindowsPlatform) {
        & chmod +x $nodePath
    }
    Test-DefaultQueueInitialization `
        -InstallerPath $packagedInstaller `
        -TestDirectory (Join-Path $tempDirectory 'queue-initialization')

    [System.IO.File]::WriteAllText(
        $queuePath,
        '{"version":1,"launchApp":true,"retryPolicy":{"maxAttempts":4,"initialDelaySeconds":30,"maxDelaySeconds":900},"tasks":[]}'
    )

    $originalPath = $env:PATH
    try {
        $env:PATH = "$fakeNodeDirectory$([System.IO.Path]::PathSeparator)$originalPath"
        & $packagedInstaller `
            -DryRun `
            -CodexBin $codexPath `
            -QueuePath $queuePath `
            -PowerShellBin 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
            -TaskUserId 'TEST\CodexQueue' `
            -ExportTaskXml $taskXmlPath `
            -ExportRunner $runnerExportPath

        & $packagedInstaller `
            -DryRun `
            -CodexBin $codexPath `
            -PowerShellBin 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
            -TaskUserId 'TEST\CodexQueue' `
            -ExportTaskXml $defaultTaskXmlPath `
            -ExportRunner $defaultRunnerExportPath

        $missingQueueWasRejected = $false
        try {
            & $packagedInstaller `
                -DryRun `
                -CodexBin $codexPath `
                -QueuePath (Join-Path $tempDirectory 'missing.json') `
                -PowerShellBin 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
                -TaskUserId 'TEST\CodexQueue' `
                -ExportTaskXml (Join-Path $tempDirectory 'unexpected.xml')
        }
        catch {
            $missingQueueWasRejected = $true
        }
        if (-not $missingQueueWasRejected) {
            throw 'An explicitly selected missing queue should be rejected'
        }
    }
    finally {
        $env:PATH = $originalPath
    }

    $taskXmlContent = Get-Content -LiteralPath $taskXmlPath -Raw
    if ($taskXmlContent -match '<\?xml[^>]*encoding=') {
        throw 'Task XML passed as a .NET string must not declare a byte encoding'
    }
    $taskXml = [xml]$taskXmlContent
    $namespace = [System.Xml.XmlNamespaceManager]::new($taskXml.NameTable)
    $namespace.AddNamespace('task', 'http://schemas.microsoft.com/windows/2004/02/mit/task')

    Assert-Equal '1.3' $taskXml.Task.version 'Task XML should use the version fixed by the official schema'
    $calendarChildren = @($taskXml.SelectSingleNode('//task:CalendarTrigger', $namespace).ChildNodes)
    Assert-Equal 'Enabled' $calendarChildren[0].LocalName 'Calendar trigger elements should follow the official XSD sequence'
    Assert-Equal 'StartBoundary' $calendarChildren[1].LocalName 'Calendar trigger elements should follow the official XSD sequence'
    $startBoundary = $taskXml.SelectSingleNode('//task:CalendarTrigger/task:StartBoundary', $namespace).InnerText
    if ($startBoundary -notmatch 'T01:00:00$') {
        throw "Task trigger should start at 01:00, got '$startBoundary'"
    }
    Assert-Equal '1' ($taskXml.SelectSingleNode('//task:ScheduleByDay/task:DaysInterval', $namespace).InnerText) 'Task should run every day'
    Assert-Equal 'InteractiveToken' ($taskXml.SelectSingleNode('//task:Principal/task:LogonType', $namespace).InnerText) 'Task should use the signed-in desktop session'
    Assert-Equal 'TEST\CodexQueue' ($taskXml.SelectSingleNode('//task:Principal/task:UserId', $namespace).InnerText) 'Task should use the selected interactive user'
    Assert-Equal 'IgnoreNew' ($taskXml.SelectSingleNode('//task:Settings/task:MultipleInstancesPolicy', $namespace).InnerText) 'Task should reject overlapping runs'
    Assert-Equal 'true' ($taskXml.SelectSingleNode('//task:Settings/task:WakeToRun', $namespace).InnerText) 'Task should request a wake timer'
    Assert-Equal 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' ($taskXml.SelectSingleNode('//task:Actions/task:Exec/task:Command', $namespace).InnerText) 'Task should use the selected PowerShell executable'

    $runner = Get-Content -LiteralPath $runnerExportPath -Raw
    Assert-Contains $runner $queuePath 'Runner should use the explicit queue path'
    Assert-Contains $runner $codexPath 'Runner should use the explicit Codex path'
    Assert-Contains $runner $fakeCodexDirectory 'Runner PATH should include the npm Codex directory'
    Assert-Contains $runner $fakeNodeDirectory 'Runner PATH should include the node interpreter directory'
    Assert-Contains $runner 'codex-queue-demo.exe' 'Runner should use the installed scheduler CLI'
    if ($runner.Contains($packageDirectory)) {
        throw 'Runner should not depend on the extracted release package directory'
    }

    $workingDirectory = $taskXml.SelectSingleNode('//task:Actions/task:Exec/task:WorkingDirectory', $namespace).InnerText
    if ($workingDirectory.Contains($packageDirectory)) {
        throw 'Scheduled task should use a stable working directory outside the release package'
    }

    $defaultRunner = Get-Content -LiteralPath $defaultRunnerExportPath -Raw
    $expectedDefaultQueue = Join-Path `
        (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'io.github.baicie.codex-queue') `
        'queue.json'
    Assert-Contains $defaultRunner $expectedDefaultQueue 'Default queue should match Tauri app_data_dir/queue.json'

    if ($isWindowsPlatform -and $env:CI -eq 'true') {
        $integrationTaskName = "Codex Queue Demo Install Test $([guid]::NewGuid().ToString('N'))"
        $integrationRoamingAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
        $integrationLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        $integrationAppData = Join-Path $integrationRoamingAppData 'io.github.baicie.codex-queue'
        $integrationRuntimeDirectory = Join-Path (Join-Path $integrationLocalAppData 'io.github.baicie.codex-queue') 'bin'
        $integrationBinary = Join-Path $integrationRuntimeDirectory 'codex-queue-demo.exe'
        $integrationRunner = Join-Path $integrationRuntimeDirectory 'run-queue.ps1'
        $alternateCodexPath = Join-Path $fakeCodexDirectory 'alternate-codex.cmd'
        [System.IO.File]::WriteAllText($alternateCodexPath, '@exit /b 0')

        if ((Test-Path -LiteralPath $integrationBinary) -or (Test-Path -LiteralPath $integrationRunner)) {
            throw 'Windows installer integration test requires a clean scheduler runtime directory'
        }

        try {
            & $packagedInstaller `
                -WhatIf `
                -TaskName $integrationTaskName `
                -CodexBin $codexPath `
                -QueuePath $queuePath
            if ((Test-Path -LiteralPath $integrationBinary) -or
                (Get-ScheduledTask -TaskName $integrationTaskName -ErrorAction SilentlyContinue)) {
                throw 'WhatIf should not install scheduler files or register a task'
            }

            & $packagedInstaller `
                -TaskName $integrationTaskName `
                -CodexBin $codexPath `
                -QueuePath $queuePath

            $preservedBinary = [System.IO.File]::ReadAllBytes($integrationBinary)
            $preservedRunner = [System.IO.File]::ReadAllText($integrationRunner)
            $preservedTask = Export-ScheduledTask -TaskName $integrationTaskName

            & $packagedInstaller `
                -WhatIf `
                -TaskName $integrationTaskName `
                -CodexBin $alternateCodexPath `
                -QueuePath $queuePath
            Assert-Equal $preservedRunner ([System.IO.File]::ReadAllText($integrationRunner)) 'WhatIf should preserve the installed runner'
            Assert-Equal $preservedTask (Export-ScheduledTask -TaskName $integrationTaskName) 'WhatIf should preserve the registered task'

            [System.IO.File]::WriteAllText($packagedCli, 'replacement executable')

            $upgradeError = $null
            try {
                & $packagedInstaller `
                    -TaskName $integrationTaskName `
                    -CodexBin $alternateCodexPath `
                    -QueuePath $queuePath
            }
            catch {
                $upgradeError = $_.Exception.Message
            }
            if ([string]::IsNullOrWhiteSpace($upgradeError)) {
                throw 'A second Windows installation should be rejected'
            }
            Assert-Contains $upgradeError 'uninstall-windows.ps1' 'Upgrade rejection should direct the user to the uninstaller'
            Assert-Contains $upgradeError 'queue and logs will be preserved' 'Upgrade rejection should explain preserved data'
            Assert-Equal `
                ([Convert]::ToBase64String($preservedBinary)) `
                ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($integrationBinary))) `
                'Rejected upgrade should preserve the installed CLI'
            Assert-Equal $preservedRunner ([System.IO.File]::ReadAllText($integrationRunner)) 'Rejected upgrade should preserve the runner'
            Assert-Equal $preservedTask (Export-ScheduledTask -TaskName $integrationTaskName) 'Rejected upgrade should preserve the registered task'
        }
        finally {
            Unregister-ScheduledTask -TaskName $integrationTaskName -Confirm:$false -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $integrationBinary, $integrationRunner -Force -ErrorAction SilentlyContinue
            if ((Test-Path -LiteralPath $integrationRuntimeDirectory -PathType Container) -and
                (Get-ChildItem -LiteralPath $integrationRuntimeDirectory -Force | Select-Object -First 1).Count -eq 0) {
                Remove-Item -LiteralPath $integrationRuntimeDirectory -Force
            }
            $integrationLogDirectory = Join-Path $integrationAppData 'logs'
            if ((Test-Path -LiteralPath $integrationLogDirectory -PathType Container) -and
                (Get-ChildItem -LiteralPath $integrationLogDirectory -Force | Select-Object -First 1).Count -eq 0) {
                Remove-Item -LiteralPath $integrationLogDirectory -Force
            }
        }
    }

    Write-Host 'PowerShell scheduler checks passed.'
}
finally {
    if (Test-Path -LiteralPath $tempDirectory) {
        Remove-Item -LiteralPath $tempDirectory -Recurse -Force
    }
}
