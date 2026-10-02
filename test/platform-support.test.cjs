'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { platformSupport } = require('../platform-support.cjs');

test('macOS 13 and 14.0/14.1 retain screen/mic recording without unavailable system audio', () => {
  for (const release of ['22.6.0', '23.0.0', '23.1.0']) {
    const support = platformSupport('darwin', release);
    assert.equal(support.mac, true);
    assert.equal(support.systemAudio, false);
    assert.match(support.systemAudioHelp, /14\.2/);
  }
});
test('CoreAudio Tap audio is enabled from macOS 14.2 and on current macOS', () => {
  for (const release of ['23.2.0', '23.6.0', '24.0.0', '25.6.0']) {
    assert.equal(platformSupport('darwin', release).systemAudio, true);
  }
});
test('Mac keyboard shortcuts and privacy links use native platform conventions', () => {
  const support = platformSupport('darwin', '25.6.0');
  assert.equal(support.pauseShortcut, 'Command+Shift+F9');
  assert.equal(support.stopShortcut, 'Command+Shift+F10');
  assert.match(support.privacySettingsBase, /PrivacySecurity\.extension/);
});
test('Windows audio and Ctrl shortcuts stay available; unsupported platforms do not claim audio', () => {
  const support = platformSupport('win32', '10.0.26100');
  assert.equal(support.mac, false);
  assert.equal(support.systemAudio, true);
  assert.equal(support.pauseShortcut, 'Control+Shift+F9');
  assert.equal(support.stopShortcut, 'Control+Shift+F10');
  assert.equal(platformSupport('linux', '6.8.0').systemAudio, false);
});
