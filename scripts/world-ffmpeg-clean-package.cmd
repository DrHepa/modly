@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem No caller argument or ambient path is expanded. The batch entry always
rem launches the repo-pinned Electron runtime with one fixed bootstrap script.
set "BASH_ENV="
set "ENV="
set "DYLD_INSERT_LIBRARIES="
set "DYLD_LIBRARY_PATH="
set "LD_AUDIT="
set "LD_LIBRARY_PATH="
set "LD_PRELOAD="
set "NODE_OPTIONS="
set "NODE_PATH="
set "NODE_EXTRA_CA_CERTS="
set "NODE_REPL_EXTERNAL_MODULE="
set "NODE_V8_COVERAGE="
set "NODE_COMPILE_CACHE="
set "OPENSSL_CONF="
set "OPENSSL_MODULES="
rem The first runtime is addressed by an absolute repo-relative path. It does
rem not inherit ambient executable lookup authority. The bootstrap validates
rem SystemRoot/WINDIR and constructs the exact child PATH/COMSPEC/PATHEXT.
set "PATH="
set "COMSPEC="
set "PATHEXT="
set "ELECTRON_RUN_AS_NODE=1"
set "WORLD_FFMPEG_CLEAN_BOOTSTRAP=modly.world-ffmpeg-package-bootstrap.v1"
set "WORLD_FFMPEG_BOOTSTRAP_EXECUTABLE=%~dp0..\node_modules\electron\dist\electron.exe"

"%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0world-ffmpeg-package-bootstrap.mjs"
if errorlevel 1 exit /b 1
exit /b 0
