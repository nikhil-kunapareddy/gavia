# Gavia on Windows

These steps let you run the Gavia desktop app on Windows.

## 1) Install prerequisites

Install the following:

- Node.js LTS
- Python 3.11+
- Rust + Cargo

Open a new PowerShell window after installing Rust so the PATH updates.

## 2) Open the project

```powershell
cd "C:\Users\Swara\Desktop\Projects\Humanitarians AI\gavia\frontend"
```

## 3) Install frontend dependencies

```powershell
npm install
```

## 4) Build the backend sidecar

From the repo root, activate the project venv and build the frozen Python backend:

```powershell
cd "C:\Users\Swara\Desktop\Projects\Humanitarians AI\gavia"
.\gavia-venv\Scripts\Activate.ps1
cd backend
pip install -r requirements-build.txt
cd ..
python .\backend\scripts\build_sidecar.py
```

If you are already inside the venv, the same command also works as:

```powershell
cd "C:\Users\Swara\Desktop\Projects\Humanitarians AI\gavia\frontend"
python ..\backend\scripts\build_sidecar.py
```

## 5) Build the Windows desktop app

```powershell
cd "C:\Users\Swara\Desktop\Projects\Humanitarians AI\gavia\frontend"
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run build:sidecar
npx tauri build
```

Do not run the macOS-only DMG packaging step on Windows; that is for `package:dmg` and is not needed for a Windows build.

This creates the Windows app in:

- `frontend\src-tauri\target\release\gavia.exe`
- `frontend\src-tauri\target\release\bundle\msi\...msi`
- `frontend\src-tauri\target\release\bundle\nsis\...setup.exe`

## 6) Run the app

Double-click either:

- the `.exe` file, or
- the generated `.msi` or `.exe` installer

## 7) If the app is not launching

Try these checks:

```powershell
Get-Process gavia -ErrorAction SilentlyContinue
Get-Process gavia-backend -ErrorAction SilentlyContinue
```

If needed, run the raw executable:

```powershell
"C:\Users\Swara\Desktop\Projects\Humanitarians AI\gavia\frontend\src-tauri\target\release\gavia.exe"
```

## Notes

- The project uses Tauri + Rust for the desktop shell.
- The Python backend is bundled into a sidecar and launched by the app.
- This is a native Windows build, not a macOS `.dmg` file converted to Windows.
