<#
.SYNOPSIS
    Invoke the d365fo-mcp management CLI.
.DESCRIPTION
    Shared by the wrapper scripts in this folder. The CLI is the single
    implementation of instance management (it also writes the JSON
    configuration these scripts used to hand-edit as .env); the .ps1 files
    remain only so existing muscle memory and documentation keep working.

    Runs the built CLI when dist/ is present, otherwise the TypeScript source
    through tsx.
#>
function Invoke-D365foMcp {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)

    $repoRoot = Split-Path $PSScriptRoot -Parent
    $dist = Join-Path $repoRoot 'dist\cli\index.js'

    if (Test-Path $dist) {
        & node $dist @CliArgs
    } else {
        & npx tsx (Join-Path $repoRoot 'src\cli\index.ts') @CliArgs
    }
    exit $LASTEXITCODE
}
