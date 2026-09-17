import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { runPvzNativeBuildScript } from '../src/native-build.ts';

it.runIf(process.platform === 'win32')('native shovel selection follows the visible seed bank layout', async () => {
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe');
  expect(existsSync(vswhere), 'Visual Studio x86 Build Tools are required for native fixtures').toBe(true);
  const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
  { encoding: 'utf8', windowsHide: true }).trim();
  const scratch = resolve('scratch');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'pvz-native-shovel-'));
  const script = join(root, 'build-fixture.cmd');
  const source = fileURLToPath(new URL('./native-shovel.cpp', import.meta.url));
  const vcvars = join(installation, 'VC/Auxiliary/Build/vcvarsall.bat');
  expect(existsSync(vcvars)).toBe(true);
  writeFileSync(script, [
    '@echo off', 'setlocal', `call "${vcvars}" x86 >nul`,
    'if errorlevel 1 exit /b 1',
    `cl.exe /nologo /std:c++17 /O2 /MT /EHsc /W4 /utf-8 /DUNICODE /D_UNICODE "${source}" /Fo"%~1\\fixture.obj" /Fe"%~1\\fixture.exe" /link user32.lib gdi32.lib`,
    'exit /b %ERRORLEVEL%',
  ].join('\r\n'));
  await runPvzNativeBuildScript(script, root);
  execFileSync(join(root, 'fixture.exe'), [], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
}, 60000);
