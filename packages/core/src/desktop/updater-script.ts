/**
 * Installation d'une mise à jour portable Windows (Windows PowerShell 5.1), lancée détachée par
 * l'hôte : attend la fermeture de Monolith, revérifie l'empreinte SHA-256 du paquet, met de côté
 * les fichiers actuels (dossier previous), copie la nouvelle version en conservant les données,
 * puis relance. Tout échec restaure la version précédente. Résultat écrit dans update-result.json.
 */
export const UPDATER_SCRIPT = String.raw`
param([int]$WaitPid = 0, [string]$Zip, [string]$Sha256, [string]$Target, [string]$Exe = 'Monolith.exe', [string]$Version = '', [switch]$Relaunch)
$ErrorActionPreference = 'Stop'
# .NET plutôt que Get-FileHash / Expand-Archive : ces modules peuvent manquer selon PSModulePath.
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-Sha256([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($path)
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
$work = Split-Path -Parent $Zip
$result = Join-Path $work 'update-result.json'
$keep = @('data', 'monolith.location.json')

function Write-Result([bool]$ok, [string]$message) {
  $json = ConvertTo-Json -Compress -InputObject @{ ok = $ok; message = $message; version = $Version; at = (Get-Date).ToUniversalTime().ToString('o') }
  [IO.File]::WriteAllText($result, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Retry([scriptblock]$action) {
  for ($i = 0; $i -lt 20; $i++) {
    try { & $action; return } catch { if ($i -eq 19) { throw }; Start-Sleep -Milliseconds 500 }
  }
}

try {
  if ($WaitPid -gt 0) {
    $p = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
    if ($p -and -not $p.WaitForExit(120000)) { throw "Monolith ne s'est pas fermé : mise à jour abandonnée." }
  }
  Start-Sleep -Milliseconds 800
  $hash = Get-Sha256 $Zip
  if ($hash -ne $Sha256.ToLowerInvariant()) { throw 'Empreinte SHA-256 du paquet incorrecte : mise à jour abandonnée.' }

  $stage = Join-Path $work 'staging'
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $stage)
  $root = $stage
  $top = @(Get-ChildItem -LiteralPath $stage -Force)
  if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $root = $top[0].FullName }
  if (-not (Test-Path -LiteralPath (Join-Path $root $Exe))) { throw "Paquet invalide : $Exe absent." }

  $previous = Join-Path $work 'previous'
  if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
  New-Item -ItemType Directory -Path $previous | Out-Null

  $moved = New-Object System.Collections.ArrayList
  $copied = New-Object System.Collections.ArrayList
  try {
    foreach ($item in @(Get-ChildItem -LiteralPath $Target -Force)) {
      if ($keep -contains $item.Name) { continue }
      $from = $item.FullName
      Retry { Move-Item -LiteralPath $from -Destination (Join-Path $previous $item.Name) }
      [void]$moved.Add($item.Name)
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $root -Force)) {
      if ($keep -contains $item.Name) { continue }
      [void]$copied.Add($item.Name)
      Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $Target $item.Name) -Recurse -Force
    }
  } catch {
    $failure = $_.Exception.Message
    # Restauration : retire ce qui a été copié, remet les fichiers précédents.
    foreach ($name in $copied) { Remove-Item -LiteralPath (Join-Path $Target $name) -Recurse -Force -ErrorAction SilentlyContinue }
    foreach ($name in $moved) { Move-Item -LiteralPath (Join-Path $previous $name) -Destination (Join-Path $Target $name) -Force -ErrorAction SilentlyContinue }
    throw "Échec de l'installation ($failure) : version précédente restaurée."
  }
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  Write-Result $true "Version $Version installée ; l'ancienne version est conservée dans le dossier previous."
} catch {
  Write-Result $false $_.Exception.Message
}
if ($Relaunch) { Start-Process -FilePath (Join-Path $Target $Exe) -WorkingDirectory $Target }
`;
