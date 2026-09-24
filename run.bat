@echo off
rem Lance l'extracteur CadnaA - Quebec sur http://127.0.0.1:8000
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
    echo Creation de l'environnement Python...
    python -m venv .venv || goto :error
    .venv\Scripts\python.exe -m pip install --upgrade pip
)
rem (Re)installe les dependances a la creation et quand requirements.txt a change.
fc /b requirements.txt .venv\requirements.installed >nul 2>&1
if errorlevel 1 (
    echo Installation des dependances...
    .venv\Scripts\python.exe -m pip install -r requirements.txt || goto :error
    copy /y requirements.txt .venv\requirements.installed >nul
)
start "" http://127.0.0.1:8000
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
goto :eof

:error
echo Echec de l'installation. Verifiez que Python 3.11+ est installe.
pause
