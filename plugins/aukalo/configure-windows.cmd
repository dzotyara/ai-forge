@echo off
setlocal

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

rem Separate lines: inside a ( ) block %NODE_FROM_PATH% would expand before the loop sets it.
if not exist "%NODE_EXE%" for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_FROM_PATH set "NODE_FROM_PATH=%%N"
if not exist "%NODE_EXE%" if defined NODE_FROM_PATH set "NODE_EXE=%NODE_FROM_PATH%"

if not exist "%NODE_EXE%" (
  echo Could not find Node.js. Start Codex once or install Node.js 18 or newer.
  exit /b 1
)

"%NODE_EXE%" "%~dp0configure.mjs"
exit /b %ERRORLEVEL%
