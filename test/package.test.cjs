'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { packageApplication, parseArguments, readRuntimeArchitectures } = require('../scripts/package.cjs');

function nativeExecutable(platform, architecture) {
  if (platform === 'darwin') {
    const buffer = Buffer.alloc(32);
    buffer.writeUInt32LE(0xfeedfacf, 0);
    buffer.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4);
    return buffer;
  }
  const buffer = Buffer.alloc(134);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(128, 60);
  buffer.writeUInt32LE(0x00004550, 128);
  buffer.writeUInt16LE({ x64: 0x8664, arm64: 0xaa64, ia32: 0x014c }[architecture], 132);
  return buffer;
}

async function fixture(t, platform = 'darwin', architecture = 'arm64') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'screen-recorder-package-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  const runtime = path.join(directory, 'runtime');
  const outputs = path.join(directory, 'outputs');
  await fs.mkdir(project);
  await fs.mkdir(runtime);
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'screen-recorder', version: '1.1.0' }));
  const payload = ['main.cjs', 'preload.cjs', 'recording-store.cjs', 'platform-support.cjs', 'renderer.js', 'index.html', 'style.css', '사용법.txt'];
  for (const file of payload) await fs.writeFile(path.join(project, file), `fixture payload: ${file}`);
  await fs.writeFile(path.join(runtime, 'LICENSE'), 'Electron license fixture');
  await fs.writeFile(path.join(runtime, 'LICENSES.chromium.html'), '<p>Chromium notices fixture</p>');
  let electronExecutable;
  const plist = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Unrelated</key><string>keep me</string></dict></plist>';
  if (platform === 'darwin') {
    const contents = path.join(runtime, 'Electron.app', 'Contents');
    await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await fs.mkdir(path.join(contents, 'Resources'));
    await fs.mkdir(path.join(contents, 'Frameworks'));
    await fs.writeFile(path.join(contents, 'Info.plist'), plist);
    electronExecutable = path.join(contents, 'MacOS', 'Electron');
    for (const helperName of ['Electron Helper', 'Electron Helper (Renderer)', 'Electron Helper (GPU)', 'Electron Helper (Plugin)']) {
      const helperContents = path.join(contents, 'Frameworks', `${helperName}.app`, 'Contents');
      await fs.mkdir(path.join(helperContents, 'MacOS'), { recursive: true });
      await fs.writeFile(path.join(helperContents, 'MacOS', helperName), nativeExecutable(platform, architecture));
      await fs.writeFile(path.join(helperContents, 'Info.plist'), plist);
    }
    const framework = path.join(contents, 'Frameworks', 'Example.framework');
    await fs.mkdir(path.join(framework, 'Versions', 'A'), { recursive: true });
    await fs.writeFile(path.join(framework, 'Versions', 'A', 'Example'), 'framework fixture');
    await fs.symlink('A', path.join(framework, 'Versions', 'Current'));
    await fs.symlink('Versions/Current/Example', path.join(framework, 'Example'));
  } else {
    electronExecutable = path.join(runtime, 'electron.exe');
    await fs.mkdir(path.join(runtime, 'resources'));
    await fs.writeFile(path.join(runtime, 'resources', 'default_app.asar'), 'Electron default fixture');
  }
  await fs.writeFile(electronExecutable, nativeExecutable(platform, architecture), { mode: 0o755 });
  const commands = [];
  const runFile = async (command, args) => { commands.push({ command, args }); return { stdout: '', stderr: '' }; };
  const options = { project, outputs, electronExecutable, hostPlatform: platform, hostArch: architecture, runFile };
  return { directory, runtime, project, outputs, payload, electronExecutable, commands, options };
}

