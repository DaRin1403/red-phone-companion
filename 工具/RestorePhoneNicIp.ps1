# RestorePhoneNicIp.ps1
#
# Give the network adapter that connects to the phone gateway a static IP.
#
# WHY THIS EXISTS
#   The gateway (HT801/HT802) lives on its own little subnet, so the PC's adapter
#   facing it needs a static IP in that subnet. Windows loses that config whenever
#   the USB adapter is unplugged and re-enumerated: it comes back as a brand-new
#   device with DHCP enabled and an APIPA address (169.254.x.x), and the gateway
#   becomes unreachable.
#
# WHY IT DOES NOT MATCH BY CHIP MODEL
#   The first version looked for "ASIX" or "USB Ethernet" in the adapter name.
#   That breaks the moment you swap the dongle: a "Realtek Gaming USB 2.5GbE
#   Family Controller" matches neither, so the script reported "adapter not found"
#   even though the adapter was sitting right there.
#   This version identifies the adapter by BEHAVIOUR instead:
#     up + wired + not virtual + has no real IPv4 (only APIPA)  ->  that is the one.
#
# USAGE  (must run elevated - setting an IP requires administrator rights)
#   Right-click the .bat next to this file -> Run as administrator
#   or:  powershell -ExecutionPolicy Bypass -File RestorePhoneNicIp.ps1
#
#   Optional overrides:
#     -InterfaceIndex 19        pin the adapter explicitly
#     -LocalIp 172.50.1.2       use a specific address
#     -PrefixLength 24
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less UTF-8 as
#       GBK, and any non-ASCII byte can break parsing.

param(
    [int]$InterfaceIndex = 0,
    [string]$LocalIp = '',
    [int]$PrefixLength = 0,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- helpers

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Fail($msg) {
    Write-Host ""
    Write-Host "FAILED: $msg" -ForegroundColor Red
    exit 1
}

# Adapters that are never the phone link, no matter what.
$VIRTUAL_RE = 'bluetooth|tailscale|hyper-v|vethernet|vmware|virtualbox|loopback|wan miniport|tunnel|npcap|wintun|zerotier'
$WIRELESS_RE = 'wi-?fi|wireless|wlan|802\.11'

# ---------------------------------------------------------------- must be elevated
# (DryRun is allowed without elevation: it only looks and reports, applies nothing.)

if (-not $DryRun) {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Fail "not running as administrator. Right-click the .bat file and choose 'Run as administrator'. (Use -DryRun to preview without elevation.)"
    }
}

Say "=== Restore phone NIC static IP ===" Cyan
if ($DryRun) { Say "*** DRY RUN - nothing will be changed ***" Yellow }
Say ""

# ---------------------------------------------------------------- read project config (for the gateway address)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$gateway = ''

# Find phone.config.json without putting any non-ASCII character in THIS FILE.
# The project keeps its code in a Chinese-named folder ("source" / "phone-companion"),
# and the moment those characters appear as literals here, Windows PowerShell 5.1
# reads this BOM-less UTF-8 file as GBK, they turn to mush, and the lookup quietly
# fails -> "no gateway found". A wildcard matches the folder just as well and keeps
# this file pure ASCII. (Yes, even the comment you are reading had to avoid them.)
$cfgPatterns = @(
    (Join-Path $here 'phone.config.json'),
    (Join-Path $here '..\*\phone-companion\phone.config.json'),
    (Join-Path $here '..\*\*\phone-companion\phone.config.json')
)
$cfgPath = $null
foreach ($pattern in $cfgPatterns) {
    $hit = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $cfgPath = $hit.FullName; break }
}

if ($cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.ataAddress) {
            $gateway = $cfg.ataAddress
            Say "gateway (from phone.config.json): $gateway"
        }
    } catch {
        Say "found $cfgPath but could not parse it: $($_.Exception.Message)" Yellow
    }
}

if (-not $LocalIp) {
    if ($gateway -match '^(\d+)\.(\d+)\.(\d+)\.') {
        $LocalIp = "$($Matches[1]).$($Matches[2]).$($Matches[3]).2"
    } else {
        $LocalIp = '172.50.1.2'
        Say "no gateway found in config; falling back to $LocalIp" Yellow
    }
}
if ($PrefixLength -le 0) { $PrefixLength = 24 }

Say "target address: $LocalIp/$PrefixLength"
Say ""

# ---------------------------------------------------------------- pick the adapter

function Get-V4($ifIndex) {
    @(Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue)
}

$chosen = $null
$why = ''

if ($InterfaceIndex -gt 0) {
    $chosen = Get-NetAdapter -InterfaceIndex $InterfaceIndex -ErrorAction SilentlyContinue
    if (-not $chosen) { Fail "no adapter with interface index $InterfaceIndex" }
    $why = "you pinned interface index $InterfaceIndex"
}

# (1) an adapter that ALREADY has an address in the gateway's subnet -> nothing to do
if (-not $chosen -and $gateway -match '^(\d+\.\d+\.\d+)\.') {
    $subnet = $Matches[1]
    foreach ($nic in Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }) {
        foreach ($ip in Get-V4 $nic.ifIndex) {
            if ($ip.IPAddress -like "$subnet.*") {
                Say "adapter '$($nic.Name)' already has $($ip.IPAddress) in the gateway subnet." Green
                Say "Nothing to configure. Checking the gateway..."
                $ok = Test-Connection -ComputerName $gateway -Count 2 -Quiet -ErrorAction SilentlyContinue
                if ($ok) { Say "OK: gateway $gateway is reachable." Green; exit 0 }
                Fail "gateway $gateway still does not answer ping, even though the address looks right."
            }
        }
    }
}

