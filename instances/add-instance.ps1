<#
.SYNOPSIS
    Create a new MCP server instance.
.DESCRIPTION
    Wrapper around: d365fo-mcp instance add [name] [port]

    The CLI asks for the name, the port and the settings this instance needs
    (each question explains itself), writes instances\<name>\d365fo-mcp.json,
    and prints the .mcp.json block. Settings reference: docs\CONFIGURATION.md.
.EXAMPLE
    .\instances\add-instance.ps1 clientA 3001
#>
param(
    [string]$InstanceName,
    [int]$Port
)

. (Join-Path $PSScriptRoot '_cli.ps1')

$cliArgs = @('instance', 'add')
if ($InstanceName) { $cliArgs += $InstanceName }
if ($PSBoundParameters.ContainsKey('Port')) { $cliArgs += "$Port" }

Invoke-D365foMcp @cliArgs
