<#
.SYNOPSIS
  Runs the checks from docs/PHONE-TEST-CHECKLIST.md that can be automated over adb, on one connected
  Android phone or emulator, and prints a pass/fail table.

.DESCRIPTION
  Drives Plannr through the screen only: adb "input" taps and keys, "uiautomator dump" to find what
  is on screen (the WebView exposes each HTML id as a resource-id), and "screencap" for evidence.
  Screenshots and a results file go to docs/phone-test-evidence/<date-time>/ (gitignored).

  Safety gates (the script stops before touching the app if any of them fails):
    - exactly one device (or the one named with -Serial), and it is authorised ("device", not
      "unauthorized" or "offline");
    - the device is not locked with a PIN, password or pattern. The script never enters or tries a
      credential; it only reads the lock state. It checks again before every step;
    - Plannr is NOT already installed, because an installed Plannr may hold real data. Pass
      -AllowExisting to run against an installed Plannr anyway. Then the script installs nothing,
      uninstalls nothing, and runs only the checks that change no ledger data.
  It never sends anything: when a share sheet opens, the only key it presses is BACK.
  Airplane mode is put back the way it was at the end, even after an error.

.PARAMETER AllowExisting
  Run against a Plannr that is already installed. Nothing is installed or uninstalled.
.PARAMETER Apk
  The debug APK to install when Plannr is not installed yet.
.PARAMETER Serial
  The adb serial of the device to use, when more than one is connected.
.PARAMETER SkipAirplane
  Do not switch airplane mode (skips check 4).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\phone-test.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\phone-test.ps1 -Serial emulator-5554 -AllowExisting
#>
[CmdletBinding()]
param(
  [switch]$AllowExisting,
  [string]$Apk,
  [string]$Serial,
  [switch]$SkipAirplane
)

$ErrorActionPreference = 'Stop'
# The repo root ($PSScriptRoot is empty inside param() defaults on Windows PowerShell 5.1).
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Apk) { $Apk = Join-Path $Root 'android\app\build\outputs\apk\debug\Plannr-debug.apk' }
$Pkg = 'com.plannr.app'
$Results = New-Object System.Collections.ArrayList
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Evidence = Join-Path $Root "docs\phone-test-evidence\$Stamp"
$ShotCount = 0

# ---------------------------------------------------------------------------------------------------
# adb helpers
# ---------------------------------------------------------------------------------------------------
function Find-Adb {
  $candidates = @()
  foreach ($root in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))) {
    if ($root) { $candidates += (Join-Path $root 'platform-tools\adb.exe') }
  }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $onPath = Get-Command adb -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  throw 'adb not found. Install the Android SDK platform-tools, or set ANDROID_HOME.'
}
$AdbExe = Find-Adb

# Runs adb and returns its output (stdout and stderr) as one string. Never throws on adb's stderr.
function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AdbArgs)
  $all = @()
  if ($script:Serial) { $all += @('-s', $script:Serial) }
  $all += $AdbArgs
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $script:AdbExe @all 2>&1 | ForEach-Object { "$_" } }
  finally { $ErrorActionPreference = $old }
  return (($out -join "`n") -replace "`r", '').Trim()
}
function Invoke-Shell([string]$Command) { return Invoke-Adb shell $Command }

function Add-Result([string]$Check, [string]$Name, [string]$Result, [string]$Notes) {
  [void]$script:Results.Add([pscustomobject]@{ Check = $Check; Name = $Name; Result = $Result; Notes = $Notes })
  $color = switch ($Result) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'Yellow' } }
  Write-Host ("  {0,-6} {1} {2}" -f $Result, $Check, $Name) -ForegroundColor $color
  if ($Notes) { Write-Host "         $Notes" }
}

function Save-Screenshot([string]$Name) {
  $script:ShotCount++
  $file = Join-Path $script:Evidence ('{0:D2}-{1}.png' -f $script:ShotCount, $Name)
  # screencap to a fixed file on the device (overwritten each time), then pull it: a pipe would mangle the bytes.
  [void](Invoke-Shell 'screencap -p /sdcard/plannr-phone-test.png')
  [void](Invoke-Adb pull /sdcard/plannr-phone-test.png $file)
  return (Split-Path $file -Leaf)
}

