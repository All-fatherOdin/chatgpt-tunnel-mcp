param(
    [switch]$ResetKey,
    [switch]$CheckOnly,
    [switch]$RunWorker,
    [switch]$RunDispatcher,
    [switch]$Status,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$settingsDirectory = Join-Path $env:LOCALAPPDATA 'chatgpt-tunnel-mcp'
$keyPath = Join-Path $settingsDirectory 'runtime-key.dpapi'
$settingsPath = Join-Path $settingsDirectory 'launcher.json'
$profile = 'chatgpt-tunnel-probe'
$workerCommand = '"' + (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -RunWorker'
$dispatcherCommand = $workerCommand.Replace(' -RunWorker', ' -RunDispatcher')
$dispatcherConfigPath = Join-Path $repoRoot 'config\dispatcher.local.json'

function Get-DispatcherWorker {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'")) {
        if ($candidate.CommandLine -eq $dispatcherCommand) {
            $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid
            if ($owner.Sid -eq $currentSid) { $candidate }
        }
    }
}

function Start-DispatcherWorker {
    if (-not (Test-Path -LiteralPath $dispatcherConfigPath)) { Write-Host 'Dispatcher: not configured.'; return }
    $dispatcherConfig = Get-Content -LiteralPath $dispatcherConfigPath -Raw | ConvertFrom-Json
    if ($dispatcherConfig.enabled -ne $true) { Write-Host 'Dispatcher: disabled.'; return }
    $existing = @(Get-DispatcherWorker)
    if ($existing.Count) { Write-Host "Dispatcher worker PID: $($existing.ProcessId -join ', ') (already running)"; return }
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $dispatcherCommand; CurrentDirectory = $repoRoot; ProcessStartupInformation = $startup
    }
    if ($created.ReturnValue -ne 0) { throw 'Windows failed to start dispatcher worker.' }
    Start-Sleep -Seconds 2
    if (-not @(Get-DispatcherWorker).Count) { throw 'Dispatcher exited. See dispatcher-error.log in the local settings directory; check for a manually running dispatcher.' }
    Write-Host "Dispatcher worker PID: $($created.ProcessId)."
}

function Get-TunnelWorker {
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'")) {
        if ($candidate.CommandLine -eq $workerCommand) {
            $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid
            if ($owner.Sid -eq $currentSid) { $candidate }
        }
    }
}

