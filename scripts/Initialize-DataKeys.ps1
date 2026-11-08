param(
    [string]$SecretsDirectory = (Join-Path $env:LOCALAPPDATA 'QamqorMed\secrets'),
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LocalSecretsDirectory {
    param([string]$Directory)
    if ($Directory -notmatch '^[A-Za-z]:[\\/]' -or $Directory.Substring(2) -match '[:*?"<>|\x00-\x1f]') { throw 'Invalid destination.' }
    $full = [IO.Path]::GetFullPath($Directory)
    if ($full.TrimEnd('\') -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw 'Invalid destination.' }
    $full = $full.TrimEnd('\')
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
    if ($full.Equals($repository, [StringComparison]::OrdinalIgnoreCase) -or
        $full.StartsWith($repository + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid destination.' }
    foreach ($name in @('OneDrive', 'OneDriveConsumer', 'OneDriveCommercial')) {
        $syncRoot = [Environment]::GetEnvironmentVariable($name)
        if (-not [string]::IsNullOrEmpty($syncRoot)) {
            $syncRoot = [IO.Path]::GetFullPath($syncRoot).TrimEnd('\')
            if ($full.Equals($syncRoot, [StringComparison]::OrdinalIgnoreCase) -or
                $full.StartsWith($syncRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid destination.' }
        }
    }
    if ($full -match '(?i)(^|\\)OneDrive(?: - [^\\]+)?(\\|$)') { throw 'Invalid destination.' }
    $cursor = $full
    while ($null -ne $cursor) {
        if (Test-Path -LiteralPath (Join-Path $cursor '.git')) { throw 'Invalid destination.' }
        if (Test-Path -LiteralPath $cursor) {
            $attributes = [IO.File]::GetAttributes($cursor)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'Invalid destination.' }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        $cursor = if ($null -eq $parent) { $null } else { $parent.FullName }
    }
    return $full
}

function Assert-PrivateDirectory {
    param([string]$Directory, [Security.Principal.SecurityIdentifier]$UserSid)
    $null = Assert-LocalSecretsDirectory $Directory
    $acl = Get-Acl -LiteralPath $Directory
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $UserSid.Value) {
        throw 'Directory protection failed.'
    }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { throw 'Directory protection failed.' }
    foreach ($sid in @($UserSid.Value, 'S-1-5-18')) {
        $matching = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid })
        if ($matching.Count -ne 1 -or $matching[0].IsInherited -or
            $matching[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $matching[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $matching[0].InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
            $matching[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'Directory protection failed.' }
    }
}

function Set-PrivateDirectory {
    param([string]$Directory, [Security.Principal.SecurityIdentifier]$UserSid)
    $null = Assert-LocalSecretsDirectory $Directory
    if ((Test-Path -LiteralPath $Directory) -and @(Get-ChildItem -LiteralPath $Directory -Force).Count -ne 0) {
        throw 'Destination must be empty.'
    }
    $null = [IO.Directory]::CreateDirectory($Directory)
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($UserSid)
    foreach ($sid in @($UserSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $null = $acl.AddAccessRule($rule)
    }
    # Set-Acl may also try to persist auditing and require SeSecurityPrivilege.
    # Persist only the changed owner/DACL sections via the filesystem API.
    $info = [IO.DirectoryInfo]::new($Directory)
    if ($null -ne $info.PSObject.Methods['SetAccessControl']) {
        $info.SetAccessControl($acl)
    } else {
        [IO.FileSystemAclExtensions]::SetAccessControl($info, $acl)
    }
    Assert-PrivateDirectory $Directory $UserSid
}

function Save-CurrentUserPayload {
    param([byte[]]$PayloadBytes, [string]$Path)
    $protected = $null
    $stored = $null
    $recovered = $null
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect($PayloadBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $file = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $file.Write($protected, 0, $protected.Length)
            $file.Flush($true)
        } finally { $file.Dispose() }
        $stored = [IO.File]::ReadAllBytes($Path)
        $recovered = [Security.Cryptography.ProtectedData]::Unprotect($stored, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ($recovered.Length -ne $PayloadBytes.Length) { throw 'Local recovery failed.' }
        $difference = 0
        for ($i = 0; $i -lt $PayloadBytes.Length; $i++) { $difference = $difference -bor ($recovered[$i] -bxor $PayloadBytes[$i]) }
        if ($difference -ne 0) { throw 'Local recovery failed.' }
    } finally {
        foreach ($bytes in @($protected, $stored, $recovered)) {
            if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        }
    }
}

$secureFirst = $null
$secureSecond = $null
$keyBytes = $null
$payloadBytes = $null
$random = $null
$child = $null
$firstPointer = [IntPtr]::Zero
$secondPointer = [IntPtr]::Zero
$passphrase = $null
$confirmation = $null
$payload = $null
$keyMap = $null
$payloadJson = $null
$requestJson = $null
$requestBytes = $null
$phase = 'preflight'
$result = 1

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $args.Count -ne 0) { throw 'Windows interactive use required.' }
    Add-Type -AssemblyName System.Security
    $phase = 'preflight: path validation'
    $directory = Assert-LocalSecretsDirectory $SecretsDirectory
    $backupPath = Join-Path $directory 'data-keys.vault.json'
    $dpapiPath = Join-Path $directory 'data-keys.dpapi'
    $phase = 'preflight: existing key files'
    if ((Test-Path -LiteralPath $backupPath) -or (Test-Path -LiteralPath $dpapiPath)) { throw 'Existing key material.' }
    $phase = 'preflight: Node.js'
    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $nodeScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'initialize-data-keys.mjs'))
    if ($nodeScript -match '["\x00-\x1f]' -or -not (Test-Path -LiteralPath $nodeScript -PathType Leaf)) { throw 'Initializer unavailable.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $userSid = $identity.User } finally { $identity.Dispose() }
    $phase = 'preflight: directory permissions'
    if ($CheckOnly) {
        if (Test-Path -LiteralPath $directory) { Assert-PrivateDirectory $directory $userSid }
        Write-Host 'Preflight passed. No keys generated or files changed.'
        exit 0
    }
    Set-PrivateDirectory $directory $userSid

    $phase = 'passphrase input'
    $secureFirst = Read-Host 'Vault passphrase (at least 16 characters; keep in your password manager)' -AsSecureString
    $secureSecond = Read-Host 'Confirm vault passphrase' -AsSecureString
    try {
        $firstPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureFirst)
        $secondPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecond)
        $passphrase = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($firstPointer)
        $confirmation = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secondPointer)
    } finally {
        if ($firstPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstPointer); $firstPointer = [IntPtr]::Zero }
        if ($secondPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondPointer); $secondPointer = [IntPtr]::Zero }
    }
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    if (-not [string]::Equals($passphrase, $confirmation, [StringComparison]::Ordinal) -or
        [Globalization.StringInfo]::ParseCombiningCharacters($passphrase.Trim()).Length -lt 16 -or
        $utf8.GetByteCount($passphrase) -gt 1024) { throw 'Passphrase requirements not met.' }
    $confirmation = $null
    Assert-PrivateDirectory $directory $userSid
    if ((Test-Path -LiteralPath $backupPath) -or (Test-Path -LiteralPath $dpapiPath)) { throw 'Existing key material.' }

    $phase = 'payload preparation'
    $keyBytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    $random.GetBytes($keyBytes)
    $keyId = 'data-' + [DateTime]::UtcNow.ToString('yyyyMMdd', [Globalization.CultureInfo]::InvariantCulture)
    $keyMap = [ordered]@{ $keyId = [Convert]::ToBase64String($keyBytes) }
    $payload = [ordered]@{
        version = 1
        createdAt = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        env = [ordered]@{
            QAMQOR_DATA_KEY_ID = $keyId
            QAMQOR_DATA_KEYS = (ConvertTo-Json -InputObject $keyMap -Compress)
        }
    }
    $payloadJson = ConvertTo-Json -InputObject $payload -Depth 8 -Compress
    $payloadBytes = $utf8.GetBytes($payloadJson)
    $requestJson = ConvertTo-Json -InputObject ([ordered]@{ passphrase = $passphrase; payload = $payload; backupPath = $backupPath }) -Depth 8 -Compress

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node.Path
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # Windows PowerShell 5.1 lacks StandardInputEncoding; write UTF-8 bytes to BaseStream below.
    if ($null -ne $start.PSObject.Properties['StandardInputEncoding']) { $start.StandardInputEncoding = $utf8 }
    $start.StandardOutputEncoding = $utf8
    $start.StandardErrorEncoding = $utf8
    $start.EnvironmentVariables.Remove('NODE_OPTIONS')
    $start.EnvironmentVariables.Remove('NODE_PATH')
    if ($null -ne $start.PSObject.Properties['ArgumentList']) {
        $start.ArgumentList.Add($nodeScript)
    } else {
        # This fixed absolute .mjs path has no quotes or trailing slash; no shell is involved.
        $start.Arguments = '"' + $nodeScript + '"'
    }
    $phase = 'portable backup'
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $start
    if (-not $child.Start()) { throw 'Initializer unavailable.' }
    $outputTask = $child.StandardOutput.ReadToEndAsync()
    $errorTask = $child.StandardError.ReadToEndAsync()
    $requestBytes = $utf8.GetBytes($requestJson)
    $child.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length)
    $child.StandardInput.BaseStream.Close()
    [Array]::Clear($requestBytes, 0, $requestBytes.Length)
    $requestJson = $null
    $passphrase = $null
    if (-not $child.WaitForExit(120000)) { throw 'Initializer did not finish.' }
    $childOutput = $outputTask.GetAwaiter().GetResult()
    $null = $errorTask.GetAwaiter().GetResult()
    if ($child.ExitCode -ne 0) { throw 'Backup verification failed.' }
    $status = ConvertFrom-Json -InputObject $childOutput
    if ($status.status -cne 'verified' -or -not [string]::Equals($status.backupPath, $backupPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Backup verification failed.'
    }
    Write-Host 'Portable encrypted backup verified.'
    Write-Host ('Backup: ' + $backupPath)
    $phase = 'DPAPI operational copy'
    Assert-PrivateDirectory $directory $userSid
    Save-CurrentUserPayload $payloadBytes $dpapiPath
    Write-Host 'Windows DPAPI CurrentUser copy verified. Initialization complete.'
    Write-Host ('Operational copy: ' + $dpapiPath)
    Write-Host 'Keep the vault passphrase in your password manager. Copy the encrypted backup to an independent location.'
    $result = 0
} catch {
    Write-Host ('Initialization failed during ' + $phase + '. Existing files were not overwritten. Preserve any encrypted backup and do not generate replacement keys.')
} finally {
    if ($null -ne $child) {
        try { if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() } } catch { }
        $child.Dispose()
    }
    if ($null -ne $random) { $random.Dispose() }
    if ($null -ne $secureFirst) { $secureFirst.Dispose() }
    if ($null -ne $secureSecond) { $secureSecond.Dispose() }
    if ($null -ne $keyBytes) { [Array]::Clear($keyBytes, 0, $keyBytes.Length) }
    if ($null -ne $payloadBytes) { [Array]::Clear($payloadBytes, 0, $payloadBytes.Length) }
    if ($null -ne $requestBytes) { [Array]::Clear($requestBytes, 0, $requestBytes.Length) }
    # Managed strings cannot be reliably erased; drop references and never persist them.
    $passphrase = $confirmation = $requestJson = $payloadJson = $payload = $keyMap = $null
}
exit $result
