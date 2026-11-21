#!/usr/bin/env node
// Validate the deployable package at Git HEAD without running package scripts.
import { execFileSync } from 'node:child_process';

const blockedHooks = ['prepare', 'preinstall', 'install', 'postinstall'];
const packHooks = ['prepack', 'prepublish', 'publish'];
const bundleMetadata = new Set([
  './package.json', './cordis.patch.yml', './icon', './locale/*.json',
]);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.hasOwn(object, key);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function readPackage() {
  const root = git(['rev-parse', '--show-toplevel']).trimEnd();
  const manifest = JSON.parse(git(['show', 'HEAD:package.json'], root));
  if (!isObject(manifest)) throw new Error('Commit a package.json containing a JSON object.');
  const files = new Set();
  for (const record of git(['ls-tree', '-r', '-z', 'HEAD'], root).split('\0')) {
    // Only regular files: a Git symlink or submodule does not supply its target bytes.
    if (/^100(?:644|755) blob /.test(record)) files.add(record.slice(record.indexOf('\t') + 1));
  }
  return { manifest, files };
}

function wildcard(target) {
  const escaped = target.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Node export patterns replace every '*' in the target with the same capture,
  // which can contain '/'. This is string substitution, not a filesystem glob.
  return new RegExp(`^${escaped[0]}(?<pattern>.+)${escaped.slice(1).join('\\k<pattern>')}$`, 's');
}

function validate(manifest, files) {
  const errors = [];
  const scripts = isObject(manifest.scripts) ? manifest.scripts : {};
  for (const hook of blockedHooks.filter((name) => has(scripts, name))) {
    errors.push(`scripts.${hook} can trigger a build on dependency install; remove this lifecycle hook, build explicitly, and commit deployable outputs.`);
  }

  function checkTarget(label, target, { exportTarget = false, pattern = false, suffix = '' } = {}) {
    const path = typeof target === 'string' ? target.replace(/^\.\//, '') : '';
    if (!path || (exportTarget && !target.startsWith('./')) ||
        /[\\:\u0000]/.test(path) || path.split('/').some((part) => ['', '.', '..', 'node_modules'].includes(part)) ||
        (!pattern && path.includes('*'))) {
      errors.push(`${label} (${JSON.stringify(target)}) is invalid; point it at a package-relative file${pattern ? ' or export pattern' : ''}.`);
      return;
    }
    const matcher = path.includes('*') ? wildcard(path) : null;
    if (matcher ? ![...files].some((file) => matcher.test(file)) : !files.has(path)) {
      errors.push(`${label} (${JSON.stringify(target)}) ${matcher ? 'matches no regular file' : 'is not a regular file'} in Git HEAD; commit the target${matcher ? ' file(s)' : ''} or fix the path${suffix}.`);
    }
  }

  function checkExports(value, label = 'exports', pattern = false) {
    if (value === null) return; // Explicitly blocked subpath or condition.
    if (Array.isArray(value)) {
      value.forEach((entry, i) => checkExports(entry, `${label}[${i}]`, pattern));
    } else if (isObject(value)) {
      for (const [key, entry] of Object.entries(value)) {
        checkExports(entry, `${label}[${JSON.stringify(key)}]`, pattern || (key.startsWith('./') && key.includes('*')));
      }
    } else {
      checkTarget(label, value, { exportTarget: true, pattern });
    }
  }

  const hasMain = has(manifest, 'main');
  const hasExports = has(manifest, 'exports');
  const bundle = manifest.dsh?.bundle;
  const configOnly = !hasMain && !manifest.dsh?.client && isObject(bundle) &&
    (!hasExports || manifest.exports === null || (isObject(manifest.exports) &&
      Object.keys(manifest.exports).every((key) => bundleMetadata.has(key))));

  // Pack/publish hooks use main (or index.js) to decide whether pnpm builds
  // a Git dependency, even if exports has a working root entry.
  const activePackHooks = packHooks.filter((name) => has(scripts, name));
  if (activePackHooks.length) {
    checkTarget(hasMain ? 'main' : 'default main', hasMain ? manifest.main : 'index.js', {
      suffix: `, or remove ${activePackHooks.map((hook) => `scripts.${hook}`).join(', ')}`,
    });
  } else if (hasMain || (!hasExports && !configOnly)) {
    checkTarget(hasMain ? 'main' : 'default main', hasMain ? manifest.main : 'index.js');
  }

  if (configOnly) checkTarget('dsh.bundle.patch', bundle.patch);
  else if (hasExports) checkExports(manifest.exports);
  return errors;
}

try {
  const { manifest, files } = readPackage();
  const errors = validate(manifest, files);
  if (errors.length) {
    console.error(`Install safety failed for ${manifest.name ?? 'package'}:\n${errors.map((error) => `- ${error}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`Install safety passed for ${manifest.name ?? 'package'} (Git HEAD).`);
  }
} catch (error) {
  console.error(`Install safety could not read the committed package: ${error.message}`);
  process.exitCode = 1;
}
