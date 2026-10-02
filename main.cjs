'use strict';

const {
  app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain,
  Menu, nativeImage, powerSaveBlocker, session, shell, systemPreferences, Tray,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { RecordingStore, MAX_CHUNK_BYTES } = require('./recording-store.cjs');
const { platformSupport } = require('./platform-support.cjs');
const support = platformSupport(process.platform, require('node:os').release());


const testMode = process.argv.includes('--test-mode');
const entryPath = path.join(__dirname, 'index.html');
const entryURL = pathToFileURL(entryPath).href;
const testWorkspace = support.mac && app.isPackaged
  ? path.resolve(__dirname, '../../../..') : path.resolve(__dirname, '..', '..');
const store = new RecordingStore();
const ownedSessions = new Set();
const completedPaths = new Set();
let mainWindow = null;
let tray = null;
let preparedCapture = null;
let recordingId = null;
let beginning = false;
let active = { recording: false, paused: false };
let sleepBlockerId = null;
let shutdownKind = null;
let shutdownTimer = null;
let allowClose = false;
let allowQuit = false;
let recovering = false;

// Tests keep Chromium's mutable profile files within the workspace.
if (testMode) {
  const inlineArgument = process.argv.find((value) => value.startsWith('--user-data-dir='));
  const argumentIndex = process.argv.indexOf('--user-data-dir');
  const suppliedPath = inlineArgument?.slice('--user-data-dir='.length)
    || (argumentIndex >= 0 ? process.argv[argumentIndex + 1] : null)
    || process.env.SCREEN_RECORDER_TEST_USER_DATA
    || process.env.RECORDER_TEST_USER_DATA || process.env.RECORDER_USER_DATA_DIR;
  const profilePath = path.resolve(__dirname, suppliedPath || '.test-user-data');
  const relative = path.relative(testWorkspace, profilePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('--test-mode의 사용자 데이터 경로는 이 작업 폴더 안에 있어야 합니다.');
  }
  fs.mkdirSync(profilePath, { recursive: true });
  app.setPath('userData', profilePath);
}

app.setName('Screen Recorder');
if (process.platform === 'win32') app.setAppUserModelId('local.screen-recorder');

function isTrustedContents(contents) {
  return Boolean(mainWindow && !mainWindow.isDestroyed()
    && contents === mainWindow.webContents && contents.getURL() === entryURL);
}

function assertTrusted(event) {
  if (!isTrustedContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('허용되지 않은 녹화 요청입니다.');
  }
}

function handle(name, callback) {
  ipcMain.handle(`recorder:${name}`, async (event, ...args) => {
    assertTrusted(event);
    return callback(...args);
  });
}

function assertOwned(id) {
  if (typeof id !== 'string' || !ownedSessions.has(id)) {
    throw new Error('이 창에서 시작한 녹화 세션이 아닙니다.');
  }
}

function hasUnfinishedRecording() {
  return active.recording || Boolean(recordingId) || beginning;
}

async function captureSources(withThumbnails) {
  // Enumerating also triggers the first native screen permission prompt. macOS
  // reports 'denied' before a first request, so do not skip enumeration here.
  const ownId = mainWindow?.getMediaSourceId();
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: withThumbnails ? { width: 240, height: 135 } : { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return sources.filter((source) => source.id !== ownId);
}

function sendCommand(command) {
  if (!hasUnfinishedRecording() || !mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('recorder:command', command);
  }
}

function setActivity(next) {
  active = next;
  if (active.recording && sleepBlockerId === null) {
    sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!active.recording && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
  updateTray();
}

function trayImage() {
  const width = 24;
  const pixels = Buffer.alloc(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - 11.5, y - 11.5);
      const offset = (y * width + x) * 4;
      if (distance < 9.5) {
        pixels[offset] = 65;
        pixels[offset + 1] = 76;
        pixels[offset + 2] = 231;
        pixels[offset + 3] = 255;
      }
      if (Math.abs(x - 11.5) < 3.5 && Math.abs(y - 11.5) < 3.5) {
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height: width, scaleFactor: 1 });
}

function revealWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(active.recording ? (active.paused ? 'Screen Recorder · 일시정지' : 'Screen Recorder · 녹화 중') : 'Screen Recorder');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '녹화 프로그램 열기', click: revealWindow },
    { type: 'separator' },
    { label: active.paused ? '녹화 다시 시작' : '녹화 일시정지', enabled: active.recording, click: () => sendCommand('pause') },
    { label: '녹화 정지 및 저장', enabled: hasUnfinishedRecording(), click: () => sendCommand('stop') },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]));
}

