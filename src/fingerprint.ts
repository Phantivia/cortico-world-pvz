import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SUPPORTED_PVZ_PROFILE = {
  id: 'goty-apac-ja-chs-south_sniper',
  executable: {
    file: 'PlantsVsZombies.exe',
    bytes: 3_703_808,
    sha256: '9ba1c9b23ed2b240ad29a54c7b9fd55bcbfac8b7f83ddfac69f7907d7b7198ed',
  },
  assets: {
    file: 'main.pak',
    bytes: 50_651_354,
    sha256: '89971bafb5bee1d5de9012007b469c65e6147a1b12cf5058be3292ff8c6ba9b8',
  },
} as const;

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyFile(
  path: string,
  expected: { bytes: number; sha256: string },
  label: string,
): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`找不到 ${label}: ${path}`);
  if (!info.isFile()) throw new Error(`${label}必须是文件: ${path}`);
  if (info.size !== expected.bytes) {
    throw new Error(`${label}大小不匹配: ${path} (${info.size} != ${expected.bytes})`);
  }
  const hash = await sha256File(path);
  if (hash !== expected.sha256) throw new Error(`${label} SHA-256 不匹配: ${path}`);
}

/** Injection is allowed only after both executable and asset fingerprints match. */
export async function verifyPvzInstallation(executablePath: string): Promise<void> {
  await verifyFile(executablePath, SUPPORTED_PVZ_PROFILE.executable, 'PvZ 游戏程序');
  await verifyFile(
    join(dirname(executablePath), SUPPORTED_PVZ_PROFILE.assets.file),
    SUPPORTED_PVZ_PROFILE.assets,
    'PvZ 资源文件 main.pak',
  );
}
