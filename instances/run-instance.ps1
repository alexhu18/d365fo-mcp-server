<#
.SYNOPSIS
    Start an MCP server instance.
.DESCRIPTION
    Wrapper around: d365fo-mcp start [name]

    Lists the instances and lets you pick one when the name is omitted.
.EXAMPLE
    .\instances\run-instance.ps1 clientA
#>
param(
    [string]$InstanceName
)

. (Join-Path $PSScriptRoot '_cli.ps1')

$cliArgs = @('start')
if ($InstanceName) { $cliArgs += $InstanceName }

Invoke-D365foMcp @cliArgs
