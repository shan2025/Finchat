@echo off
title FinChat Launcher
color 0A

echo.
echo ========================================
echo     FINCHAT - Governed Messaging System
echo     Startup Script v1.0
echo ========================================
echo.

:: ── Step 0: Set up nvm PATH explicitly ──
set "NVM_HOME=E:\nvm"
set "NVM_SYMLINK=C:\nvm4w\nodejs"
set "PATH=%NVM_HOME%;%NVM_SYMLINK%;%PATH%"

echo [0/4] Activating Node.js via nvm...
call nvm use 20.20.0
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found after nvm activation.
    echo         Please run: nvm install 20.20.0
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo       Node.js %%v activated
echo.

:: ── Step 1: Install dependencies if needed ──
echo [1/4] Checking dependencies...
if not exist "e:\FinChat\finchat\legacy_prototype\backend\node_modules" (
    echo       Installing npm packages...
    cd /d e:\FinChat\finchat\legacy_prototype\backend
    call npm install
    echo       Dependencies installed.
) else (
    echo       Dependencies already installed.
)

:: ── Step 1b: Rebuild better-sqlite3 if needed ──
cd /d e:\FinChat\finchat\legacy_prototype\backend
node -e "try{require('better-sqlite3');process.exit(0)}catch(e){process.exit(1)}" >nul 2>&1
if errorlevel 1 (
    echo       Rebuilding better-sqlite3 for current Node.js version...
    call npm rebuild better-sqlite3
    echo       Rebuild complete.
)
echo.

:: ── Step 2: Start Ollama (optional) ──
echo [2/4] Starting Ollama AI...
where ollama >nul 2>&1
if errorlevel 1 (
    echo       Ollama not found - AI will use simulation mode.
) else (
    start "Ollama AI" /min cmd /c "ollama serve"
    timeout /t 2 /nobreak >nul
    echo       Ollama started.
)
echo.

:: ── Step 3: Start Backend ──
echo [3/4] Starting Backend Server...
start "FinChat Backend" cmd /k "set PATH=E:\nvm;C:\nvm4w\nodejs;%PATH% && call nvm use 20.20.0 >nul 2>&1 && cd /d e:\FinChat\finchat\legacy_prototype\backend && npm run dev"
timeout /t 5 /nobreak >nul
echo       Backend starting on http://localhost:3000
echo.

:: ── Step 4: Open Frontend ──
echo [4/4] Opening FinChat in browser...
start "" "e:\FinChat\finchat\legacy_prototype\frontend\finchat_login.html"
echo       Frontend opened.
echo.

echo ========================================
echo  All systems launched!
echo  Backend  : http://localhost:3000
echo  Frontend : finchat_login.html
echo  Health   : http://localhost:3000/health
echo ========================================
echo.
echo You can close this window.
pause
