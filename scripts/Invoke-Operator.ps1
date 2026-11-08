param(
    [ValidateSet('stage', 'stage-access', 'set-keys', 'production', 'production-check', 'publish-db-config', 'build', 'verify-live')][string]$Action = 'stage'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$child = $null
$plain = $null
try {
    Add-Type -AssemblyName System.Security
    $keyFile = Join-Path $env:LOCALAPPDATA 'QamqorMed\secrets\data-keys.dpapi'
    $stored = [IO.File]::ReadAllBytes($keyFile)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($stored, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $node = Get-Command node -CommandType Application | Select-Object -First 1
    $script = Join-Path $PSScriptRoot 'operator-rollout.mjs'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node.Path
    $start.Arguments = '"' + $script + '" ' + $Action
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Remove('NODE_OPTIONS')
    $start.EnvironmentVariables.Remove('NODE_PATH')
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $start
    $null = $child.Start()
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    $child.StandardInput.BaseStream.Write($plain, 0, $plain.Length)
    $child.StandardInput.Close()
    if (-not $child.WaitForExit(300000)) { throw 'Operation timed out.' }
    $output = $stdout.GetAwaiter().GetResult()
    $null = $stderr.GetAwaiter().GetResult()
    Write-Output $output
    exit $child.ExitCode
} catch {
    Write-Output '{"check":"operator","status":"failed","reason":"Check the protected key file and local tools; details redacted"}'
    exit 1
} finally {
    if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
    if ($null -ne $child) {
        try { if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() } } catch { }
        $child.Dispose()
    }
}