# ---------------------------------------------------------------------------------------------------
# Screen helpers (uiautomator)
# ---------------------------------------------------------------------------------------------------
function Get-Screen {
  [void](Invoke-Shell 'uiautomator dump /sdcard/plannr-phone-test.xml')
  $raw = Invoke-Adb exec-out 'cat /sdcard/plannr-phone-test.xml'
  $start = $raw.IndexOf('<?xml')
  if ($start -lt 0) { return $null }
  try { return [xml]$raw.Substring($start) } catch { return $null }
}
function Get-ScreenText($doc) {
  if (-not $doc) { return '' }
  return (($doc.SelectNodes('//node') | ForEach-Object { $_.GetAttribute('text') } | Where-Object { $_ }) -join "`n")
}
# A node whose resource-id is $Id, or whose text is $Text (case-insensitive, exact).
function Find-Node($doc, [string]$Id, [string]$Text) {
  if (-not $doc) { return $null }
  foreach ($n in $doc.SelectNodes('//node')) {
    if ($Id -and $n.GetAttribute('resource-id') -eq $Id) { return $n }
    if ($Text -and $n.GetAttribute('text').Trim() -ieq $Text) { return $n }
  }
  return $null
}
function Get-Center($node) {
  if ($node.GetAttribute('bounds') -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
    return @([int](([int]$matches[1] + [int]$matches[3]) / 2), [int](([int]$matches[2] + [int]$matches[4]) / 2))
  }
  return $null
}
$ScreenSize = @(1080, 2400)
if ((Invoke-Shell 'wm size') -match '(\d+)x(\d+)\s*$') { $ScreenSize = @([int]$matches[1], [int]$matches[2]) }

# Waits until the element is on screen (scrolling down if needed), then taps it. Returns $true if tapped.
function Invoke-Tap([string]$Id, [string]$Text, [int]$TimeoutSec = 20) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $scrolls = 0
  while ((Get-Date) -lt $deadline) {
    $doc = Get-Screen
    $node = Find-Node $doc $Id $Text
    if ($node) {
      $c = Get-Center $node
      if ($c -and $c[1] -gt 150 -and $c[1] -lt ($script:ScreenSize[1] - 150)) {
        [void](Invoke-Shell "input tap $($c[0]) $($c[1])")
        return $true
      }
      if ($c -and $scrolls -lt 8) {
        $x = [int]($script:ScreenSize[0] / 2)
        if ($c[1] -ge ($script:ScreenSize[1] - 150)) { [void](Invoke-Shell "input swipe $x $([int]($script:ScreenSize[1] * 0.75)) $x $([int]($script:ScreenSize[1] * 0.35)) 300") }
        else { [void](Invoke-Shell "input swipe $x $([int]($script:ScreenSize[1] * 0.35)) $x $([int]($script:ScreenSize[1] * 0.75)) 300") }
        $scrolls++
        continue
      }
    }
    Start-Sleep -Milliseconds 700
  }
  return $false
}
function Wait-ForScreen([scriptblock]$Test, [int]$TimeoutSec = 20) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $doc = Get-Screen
    if ($doc -and (& $Test $doc)) { return $doc }
    Start-Sleep -Milliseconds 700
  }
  return $null
}

function Get-TopActivity { return (Invoke-Shell "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity' | head -1") }
function Test-ShareSheet { return ((Get-TopActivity) -match 'Chooser|Resolver|intentresolver') }
function Wait-ShareSheet([int]$TimeoutSec = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) { if (Test-ShareSheet) { return $true }; Start-Sleep -Milliseconds 500 }
  return $false
}
# Closes a share sheet with BACK only, never a tap inside it. $true once Plannr is on top again.
function Close-ShareSheet {
  for ($i = 0; $i -lt 3; $i++) {
    if (-not (Test-ShareSheet)) { return $true }
    [void](Invoke-Shell 'input keyevent 4')
    Start-Sleep -Milliseconds 1500
  }
  return (-not (Test-ShareSheet))
}

function Start-Plannr {
  [void](Invoke-Shell "am force-stop $Pkg")
  [void](Invoke-Shell "monkey -p $Pkg -c android.intent.category.LAUNCHER 1")
  return (Wait-ForScreen { param($d) [bool](Find-Node $d 'notifAddBtn' $null) -or [bool](Find-Node $d $null 'Sections') } 30)
}
function Open-Section([string]$SectionText, [string]$ReadyId) {
  $homeScreen = Start-Plannr
  if (-not $homeScreen) { return $null }
  if (-not (Invoke-Tap -Text $SectionText)) { return $null }
  return (Wait-ForScreen { param($d) [bool](Find-Node $d $ReadyId $null) } 30)
}

