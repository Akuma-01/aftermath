import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
for (const field of [
  'name',
  'version',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'engines',
  'workspaces',
]) {
  if (JSON.stringify(manifest[field]) !== JSON.stringify(lock.packages[''][field]))
    throw new Error(`Lockfile mismatch: ${field}`);
}
let count = 0;
for (const root of ['apps', 'packages'])
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const workspace = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (realpathSync(join('node_modules', workspace.name)) !== resolve(path))
      throw new Error(`Workspace link mismatch: ${workspace.name}`);
    count++;
  }
const files = [
  ...new Set(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  ),
];
const findings: string[] = [];
for (const file of files) {
  if (
    /(^|\/)(node_modules|dist|\.data|\.cache|\.vite|test-results|playwright-report)(\/|$)|(^|\/)\.env(?!\.example$)(\.|$)|\.(db|sqlite3?|pem|key)$/.test(
      file,
    )
  )
    findings.push(`Unwanted tracked/candidate file: ${file}`);
  const content = readFileSync(file, 'utf8');
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/.test(
      content,
    )
  )
    findings.push(`Possible credential signature: ${file}`);
}
if (findings.length) throw new Error(findings.join('\n'));
console.log(
  `PASS: lockfile matches manifest; ${count} workspace links resolve; ${files.length} tracked/candidate files checked for generated artifacts and common credential signatures. Ignored local files and Git history were not scanned; this is not a complete secret or vulnerability audit.`,
);
