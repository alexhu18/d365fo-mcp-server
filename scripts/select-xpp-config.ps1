<#
.SYNOPSIS
    Pin the XPP config (UDE) used by the root server.
.DESCRIPTION
    Wrapper around: d365fo-mcp config --xpp-config

    Lists the configs in %LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig and
    writes the selected one to config\d365fo-mcp.json (environment.xppConfigName).
    Use -Instance to pin the config of an instance instead.
.EXAMPLE
    .\scripts\select-xpp-config.ps1
.EXAMPLE
    .\scripts\select-xpp-config.ps1 -Instance clientA
#>
param(
    [string]$Instance
)

. (Join-Path (Split-Path $PSScriptRoot -Parent) 'instances\_cli.ps1')

$cliArgs = @('config', '--xpp-config')
if ($Instance) { $cliArgs += @('--instance', $Instance) }

Invoke-D365foMcp @cliArgs
