param([switch]$UseEnvironment)

$ErrorActionPreference = 'Stop'
$previousKey = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'Process')
$secureKey = $null
$buffer = [IntPtr]::Zero
$result = 2

try {
    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if (-not $UseEnvironment) {
        Write-Host 'One synthetic request will be sent to Google Gemini. No database or deployment will be touched.'
        $secureKey = Read-Host 'Paste your new Gemini API key here (hidden; not saved)' -AsSecureString
        $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        $env:GEMINI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer)
        $buffer = [IntPtr]::Zero
    }
    & $node.Path (Join-Path $PSScriptRoot 'check-gemini.mjs')
    $result = $LASTEXITCODE
} catch {
    Write-Host 'Gemini check could not start. Check Node.js installation and script access. No diagnostic details are printed to protect credentials.'
} finally {
    if ($buffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer) }
    if ($null -ne $secureKey) { $secureKey.Dispose() }
    [Environment]::SetEnvironmentVariable('GEMINI_API_KEY', $previousKey, 'Process')
}
exit $result
