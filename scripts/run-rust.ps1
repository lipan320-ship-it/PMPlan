param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('check', 'build')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $repositoryRoot 'src-tauri\Cargo.toml'
$vswherePath = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$cargoPath = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $vswherePath)) {
  throw 'Visual Studio Installer was not found. Install Desktop development with C++.'
}

if (-not (Test-Path -LiteralPath $cargoPath)) {
  throw 'Cargo was not found. Install the Rust MSVC toolchain.'
}

$installationPath = & $vswherePath `
  -latest `
  -products * `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath

if (-not $installationPath) {
  throw 'Microsoft C++ Build Tools were not found.'
}

$devCommandPath = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
$cargoBin = Split-Path -Parent $cargoPath
$quotedManifest = '"' + $manifestPath + '"'
$quotedCargo = '"' + $cargoPath + '"'
$quotedNpm = '"' + $npmPath + '"'

if ($Action -eq 'check') {
  $taskCommand = @(
    "$quotedCargo fmt --manifest-path $quotedManifest --check",
    "$quotedCargo test --manifest-path $quotedManifest",
    "$quotedCargo clippy --manifest-path $quotedManifest --all-targets --all-features -- -D warnings"
  ) -join ' && '
} else {
  $taskCommand = "$quotedNpm run tauri -- build --debug --no-bundle"
}

$commandLine = 'call "' + $devCommandPath + '" -arch=x64 >nul' +
  ' && set "PATH=' + $cargoBin + ';%PATH%"' +
  ' && ' + $taskCommand

Push-Location $repositoryRoot
try {
  & $env:ComSpec /d /s /c $commandLine
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
