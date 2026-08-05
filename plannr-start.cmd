@echo off
REM Plannr auto-start launcher. Task Scheduler points HERE, not at node directly, so the server always
REM starts from the PROJECT ROOT regardless of the working directory the task inherits (Task Scheduler
REM defaults to C:\Windows\System32). process.loadEnvFile() resolves .env relative to the CWD, so this
REM `cd` is exactly what makes .env (GMAIL_USER / GMAIL_APP_PASSWORD) load ??? without it email fails with
REM a misleading "credentials are not configured". %~dp0 is this file's own folder (the project root).
cd /d "%~dp0"
REM Part B — rotate the startup log: keep the CURRENT run plus ONE previous (.1). Without this the file
REM appended on every single logon forever, so contact data (masked, but still) and boot noise piled up
REM unbounded in the project root. `move /Y` overwrites any existing .1, so at most two files ever exist.
if exist "%~dp0plannr-startup.log" move /Y "%~dp0plannr-startup.log" "%~dp0plannr-startup.log.1" >nul
node server.js >> "%~dp0plannr-startup.log" 2>&1