function continueShutdown() {
  if (!shutdownKind || hasUnfinishedRecording() || recovering) return;
  clearTimeout(shutdownTimer);
  shutdownTimer = null;
  preparedCapture = null;
  const kind = shutdownKind;
  shutdownKind = null;
  if (kind === 'quit') {
    allowQuit = true;
    app.quit();
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    allowClose = true;
    mainWindow.close();
  }
}

async function preserveUnfinished(message) {
  if (recovering) return;
  recovering = true;
  preparedCapture = null;
  try {
    const results = await store.abandonAll();
    recordingId = null;
    beginning = false;
    setActivity({ recording: false, paused: false });
    const partials = results.filter((result) => result.partial && result.path);
    if (partials.length && !testMode) {
      const options = {
        type: 'warning', title: '부분 녹화 파일 보존',
        message, detail: `${partials.map((result) => result.path).join('\n')}\n\n이 파일은 정상 완료되지 않아 재생이나 복구가 제한될 수 있습니다.`,
        buttons: ['확인'], noLink: true,
      };
      if (mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, options);
      else await dialog.showMessageBox(options);
    }
  } catch (error) {
    console.error('[recorder] 부분 파일 보존 오류:', error.message);
    recordingId = null;
    beginning = false;
    setActivity({ recording: false, paused: false });
  } finally {
    recovering = false;
    continueShutdown();
  }
}

function requestShutdown(kind) {
  shutdownKind = shutdownKind === 'quit' ? 'quit' : kind;
  if (!hasUnfinishedRecording()) {
    continueShutdown();
    return;
  }
  sendCommand('stop');
  if (!shutdownTimer) {
    shutdownTimer = setTimeout(() => {
      void preserveUnfinished('녹화 종료가 15초 안에 완료되지 않아 현재까지의 데이터를 부분 파일로 보존했습니다.');
    }, 15_000);
  }
}

function setupCapturePermissions() {
  session.defaultSession.setPermissionCheckHandler((contents, permission) => (
    isTrustedContents(contents) && ['media', 'display-capture'].includes(permission)
  ));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const asksForCamera = permission === 'media' && details?.mediaTypes?.includes('video');
    callback(isTrustedContents(contents) && ['media', 'display-capture'].includes(permission) && !asksForCamera);
  });
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const selection = preparedCapture;
    // Consume before invoking Chromium. A selection cannot authorize a second
    // request or survive navigation, cancellation, crash or expiry.
    preparedCapture = null;
    if (!mainWindow || !isTrustedContents(mainWindow.webContents)
      || request.frame !== mainWindow.webContents.mainFrame
      || !request.userGesture || !request.videoRequested
      || !selection || selection.expiresAt < Date.now()) {
      callback(null);
      return;
    }
    const streams = { video: selection.source };
    if (selection.systemAudio && request.audioRequested && support.systemAudio) {
      streams.audio = 'loopback';
    }
    callback(streams);
  });
}

