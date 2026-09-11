@echo off
rem harness command wrapper (cmd.exe) - real logic lives in _log.mjs
node "%~dp0_log.mjs" --tool python3 -- %*
exit /b %ERRORLEVEL%
