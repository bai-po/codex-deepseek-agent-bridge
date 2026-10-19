@echo off
rem ============================================================================
rem DeepSeek Bridge MCP launcher (manual fallback)
rem
rem The plugin normally starts the server with plain `node ./server.mjs` (see .mcp.json).
rem Use this script only when `node` is not on PATH for the Codex process:
rem   set the plugin's .mcp.json to
rem     "command": "cmd.exe",
rem     "args": ["/d","/s","/c","call","<plugin dir>\scripts\launch_deepseek_bridge_mcp.cmd","<plugin dir>\server.mjs"]
rem
rem Node discovery order (first hit wins):
rem   1. %CODEX_MCP_NODE_PATH%
rem   2. %CODEX_BROWSER_USE_NODE_PATH%
rem   3. %CODEX_ELECTRON_RESOURCES_PATH%\cua_node\bin\node.exe
rem   4. <codex CLI exe dir>\..\cua_node\bin\node.exe
rem   5. %USERPROFILE%\.cache\codex-runtimes\*\deps\node\bin\node.exe
rem   6. %LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*\node.exe
rem   7. node.exe on PATH
rem Exit codes: 0 normal, 127 no usable node found.
rem ============================================================================
setlocal EnableExtensions

set "SERVER=%~1"
if "%SERVER%"=="" set "SERVER=%~dp0..\server.mjs"

set "NODE_EXE="

if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" set "NODE_EXE=%CODEX_MCP_NODE_PATH%"
if not defined NODE_EXE if defined CODEX_BROWSER_USE_NODE_PATH if exist "%CODEX_BROWSER_USE_NODE_PATH%" set "NODE_EXE=%CODEX_BROWSER_USE_NODE_PATH%"

if not defined NODE_EXE if defined CODEX_ELECTRON_RESOURCES_PATH call :probe "%CODEX_ELECTRON_RESOURCES_PATH%\cua_node\bin\node.exe"

if not defined NODE_EXE call :probe "%~dp0..\..\..\..\cua_node\bin\node.exe"

if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes" (
  for /d %%D in ("%USERPROFILE%\.cache\codex-runtimes\*") do (
    if not defined NODE_EXE call :probe "%%~D\deps\node\bin\node.exe"
  )
)

if not defined NODE_EXE if exist "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node" (
  for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do (
    if not defined NODE_EXE call :probe "%%~D\node.exe"
  )
)

if not defined NODE_EXE (
  for %%N in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:N"
)

if not defined NODE_EXE (
  echo [deepseek-bridge] No node.exe found. Install Node.js 22+ or set CODEX_MCP_NODE_PATH.>&2
  exit /b 127
)

"%NODE_EXE%" "%SERVER%" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%

:probe
if not defined NODE_EXE if exist "%~1" set "NODE_EXE=%~1"
goto :eof
