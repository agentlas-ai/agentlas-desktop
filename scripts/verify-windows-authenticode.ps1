<#
  Release gate: every Windows artifact the release ships must carry a valid, timestamped Authenticode signature from the
  approved certificate profile, and the update feed must describe exactly those signed bytes.

  Fails (exit 1) on any of: a missing artifact, a signature status other than Valid, a signer whose common name is not
  the approved publisher, a missing timestamp, a failed `signtool verify /pa`, or a latest.yml whose sha512 or size
  does not match the final Setup file. There is no unsigned fallback and no warning-only mode.

  Usage (Windows runner, after electron-builder finished):
    powershell -NoProfile -File scripts/verify-windows-authenticode.ps1 -ReleaseDir release -Publisher "<CN of the profile>"
#>
param(
  [Parameter(Mandatory = $true)][string]$ReleaseDir,
  [Parameter(Mandatory = $true)][string]$Publisher,
  [string]$Report = ''
)
$ErrorActionPreference = 'Stop'
# A script error is a gate failure with its position printed, never a silent pass.
trap { Write-Host ('GATE SCRIPT ERROR: ' + $_.Exception.Message + ' | ' + $_.InvocationInfo.PositionMessage); exit 1 }
$failures = New-Object System.Collections.Generic.List[string]
$rows = New-Object System.Collections.Generic.List[object]

function Find-Signtool {
  $root = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (-not (Test-Path -LiteralPath $root)) { return $null }
  Get-ChildItem -LiteralPath $root -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
$signtool = Find-Signtool

function Test-Signed([string]$File, [string]$Role) {
  if (-not (Test-Path -LiteralPath $File)) { $failures.Add("${Role}: missing $File"); return }
  $name = [IO.Path]::GetFileName($File)
  $sig = Get-AuthenticodeSignature -LiteralPath $File
  $ok = $true
  if ($sig.Status -ne 'Valid') { $failures.Add("${Role}: $name signature status is $($sig.Status) (must be Valid)"); $ok = $false }
  $cn = $null
  if ($null -ne $sig.SignerCertificate) { $cn = $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }
  if ($cn -ne $Publisher) { $failures.Add("${Role}: $name is signed by '$cn', expected '$Publisher'"); $ok = $false }
  if ($null -eq $sig.TimeStamperCertificate) { $failures.Add("${Role}: $name has no timestamp"); $ok = $false }
  $verify = 'not-run'
  if ($ok -and $signtool) {
    & $signtool verify /pa /q $File *> $null
    $verify = if ($LASTEXITCODE -eq 0) { 'ok' } else { 'failed' }
    if ($LASTEXITCODE -ne 0) { $failures.Add("${Role}: signtool verify /pa failed for $name"); $ok = $false }
  }
  $rows.Add([pscustomobject]@{ role = $Role; file = $name; status = "$($sig.Status)"; signer = $cn; timestamped = ($null -ne $sig.TimeStamperCertificate); signtool = $verify; ok = $ok })
}

function Get-One([string]$Dir, [string]$Filter, [string]$Role) {
  $found = @(Get-ChildItem -LiteralPath $Dir -Filter $Filter -File -ErrorAction SilentlyContinue)
  if ($found.Count -ne 1) { $failures.Add("${Role}: expected exactly one '$Filter' in $Dir, found $($found.Count)"); return $null }
  $found[0].FullName
}

$setup = Get-One $ReleaseDir 'Agentlas-*-Windows-x64-Setup.exe' 'Setup installer'
$portable = Get-One $ReleaseDir 'Agentlas-*-Windows-x64-Portable.exe' 'Portable executable'
if ($setup) { Test-Signed $setup 'Setup installer' }
if ($portable) { Test-Signed $portable 'Portable executable' }
Test-Signed (Join-Path $ReleaseDir 'win-unpacked\Agentlas.exe') 'Application executable'
# electron-builder 26 signs the NSIS uninstaller (<Setup name>.__uninstaller.exe) while it builds Setup, embeds it, and then deletes it from
# the output directory, so it cannot be read back from release/. If one is left behind it must be signed; either way the hook ledger below
# has to show that it was signed.
foreach ($u in @(Get-ChildItem -LiteralPath $ReleaseDir -Filter '*__uninstaller.exe' -File -ErrorAction SilentlyContinue)) { Test-Signed $u.FullName 'NSIS uninstaller' }

# The update feed must describe the final signed Setup bytes (electron-updater checks sha512 before it installs).
if ($setup) {
  $latest = Join-Path $ReleaseDir 'latest.yml'
  if (-not (Test-Path -LiteralPath $latest)) { $failures.Add('feed: latest.yml is missing') }
  else {
    $name = [IO.Path]::GetFileName($setup)
    $text = Get-Content -LiteralPath $latest -Raw
    # The pattern is built first: inside a method call the comma binds tighter than +, so concatenating in the argument list fails.
    $pattern = "(?ms)^\s*-\s*url:\s*" + [regex]::Escape($name) + "\s*\r?\n(?<body>(?:\s+\S.*\r?\n?)*)"
    $block = [regex]::Match($text, $pattern)
    $sha = [regex]::Match($block.Groups['body'].Value, '(?m)^\s*sha512:\s*(\S+)').Groups[1].Value
    $size = [regex]::Match($block.Groups['body'].Value, '(?m)^\s*size:\s*(\d+)').Groups[1].Value
    $stream = [IO.File]::OpenRead($setup)
    try { $actual = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($stream)) } finally { $stream.Dispose() }
    if (-not $sha) { $failures.Add("feed: latest.yml has no sha512 for $name") }
    elseif ($sha -ne $actual) { $failures.Add("feed: latest.yml sha512 does not match the signed $name") }
    if ($size -and [int64]$size -ne (Get-Item -LiteralPath $setup).Length) { $failures.Add("feed: latest.yml size does not match the signed $name") }
    if (-not (Test-Path -LiteralPath ($setup + '.blockmap'))) { $failures.Add("feed: $name.blockmap is missing") }
  }
}

