$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler not found.' }
$output = Join-Path (Split-Path -Parent $PSScriptRoot) 'Start-MCP-Tunnel.exe'
& $compiler /nologo /target:exe "/out:$output" (Join-Path $PSScriptRoot 'TunnelLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
Write-Host "Created $output"
