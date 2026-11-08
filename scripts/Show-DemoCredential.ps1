param([ValidateSet('patient','doctor','admin')][string]$Role = 'admin')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$plain = $null
$child = $null
try {
    Add-Type -AssemblyName System.Security
    $path = Join-Path $env:LOCALAPPDATA 'QamqorMed\secrets\data-keys.dpapi'
    $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command node -CommandType Application | Select-Object -First 1).Path
    $start.Arguments = '"' + (Join-Path $PSScriptRoot 'show-demo-credential.mjs') + '" ' + $Role
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.EnvironmentVariables.Remove('NODE_OPTIONS')
    $start.EnvironmentVariables.Remove('NODE_PATH')
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $start
    $null = $child.Start()
    $child.StandardInput.BaseStream.Write($plain, 0, $plain.Length)
    $child.StandardInput.Close()
    if (-not $child.WaitForExit(30000)) { throw 'Viewer timed out.' }
    exit $child.ExitCode
} catch {
    Write-Host 'Credential viewer stopped. Check the local protected files; details redacted.'
    exit 1
} finally {
    if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
    if ($null -ne $child) {
        try { if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() } } catch { }
        $child.Dispose()
    }
}
