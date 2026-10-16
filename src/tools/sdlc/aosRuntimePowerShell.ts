/** A constant program: inputs are JSON stdin, never PowerShell source interpolation. */
export const AOS_RUNTIME_POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AosCommandLine {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string line, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int info, out int value, int size, out int returned);
  public static void AssertControl(int pid, bool currentAdmin) {
    var process = OpenProcess(0x1001, false, pid); // QUERY_LIMITED_INFORMATION | TERMINATE; preflight only
    if (process == IntPtr.Zero) throw new Exception("No permission to control the selected IIS Express process");
    try {
      IntPtr token;
      if (!OpenProcessToken(process, 8, out token)) throw new Exception("Cannot verify process elevation");
      try { int value, returned; if (!GetTokenInformation(token, 20, out value, 4, out returned)) throw new Exception("Cannot read process elevation");
        if (value != 0 && !currentAdmin) throw new Exception("Cannot relaunch elevated IIS Express from a non-elevated account session"); }
      finally { CloseHandle(token); }
    } finally { CloseHandle(process); }
  }
  public static string[] Parse(string line) {
    int count; var ptr = CommandLineToArgvW(line, out count);
    if (ptr == IntPtr.Zero) throw new Exception("Cannot parse process command line");
    try { var args = new string[count]; for (int i=0; i<count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(ptr, i*IntPtr.Size)); return args; }
    finally { LocalFree(ptr); }
  }
}
'@
function Read-ConfigRoots([string]$configPath) {
  $settings = New-Object System.Xml.XmlReaderSettings
  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $reader = [System.Xml.XmlReader]::Create($configPath, $settings)
  try { $xml = New-Object System.Xml.XmlDocument; $xml.XmlResolver = $null; $xml.Load($reader) } finally { $reader.Dispose() }
  $hash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
  foreach ($site in $xml.SelectNodes('/configuration/system.applicationHost/sites/site')) {
    foreach ($app in $site.SelectNodes('application')) {
      if ($app.GetAttribute('path') -ne '/') { continue }
      $pool = $app.GetAttribute('applicationPool')
      if (!$pool) { $defaults = $site.SelectSingleNode('applicationDefaults'); if ($defaults) { $pool = $defaults.GetAttribute('applicationPool') } }
      if (!$pool) { $defaults = $xml.SelectSingleNode('/configuration/system.applicationHost/sites/applicationDefaults'); if ($defaults) { $pool = $defaults.GetAttribute('applicationPool') } }
      foreach ($binding in $site.SelectNodes('bindings/binding')) {
        [pscustomobject]@{ siteName=$site.GetAttribute('name'); siteId=$site.GetAttribute('id'); pool=$pool; applicationPath='/'; configPath=$configPath; configHash=$hash;
          binding=@{ protocol=$binding.GetAttribute('protocol'); information=$binding.GetAttribute('bindingInformation') } }
      }
    }
  }
}
function Get-Workers([string]$pool) {
  @(Get-CimInstance -Namespace root\WebAdministration -ClassName WorkerProcess | Where-Object { $_.AppPoolName -eq $pool } | ForEach-Object { [int]$_.ProcessId })
}
function Get-Inventory([string]$url) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $admin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $local = @('127.0.0.1', '::1') + @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object { $_.GetIPProperties().UnicastAddresses | ForEach-Object { $_.Address.ToString() } })
  $target = @([Net.Dns]::GetHostAddresses(([Uri]$url).DnsSafeHost) | ForEach-Object { $_.ToString() })
  $hosts = @(); $problems = @()
  foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='iisexpress.exe'")) {
    try {
      if (!$proc.CommandLine -or !$proc.ExecutablePath) { throw 'Process executable/command line not readable' }
      $argv = [AosCommandLine]::Parse($proc.CommandLine)
      $startupArgs = @($argv | Select-Object -Skip 1)
      $configArg = @($startupArgs | Where-Object { $_ -match '^/config:' })
      if ($configArg.Count -ne 1) { throw 'Explicit /config is required' }
      $configPath = $configArg[0].Substring(8)
      $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid
      if ($owner.ReturnValue -ne 0) { throw 'Cannot read process owner SID' }
      foreach ($root in @(Read-ConfigRoots $configPath)) {
        $poolArg = @($startupArgs | Where-Object { $_ -match '^/apppool:' })
        $siteArg = @($startupArgs | Where-Object { $_ -match '^/site:' })
        $idArg = @($startupArgs | Where-Object { $_ -match '^/siteid:' })
        if ($poolArg.Count -eq 1 -and $root.pool -ne $poolArg[0].Substring(9)) { continue }
        if ($siteArg.Count -eq 1 -and $root.siteName -ne $siteArg[0].Substring(6)) { continue }
        if ($idArg.Count -eq 1 -and $root.siteId -ne $idArg[0].Substring(8)) { continue }
        $root | Add-Member kind 'iis-express'
        $root | Add-Member pid ([int]$proc.ProcessId)
        $root | Add-Member creationTime ($proc.CreationDate.ToUniversalTime().ToString('o'))
        $root | Add-Member executablePath $proc.ExecutablePath
        $root | Add-Member commandLine $proc.CommandLine
        $root | Add-Member args $startupArgs
        $root | Add-Member ownerSid $owner.Sid
        $hosts += $root
      }
    } catch { $problems += "IIS Express PID $($proc.ProcessId): $($_.Exception.Message)" }
  }
  $iisConfig = Join-Path $env:windir 'System32\inetsrv\config\applicationHost.config'
  $iisService = Get-Service -Name W3SVC -ErrorAction SilentlyContinue
  if ($iisService -and $iisService.Status -eq 'Running' -and (Test-Path -LiteralPath $iisConfig)) {
    try {
      Import-Module WebAdministration
      foreach ($root in @(Read-ConfigRoots $iisConfig)) {
        if ($root.pool -ne 'AOSService') { continue }
        if ((Get-WebAppPoolState -Name $root.pool).Value -ne 'Started' -or (Get-Website -Name $root.siteName).State -ne 'Started') { continue }
        $root | Add-Member kind 'iis'
        $root | Add-Member workerPids @(Get-Workers $root.pool)
        $hosts += $root
      }
    } catch { $problems += "IIS discovery: $($_.Exception.Message)" }
  }
  @{ currentSid=$identity.User.Value; isAdmin=$admin; localAddresses=$local; targetAddresses=$target; hosts=$hosts; errors=$problems }
}
function Get-SameHost($request) {
  $inv = Get-Inventory $request.url
  if ($inv.errors.Count) { throw ('Discovery changed: ' + ($inv.errors -join '; ')) }
  if (!$inv.targetAddresses.Count -or @($inv.targetAddresses | Where-Object { $_ -notin $inv.localAddresses }).Count) { throw 'Target hostname is no longer exclusively local' }
  $uri = [Uri]$request.url
  $matches = @($inv.hosts | Where-Object {
    $binding = [regex]::Match($_.binding.information, '^(.*):(\d+):(.*)$')
    $binding.Success -and $_.applicationPath -eq '/' -and $_.binding.protocol -eq $uri.Scheme -and
      [int]$binding.Groups[2].Value -eq $uri.Port -and (!$binding.Groups[3].Value -or $binding.Groups[3].Value -eq $uri.DnsSafeHost) -and
      ($binding.Groups[1].Value -in @('*', '', '0.0.0.0', '[::]') -or $binding.Groups[1].Value -in $inv.targetAddresses)
  })
  if ($matches.Count -ne 1) { throw 'Runtime root became ambiguous before restart' }
  $h = $request.host
  $same = @($matches | Where-Object { $_.kind -eq $h.kind -and $_.siteName -eq $h.siteName -and $_.pool -eq $h.pool -and
    $_.binding.protocol -eq $h.binding.protocol -and $_.binding.information -eq $h.binding.information -and $_.configPath -eq $h.configPath -and $_.configHash -eq $h.configHash })
  if ($same.Count -ne 1) { throw 'Selected host/configuration changed before restart' }
  if ($h.kind -eq 'iis-express') {
    $live = $same[0]
    if ($live.pid -ne $h.pid -or $live.creationTime -ne $h.creationTime -or $live.commandLine -cne $h.commandLine -or $live.executablePath -ine $h.executablePath -or $live.ownerSid -ne $inv.currentSid) { throw 'Process identity or ownership changed before restart' }
    if (($live.args | ConvertTo-Json -Compress) -cne ($h.args | ConvertTo-Json -Compress)) { throw 'Startup arguments changed' }
    [AosCommandLine]::AssertControl([int]$live.pid, [bool]$inv.isAdmin)
    if (!(Test-Path -LiteralPath $live.executablePath -PathType Leaf)) { throw 'Original executable unavailable for relaunch' }
    $handle = [IO.File]::OpenRead($live.executablePath); $handle.Dispose()
  } elseif (!$inv.isAdmin -or $h.pool -ne 'AOSService') { throw 'Administrative AOSService preflight failed' }
  return $same[0]
}
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  switch ($request.action) {
    'discover' { $result = Get-Inventory $request.url }
    'restart' {
      $h = Get-SameHost $request
      if ($h.kind -eq 'iis-express') {
        # Arguments remain data; no cmd.exe, Invoke-Expression, or executable guessing.
        $quotedArgs = @($h.args | ForEach-Object { if ($_ -match '["\r\n]') { throw 'Unsafe argument quoting' }; '"' + $_ + '"' }) -join ' '
        $running = Get-Process -Id $h.pid -ErrorAction Stop
        Stop-Process -InputObject $running -ErrorAction Stop
        if (!$running.WaitForExit(15000)) { throw 'Old IIS Express process did not exit; replacement not started' }
        $replacement = Start-Process -FilePath $h.executablePath -ArgumentList $quotedArgs -WorkingDirectory ([IO.Path]::GetDirectoryName($h.executablePath)) -WindowStyle Hidden -PassThru
        $result = @{ restarted=$true; replacementPid=$replacement.Id }
      } else {
        Restart-WebAppPool -Name 'AOSService'
        $result = @{ restarted=$true }
      }
    }
    'verify' {
      $h = $request.host
      if ($h.kind -eq 'iis-express') {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$request.replacementPid)"
        if (!$proc) { $result = @{ verified=$false; message='Replacement IIS Express process exited' }; break }
        $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid
        $startupArgs = @([AosCommandLine]::Parse($proc.CommandLine) | Select-Object -Skip 1)
        $sameArgs = ($startupArgs | ConvertTo-Json -Compress) -ceq ($h.args | ConvertTo-Json -Compress)
        $old = Get-Process -Id $h.pid -ErrorAction SilentlyContinue
        $ok = !$old -and $proc.ExecutablePath -ieq $h.executablePath -and $owner.Sid -eq ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value -and $sameArgs
        $result = @{ verified=[bool]$ok; message='Replacement process identity/arguments/old PID check' }
      } else {
        Import-Module WebAdministration
        $workers = @(Get-Workers 'AOSService')
        $newWorkers = @($workers | Where-Object { $_ -notin @($h.workerPids) })
        $oldWorkers = @($workers | Where-Object { $_ -in @($h.workerPids) })
        $result = @{ verified=((Get-WebAppPoolState -Name 'AOSService').Value -eq 'Started' -and $newWorkers.Count -gt 0 -and $oldWorkers.Count -eq 0); message='AOSService pool and replacement worker check' }
      }
    }
    default { throw 'Unknown runtime operation' }
  }
  $result | ConvertTo-Json -Depth 12 -Compress
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
