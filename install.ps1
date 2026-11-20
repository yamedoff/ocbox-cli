# Install the OpenCloudBox CLI for the current user.
# Usage: irm <install url>/install.ps1 | iex
$ErrorActionPreference = 'Stop'

# Keep in sync with package.json engines.node.
$MinNodeMajor = 22
$DefaultReleaseBase = 'https://github.com/yamedoff/ocbox-cli/releases/latest/download'
$LatestReleaseApi = 'https://api.github.com/repos/yamedoff/ocbox-cli/releases/latest'

function Fail([string]$Message) {
  throw $Message
}

try {
  if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js $MinNodeMajor or newer is required. Install it from https://nodejs.org/ and run this again."
  }

  $nodeVersion = (& node -p 'process.versions.node').Trim()
  if ([string]::IsNullOrWhiteSpace($nodeVersion)) {
    $nodeVersion = (& node --version).Trim()
  }
  $nodeVersion = $nodeVersion.TrimStart('v')
  $nodeMajor = 0
  if (-not [int]::TryParse(($nodeVersion -split '\.')[0], [ref]$nodeMajor)) {
    Fail "Could not read the Node.js version. Install Node.js $MinNodeMajor or newer from https://nodejs.org/ and run this again."
  }
  if ($nodeMajor -lt $MinNodeMajor) {
    Fail "Node.js $MinNodeMajor or newer is required (found $nodeVersion). Install it from https://nodejs.org/ and run this again."
  }

  if ($null -eq (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "npm was not found. Install Node.js $MinNodeMajor or newer from https://nodejs.org/ and run this again."
  }

  $releaseBase = $env:OCBOX_RELEASE_BASE
  if ([string]::IsNullOrWhiteSpace($releaseBase)) {
    $releaseBase = $DefaultReleaseBase
  }
  $releaseBase = $releaseBase.TrimEnd('/')
  $isLocalBase = $releaseBase -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://'

  $version = $env:OCBOX_VERSION
  if ([string]::IsNullOrWhiteSpace($version)) {
    if ($isLocalBase) {
      $tarballs = @(Get-ChildItem -LiteralPath $releaseBase -Filter 'ocbox-*.tgz' -File)
      if ($tarballs.Count -eq 0) {
        Fail "No release tarball was found in $releaseBase. Set OCBOX_VERSION."
      }
      if ($tarballs.Count -gt 1) {
        Fail "More than one release tarball was found in $releaseBase. Set OCBOX_VERSION."
      }
      $version = $tarballs[0].Name
      $version = $version -replace '^ocbox-', '' -replace '\.tgz$', ''
    }
    else {
      $releaseJson = Invoke-WebRequest -UseBasicParsing -Uri $LatestReleaseApi
      $version = ($releaseJson.Content | ConvertFrom-Json).tag_name
      if ([string]::IsNullOrWhiteSpace($version)) {
        Fail 'Could not read the latest release version.'
      }
    }
  }

  $version = $version.Trim()
  if ($version.StartsWith('v')) {
    $version = $version.Substring(1)
  }
  if ([string]::IsNullOrWhiteSpace($version)) {
    Fail 'Could not determine the release version.'
  }

  $tarballName = "ocbox-$version.tgz"
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('ocbox-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempDir | Out-Null

  try {
    function Get-ReleaseAsset([string]$Name, [string]$Destination) {
      if ($isLocalBase) {
        $source = Join-Path $releaseBase $Name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
          Fail "Release asset $Name was not found in $releaseBase."
        }
        Copy-Item -LiteralPath $source -Destination $Destination
      }
      else {
        Invoke-WebRequest -UseBasicParsing -Uri ($releaseBase + '/' + $Name) -OutFile $Destination
      }
    }

    $tarballPath = Join-Path $tempDir $tarballName
    $sumsPath = Join-Path $tempDir 'SHA256SUMS'
    Get-ReleaseAsset $tarballName $tarballPath
    Get-ReleaseAsset 'SHA256SUMS' $sumsPath

    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sumsPath) {
      $parts = @($line.Trim() -split '\s+', 2)
      if ($parts.Count -eq 2) {
        $listed = $parts[1].TrimStart('*')
        if ($listed -eq $tarballName) {
          $expected = $parts[0].ToLowerInvariant()
          break
        }
      }
    }
    if ([string]::IsNullOrWhiteSpace($expected)) {
      Fail "SHA256SUMS does not list $tarballName."
    }

    $actual = (Get-FileHash -LiteralPath $tarballPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Fail "Checksum mismatch for $tarballName. Refusing to install."
    }

    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
      Fail 'LOCALAPPDATA is not set.'
    }
    $prefix = Join-Path $env:LOCALAPPDATA 'ocbox'
    New-Item -ItemType Directory -Force -Path $prefix | Out-Null

    & npm install -g --prefix $prefix $tarballPath
    if ($LASTEXITCODE -ne 0) {
      Fail 'npm install failed.'
    }

    # Windows global installs place the command shims in the prefix itself.
    $binDir = $prefix
    $ocboxCommand = Join-Path $binDir 'ocbox.cmd'
    if (-not (Test-Path -LiteralPath $ocboxCommand -PathType Leaf)) {
      Fail "The ocbox command was not installed in $binDir."
    }

    $normalizedBin = $binDir.TrimEnd('\')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $userPath) {
      $userPath = ''
    }
    $onUserPath = $false
    foreach ($entry in ($userPath -split ';')) {
      if ($entry.Trim().TrimEnd('\') -ieq $normalizedBin) {
        $onUserPath = $true
      }
    }
    if (-not $onUserPath) {
      $updatedPath = $userPath.TrimEnd(';')
      if ([string]::IsNullOrWhiteSpace($updatedPath)) {
        $updatedPath = $binDir
      }
      else {
        $updatedPath = $updatedPath + ';' + $binDir
      }
      [Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User')
    }

    $onProcessPath = $false
    foreach ($entry in ($env:Path -split ';')) {
      if ($entry.Trim().TrimEnd('\') -ieq $normalizedBin) {
        $onProcessPath = $true
      }
    }
    if (-not $onProcessPath) {
      $env:Path = $env:Path.TrimEnd(';') + ';' + $binDir
    }

    $installedVersion = & $ocboxCommand --version
    if ($LASTEXITCODE -ne 0) {
      Fail 'The installed ocbox command could not run.'
    }
    [Console]::Out.WriteLine((($installedVersion | Out-String).Trim()))
  }
  finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
catch {
  [Console]::Error.WriteLine('ocbox install: ' + $_.Exception.Message)
  exit 1
}
