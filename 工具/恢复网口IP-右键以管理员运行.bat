@echo off
title Restore phone NIC IP

echo ================================================
echo   Restore static IP for the red phone link
echo ================================================
echo.
echo Target : 172.50.1.2/24 on the USB network adapter
echo Gateway: 172.50.1.103  (Grandstream HT801)
echo.
echo NOTE: this file must stay pure ASCII and must NOT
echo       call chcp. Changing the code page in the
echo       middle of a .bat corrupts the rest of it.
echo.

if not exist "%~dp0RestorePhoneNicIp.ps1" (
  echo [FAILED] RestorePhoneNicIp.ps1 not found next to this file.
  echo Keep both files in the same folder.
  echo.
  pause
  exit /b 1
)

echo Running the helper script...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0RestorePhoneNicIp.ps1"
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo [OK] Address is in place. Tell the assistant so it can
  echo      restart the phone service and verify the link.
) else (
  echo [FAILED] exit code %RC% -- read the messages above.
  echo.
  echo If it says "not running as administrator", right-click
  echo this file and choose "Run as administrator".
)
echo.
pause