function setupIPC() {
  handle('getEnvironment', () => ({
    ...support,
    permissionApp: app.isPackaged ? 'Screen Recorder' : 'Electron',
    screenAccess: support.mac ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
    microphoneAccess: support.mac ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
  }));
  handle('openPrivacySettings', (kind) => {
    if (!support.mac || !['screen', 'microphone'].includes(kind)) throw new Error('지원하지 않는 권한 설정입니다.');
    return shell.openExternal(`${support.privacySettingsBase}${kind === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Microphone'}`);
  });
  handle('getSources', async () => {
    const sources = await captureSources(true);
    return sources.map((source) => ({
      id: source.id, name: source.name,
      thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    }));
  });
  handle('prepareCapture', async (options) => {
    preparedCapture = null;
    if (shutdownKind || recovering) throw new Error('녹화를 마무리하는 중입니다.');
    if (!options || typeof options.sourceId !== 'string' || options.sourceId.length > 512
      || typeof options.systemAudio !== 'boolean'
      || (options.microphone !== undefined && typeof options.microphone !== 'boolean')) {
      throw new Error('녹화할 화면과 소리 설정을 확인해 주세요.');
    }
    if (options.systemAudio && !support.systemAudio) throw new Error(support.systemAudioHelp);
    if (support.mac) {
      if (['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) {
        throw new Error('시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 이 앱을 허용한 뒤 앱을 다시 열어 주세요.');
      }
      // getUserMedia requests first-time microphone access after display capture.
      // Waiting for a native permission dialog here would expire getDisplayMedia's
      // required transient activation from the user's Start click.
      if (options.microphone && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('microphone'))) {
        throw new Error('마이크 접근을 허용하지 않았어요. 시스템 설정 → 개인정보 보호 및 보안 → 마이크에서 이 앱을 허용하거나 마이크 옵션을 꺼 주세요.');
      }
    }
    const source = (await captureSources(false)).find((item) => item.id === options.sourceId);
    if (!source) throw new Error('선택한 화면이나 창이 없어졌습니다. 다시 선택해 주세요.');
    preparedCapture = { source, systemAudio: options.systemAudio, expiresAt: Date.now() + 30_000 };
  });
  handle('beginRecording', async (options) => {
    if (!options || !['mp4', 'webm'].includes(options.extension)) {
      throw new Error('지원하지 않는 녹화 파일 형식입니다.');
    }
    if (recordingId || beginning || active.recording || shutdownKind || recovering) {
      throw new Error('진행 중인 녹화를 먼저 마무리해 주세요.');
    }
    beginning = true;
    try {
      const stamp = new Date().toISOString().replace('T', ' ').replace(/[:.]/g, '-').slice(0, 19);
      let result;
      if (testMode && process.env.SCREEN_RECORDER_TEST_SAVE_DIR) {
        const saveDirectory = path.resolve(process.env.SCREEN_RECORDER_TEST_SAVE_DIR);
        const relative = path.relative(testWorkspace, saveDirectory);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('테스트 녹화 저장 폴더는 이 작업 폴더 안에 있어야 합니다.');
        }
        await require('node:fs/promises').mkdir(saveDirectory, { recursive: true });
        result = { canceled: false, filePath: path.join(saveDirectory, `test-${Date.now()}-${require('node:crypto').randomUUID()}.${options.extension}`) };
      } else {
        result = await dialog.showSaveDialog(mainWindow, {
          title: '녹화 파일 저장 위치',
          defaultPath: path.join(app.getPath('videos'), `화면 녹화 ${stamp}.${options.extension}`),
          buttonLabel: '이 위치에 녹화',
          filters: [{ name: options.extension === 'mp4' ? 'MP4 동영상' : 'WebM 동영상', extensions: [options.extension] }],
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        });
      }
      if (result.canceled || !result.filePath || shutdownKind || recovering) return { cancelled: true };
      const extension = path.extname(result.filePath).toLowerCase();
      const destination = extension ? result.filePath : `${result.filePath}.${options.extension}`;
      if (path.extname(destination).toLowerCase() !== `.${options.extension}`) {
        throw new Error(`파일 이름의 확장자를 .${options.extension}로 지정해 주세요.`);
      }
      const recording = await store.begin(destination);
      if (shutdownKind || recovering) {
        await store.abandon(recording.id);
        return { cancelled: true };
      }
      recordingId = recording.id;
      ownedSessions.add(recording.id);
      updateTray();
      return recording;
    } finally {
      beginning = false;
      continueShutdown();
    }
  });
  handle('writeChunk', (id, data) => {
    assertOwned(id);
    if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_CHUNK_BYTES) {
      throw new Error('잘못된 녹화 데이터입니다.');
    }
    return store.writeChunk(id, data);
  });
  handle('finishRecording', async (id) => {
    assertOwned(id);
    const result = await store.finish(id);
    if (recordingId === id) recordingId = null;
    completedPaths.add(result.path);
    if (completedPaths.size > 20) completedPaths.delete(completedPaths.values().next().value);
    if (!shutdownKind && mainWindow?.isMinimized()) revealWindow();
    updateTray();
    return result;
  });
  handle('abandonRecording', async (id) => {
    assertOwned(id);
    const result = await store.abandon(id);
    if (recordingId === id) recordingId = null;
    if (result.path) {
      completedPaths.add(result.path);
      if (completedPaths.size > 20) completedPaths.delete(completedPaths.values().next().value);
    }
    if (!shutdownKind && mainWindow?.isMinimized()) revealWindow();
    updateTray();
    return result;
  });
  handle('setActive', (next) => {
    if (!next || typeof next.recording !== 'boolean' || typeof next.paused !== 'boolean'
      || (next.paused && !next.recording)) {
      throw new Error('잘못된 녹화 상태입니다.');
    }
    if (next.recording && !recordingId) throw new Error('저장 위치를 먼저 선택해 주세요.');
    if (!next.recording && recordingId) throw new Error('녹화 파일 저장을 먼저 완료해 주세요.');
    setActivity({ recording: next.recording, paused: next.paused });
    if (!next.recording) preparedCapture = null;
    continueShutdown();
  });
  handle('showFile', (filePath) => {
    if (typeof filePath !== 'string' || !completedPaths.has(filePath)) {
      throw new Error('이 프로그램에서 최근 저장한 녹화 파일만 열 수 있습니다.');
    }
    shell.showItemInFolder(filePath);
  });
  handle('minimize', () => mainWindow.minimize());
}

