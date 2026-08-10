<#
.SYNOPSIS
    Repoint an instance at a new XPP config and rebuild its databases.
.DESCRIPTION
    Wrapper around: d365fo-mcp instance upgrade [name]

    Use this after a UDE version upgrade (Microsoft drops a new XPPConfig file
    with a new FrameworkDirectory). Pick the instance, pick the new config; the
    CLI updates instances\<name>\d365fo-mcp.json and rebuilds the index.
.EXAMPLE
    .\instances\upgrade-instance.ps1 clientA
#>
param(
    [string]$InstanceName
)

. (Join-Path $PSScriptRoot '_cli.ps1')

$cliArgs = @('instance', 'upgrade')
if ($InstanceName) { $cliArgs += $InstanceName }

Invoke-D365foMcp @cliArgs
