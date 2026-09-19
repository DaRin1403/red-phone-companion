<#
.SYNOPSIS
  Inject a string into the DSH input box and (optionally) submit it.

.DESCRIPTION
  Why PowerShell + Win32: Node has no reliable way to locate and focus a specific
  window, while user32 gives us EnumWindows / SetForegroundWindow directly.

  Flow:
    1. enumerate top-level windows, pick the one whose title matches -TitleMatch
    2. if it is NOT already foreground, bring it forward
    3. make sure focus is on the PAGE (not browser chrome), else press ESC
    4. put the text on the clipboard and send Ctrl+V
    5. optionally send ENTER to submit
    6. restore the user's previous clipboard content

  IMPORTANT (learned the hard way):
    * This file MUST stay pure ASCII. Windows PowerShell 5.1 reads BOM-less .ps1
      files as ANSI (GBK on Chinese Windows), so any non-ASCII literal breaks
      parsing. Do not add Chinese comments or strings here.
    * Never write a hash-greater-than sequence inside a comment block; it ends
      the block early and the rest is parsed as code.
    * Do NOT tap Alt when the target window is already foreground: that moves
      focus to the browser chrome (Edge lands on its menu button) and the
      subsequent Ctrl+V goes to the UI instead of the page input box. That bug
      showed up as "script reports success but no text appears".

.EXAMPLE
  powershell -NoProfile -File inject-text.ps1 -ListWindows
  powershell -NoProfile -File inject-text.ps1 -Text "hello" -Submit
  powershell -NoProfile -File inject-text.ps1 -TextFile C:\tmp\t.txt -Submit

Exit codes: 0 ok | 1 bad args | 2 target window not found | 3 focus failed
#>
[CmdletBinding()]
param(
  [string]$Text = '',
  [string]$TextFile = '',
  [switch]$Submit,
  [switch]$DryRun,
  [switch]$ListWindows,
  [string]$TitleMatch = 'DeepSeek Harness|DSH|localhost:3080|127\.0\.0\.1:3080',
  [int]$FocusDelayMs = 250,
  [int]$PasteDelayMs = 200,
  [int]$SubmitDelayMs = 250,
  [int]$SubmitRetries = 3,
  [switch]$KeepClipboard
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

# -TextFile wins over -Text: the Node caller writes the text into a temp file
# and passes the path, so long text, quotes and newlines never hit PowerShell's
# argv quoting rules or the command line length limit.
if ($TextFile) {
  if (-not (Test-Path -LiteralPath $TextFile)) {
    Write-Error "TextFile not found: $TextFile"
    exit 1
  }
  $resolved = (Resolve-Path -LiteralPath $TextFile).Path
  $Text = [System.IO.File]::ReadAllText($resolved, [System.Text.Encoding]::UTF8)
}

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Win {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public const int SW_RESTORE = 9;
  public const byte VK_MENU = 0x12;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  public class WinInfo {
    public IntPtr Handle;
    public string Title = "";
    public uint Pid;
    public string Process = "";
  }

  public static List<WinInfo> ListVisible() {
    var list = new List<WinInfo>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      string pname = "";
      try { pname = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
      list.Add(new WinInfo { Handle = h, Title = sb.ToString(), Pid = pid, Process = pname });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool IsForeground(IntPtr h) {
    return GetForegroundWindow() == h;
  }

  // Only touch focus when the window is NOT already foreground.
  // Tapping Alt while already foreground steals focus to the chrome.
  public static bool Focus(IntPtr h) {
    if (IsForeground(h)) return true;
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    bool ok = SetForegroundWindow(h);
    BringWindowToTop(h);
    return ok || IsForeground(h);
  }
}
"@

if ($ListWindows) {
  Write-Output "=== visible top-level windows ==="
  foreach ($w in [Win]::ListVisible()) {
    $mark = if ($w.Title -match $TitleMatch) { ' <== candidate' } else { '' }
    Write-Output ("0x{0:X8}  {1,-24} {2}{3}" -f $w.Handle.ToInt64(), $w.Process, $w.Title, $mark)
  }
  exit 0
}

$targets = @([Win]::ListVisible() | Where-Object { $_.Title -match $TitleMatch })
if ($targets.Count -eq 0) {
  Write-Error "No window title matched '$TitleMatch'. Run with -ListWindows to see what is available."
  exit 2
}
$win = $targets | Sort-Object { $_.Title.Length } | Select-Object -First 1
Write-Output ("target: [{0}] {1} (0x{2:X8} pid={3})" -f $win.Process, $win.Title, $win.Handle.ToInt64(), $win.Pid)

if ($DryRun) {
  Write-Output "DryRun: window located, nothing injected."
  if ($Text) { Write-Output ("would inject {0} chars, submit={1}" -f $Text.Length, [bool]$Submit) }
  exit 0
}

if (-not $Text) {
  Write-Error "No text to inject (-Text was empty)."
  exit 1
}

if ([Win]::IsForeground($win.Handle)) {
  Write-Output "window already foreground (no focus change)"
} else {
  Write-Output "window not foreground, bringing forward"
}
if (-not [Win]::Focus($win.Handle)) {
  Write-Error "Could not bring the target window to the foreground."
  exit 3
}
Start-Sleep -Milliseconds $FocusDelayMs

# Inspect where focus currently is. If it sits on browser chrome (menu button,
# address bar), a plain Ctrl+V goes to the UI and the text vanishes.
# Pressing ESC returns focus to the page content.
function Get-FocusedInfo {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $el) { return $null }
    return [PSCustomObject]@{
      Class = $el.Current.ClassName
      Type  = $el.Current.ControlType.ProgrammaticName
      Name  = $el.Current.Name
    }
  } catch { return $null }
}

# Read the focused edit control's text. Returns $null when it cannot be read
# (e.g. focus already left the input box, which itself implies a successful send).
function Get-InputValue {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $el) { return $null }
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp) { return $vp.Current.Value }
  } catch { }
  return $null
}