try {
    if ($RunDispatcher) {
        $pathBytes = [System.Text.Encoding]::UTF8.GetBytes($repoRoot.ToLowerInvariant())
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        $pathHash = [BitConverter]::ToString($hasher.ComputeHash($pathBytes)).Replace('-', '')
        $hasher.Dispose()
        $workerLock = New-Object System.Threading.Mutex($false, ('Local\ChatGPT-MCP-Dispatcher-' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value + '-' + $pathHash))
        try { $ownsWorkerLock = $workerLock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsWorkerLock = $true }
        if (-not $ownsWorkerLock) { exit 0 }
        New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
        $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
        $dispatcher = Start-Process -FilePath $nodeExecutable -ArgumentList ('"' + (Join-Path $repoRoot 'dist\src\dispatcher\index.js') + '" --config "' + $dispatcherConfigPath + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $settingsDirectory 'dispatcher-output.log') -RedirectStandardError (Join-Path $settingsDirectory 'dispatcher-error.log')
        $dispatcher.WaitForExit()
        exit $dispatcher.ExitCode
    }
    if ($Status -or $Stop) {
        $workers = @(Get-TunnelWorker)
        $dispatchers = @(Get-DispatcherWorker)
        if ($Stop) {
            foreach ($worker in @($dispatchers) + @($workers)) {
                # Only the verified worker of this user and this repository, including its children.
                & (Join-Path $env:WINDIR 'System32\taskkill.exe') /PID $worker.ProcessId /T /F | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Could not stop the verified worker tree.' }
            }
            Write-Host 'Managed tunnel and dispatcher stopped. Manually started processes are not affected.'
            exit 0
        }
        if ($dispatchers.Count) { Write-Host "Dispatcher worker PID: $($dispatchers.ProcessId -join ', ')" }
        else { Write-Host 'Dispatcher worker is not running.' }
        if (-not $workers.Count) { Write-Host 'Tunnel worker is not running.'; exit 1 }
        Write-Host "Worker PID: $($workers.ProcessId -join ', ')"
        try {
            $ready = Invoke-WebRequest 'http://127.0.0.1:8080/readyz' -UseBasicParsing -TimeoutSec 3
            Write-Host "Readiness: $($ready.Content.Trim())"
        } catch { Write-Host 'Readiness: unavailable'; exit 1 }
        exit 0
    }
    $tunnelExecutable = $null
    if (Test-Path -LiteralPath $settingsPath) {
        $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        $tunnelExecutable = $settings.tunnelExecutable
    }
    if (-not $tunnelExecutable) {
        $candidate = Get-Command tunnel-client.exe -ErrorAction SilentlyContinue
        if ($candidate) { $tunnelExecutable = $candidate.Source }
    }
    if (-not $tunnelExecutable) {
        $candidatePath = 'C:\Alex\Self\tunnel-client-v0.0.14-windows-amd64\tunnel-client.exe'
        if (Test-Path -LiteralPath $candidatePath) { $tunnelExecutable = $candidatePath }
    }
    if (-not $tunnelExecutable -or -not (Test-Path -LiteralPath $tunnelExecutable -PathType Leaf)) {
        if ($CheckOnly) { throw 'Tunnel executable not configured or missing.' }
        $tunnelExecutable = (Read-Host 'Full path to tunnel-client.exe').Trim('"')
        if (-not (Test-Path -LiteralPath $tunnelExecutable -PathType Leaf)) { throw 'Executable not found.' }
    }
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $profilePath = Join-Path $env:APPDATA "tunnel-client\$profile.yaml"
    if (-not (Test-Path -LiteralPath $profilePath)) { throw 'Tunnel profile missing. Create chatgpt-tunnel-probe with tunnel-client init first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'config\local.json'))) { throw 'config/local.json is missing.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist\src\index.js'))) { throw 'Server build missing. Run npm.cmd run build in the repository.' }
    if ($CheckOnly) {
        if (Test-Path -LiteralPath $dispatcherConfigPath) {
            $dispatcherConfig = Get-Content -LiteralPath $dispatcherConfigPath -Raw | ConvertFrom-Json
            if ($dispatcherConfig.enabled -eq $true) {
                & $nodeExecutable (Join-Path $repoRoot 'dist\src\dispatcher\index.js') --config $dispatcherConfigPath --status
                if ($LASTEXITCODE -ne 0) { throw 'Dispatcher configuration check failed.' }
            }
        }
        $null = Get-CimClass Win32_Process
        Write-Host 'Launcher prerequisites OK. No key read and no tunnel started.'
        exit 0
    }

    if (-not $RunWorker) {
        $workers = @(Get-TunnelWorker)
        if ($workers.Count) {
            if ($ResetKey) { throw 'Stop the tunnel with --stop before resetting its key.' }
            Write-Host 'Tunnel worker already running.'
            Start-DispatcherWorker
            exit 0
        }
    }

    if ($RunWorker) {
        $workerLock = New-Object System.Threading.Mutex($false, ('Local\ChatGPT-MCP-Tunnel-' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
        try { $ownsWorkerLock = $workerLock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsWorkerLock = $true }
        if (-not $ownsWorkerLock) { throw 'Another tunnel worker is already running.' }
    }

    # Refuse a duplicate local daemon before accessing credentials.
    $listener = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
    if ($listener) { throw 'Port 8080 is already in use. Check http://127.0.0.1:8080/ui or stop the existing tunnel.' }

    New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
    @{ tunnelExecutable = $tunnelExecutable } | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    if ($ResetKey -or -not (Test-Path -LiteralPath $keyPath)) {
        if ($RunWorker) { throw 'Saved runtime key missing. Run the EXE interactively first.' }
        Write-Host 'Enter the runtime key once. Windows encrypts it for this user on this device.'
        $secureKey = Read-Host 'Runtime API key' -AsSecureString
        if ($secureKey.Length -eq 0) { throw 'Empty key was not saved.' }
        $encrypted = ConvertFrom-SecureString -SecureString $secureKey
        $temporaryKeyPath = Join-Path $settingsDirectory ('key-' + [guid]::NewGuid().ToString() + '.tmp')
        try {
            [System.IO.File]::WriteAllText($temporaryKeyPath, $encrypted)
            Move-Item -LiteralPath $temporaryKeyPath -Destination $keyPath -Force
        } finally {
            if (Test-Path -LiteralPath $temporaryKeyPath) { Remove-Item -LiteralPath $temporaryKeyPath }
        }
    } else {
        $secureKey = Get-Content -LiteralPath $keyPath -Raw | ConvertTo-SecureString
    }

    if (-not $RunWorker) {
        $secureKey.Dispose()
        # WMI creates the worker in its provider host, outside the caller's process/job tree.
        $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
        $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $workerCommand; CurrentDirectory = $repoRoot; ProcessStartupInformation = $startup
        }
        if ($created.ReturnValue -ne 0) { throw "Windows failed to start the worker (code $($created.ReturnValue))." }
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 500
            $live = @(Get-TunnelWorker | Where-Object { $_.ProcessId -eq $created.ProcessId })
            if (-not $live.Count) { throw 'Worker exited. See worker-error.txt in the local launcher settings directory.' }
            try {
                $ready = Invoke-WebRequest 'http://127.0.0.1:8080/readyz' -UseBasicParsing -TimeoutSec 1
                if ($ready.StatusCode -eq 200) {
                    Start-DispatcherWorker
                    Write-Host "Tunnel ready. Independent worker PID: $($created.ProcessId). Codex and this window can be closed."
                    Write-Host 'Use --status to check readiness and --stop to stop the tunnel.'
                    exit 0
                }
            } catch { }
        }
        throw 'Worker started but readiness is not confirmed. Use --status; do not start another instance.'
    }

    # Only the child process receives the credential; it is not a command-line argument.
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $tunnelExecutable
    $start.Arguments = "run --profile $profile"
    $start.WorkingDirectory = $repoRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables['CONTROL_PLANE_API_KEY'] = (New-Object PSCredential 'unused', $secureKey).GetNetworkCredential().Password
    Write-Host 'Starting independent tunnel worker.'
    Write-Host 'Local status: http://127.0.0.1:8080/ui'
    $process = [System.Diagnostics.Process]::Start($start)
    $start.EnvironmentVariables.Remove('CONTROL_PLANE_API_KEY')
    $secureKey.Dispose()
    $process.WaitForExit()
    $resultCode = $process.ExitCode
    $process.Dispose()
    if ($resultCode -ne 0) { throw "Tunnel exited with code $resultCode. Check the output above." }
    exit 0
} catch {
    Write-Host ('Launcher error: ' + $_.Exception.Message) -ForegroundColor Red
    if ($RunWorker -or $RunDispatcher) {
        # Store only launcher diagnostics, never the decrypted credential or environment.
        $errorFile = if ($RunDispatcher) { 'dispatcher-worker-error.txt' } else { 'worker-error.txt' }
        [System.IO.File]::WriteAllText((Join-Path $settingsDirectory $errorFile), $_.Exception.Message)
    }
    exit 1
}
finally {
    if ($ownsWorkerLock) { $workerLock.ReleaseMutex() }
    if ($workerLock) { $workerLock.Dispose() }
}