# (2) THE MAIN CASE: up + wired + not virtual + no real IPv4 (only APIPA or nothing)
if (-not $chosen) {
    $candidates = @()
    foreach ($nic in Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }) {
        $desc = "$($nic.InterfaceDescription) $($nic.Name)"
        if ($desc -match $VIRTUAL_RE) { continue }
        if ($desc -match $WIRELESS_RE) { continue }
        $ips = Get-V4 $nic.ifIndex
        $real = @($ips | Where-Object { $_.IPAddress -notlike '169.254.*' })
        if ($real.Count -gt 0) { continue }          # it already has a usable address
        $candidates += $nic
    }
    if ($candidates.Count -ge 1) {
        # If several, prefer a USB dongle over an onboard port
        $chosen = $candidates | Sort-Object @{ Expression = { if ($_.InterfaceDescription -match 'USB') { 0 } else { 1 } } } | Select-Object -First 1
        $why = "it is up, wired, not virtual, and currently has no usable IP (only APIPA)"
    }
}

# (3) last resort: any up wired adapter that is not the one carrying the default route
if (-not $chosen) {
    $defaultIf = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Sort-Object RouteMetric | Select-Object -First 1).ifIndex
    $chosen = Get-NetAdapter | Where-Object {
        $_.Status -eq 'Up' -and $_.ifIndex -ne $defaultIf -and
        $_.InterfaceDescription -notmatch $VIRTUAL_RE -and $_.InterfaceDescription -notmatch $WIRELESS_RE
    } | Select-Object -First 1
    if ($chosen) { $why = "it is the only other wired adapter besides the one used for internet" }
}

if (-not $chosen) {
    Say "Adapters currently present:" Yellow
    Get-NetAdapter | ForEach-Object { Say ("  [{0}] {1}  {2}  {3}" -f $_.ifIndex, $_.Name, $_.Status, $_.InterfaceDescription) }
    Fail "could not work out which adapter goes to the phone gateway. Plug the dongle in, or re-run with -InterfaceIndex <n> from the list above."
}

Say "ALL adapters (so you can check the pick):" DarkGray
Get-NetAdapter | Sort-Object ifIndex | ForEach-Object {
    $ips = (Get-V4 $_.ifIndex | ForEach-Object { $_.IPAddress }) -join ', '
    if (-not $ips) { $ips = '(no IPv4)' }
    $mark = if ($_.ifIndex -eq $chosen.ifIndex) { '  <== CHOSEN' } else { '' }
    Say ("  [{0,2}] {1,-14} {2,-12} {3,-10} {4}{5}" -f $_.ifIndex, $_.Name, $_.Status, $ips, $_.InterfaceDescription, $mark)
}
Say ""

Say ("adapter : {0}  [{1}]" -f $chosen.Name, $chosen.InterfaceDescription)
Say ("state   : {0}   link: {1}   mac: {2}" -f $chosen.Status, $chosen.LinkSpeed, $chosen.MacAddress)
Say ("index   : {0}" -f $chosen.ifIndex)
Say ("chosen  : {0}" -f $why)
Say ""

if ($chosen.Status -ne 'Up') {
    Fail "that adapter has no link. Check the cable to the gateway and that it is powered on."
}

if ($DryRun) {
    Say "=== DRY RUN: would apply this ===" Cyan
    Say ("  remove existing IPv4 on '{0}' and set {1}/{2}, DHCP off" -f $chosen.Name, $LocalIp, $PrefixLength)
    if ($gateway) { Say ("  then ping {0}" -f $gateway) }
    Say ""
    Say "Nothing was changed. Re-run without -DryRun (and elevated) to apply."
    exit 0
}

# ---------------------------------------------------------------- apply

foreach ($ip in (Get-V4 $chosen.ifIndex)) {
    if ($ip.IPAddress -eq $LocalIp) { continue }
    Say ("removing current address {0}" -f $ip.IPAddress)
    Remove-NetIPAddress -InterfaceIndex $chosen.ifIndex -IPAddress $ip.IPAddress -Confirm:$false -ErrorAction SilentlyContinue
}

Say "disabling DHCP on this adapter..."
Set-NetIPInterface -InterfaceIndex $chosen.ifIndex -Dhcp Disabled -ErrorAction SilentlyContinue

$already = Get-V4 $chosen.ifIndex | Where-Object { $_.IPAddress -eq $LocalIp }
if ($already) {
    Say ("address {0} already present" -f $LocalIp)
} else {
    Say ("adding {0}/{1} ..." -f $LocalIp, $PrefixLength)
    New-NetIPAddress -InterfaceIndex $chosen.ifIndex -IPAddress $LocalIp -PrefixLength $PrefixLength -ErrorAction Stop | Out-Null
}

Say ""
Say "=== result ===" Cyan
Get-V4 $chosen.ifIndex | Select-Object IPAddress, PrefixLength, PrefixOrigin | Format-Table -AutoSize | Out-String | Write-Host

# ---------------------------------------------------------------- verify

if (-not $gateway) {
    Say "no gateway address configured, skipping the ping check." Yellow
    exit 0
}

Say ("pinging gateway {0} ..." -f $gateway)
if (Test-Connection -ComputerName $gateway -Count 3 -Quiet -ErrorAction SilentlyContinue) {
    Say ("OK: gateway {0} is reachable." -f $gateway) Green
    Say ""
    Say "The phone service keeps advertising this same address, so it should"
    Say "reconnect on its own. If the phone still does not work, restart the service."
    exit 0
}

Say ("WARNING: {0} still does not answer ping." -f $gateway) Yellow
Say "  - Is the gateway powered on, and is its cable in THIS adapter?"
Say "  - Maybe the gateway moved to a different IP. Check its web UI."
Say "  - Our side is configured correctly, which is the main thing."
exit 2