# The hook ledger (one JSON line per file the signing hook signed) is the proof for files that cannot be read back from release/ (the
# embedded uninstaller) and the signature count for the monthly quota. It must show a signed entry for each owner executable, all by the publisher.
$ledgerLines = 0
$ledgerPath = $env:AGENTLAS_WINDOWS_SIGN_LEDGER
if (-not $ledgerPath -or -not (Test-Path -LiteralPath $ledgerPath)) { $failures.Add('ledger: the signing hook wrote no ledger (AGENTLAS_WINDOWS_SIGN_LEDGER)') }
else {
  $entries = @(Get-Content -LiteralPath $ledgerPath | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
  $ledgerLines = $entries.Count
  $names = @($entries | ForEach-Object { $_.file })
  foreach ($need in @(
      @{ role = 'application executable'; pattern = '^Agentlas\.exe$' },
      @{ role = 'NSIS uninstaller'; pattern = '__uninstaller\.exe$' },
      @{ role = 'Setup installer'; pattern = '^Agentlas-.+-Windows-x64-Setup\.exe$' },
      @{ role = 'Portable executable'; pattern = '^Agentlas-.+-Windows-x64-Portable\.exe$' })) {
    if (-not @($names | Where-Object { $_ -match $need.pattern })) { $failures.Add("ledger: the hook did not sign the $($need.role)") }
  }
  foreach ($e in $entries) {
    $cn = ''
    if ("$($e.subject)" -match '^CN=(?:"(?<q>[^"]+)"|(?<p>[^,]+))') { $cn = if ($Matches['q']) { $Matches['q'] } else { $Matches['p'].Trim() } }
    if ($cn -ne $Publisher) { $failures.Add("ledger: $($e.file) was signed as '$cn', expected '$Publisher'") }
  }
}

$rows | Format-Table -AutoSize | Out-String | Write-Host
$summary = New-Object psobject
$summary | Add-Member -NotePropertyName publisher -NotePropertyValue $Publisher
$summary | Add-Member -NotePropertyName checkedFiles -NotePropertyValue $rows.Count
$summary | Add-Member -NotePropertyName signaturesRecordedByHook -NotePropertyValue $ledgerLines
$summary | Add-Member -NotePropertyName signtoolFound -NotePropertyValue ([bool]$signtool)
$summary | Add-Member -NotePropertyName failures -NotePropertyValue $failures.ToArray()
$summary | Add-Member -NotePropertyName ok -NotePropertyValue ($failures.Count -eq 0)
$summary | Add-Member -NotePropertyName files -NotePropertyValue $rows.ToArray()
if ($Report) { $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Report -Encoding UTF8 }
if ($failures.Count -gt 0) {
  Write-Host "WINDOWS SIGNATURE GATE FAILED ($($failures.Count)):"
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host "WINDOWS SIGNATURE GATE PASSED: $($rows.Count) files valid and timestamped, signer '$Publisher', feed hashes match, $ledgerLines signatures recorded by the hook."
