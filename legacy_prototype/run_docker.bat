@echo off
echo Checking Docker status...
docker info >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo ERROR: Docker is NOT running!
  echo Please open "Docker Desktop" app and wait for it to start.
  echo.
  pause
  exit /b
)

echo Starting FinChat with Docker...
docker-compose up -d --build
echo.
echo Containers are running!
echo Backend: http://localhost:3000
echo Frontend: http://localhost:5500 (if served)
echo.
echo To stop: docker-compose down
pause