$focused = Get-FocusedInfo
if ($focused) {
  Write-Output ("focus before paste: class={0} type={1}" -f $focused.Class, $focused.Type)
  $onChrome = ($focused.Class -eq 'BrowserAppMenuButton') -or
              ($focused.Class -like 'Chrome*') -or
              ($focused.Type -like '*MenuBar*')
  if ($onChrome) {
    Write-Output "focus is on browser chrome -> send ESC to return focus to page"
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    Start-Sleep -Milliseconds 180
    $focused = Get-FocusedInfo
    if ($focused) { Write-Output ("focus after ESC: class={0} type={1}" -f $focused.Class, $focused.Type) }
  }
}

$old = $null
if (-not $KeepClipboard) {
  try { $old = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { $old = $null }
}
Set-Clipboard -Value $Text
Start-Sleep -Milliseconds 80

[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds $PasteDelayMs
Write-Output ("pasted {0} chars" -f $Text.Length)

$after = Get-FocusedInfo
if ($after) { Write-Output ("focus after paste: class={0} type={1}" -f $after.Class, $after.Type) }

# ---------------------------------------------------------------- 提交
# ---------------------------------------------------------------- submit
# Observations that shaped this logic:
#   * Pressing ENTER exactly once is not reliable -- the text was seen staying
#     in the input box, never sent.
#   * Blindly retrying works, but the FIRST attempt then always fails, which
#     wastes ~700ms on every single send.
# So: wait until the input actually contains our text (the page may still be
# processing the paste), then press ENTER and verify the input cleared.
if ($Submit) {
  $sample = $Text.Trim()
  if ($sample.Length -gt 12) { $sample = $sample.Substring(0, 12) }

  # Phase 1: wait for the paste to become visible in the input.
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    $val = Get-InputValue
    if ($val -and $val.Contains($sample)) { $ready = $true; break }
    Start-Sleep -Milliseconds 50
  }
  if ($ready) { Write-Output "input confirmed to contain the text" }
  else { Write-Output "WARNING: could not confirm the text is in the input, sending anyway" }

  # Phase 2: press ENTER ONCE, then wait for the input to clear.
  # Why only once: hammering ENTER risks sending the message multiple times.
  # Observed behaviour: ENTER triggers the send, but the input box does not
  # clear instantly, so "pressing again because it still has text" would be
  # both wrong and dangerous. Wait and verify instead.
  Start-Sleep -Milliseconds $SubmitDelayMs
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Write-Output "pressed ENTER"

  $cleared = $false
  for ($i = 0; $i -lt 16; $i++) {           # up to ~1.6s
    Start-Sleep -Milliseconds 100
    $val = Get-InputValue
    if ($null -eq $val) { $cleared = $true; break }        # focus left the input
    if (-not $val.Contains($sample)) { $cleared = $true; break }
  }

  if ($cleared) {
    Write-Output "submit confirmed (input no longer holds the text)"
  } else {
    # Only now, after a real timeout, consider one more attempt.
    if ($SubmitRetries -gt 1) {
      Write-Output "input still holds the text after 1.6s, pressing ENTER once more"
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      Start-Sleep -Milliseconds 600
      $val = Get-InputValue
      if ($null -eq $val -or -not $val.Contains($sample)) {
        Write-Output "submit confirmed after second attempt"
      } else {
        Write-Output "WARNING: input still contains the text after two attempts"
      }
    } else {
      Write-Output "WARNING: input still contains the text after submitting"
    }
  }
}

if (-not $KeepClipboard -and $null -ne $old) {
  try { Set-Clipboard -Value $old } catch { }
}

exit 0
