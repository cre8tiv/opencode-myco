# Installs or updates myco for OpenCode (Windows PowerShell 5.1 or PowerShell 7). Run it again to update.
#
#   irm https://raw.githubusercontent.com/cre8tiv/opencode-myco/main/install.ps1 | iex
#
# With options, run it as a script block (a piped script cannot take parameters):
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/cre8tiv/opencode-myco/main/install.ps1))) -Ref <tag-or-sha> -Models C:\models.json
#
# What it does, and nothing else: it keeps a shallow checkout of the repository in
# ~\.local\share\myco\src (or $env:MYCO_SRC), moved to -Ref (default: main), and runs
# scripts\install.mjs from it. That installs agents, skills and the plugin into OpenCode's config
# directory and leaves your own agents, skills and models.json alone. No other files.
#
#   -Ref <ref>              a branch, tag or commit to install (default: main). Pin one to install a known version.
#   -Project                install into .\.opencode instead of your user config (the default, which is global)
#   -Target <dir>           install into this directory
#   -Models <file>          map your models to the teams as you install; see the README
#   -AllowAutonomousMerge   for projects that set merge_policy: autonomous; see the README
#
# Needs git and Node.js 22 or newer. $env:MYCO_REPO overrides the repository, for a fork.
[CmdletBinding()]
param(
  [string]$Ref = 'main',
  [switch]$Project,
  [string]$Target,
  [string]$Models,
  [switch]$AllowAutonomousMerge
)

# No `exit` anywhere: run through `irm | iex` it would close the caller's PowerShell. A failure is a throw.
$Repo = if ($env:MYCO_REPO) { $env:MYCO_REPO } else { 'https://github.com/cre8tiv/opencode-myco' }
$Src = if ($env:MYCO_SRC) { $env:MYCO_SRC } else { Join-Path (Join-Path (Join-Path (Join-Path $HOME '.local') 'share') 'myco') 'src' }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'myco install: git is required' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'myco install: Node.js 22 or newer is required (https://nodejs.org)' }
$major = [int](& node -p 'process.versions.node.split(".")[0]')
if ($major -lt 22) { throw "myco install: Node.js 22 or newer is required (found $(& node -v))" }

# Runs git and stops on failure. Native commands do not throw on their own.
function Invoke-Git {
  & git @args
  if ($LASTEXITCODE -ne 0) { throw "myco install: git $($args -join ' ') failed" }
}

Write-Host "Fetching $Repo ($Ref) into $Src"
New-Item -ItemType Directory -Force -Path $Src | Out-Null
if (-not (Test-Path (Join-Path $Src '.git'))) {
  if (Get-ChildItem -Force -Path $Src | Select-Object -First 1) { throw "myco install: $Src exists and is not a myco checkout; move it away or set MYCO_SRC" }
  Invoke-Git -C $Src init -q
}
& git -C $Src remote get-url origin *> $null
if ($LASTEXITCODE -eq 0) { Invoke-Git -C $Src remote set-url origin $Repo } else { Invoke-Git -C $Src remote add origin $Repo }
& git -C $Src fetch -q --depth 1 origin $Ref
if ($LASTEXITCODE -ne 0) { throw "myco install: could not fetch '$Ref' from $Repo" }
& git -C $Src -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw "myco install: could not check out '$Ref' in $Src (local changes there? delete the directory and run again)" }
Write-Host "At $(& git -C $Src rev-parse --short HEAD)"

# Global unless told where, as install.sh does.
$installer = @((Join-Path $Src 'scripts/install.mjs'))
if ($Project) { $installer += '--project' } elseif (-not $Target) { $installer += '--global' }
if ($Target) { $installer += @('--target', $Target) }
if ($Models) { $installer += @('--models', $Models) }
if ($AllowAutonomousMerge) { $installer += '--allow-autonomous-merge' }
Write-Host "Installing: $($installer[1..($installer.Count - 1)] -join ' ')"
& node @installer
if ($LASTEXITCODE -ne 0) { throw "myco install: the installer failed (exit $LASTEXITCODE)" }
