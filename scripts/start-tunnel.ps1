param(
    [switch]$ResetKey,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$settingsDirectory = Join-Path $env:LOCALAPPDATA 'chatgpt-tunnel-mcp'
$keyPath = Join-Path $settingsDirectory 'runtime-key.dpapi'
$settingsPath = Join-Path $settingsDirectory 'launcher.json'
$profile = 'chatgpt-tunnel-probe'

try {
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
        Write-Host 'Launcher prerequisites OK. No key read and no tunnel started.'
        exit 0
    }

    # Refuse a duplicate local daemon before accessing credentials.
    $listener = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
    if ($listener) { throw 'Port 8080 is already in use. Check http://127.0.0.1:8080/ui or stop the existing tunnel.' }

    New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
    @{ tunnelExecutable = $tunnelExecutable } | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    if ($ResetKey -or -not (Test-Path -LiteralPath $keyPath)) {
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

    # Only the child process receives the credential; it is not a command-line argument.
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $tunnelExecutable
    $start.Arguments = "run --profile $profile"
    $start.WorkingDirectory = $repoRoot
    $start.UseShellExecute = $false
    $start.EnvironmentVariables['CONTROL_PLANE_API_KEY'] = (New-Object PSCredential 'unused', $secureKey).GetNetworkCredential().Password
    Write-Host 'Starting tunnel. Keep this window open. Close it to stop the tunnel.'
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
    if (-not $CheckOnly) { Read-Host 'Press Enter to close' | Out-Null }
    exit 1
}
