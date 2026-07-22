@echo off
rem StayLeased demo launcher (Windows). Double-click me.
rem If Windows shows "Windows protected your PC", click "More info" then "Run anyway".
setlocal
cd /d "%~dp0"

echo ==========================================
echo   StayLeased - Summit Ridge demo launcher
echo ==========================================
echo.

rem 1) Node present and new enough?
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed on this computer.
  echo Install the LTS version from https://nodejs.org - big green button -
  echo then double-click this file again.
  pause
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=11)?0:1)"
if errorlevel 1 (
  echo Your Node.js is too old - StayLeased needs Node 22.11 or newer.
  echo Install the current LTS from https://nodejs.org, then run this again.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Node %%v - OK

rem TypeScript support: Node 22 needs the flag; newer Nodes strip types by
rem default (and may eventually drop the flag), so probe instead of assuming.
set "RUN_FLAGS=--experimental-strip-types --no-warnings"
node --experimental-strip-types -e "" >nul 2>nul
if errorlevel 1 set "RUN_FLAGS=--no-warnings"

rem 2) Dependencies (bundled in the zip; installed only if missing)
if not exist node_modules\pdf-lib\package.json (
  echo.
  echo Installing dependencies - one time...
  call npm install --omit=dev
  if errorlevel 1 (
    echo npm install failed - see the message above.
    pause
    exit /b 1
  )
)

rem 3) Demo world (bundled in the zip; rebuilt only if you deleted the data folder)
if not exist data\.seeded (
  echo.
  echo Building the demo world - about a minute, one time only...
  node %RUN_FLAGS% src\seed\seed.ts --reset
  if errorlevel 1 (
    echo Seeding failed - see the message above.
    pause
    exit /b 1
  )
  type nul > data\.seeded
)

rem 4) Start the server and open the browser
echo.
echo Starting StayLeased at http://localhost:3000
echo Sign in as admin@summitridge.demo with password demo1234
echo (all demo logins are listed in HOW-TO-RUN.txt)
echo.
echo Leave this window open while you use it. Close it to stop the server.
echo.
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:3000"
node %RUN_FLAGS% src\server\main.ts
if errorlevel 1 (
  echo.
  echo The server stopped with an error - see above.
  echo If it says the address is in use, another app is using port 3000 - close it and try again.
)
pause
