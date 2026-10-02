'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runCommand = promisify(execFile);
const PRODUCT_NAME = 'Screen Recorder';
const BUNDLE_ID = 'local.screen-recorder';
const APP_FILES = [
  'main.cjs', 'preload.cjs', 'recording-store.cjs', 'platform-support.cjs',
  'renderer.js', 'index.html', 'style.css',
];

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--platform') options.platform = args[++index];
    else if (argument.startsWith('--platform=')) options.platform = argument.slice('--platform='.length);
    else throw new Error(`Unknown packaging option: ${argument}`);
    if (!options.platform) throw new Error('--platform needs a value (darwin or win32).');
  }
  return options;
}

async function readRuntimeArchitectures(executable, platform) {
  const handle = await fs.open(executable, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (platform === 'win32' && bytesRead >= 64 && header.toString('ascii', 0, 2) === 'MZ') {
      const peOffset = header.readUInt32LE(60);
      const pe = Buffer.alloc(6);
      const read = await handle.read(pe, 0, pe.length, peOffset);
      if (read.bytesRead === pe.length && pe.readUInt32LE(0) === 0x00004550) {
        const machine = { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32' }[pe.readUInt16LE(4)];
        if (machine) return [machine];
      }
    }
    if (platform === 'darwin' && bytesRead >= 8) {
      const architecture = (cpu) => ({ 0x01000007: 'x64', 0x0100000c: 'arm64' }[cpu]);
      if (header.readUInt32LE(0) === 0xfeedfacf) {
        const arch = architecture(header.readUInt32LE(4));
        if (arch) return [arch];
      }
      const magic = header.readUInt32BE(0);
      if (magic === 0xcafebabe || magic === 0xcafebabf) {
        const count = header.readUInt32BE(4);
        const stride = magic === 0xcafebabf ? 32 : 20;
        if (count > 0 && count <= 32 && 8 + count * stride <= bytesRead) {
          return Array.from({ length: count }, (_, index) => architecture(header.readUInt32BE(8 + index * stride))).filter(Boolean);
        }
      }
    }
    throw new Error(`The installed Electron executable is not a supported ${platform} runtime: ${executable}`);
  } finally {
    await handle.close();
  }
}

async function setPlistStrings(plist, values, runFile) {
  // plutil supports both XML and binary Info.plist files and preserves other keys.
  for (const [key, value] of Object.entries(values)) {
    await runFile('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
  }
}

async function customizeMacBundle(bundle, version, runFile) {
  const contents = path.join(bundle, 'Contents');
  await fs.rename(path.join(contents, 'MacOS', 'Electron'), path.join(contents, 'MacOS', PRODUCT_NAME));
  await setPlistStrings(path.join(contents, 'Info.plist'), {
    CFBundleDisplayName: PRODUCT_NAME,
    CFBundleName: PRODUCT_NAME,
    CFBundleExecutable: PRODUCT_NAME,
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: '13.0',
    NSMicrophoneUsageDescription: '선택한 화면 또는 창의 영상과 함께 마이크 소리를 녹음합니다.',
    NSAudioCaptureUsageDescription: '선택한 화면 또는 창의 영상과 함께 시스템 소리를 녹음합니다.',
    NSScreenCaptureUsageDescription: '선택한 화면 또는 창을 동영상으로 녹화합니다.',
  }, runFile);

  const frameworks = path.join(contents, 'Frameworks');
  for (const entry of await fs.readdir(frameworks, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^Electron Helper(?: \([A-Za-z]+\))?\.app$/.test(entry.name)) continue;
    const oldName = entry.name.slice(0, -4);
    const helperName = oldName.replace('Electron', PRODUCT_NAME);
    const oldHelper = path.join(frameworks, entry.name);
    const helper = path.join(frameworks, `${helperName}.app`);
    await fs.rename(oldHelper, helper);
    await fs.rename(path.join(helper, 'Contents', 'MacOS', oldName), path.join(helper, 'Contents', 'MacOS', helperName));
    const suffix = oldName.match(/\(([A-Za-z]+)\)/)?.[1].toLowerCase();
    await setPlistStrings(path.join(helper, 'Contents', 'Info.plist'), {
      CFBundleDisplayName: helperName,
      CFBundleName: helperName,
      CFBundleExecutable: helperName,
      CFBundleIdentifier: `${BUNDLE_ID}.helper${suffix ? `.${suffix}` : ''}`,
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
    }, runFile);
  }
}

async function copyApplication(project, appDirectory, manifest) {
  await fs.mkdir(appDirectory, { recursive: true });
  for (const file of APP_FILES) await fs.copyFile(path.join(project, file), path.join(appDirectory, file));
  await fs.writeFile(path.join(appDirectory, 'package.json'), `${JSON.stringify({
    name: manifest.name,
    productName: PRODUCT_NAME,
    version: manifest.version,
    main: 'main.cjs',
    private: true,
  }, null, 2)}\n`);
}

async function copyRuntime(runtimeDirectory, destination) {
  for (const entry of await fs.readdir(runtimeDirectory)) {
    await fs.cp(path.join(runtimeDirectory, entry), path.join(destination, entry), {
      recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true,
    });
  }
}

async function packageApplication(options = {}) {
  const project = path.resolve(options.project || path.join(__dirname, '..'));
  const outputs = path.resolve(options.outputs || process.env.SCREEN_RECORDER_OUTPUT_DIR || path.join(project, 'dist'));
  const hostPlatform = options.hostPlatform || process.platform;
  const hostArch = options.hostArch || process.arch;
  const platform = options.platform || hostPlatform;
  const runFile = options.runFile || runCommand;
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Packaging supports macOS (darwin) and Windows (win32).');
  if (platform !== hostPlatform) {
    throw new Error(`Package ${platform} on a ${platform} computer with its matching Electron runtime; this host is ${hostPlatform}.`);
  }
  if (!['x64', 'arm64', ...(platform === 'win32' ? ['ia32'] : [])].includes(hostArch)) {
    throw new Error(`Unsupported ${platform} architecture: ${hostArch}`);
  }
  const electronExecutable = path.resolve(options.electronExecutable || require('electron'));
  const sourceBundle = platform === 'darwin' ? path.resolve(path.dirname(electronExecutable), '..', '..') : null;
  if (sourceBundle && path.basename(sourceBundle) !== 'Electron.app') throw new Error('Expected Electron.app in the installed macOS runtime.');
  if (platform === 'win32' && path.basename(electronExecutable).toLowerCase() !== 'electron.exe') throw new Error('Expected electron.exe in the installed Windows runtime.');
  const runtimeArchitectures = await readRuntimeArchitectures(electronExecutable, platform);
  if (!runtimeArchitectures.includes(hostArch)) {
    throw new Error(`The installed Electron runtime is ${runtimeArchitectures.join('/')} but this host is ${hostArch}. Install the matching Electron runtime before packaging.`);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
  if (!manifest.name || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) throw new Error('package.json needs a name and a valid version.');
  // Validate the application payload before creating the output directory.
  for (const file of [...APP_FILES, '사용법.txt']) await fs.access(path.join(project, file));
  const destination = path.join(outputs, platform === 'darwin' ? `ScreenRecorder-macOS-${hostArch}` : 'ScreenRecorder-Windows');
  await fs.mkdir(outputs, { recursive: true });
  try {
    await fs.mkdir(destination);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`A previous package exists at ${destination}. Choose a new output directory; existing packages are never overwritten.`);
    throw error;
  }

  let executable;
  let bundle;
  if (platform === 'darwin') {
    // Copy the complete runtime, including its top-level LICENSE and Chromium notices.
    await copyRuntime(path.dirname(sourceBundle), destination);
    bundle = path.join(destination, `${PRODUCT_NAME}.app`);
    await fs.rename(path.join(destination, 'Electron.app'), bundle);
    await customizeMacBundle(bundle, manifest.version, runFile);
    await copyApplication(project, path.join(bundle, 'Contents', 'Resources', 'app'), manifest);
    executable = path.join(bundle, 'Contents', 'MacOS', PRODUCT_NAME);
  } else {
    await copyRuntime(path.dirname(electronExecutable), destination);
    executable = path.join(destination, 'ScreenRecorder.exe');
    await fs.rename(path.join(destination, 'electron.exe'), executable);
    await copyApplication(project, path.join(destination, 'resources', 'app'), manifest);
  }
  await fs.copyFile(path.join(project, '사용법.txt'), path.join(destination, '사용법.txt'));
  try {
    await fs.copyFile(path.join(project, '사용법.txt'), path.join(outputs, '화면녹화-사용법.txt'), constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (bundle) {
    // Local ad hoc signing restores validity after changing bundle identities.
    // Preserve Electron's entitlements when signing the nested helper apps.
    await runFile('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', '--timestamp=none', bundle]);
    await runFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  }
  return { destination, executable, ...(bundle ? { bundle } : {}) };
}

module.exports = { packageApplication, parseArguments, readRuntimeArchitectures };

if (require.main === module) {
  Promise.resolve().then(() => packageApplication(parseArguments(process.argv.slice(2))))
    .then((result) => console.log(result.bundle || result.executable))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
