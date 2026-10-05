/**
 * 冷库事务逻辑的轻量验证运行器：
 *   node scripts/run-verify.mjs storage   → scripts/verify-storage.ts
 *   node scripts/run-verify.mjs migration → scripts/verify-migration.ts
 * 用本地已有的 esbuild（vite 的依赖）即时打包 TS，无需额外测试框架。
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? 'storage';
const entryMap = {
  storage: 'verify-storage.ts',
  migration: 'verify-migration.ts',
};
const entryName = entryMap[target];
if (!entryName) {
  console.error(`未知验证目标：${target}（可选 storage / migration）`);
  process.exitCode = 2;
} else {
  const outfile = resolve(here, `../node_modules/.cache/verify-${target}.mjs`);
  await build({
    entryPoints: [resolve(here, entryName)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  try {
    await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(outfile, { force: true });
  }
}
