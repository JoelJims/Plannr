@echo off
REM Graceful, console-independent stop for the windowless auto-started Plannr server. Creates the stop
REM sentinel the server polls for (see watchStopSentinel in server.js), which routes into shutdown() ???
REM WhatsApp + PDF Chromium closed, DB closed cleanly, complete snapshot taken if the session was ready.
REM Same path as Ctrl+C, but reachable without a console (Task Scheduler's plannr-start.cmd is
REM windowless, so a forced kill was the only alternative ??? which skips all of the above). Then waits
REM for the server to actually exit (port 3000 released). %~dp0 is this file's folder (the project root).
cd /d "%~dp0"
echo stop-requested> ".plannr-stop"
echo Stop signal sent. Waiting for Plannr to shut down gracefully...
set /a tries=0
:wait
ping -n 2 127.0.0.1 >nul
set /a tries+=1
netstat -ano | findstr ":3000 " | findstr LISTENING >nul 2>&1 || goto stopped
if %tries% lss 45 goto wait
echo Timed out after ~45s ??? the server may still be finishing; check the log.
goto end
:stopped
echo Plannr has stopped cleanly.
:end