function createWindow() {
  allowClose = false;
  mainWindow = new BrowserWindow({
    width: 1160, height: 900, minWidth: 840, minHeight: 700,
    show: !testMode, title: '화면 녹화', backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, backgroundThrottling: false,
      offscreen: testMode,
    },
  });
  if (!support.mac) mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    preparedCapture = null;
    if (url !== entryURL) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (event) => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', () => {
    void preserveUnfinished('녹화 화면이 예기치 않게 종료되어 현재까지의 데이터를 부분 파일로 보존했습니다.');
  });
  mainWindow.on('close', (event) => {
    if (!allowClose && (hasUnfinishedRecording() || recovering)) {
      event.preventDefault();
      requestShutdown('close');
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-finish-load', () => {
    if (testMode) console.log('[recorder] ready (test-mode)');
  });
  void mainWindow.loadFile(entryPath);
}

app.whenReady().then(() => {
  setupCapturePermissions();
  setupIPC();
  if (support.mac) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Screen Recorder', submenu: [
        { role: 'about', label: 'Screen Recorder 정보' }, { type: 'separator' },
        { label: '화면 녹화 권한 설정…', click: () => { void shell.openExternal(`${support.privacySettingsBase}Privacy_ScreenCapture`); } },
        { type: 'separator' }, { role: 'hide', label: 'Screen Recorder 가리기' },
        { role: 'hideOthers', label: '기타 가리기' }, { role: 'unhide', label: '모두 보기' },
        { type: 'separator' }, { role: 'quit', label: 'Screen Recorder 종료' },
      ] },
      { role: 'editMenu', label: '편집' }, { role: 'windowMenu', label: '윈도우' },
    ]));
  }
  createWindow();
  if (!testMode) {
    tray = new Tray(trayImage());
    tray.on('double-click', revealWindow);
    updateTray();
    for (const [accelerator, command] of [
      [support.pauseShortcut, 'pause'], [support.stopShortcut, 'stop'],
    ]) {
      if (!globalShortcut.register(accelerator, () => sendCommand(command))) {
        console.warn(`[recorder] ${accelerator} 단축키를 다른 프로그램이 사용 중입니다.`);
      }
    }
  }
}).catch((error) => {
  console.error('[recorder] 시작 오류:', error.message);
  app.quit();
});

app.on('before-quit', (event) => {
  if (!allowQuit && (hasUnfinishedRecording() || recovering)) {
    event.preventDefault();
    requestShutdown('quit');
  }
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (sleepBlockerId !== null) powerSaveBlocker.stop(sleepBlockerId);
  if (tray && !tray.isDestroyed()) tray.destroy();
});
app.on('activate', () => { if (support.mac) revealWindow(); });
app.on('window-all-closed', () => { if (!support.mac || testMode) app.quit(); });