test('macOS package includes application payload, licenses, renamed helpers and local signing', async (t) => {
  const f = await fixture(t);
  const sourceExecutable = await fs.readFile(f.electronExecutable);
  const result = await packageApplication(f.options);
  assert.equal(result.destination, path.join(f.outputs, 'ScreenRecorder-macOS-arm64'));
  assert.equal(result.bundle, path.join(result.destination, 'Screen Recorder.app'));
  assert.equal(result.executable, path.join(result.bundle, 'Contents', 'MacOS', 'Screen Recorder'));
  assert.deepEqual(await fs.readFile(result.executable), sourceExecutable);
  const application = path.join(result.bundle, 'Contents', 'Resources', 'app');
  for (const file of f.payload.filter((file) => file !== '사용법.txt')) {
    assert.equal(await fs.readFile(path.join(application, file), 'utf8'), `fixture payload: ${file}`);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8')), {
    name: 'screen-recorder', productName: 'Screen Recorder', version: '1.1.0', main: 'main.cjs', private: true,
  });
  assert.equal(await fs.readFile(path.join(result.destination, 'LICENSE'), 'utf8'), 'Electron license fixture');
  assert.equal(await fs.readFile(path.join(result.destination, 'LICENSES.chromium.html'), 'utf8'), '<p>Chromium notices fixture</p>');
  assert.equal(await fs.readFile(path.join(result.destination, '사용법.txt'), 'utf8'), 'fixture payload: 사용법.txt');
  assert.equal(await fs.readlink(path.join(result.bundle, 'Contents', 'Frameworks', 'Example.framework', 'Versions', 'Current')), 'A');
  assert.equal(await fs.readlink(path.join(result.bundle, 'Contents', 'Frameworks', 'Example.framework', 'Example')), 'Versions/Current/Example');
  const mainPlist = path.join(result.bundle, 'Contents', 'Info.plist');
  const metadata = Object.fromEntries(f.commands.filter(({ command, args }) => command.endsWith('/plutil') && args[4] === mainPlist).map(({ args }) => [args[1], args[3]]));
  assert.equal(metadata.CFBundleIdentifier, 'local.screen-recorder');
  assert.equal(metadata.CFBundleExecutable, 'Screen Recorder');
  assert.equal(metadata.CFBundleVersion, '1.1.0');
  assert.equal(metadata.CFBundleShortVersionString, '1.1.0');
  assert.equal(metadata.LSMinimumSystemVersion, '13.0');
  for (const key of ['NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription', 'NSScreenCaptureUsageDescription']) assert(metadata[key]?.length > 5);
  for (const suffix of ['', 'Renderer', 'GPU', 'Plugin']) {
    const helperName = `Screen Recorder Helper${suffix ? ` (${suffix})` : ''}`;
    const helper = path.join(result.bundle, 'Contents', 'Frameworks', `${helperName}.app`, 'Contents');
    await fs.access(path.join(helper, 'MacOS', helperName));
    assert(f.commands.some(({ args }) => args[1] === 'CFBundleIdentifier' && args[3] === `local.screen-recorder.helper${suffix ? `.${suffix.toLowerCase()}` : ''}` && args[4] === path.join(helper, 'Info.plist')));
  }
  assert.deepEqual(f.commands.slice(-2), [
    { command: '/usr/bin/codesign', args: ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', '--timestamp=none', result.bundle] },
    { command: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', result.bundle] },
  ]);
  assert.deepEqual(await fs.readFile(f.electronExecutable), sourceExecutable, 'installed runtime remains intact');
  await fs.access(path.join(f.runtime, 'Electron.app', 'Contents', 'Frameworks', 'Electron Helper.app'));
});

test('Windows package preserves its .exe output and includes the new shared module', async (t) => {
  const f = await fixture(t, 'win32', 'x64');
  const result = await packageApplication(f.options);
  assert.equal(result.destination, path.join(f.outputs, 'ScreenRecorder-Windows'));
  assert.equal(result.executable, path.join(result.destination, 'ScreenRecorder.exe'));
  assert.deepEqual(await fs.readFile(result.executable), await fs.readFile(f.electronExecutable));
  assert.equal(await fs.readFile(path.join(result.destination, 'resources', 'app', 'platform-support.cjs'), 'utf8'), 'fixture payload: platform-support.cjs');
  assert.equal(JSON.parse(await fs.readFile(path.join(result.destination, 'resources', 'app', 'package.json'), 'utf8')).version, '1.1.0');
  assert.equal(await fs.readFile(path.join(result.destination, 'LICENSE'), 'utf8'), 'Electron license fixture');
  assert.deepEqual(f.commands, []);
  await fs.access(f.electronExecutable);
});

test('existing complete or incomplete output is never overwritten', async (t) => {
  for (const platform of ['darwin', 'win32']) {
    const f = await fixture(t, platform, platform === 'darwin' ? 'arm64' : 'x64');
    const destination = path.join(f.outputs, platform === 'darwin' ? 'ScreenRecorder-macOS-arm64' : 'ScreenRecorder-Windows');
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, 'previous-output.txt'), 'keep the existing output');
    await assert.rejects(packageApplication(f.options), /previous package exists.*never overwritten/);
    assert.deepEqual(await fs.readdir(destination), ['previous-output.txt']);
    assert.equal(await fs.readFile(path.join(destination, 'previous-output.txt'), 'utf8'), 'keep the existing output');
    assert.deepEqual(f.commands, []);
  }
});

