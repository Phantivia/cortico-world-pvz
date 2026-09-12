@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SOURCE_DIR=%~dp0"
if "%~1"=="" (
  echo Usage: build.cmd OUTPUT_DIR 1>&2
  exit /b 2
)
set "OUTPUT_DIR=%~f1"

where cl.exe >nul 2>nul
if not errorlevel 1 goto :toolchain_ready

rem Toolchain probing stays out of ( ) blocks and out of for/f IN clauses:
rem the closing parenthesis in %ProgramFiles(x86)% ends either one early, after
rem which cmd looks for a bare vswhere.exe on PATH. vswhere output goes through
rem a temp file instead.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSWHERE_OUT=%TEMP%\cortico-vswhere-%RANDOM%.txt"
if not exist "%VSWHERE%" goto :vs_default
"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%VSWHERE_OUT%" 2>nul
if exist "%VSWHERE_OUT%" set /p VSINSTALL=<"%VSWHERE_OUT%"
if exist "%VSWHERE_OUT%" del "%VSWHERE_OUT%"
:vs_default
if not defined VSINSTALL set "VSINSTALL=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools"
if exist "%VSINSTALL%\VC\Auxiliary\Build\vcvarsall.bat" goto :vs_found
echo Visual Studio Build Tools with the x86 C++ toolchain was not found. 1>&2
exit /b 1
:vs_found
call "%VSINSTALL%\VC\Auxiliary\Build\vcvarsall.bat" x86 >nul
if errorlevel 1 exit /b 1

:toolchain_ready
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"
if errorlevel 1 exit /b 1

pushd "%SOURCE_DIR%"
cl.exe /nologo /std:c++17 /O2 /MT /EHsc /W4 /DUNICODE /D_UNICODE /c injector.cpp /Fo"%OUTPUT_DIR%\injector.obj"
if errorlevel 1 goto :failed
link.exe /nologo /MACHINE:X86 /SUBSYSTEM:CONSOLE /OUT:"%OUTPUT_DIR%\pvz-injector.exe" "%OUTPUT_DIR%\injector.obj" advapi32.lib user32.lib
if errorlevel 1 goto :failed

cl.exe /nologo /std:c++17 /O2 /MT /EHsc /W4 /DUNICODE /D_UNICODE /c implant.cpp /Fo"%OUTPUT_DIR%\implant.obj"
if errorlevel 1 goto :failed
link.exe /nologo /DLL /MACHINE:X86 /OUT:"%OUTPUT_DIR%\pvz-implant.dll" /DEF:implant.def "%OUTPUT_DIR%\implant.obj" advapi32.lib crypt32.lib gdiplus.lib ole32.lib version.lib user32.lib gdi32.lib
if errorlevel 1 goto :failed
popd
echo Built "%OUTPUT_DIR%\pvz-injector.exe"
echo Built "%OUTPUT_DIR%\pvz-implant.dll"
exit /b 0

:failed
set "BUILD_ERROR=%ERRORLEVEL%"
popd
exit /b %BUILD_ERROR%
