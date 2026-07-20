@echo off
echo Stopping Ollama...
taskkill /F /IM ollama_app.exe >nul 2>&1
taskkill /F /IM ollama.exe >nul 2>&1

echo Configuring Ollama to listen on all addresses (0.0.0.0)...
set OLLAMA_HOST=0.0.0.0

echo Starting Ollama...
echo (A new window might open quickly, just minimize it)
start ollama serve

echo.
echo Ollama is restarting with network access!
echo Please wait 10 seconds, then run run_docker.bat again.
pause
