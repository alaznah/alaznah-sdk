#!/usr/bin/env node
/**
 * Applies the iOS WebRTC PiP patch to the host app's react-native-webrtc.
 *
 * Runs from SDK postinstall and from the iOS before-compile script phase
 * (npm often installs @alaznah/calling before react-native-webrtc, so
 * postinstall alone is not enough). Integrators do not add patch-package.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const sdkRoot = path.resolve(__dirname, '..');
const patchDir = path.join(sdkRoot, 'patches');
const MARKER = 'AlaznahWebRTCPipRequestStart';
const LOG = '[alaznah/calling]';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const resolved = path.resolve(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function isHostApp(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) return false;
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  return Boolean(deps['react-native']);
}

function webrtcIn(dir) {
  return path.join(dir, 'node_modules', 'react-native-webrtc');
}

function hasWebrtc(dir) {
  return fs.existsSync(path.join(webrtcIn(dir), 'ios', 'RCTWebRTC', 'PIPController.m'));
}

function walkParents(start, max = 14) {
  const dirs = [];
  let dir = path.resolve(start);
  for (let i = 0; i < max; i += 1) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function resolveWebrtcPackage(fromDir) {
  try {
    return path.dirname(
      require.resolve('react-native-webrtc/package.json', { paths: [fromDir] }),
    );
  } catch {
    return null;
  }
}

function hostFromWebrtc(webrtcRoot) {
  const nm = path.dirname(webrtcRoot);
  if (path.basename(nm) === 'node_modules') {
    return path.dirname(nm);
  }
  return null;
}

function findHostRoot() {
  const envStarts = [
    process.env.ALAZNAH_APP_ROOT,
    process.env.INIT_CWD,
    process.env.npm_config_local_prefix,
    process.env.SRCROOT ? path.resolve(process.env.SRCROOT, '..') : null,
    process.env.PROJECT_DIR ? path.resolve(process.env.PROJECT_DIR, '..') : null,
    process.env.PODS_ROOT ? path.resolve(process.env.PODS_ROOT, '../..') : null,
    process.cwd(),
  ];

  const starts = unique([
    ...envStarts,
    sdkRoot,
    ...walkParents(sdkRoot),
    ...walkParents(process.cwd()),
  ]);

  for (const dir of starts) {
    if (!fs.existsSync(dir)) continue;
    if (isHostApp(dir) && hasWebrtc(dir)) {
      return dir;
    }
    const resolved = resolveWebrtcPackage(dir);
    if (resolved) {
      const host = hostFromWebrtc(resolved);
      if (host && isHostApp(host)) return host;
    }
    if (hasWebrtc(dir)) return dir;
  }
  return null;
}

function alreadyPatched(host) {
  const file = path.join(webrtcIn(host), 'ios', 'RCTWebRTC', 'PIPController.m');
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').includes(MARKER);
}

function resolvePatchPackage() {
  const roots = [sdkRoot, process.cwd(), process.env.INIT_CWD].filter(Boolean);
  for (const root of roots) {
    try {
      const pkgDir = path.dirname(
        require.resolve('patch-package/package.json', { paths: [root] }),
      );
      const json = readJson(path.join(pkgDir, 'package.json'));
      const bin = json?.bin?.['patch-package'] ?? json?.bin;
      if (typeof bin === 'string') return path.join(pkgDir, bin);
    } catch {
      // try next
    }
  }
  return null;
}

function listWebrtcPatches() {
  if (!fs.existsSync(patchDir)) return [];
  return fs
    .readdirSync(patchDir)
    .filter((name) => /^react-native-webrtc\+.+\.patch$/.test(name));
}

function stagePatchDir(host) {
  const patches = listWebrtcPatches();
  if (!patches.length) return null;
  const ver = readJson(path.join(webrtcIn(host), 'package.json'))?.version;
  const exactName = ver ? `react-native-webrtc+${ver}.patch` : patches[0];
  const sourceName = patches.includes(exactName)
    ? exactName
    : patches.sort().reverse()[0];
  // patch-package requires a path relative to the host cwd.
  const staged = path.join(host, 'node_modules', '.cache', 'alaznah-webrtc-pip');
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true });
  fs.copyFileSync(path.join(patchDir, sourceName), path.join(staged, exactName));
  return staged;
}

function applyWithPatchPackage(host, stagedDir) {
  const cli = resolvePatchPackage();
  const relativeDir = path.relative(host, stagedDir) || stagedDir;
  const args = [`--patch-dir=${relativeDir}`];
  if (cli) {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: host,
      encoding: 'utf8',
    });
  }
  return spawnSync('npx', ['--yes', 'patch-package', ...args], {
    cwd: host,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}

function applyWithSystemPatch(host, stagedDir) {
  const files = fs.readdirSync(stagedDir).filter((name) => name.endsWith('.patch'));
  if (!files.length) {
    return { status: 1, stderr: 'no staged patch', stdout: '' };
  }
  return spawnSync(
    'patch',
    ['-p1', '--forward', '--batch', '-i', path.join(stagedDir, files[0])],
    { cwd: host, encoding: 'utf8' },
  );
}

const host = findHostRoot();
if (!host) {
  process.exit(0);
}
if (alreadyPatched(host)) {
  process.exit(0);
}
if (!fs.existsSync(patchDir) || !listWebrtcPatches().length) {
  process.exit(0);
}

const staged = stagePatchDir(host);
if (!staged) {
  process.exit(0);
}

try {
  let result = applyWithPatchPackage(host, staged);
  if (result.status !== 0 && !alreadyPatched(host)) {
    result = applyWithSystemPatch(host, staged);
  }
  if (result.status !== 0 && !alreadyPatched(host)) {
    const err = (result.stderr || result.stdout || '').trim();
    console.warn(
      `${LOG} iOS WebRTC PiP patch did not apply (voice/video still work).`,
      err ? `\n${err}` : '',
    );
    process.exit(0);
  }
} finally {
  fs.rmSync(staged, { recursive: true, force: true });
}

if (alreadyPatched(host)) {
  console.log(`${LOG} applied iOS WebRTC PiP patch`);
} else {
  console.warn(`${LOG} iOS WebRTC PiP patch ran but marker is missing — rebuild iOS after npm install`);
}
process.exit(0);
