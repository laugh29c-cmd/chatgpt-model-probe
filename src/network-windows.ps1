$ErrorActionPreference = 'Stop'
function Get-Fingerprint($Value) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([string](ConvertTo-Json -InputObject $Value -Compress -Depth 6))))).Replace('-', '').Substring(0, 16).ToLowerInvariant() }
  finally { $hash.Dispose() }
}
$adapters = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object OperationalStatus -eq 'Up' | Sort-Object Id | ForEach-Object {
  $info = $_.GetIPProperties()
  [PSCustomObject]@{
    adapter_id=(Get-Fingerprint $_.Id)
    type=[string]$_.NetworkInterfaceType
    speed_bps=$_.Speed
    gateway_id=(Get-Fingerprint @($info.GatewayAddresses | ForEach-Object { $_.Address.ToString() }))
    dns_id=(Get-Fingerprint @($info.DnsAddresses | ForEach-Object { $_.ToString() }))
    ipv4_available=($_.Supports([Net.NetworkInformation.NetworkInterfaceComponent]::IPv4))
    ipv6_available=($_.Supports([Net.NetworkInformation.NetworkInterfaceComponent]::IPv6))
  }
})
$proxy = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$routeText = & "$env:SystemRoot\System32\route.exe" print
[PSCustomObject]@{status='observed';platform='win32';adapters=$adapters;route_snapshot_id=(Get-Fingerprint $routeText);system_proxy_enabled=($proxy.ProxyEnable -eq 1);system_proxy_id=(Get-Fingerprint @($proxy.ProxyServer,$proxy.AutoConfigURL));selected_physical_path='NOT_VERIFIED';effective_egress='NOT_OBSERVED'} | ConvertTo-Json -Compress -Depth 8
