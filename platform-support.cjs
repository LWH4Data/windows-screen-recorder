'use strict';

// Darwin 23.2 corresponds to macOS 14.2, where CoreAudio Tap capture is available.
// Electron 44 runs on macOS 13+, which can still record screen/microphone video.
function platformSupport(platform, release) {
  const mac = platform === 'darwin';
  const darwinMajor = Number(String(release).split('.')[0]);
  const darwinMinor = Number(String(release).split('.')[1] || 0);
  const systemAudio = platform === 'win32' || (mac && (darwinMajor > 23 || (darwinMajor === 23 && darwinMinor >= 2)));
  return {
    platform, mac, systemAudio,
    systemAudioHelp: systemAudio
      ? '창을 선택해도 컴퓨터 전체의 소리가 녹음됩니다.'
      : mac ? '컴퓨터 소리 녹음은 macOS 14.2 이상에서 사용할 수 있어요. 화면과 마이크는 녹화할 수 있습니다.'
        : '이 운영체제에서는 컴퓨터 소리 녹음을 지원하지 않아요.',
    pauseShortcut: mac ? 'Command+Shift+F9' : 'Control+Shift+F9',
    stopShortcut: mac ? 'Command+Shift+F10' : 'Control+Shift+F10',
    pauseLabel: mac ? 'Cmd + Shift + F9' : 'Ctrl + Shift + F9',
    stopLabel: mac ? 'Cmd + Shift + F10' : 'Ctrl + Shift + F10',
    privacySettingsBase: mac && darwinMajor >= 22
      ? 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?'
      : 'x-apple.systempreferences:com.apple.preference.security?',
  };
}

module.exports = { platformSupport };