# ---------------------------------------------------------------------------------------------------
# Safety gates
# ---------------------------------------------------------------------------------------------------
function Stop-Run([string]$Why) {
  Write-Host ''
  Write-Host "STOPPED: $Why" -ForegroundColor Red
  exit 2
}

function Assert-Device {
  # "<serial><TAB><state>" lines only: skips the header and "* daemon started" notices.
  $lines = (Invoke-Adb devices) -split "`n" | Where-Object { $_ -match '^\S+\t\S+' }
  $devs = @($lines | ForEach-Object { $p = $_ -split '\s+'; [pscustomobject]@{ Serial = $p[0]; State = $p[1] } })
  if ($script:Serial) { $devs = @($devs | Where-Object { $_.Serial -eq $script:Serial }) }
  if ($devs.Count -eq 0) { Stop-Run 'no device found. Connect the phone with USB debugging on, or start the emulator.' }
  if ($devs.Count -gt 1) { Stop-Run ("more than one device: {0}. Choose one with -Serial." -f (($devs | ForEach-Object { $_.Serial }) -join ', ')) }
  $d = $devs[0]
  if ($d.State -eq 'unauthorized') { Stop-Run "$($d.Serial) is unauthorized. Unlock the phone and accept the 'Allow USB debugging?' prompt, then run again." }
  if ($d.State -ne 'device') { Stop-Run "$($d.Serial) is '$($d.State)', not ready." }
  $script:Serial = $d.Serial
  return $d.Serial
}

# Reads the lock state only. Never enters, tries or verifies a credential.
function Assert-Unlocked {
  $cred = 'UNKNOWN'
  if ((Invoke-Shell "dumpsys lock_settings | grep -m1 CredentialType") -match 'CredentialType:\s*(\w+)') { $cred = $matches[1].ToUpper() }
  $locked = (Invoke-Shell "dumpsys trust | grep -m1 deviceLocked") -match 'deviceLocked=1'
  $keyguard = (Invoke-Shell "dumpsys window | grep -m1 isKeyguardShowing") -match 'isKeyguardShowing=true'
  if (($locked -or $keyguard) -and $cred -ne 'NONE') {
    Stop-Run "the device is locked with a $($cred.ToLower()) (or the lock type cannot be read). Unlock it yourself and run again; the script never enters a PIN."
  }
  if ($keyguard) {
    # A swipe-only lock screen (no PIN): wake the screen and dismiss it.
    [void](Invoke-Shell 'input keyevent 224')
    [void](Invoke-Shell 'wm dismiss-keyguard')
    Start-Sleep -Seconds 1
  }
  if ((Invoke-Shell "dumpsys power | grep -m1 mWakefulness=") -notmatch 'Awake') { [void](Invoke-Shell 'input keyevent 224'); Start-Sleep -Seconds 1 }
  return $cred
}

# ---------------------------------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------------------------------
Write-Host "Plannr phone test - $Stamp"
$serialUsed = Assert-Device
$credType = Assert-Unlocked
Write-Host "  device: $serialUsed (lock: $credType)"

$installed = (Invoke-Shell "pm list packages $Pkg") -match "package:$([regex]::Escape($Pkg))$"
if ($installed -and -not $AllowExisting) {
  Stop-Run "Plannr is already installed on $serialUsed and may hold real data. Nothing was changed. Export your backups first; then run with -AllowExisting to test the installed app (it installs and uninstalls nothing), or use a device without Plannr."
}
New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
if (-not $installed) {
  if (-not (Test-Path $Apk)) { Stop-Run "APK not found: $Apk. Build it first (docs/PHONE-TEST-CHECKLIST.md)." }
  Write-Host "  installing $Apk"
  $out = Invoke-Adb install $Apk
  if ($out -notmatch 'Success') { Stop-Run "install failed: $out" }
}

