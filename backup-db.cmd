@echo off
REM Plannr DB backup for Windows Task Scheduler. Point the scheduled task HERE (not at node directly)
REM so the backup always runs from the PROJECT ROOT (node_modules + the default PLANNR_DB resolve).
REM VACUUM INTO writes a consistent snapshot to %USERPROFILE%\PlannrBackups (keeps the newest 14) and
REM this appends its output to a log kept alongside the backups (OUTSIDE the project, so *.log ignore
REM rules and log rotation never touch it). %~dp0 is this file's folder (the project root).
cd /d "%~dp0"
if not exist "%USERPROFILE%\PlannrBackups" mkdir "%USERPROFILE%\PlannrBackups"
node backup-db.js >> "%USERPROFILE%\PlannrBackups\backup.log" 2>&1