test('a shared usage file already present in output is preserved', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.outputs);
  await fs.writeFile(path.join(f.outputs, '화면녹화-사용법.txt'), 'previous documentation');
  await packageApplication(f.options);
  assert.equal(await fs.readFile(path.join(f.outputs, '화면녹화-사용법.txt'), 'utf8'), 'previous documentation');
});

test('platform and runtime architecture mismatches fail before any output is created', async (t) => {
  const f = await fixture(t);
  await assert.rejects(packageApplication({ ...f.options, platform: 'win32' }), /this host is darwin/);
  await assert.rejects(packageApplication({ ...f.options, platform: 'linux' }), /supports macOS.*Windows/);
  await assert.rejects(packageApplication({ ...f.options, hostArch: 'x64' }), /runtime is arm64.*host is x64/);
  await fs.writeFile(f.electronExecutable, nativeExecutable('win32', 'arm64'));
  await assert.rejects(packageApplication(f.options), /not a supported darwin runtime/);
  await assert.rejects(fs.stat(f.outputs), { code: 'ENOENT' });
});

test('missing application payload fails before reserving an output directory', async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.project, 'platform-support.cjs'));
  await assert.rejects(packageApplication(f.options), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.outputs), { code: 'ENOENT' });
});

test('code signature verification failure cannot report a successful macOS package', async (t) => {
  const f = await fixture(t);
  const runFile = async (command, args) => {
    await f.options.runFile(command, args);
    if (command.endsWith('/codesign') && args[0] === '--verify') throw new Error('signature verification failed');
  };
  await assert.rejects(packageApplication({ ...f.options, runFile }), /signature verification failed/);
  await assert.rejects(packageApplication(f.options), /previous package exists/);
});

test('architecture checks accept universal macOS binaries and reject truncated files', async (t) => {
  const f = await fixture(t);
  const universal = Buffer.alloc(48);
  universal.writeUInt32BE(0xcafebabe, 0);
  universal.writeUInt32BE(2, 4);
  universal.writeUInt32BE(0x01000007, 8);
  universal.writeUInt32BE(0x0100000c, 28);
  await fs.writeFile(f.electronExecutable, universal);
  assert.deepEqual(await readRuntimeArchitectures(f.electronExecutable, 'darwin'), ['x64', 'arm64']);
  await fs.writeFile(f.electronExecutable, Buffer.from([0xcf, 0xfa]));
  await assert.rejects(readRuntimeArchitectures(f.electronExecutable, 'darwin'), /not a supported darwin runtime/);
});

test('packaging command arguments permit only an explicit platform choice', () => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(['--platform', 'darwin']), { platform: 'darwin' });
  assert.deepEqual(parseArguments(['--platform=win32']), { platform: 'win32' });
  assert.throws(() => parseArguments(['--platform']), /needs a value/);
  assert.throws(() => parseArguments(['--arch=arm64']), /Unknown packaging option/);
});