$airplaneBefore = Invoke-Shell 'settings get global airplane_mode_on'
try {
  # ---- 0. Phone details ---------------------------------------------------------------------------
  $model = Invoke-Shell 'getprop ro.product.model'
  $release = Invoke-Shell 'getprop ro.build.version.release'
  $sdk = Invoke-Shell 'getprop ro.build.version.sdk'
  $wv = ''
  if ((Invoke-Shell "dumpsys package com.google.android.webview | grep -m1 versionName") -match 'versionName=(\S+)') { $wv = $matches[1] }
  $appVer = ''
  if ((Invoke-Shell "dumpsys package $Pkg | grep -m1 versionName") -match 'versionName=(\S+)') { $appVer = $matches[1] }
  Add-Result '0' 'Phone details' 'INFO' "$model, Android $release (API $sdk), WebView $wv, Plannr $appVer"

  # ---- 1. Where the data lives (debug builds only: run-as) ----------------------------------------
  [void](Assert-Unlocked)
  $homeScreen = Start-Plannr
  Start-Sleep -Seconds 2
  $ls = Invoke-Shell "run-as $Pkg ls 'app_webview/Default/Local Storage/leveldb'"
  if ($ls -match 'not debuggable|unknown package|run-as:') {
    Add-Result '1' 'Data location and sizes' 'SKIP' 'run-as works only with a debug build'
  } else {
    $du = (Invoke-Shell "run-as $Pkg du -sk app_webview 'app_webview/Default/Local Storage' files") -replace "`n", '; '
    $ok = $ls -match '\.ldb|\.log|MANIFEST'
    Add-Result '1' 'Data location and sizes' ($(if ($ok) { 'PASS' } else { 'FAIL' })) "Local Storage/leveldb: $($ls -replace "`n", ' '); KB: $du"
  }
  $shot = Save-Screenshot 'home'

  # ---- 2. Storage meter ---------------------------------------------------------------------------
  [void](Assert-Unlocked)
  $doc = Open-Section 'DATA BACKUP' 'storageText'
  $doc = Wait-ForScreen { param($d) $n = Find-Node $d 'storageText' $null; $n -and ($n.GetAttribute('text') -notmatch 'Checking') } 20
  $meter = ''
  if ($doc) { $n = Find-Node $doc 'storageText' $null; if ($n) { $meter = $n.GetAttribute('text') } }
  $shot = Save-Screenshot 'data-backup-meter'
  Add-Result '2' 'Storage meter shown' ($(if ($meter -match 'Used .* of about .*MB') { 'PASS' } else { 'FAIL' })) "'$meter' ($shot)"
  Add-Result '2' 'Real localStorage limit' 'MANUAL' 'needs chrome://inspect and the console probe in the checklist'

  # ---- 3. JSON backup export: the share sheet opens, the file is written ---------------------------
  [void](Assert-Unlocked)
  $tapped = Invoke-Tap -Id 'downloadJsonBtn'
  $sheet = $tapped -and (Wait-ShareSheet 30)
  $shot = ''
  if ($sheet) { $shot = Save-Screenshot 'json-backup-share-sheet' }
  $closed = Close-ShareSheet
  $file = Invoke-Shell "run-as $Pkg ls cache"
  $hasFile = $file -match 'plannr-backup-.*\.json'
  $res = 'FAIL'; if ($sheet -and $closed -and ($hasFile -or $file -match 'run-as:')) { $res = 'PASS' }
  Add-Result '3' 'JSON backup opens the share sheet (closed with BACK)' $res "sheet=$sheet closedWithBack=$closed fileInCache=$hasFile $shot"
  Add-Result '3' 'Encrypted backup; restores' 'MANUAL' 'passphrase entry and file picking are done by hand (checklist check 3)'

  # ---- 4. Airplane mode: the app opens and the PDF share sheet opens offline ------------------------
  if ($SkipAirplane) {
    Add-Result '4' 'Airplane mode' 'SKIP' '-SkipAirplane'
  } else {
    [void](Assert-Unlocked)
    [void](Invoke-Shell 'cmd connectivity airplane-mode enable')
    Start-Sleep -Seconds 3
    $air = Invoke-Shell 'settings get global airplane_mode_on'
    if ($air -ne '1') {
      Add-Result '4' 'Airplane mode' 'SKIP' "could not switch airplane mode over adb on this device (airplane_mode_on=$air); do check 4 by hand"
    } else {
      $homeScreen = Start-Plannr
      $text = Get-ScreenText $homeScreen
      $okHome = [bool]$homeScreen -and ($text -notmatch '(?i)network error|could not|failed')
      $shot = Save-Screenshot 'offline-home'
      Add-Result '4' 'Home opens offline, no error' ($(if ($okHome) { 'PASS' } else { 'FAIL' })) $shot
      $doc = Open-Section 'OVERVIEW' 'ovPdfBtn'
      $sheet = $false
      if ($doc -and (Invoke-Tap -Id 'ovPdfBtn')) {
        [void](Invoke-Tap -Text 'Light' -TimeoutSec 10)
        $sheet = Wait-ShareSheet 40
      }
      if ($sheet) { $shot = Save-Screenshot 'offline-pdf-share-sheet' } else { $shot = Save-Screenshot 'offline-pdf-no-sheet' }
      $closed = Close-ShareSheet
      Add-Result '4' 'PDF export opens the share sheet offline' ($(if ($sheet -and $closed) { 'PASS' } else { 'FAIL' })) $shot
    }
    if ($airplaneBefore -ne '1') { [void](Invoke-Shell 'cmd connectivity airplane-mode disable') }
  }
  Add-Result '4' 'A reminder fires' 'MANUAL' 'set a time a few minutes ahead on Home, background the app, wait'

  # ---- 8. A share sheet left open 25 s, then closed --------------------------------------------------
  [void](Assert-Unlocked)
  $doc = Open-Section 'OVERVIEW' 'ovPdfBtn'
  $sheet = $false
  if ($doc -and (Invoke-Tap -Id 'ovPdfBtn')) {
    [void](Invoke-Tap -Text 'Light' -TimeoutSec 10)
    $sheet = Wait-ShareSheet 40
  }
  $stillOpen = $false
  if ($sheet) { Start-Sleep -Seconds 25; $stillOpen = Test-ShareSheet; $shot = Save-Screenshot 'share-sheet-after-25s' }
  $closed = Close-ShareSheet
  $after = Wait-ForScreen { param($d) (Get-ScreenText $d) -match 'not shared|share sheet was closed' } 10
  $afterText = Get-ScreenText $after
  $shot2 = Save-Screenshot 'after-closing-share-sheet'
  $ok = $sheet -and $stillOpen -and $closed -and ($afterText -match 'not shared') -and ($afterText -notmatch '(?i)timed out')
  $msg = ''; if ($afterText -match '(PDF not shared[^\n]*)') { $msg = $matches[1] }
  Add-Result '8' 'Share sheet open 25 s, closed: no timeout, says not shared' ($(if ($ok) { 'PASS' } else { 'FAIL' })) "open=$sheet after25s=$stillOpen closed=$closed '$msg' ($shot2)"
  Add-Result '8' 'PDF total row' 'MANUAL' 'open the exported PDF and look at the Total row (checklist check 8)'

  Add-Result '5' 'Update over the old version' 'MANUAL' 'needs the previous APK (checklist check 5)'
  Add-Result '6' 'Auto Backup' 'MANUAL' 'uninstalls the app; do it by hand with the data exported (checklist check 6)'
}
finally {
  $now = Invoke-Shell 'settings get global airplane_mode_on'
  if ($now -ne $airplaneBefore) {
    if ($airplaneBefore -eq '1') { [void](Invoke-Shell 'cmd connectivity airplane-mode enable') } else { [void](Invoke-Shell 'cmd connectivity airplane-mode disable') }
  }
}

# ---------------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------------
Write-Host ''
$Results | Format-Table -AutoSize -Wrap Check, Result, Name, Notes | Out-String -Width 220 | Write-Host
$fails = @($Results | Where-Object { $_.Result -eq 'FAIL' }).Count
$md = @("# Phone test $Stamp", '', "Device: $serialUsed", '', '| Check | Result | Name | Notes |', '|---|---|---|---|')
foreach ($r in $Results) { $md += "| $($r.Check) | $($r.Result) | $($r.Name) | $(($r.Notes -replace '\|', '/')) |" }
$md | Set-Content -Encoding utf8 -Path (Join-Path $Evidence 'results.md')
Write-Host "Evidence: $((Resolve-Path $Evidence).Path)"
if ($fails -gt 0) { Write-Host "$fails check(s) FAILED" -ForegroundColor Red; exit 1 }
Write-Host 'No automated check failed (MANUAL rows still need a person).' -ForegroundColor Green
exit 0
