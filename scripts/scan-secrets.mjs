#!/usr/bin/env node
/**
 * scripts/scan-secrets.mjs
 * 扫描工作区中潜在的密钥 / Cookie / Token。
 * 用法：node scripts/scan-secrets.mjs
 * 退出码：非 0 表示发现可疑内容。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.crxjs', '.chrome', 'coverage', '.workbuddy']);
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.txt',
  '.html', '.css', '.env', '.yml', '.yaml', '.toml', '.sh',
]);

const PATTERNS = [
  { name: 'SESSDATA',   re: /SESSDATA\s*[:=]\s*['"]?[a-zA-Z0-9%]+['"]?/ },
  { name: 'bili_jct',   re: /bili_jct\s*[:=]\s*['"]?[a-f0-9]{32,}['"]?/ },
  { name: 'Bearer',     re: /Bearer\s+[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}/ },
  { name: 'OpenAI-Key', re: /sk-[A-Za-z0-9]{32,}/ },
  { name: 'Google-Key', re: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: 'DeepSeek',   re: /sk-[a-f0-9]{32,}/ },
  { name: 'Generic-KV', re: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{16,}['"]/i },
];

let hits = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (TEXT_EXT.has('.' + (name.split('.').pop() || ''))) scan(full);
  }
}

function scan(file) {
  let txt;
  try { txt = readFileSync(file, 'utf8'); } catch { return; }
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of PATTERNS) {
      if (re.test(lines[i])) {
        console.error(`[SECRET] ${name} at ${relative(ROOT, file)}:${i + 1}  ${lines[i].trim()}`);
        hits++;
      }
    }
  }
}

walk(ROOT);

if (hits > 0) {
  console.error(`\n[FAIL] scan-secrets found ${hits} potential secret(s).`);
  process.exit(1);
} else {
  console.log('[OK] scan-secrets: no secrets detected.');
}