# Build RED_DMA_Bot_Manager.exe with PyInstaller
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Manager = $PSScriptRoot
Set-Location $Manager

python -m pip install -q customtkinter pyinstaller
python -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --windowed `
  --name "RED_DMA_Bot_Manager" `
  --paths $Manager `
  --distpath (Join-Path $Root "dist") `
  --workpath (Join-Path $Manager "build") `
  --specpath $Manager `
  (Join-Path $Manager "app.py")

Write-Host "EXE:" (Join-Path $Root "dist\RED_DMA_Bot_Manager.exe")
