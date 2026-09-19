# RestorePhoneNicIp.ps1   (helper for the .bat next to it)
#
# Restore the static IP on the USB NIC that connects to the HT801 phone gateway.
#
# Why this script exists:
#   The ASIX USB NIC got re-enumerated (its Windows name changed from "Ethernet 2"
#   to "Ethernet"), and the static IP 172.50.1.2/24 was lost with it. The NIC fell
#   back to an APIPA address (169.254.x.x), so it can no longer reach the gateway
#   at 172.50.1.103 -- the phone link is completely down.
#   Setting an IP requires administrator rights, so this must run elevated.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less UTF-8 as
#       GBK, and any non-ASCII byte can break parsing (this project got bitten by
#       that three times already).

$ErrorActionPreference = 'Stop'

$TargetIp = '172.50.1.2'
$PrefixLength = 24
$GatewayIp = '172.50.1.103'

function Fail($msg) {
    Write-Host ""
    Write-Host "FAILED: $msg" -ForegroundColor Red
    exit 1
}

# --- must be elevated ---------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Fail "not running as administrator. Right-click the .bat file and choose 'Run as administrator'."
}

Write-Host "=== Restore phone NIC IP ===" -ForegroundColor Cyan
Write-Host ""

# --- locate the USB NIC (ASIX). The Realtek 2.5G adapter is the internet NIC. ---
$nic = Get-NetAdapter | Where-Object {
    $_.InterfaceDescription -like '*ASIX*' -or $_.InterfaceDescription -like '*USB*Ethernet*'
} | Select-Object -First 1

if (-not $nic) {
    Write-Host "Adapters currently present:" -ForegroundColor Yellow
    Get-NetAdapter | ForEach-Object { Write-Host ("  {0}  [{1}]  {2}" -f $_.Name, $_.InterfaceDescription, $_.Status) }
    Fail "could not find the ASIX USB Ethernet adapter. Is it plugged in?"
}

Write-Host ("Adapter : {0}  [{1}]" -f $nic.Name, $nic.InterfaceDescription)
Write-Host ("Status  : {0}   Link: {1}" -f $nic.Status, $nic.LinkSpeed)
Write-Host ("Index   : {0}" -f $nic.ifIndex)
Write-Host ""

if ($nic.Status -ne 'Up') {
    Fail "the adapter has no link. Check that the cable to the phone gateway is plugged in and the gateway is powered on."
}

# --- drop whatever address it has now (usually an APIPA 169.254.x.x) ----------
$existing = Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
foreach ($a in $existing) {
    if ($a.IPAddress -eq $TargetIp) { continue }
    Write-Host ("Removing current address {0}" -f $a.IPAddress)
    Remove-NetIPAddress -InterfaceIndex $nic.ifIndex -IPAddress $a.IPAddress -Confirm:$false -ErrorAction SilentlyContinue
}

# --- disable DHCP, then apply the static address ------------------------------
Write-Host "Disabling DHCP on this adapter..."
Set-NetIPInterface -InterfaceIndex $nic.ifIndex -Dhcp Disabled -ErrorAction SilentlyContinue

$already = Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -eq $TargetIp }

if ($already) {
    Write-Host ("Address {0} already present, leaving it as is." -f $TargetIp)
} else {
    Write-Host ("Adding {0}/{1} ..." -f $TargetIp, $PrefixLength)
    New-NetIPAddress -InterfaceIndex $nic.ifIndex -IPAddress $TargetIp -PrefixLength $PrefixLength -ErrorAction Stop | Out-Null
}

Write-Host ""
Write-Host "=== Result ===" -ForegroundColor Cyan
Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 |
    Select-Object IPAddress, PrefixLength, PrefixOrigin | Format-Table -AutoSize

# --- verify the gateway is reachable ------------------------------------------
Write-Host ("Pinging gateway {0} ..." -f $GatewayIp)
$ok = Test-Connection -ComputerName $GatewayIp -Count 2 -Quiet
if ($ok) {
    Write-Host ("OK: gateway {0} is reachable." -f $GatewayIp) -ForegroundColor Green
    Write-Host "Now restart the phone service so it picks up this address."
    exit 0
}

Write-Host ("WARNING: {0} still does not answer ping." -f $GatewayIp) -ForegroundColor Yellow
Write-Host "  - Check the gateway is powered on and its LAN cable goes to THIS adapter."
Write-Host "  - The gateway may have a different IP now; check its web UI or reset it."
Write-Host "  - The address is configured correctly on our side, which is the main thing."
exit 2
