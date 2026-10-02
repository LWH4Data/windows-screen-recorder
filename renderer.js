'use strict';

const $ = (id) => document.getElementById(id);
const api = window.recorder;
let environment = null;
let sources = [], sourceKind = 'screen', selectedSource = null;
let state = 'idle', mediaRecorder = null, displayStream = null, micStream = null;
let mixedStream = null, audioContext = null, micGain = null, recording = null;
let writeQueue = Promise.resolve(), writeError = null, encoderError = null, savedBytes = 0;
let startedAt = 0, elapsedBeforePause = 0, clockTimer = null, lastSavedPath = null;
let finalization = null, resolveFinalization = null, sessionWarnings = [];
let stopRequested = false;
let finalizing = false, pendingBytes = 0;

const formats = [
  {label: 'MP4 · 유튜브 / 편집용', extension: 'mp4', mime: 'video/mp4;codecs=avc1.42E02A,mp4a.40.2'},
  {label: 'MP4 · 유튜브 / 편집용', extension: 'mp4', mime: 'video/mp4;codecs=avc1.42001E,mp4a.40.2'},
  {label: 'MP4 · 유튜브 / 편집용', extension: 'mp4', mime: 'video/mp4'},
  {label: 'WebM · 대체 형식', extension: 'webm', mime: 'video/webm;codecs=vp8,opus'},
  {label: 'WebM · 대체 형식', extension: 'webm', mime: 'video/webm'}
];
const availableFormats = [];
for (const format of formats) {
  if (MediaRecorder.isTypeSupported(format.mime) && !availableFormats.some((f) => f.extension === format.extension)) {
    availableFormats.push(format);
  }
}
for (const [index, format] of availableFormats.entries()) {
  const option = document.createElement('option');
  option.value = String(index); option.textContent = format.label;
  $('format').append(option);
}
function updateFormatHelp() {
  const format = availableFormats[Number($('format').value)];
  $('format-help').textContent = format?.extension === 'mp4'
    ? '녹화 후 MP4 파일로 저장합니다.'
    : '이 컴퓨터의 대체 형식입니다. MP4가 필요하면 영상 편집기에서 변환할 수 있어요.';
}
$('format').addEventListener('change', updateFormatHelp);
updateFormatHelp();

function notify(message, kind = 'success', path = null) {
  $('notice').hidden = false;
  $('notice').className = `notice ${kind}`;
  $('notice-text').textContent = message;
  lastSavedPath = path;
  $('show-file').hidden = !path;
}
function setState(next) {
  state = next;
  const busy = ['preparing', 'recording', 'paused', 'saving'].includes(state);
  const capturing = state === 'recording' || state === 'paused';
  $('settings-fields').disabled = busy;
  $('refresh').disabled = busy;
  $('tab-screen').disabled = busy; $('tab-window').disabled = busy;
  document.querySelectorAll('.source-card').forEach((button) => { button.disabled = busy; });
  const screenDenied = environment?.mac && environment.screenAccess !== 'granted';
  $('record').disabled = state === 'preparing' || state === 'saving' || (!capturing && (!environment || screenDenied || !selectedSource || !availableFormats.length));
  $('pause').disabled = !capturing;
  $('pause').textContent = state === 'paused' ? '녹화 재개' : '일시정지';
  $('record-label').textContent = capturing ? '녹화 중지' : state === 'saving' ? '저장하는 중…' : state === 'preparing' ? '준비하는 중…' : '녹화 시작';
  $('record').classList.toggle('stopping', capturing);
  $('state-label').textContent = ({idle:'준비',preparing:'준비 중',recording:'녹화 중',paused:'일시정지',saving:'저장 중'})[state];
  $('state-dot').className = `state-dot ${capturing ? state : ''}`;
}
function displaySources() {
  const items = sources.filter((source) => source.kind === sourceKind);
  $('source-count').textContent = `${items.length}개`;
  $('sources').replaceChildren();
  if (!items.length) {
    const message = document.createElement('p'); message.className = 'source-message';
    message.textContent = sourceKind === 'screen' ? '녹화할 화면을 찾지 못했어요. 목록을 새로고침해 주세요.' : '녹화할 창을 열고 목록을 새로고침해 주세요.';
    $('sources').append(message);
  }
  for (const source of items) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `source-card ${source.id === selectedSource?.id ? 'selected' : ''}`;
    button.setAttribute('aria-pressed', String(source.id === selectedSource?.id));
    button.setAttribute('aria-label', `${source.name} 녹화 대상으로 선택`);
    button.title = source.name;
    const img = document.createElement('img'); img.src = source.thumbnail; img.alt = '';
    const name = document.createElement('span'); name.textContent = source.name;
    button.append(img, name); button.addEventListener('click', () => chooseSource(source));
    $('sources').append(button);
  }
  setState(state);
}
function chooseSource(source) {
  if (state !== 'idle') return;
  selectedSource = source;
  $('source-preview').src = source.thumbnail; $('source-preview').hidden = false;
  $('preview-empty').hidden = true; $('live-preview').hidden = true;
  $('preview-label').hidden = false; $('preview-label').textContent = source.name;
  $('recording-detail').textContent = source.name;
  displaySources();
}
async function refreshSources() {
  if (state !== 'idle') return;
  $('refresh').disabled = true;
  try {
    await refreshEnvironment();
    sources = await api.getSources();
    if (selectedSource && !sources.some((source) => source.id === selectedSource.id)) {
      selectedSource = null; $('source-preview').hidden = true;
      $('preview-empty').hidden = false; $('preview-label').hidden = true;
      $('recording-detail').textContent = '녹화할 화면을 선택해 주세요';
    } else if (selectedSource) {
      chooseSource(sources.find((source) => source.id === selectedSource.id));
    }
    displaySources();
    await refreshEnvironment();
  } catch (error) {
    notify(`화면 목록을 불러오지 못했어요. 목록 새로고침을 눌러 주세요. ${cleanError(error)}`, 'error');
  } finally { setState(state); }
}
async function refreshEnvironment() {
  environment = await api.getEnvironment();
  $('pause-shortcut').textContent = environment.pauseLabel;
  $('stop-shortcut').textContent = environment.stopLabel;
  $('mac-function-help').hidden = !environment.mac;
  $('mac-function-help').textContent = 'F 키가 음량·미디어를 조절하면 Fn 키도 함께 누르세요.';
  $('system-audio').disabled = !environment.systemAudio;
  if (!environment.systemAudio) $('system-audio').checked = false;
  $('audio-help').textContent = environment.systemAudioHelp;
  const screenMissing = environment.mac && environment.screenAccess !== 'granted';
  const micDenied = environment.mac && $('microphone').checked
    && ['denied', 'restricted'].includes(environment.microphoneAccess);
  $('permissions').hidden = !screenMissing && !micDenied;
  $('screen-permission').hidden = !screenMissing;
  $('mic-permission').hidden = !micDenied;
  $('permission-help').textContent = screenMissing
    ? `시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음(또는 화면 기록)에서 ${environment.permissionApp}를 허용해 주세요. 허용 후 앱을 다시 열거나 목록을 새로고침하세요.`
    : '시스템 설정 → 개인정보 보호 및 보안 → 마이크에서 이 앱을 허용하거나 마이크 옵션을 꺼 주세요.';
}
for (const [id, kind] of [['screen-permission', 'screen'], ['mic-permission', 'microphone']]) {
  $(id).addEventListener('click', () => api.openPrivacySettings(kind).catch((error) => notify(cleanError(error), 'error')));
}
function setSourceKind(kind) {
  if (state !== 'idle') return;
  sourceKind = kind;
  for (const current of ['screen','window']) {
    $(`tab-${current}`).setAttribute('aria-selected', String(current === kind));
    $(`tab-${current}`).tabIndex = current === kind ? 0 : -1;
  }
  $('sources').setAttribute('aria-labelledby', `tab-${kind}`);
  displaySources();
}
for (const kind of ['screen','window']) {
  $(`tab-${kind}`).addEventListener('click', () => setSourceKind(kind));
  $(`tab-${kind}`).addEventListener('keydown', (event) => {
    if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      event.preventDefault(); const target = event.key === 'Home' ? 'screen' : event.key === 'End' ? 'window' : kind === 'screen' ? 'window' : 'screen';
      setSourceKind(target); $(`tab-${target}`).focus();
    }
  });
}
function cleanError(error) {
  return String(error?.message || error || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 240);
}
function captureError(error) {
  if (error?.name === 'NotAllowedError') return environment?.mac
    ? '화면 또는 마이크 접근을 허용하지 않았어요. 시스템 설정 → 개인정보 보호 및 보안에서 이 앱의 화면 녹화·마이크 권한을 확인한 뒤 다시 열어 주세요.'
    : '화면 또는 마이크 접근을 허용하지 않았어요. Windows의 마이크 개인정보 설정을 확인한 뒤 다시 시도해 주세요.';
  if (error?.name === 'NotFoundError') return '사용할 마이크를 찾지 못했어요. 마이크를 연결하거나 마이크 옵션을 꺼 주세요.';
  if (error?.name === 'NotReadableError') return '화면이나 마이크를 사용할 수 없어요. 선택한 창이 열려 있는지, 장치를 다른 앱이 사용 중인지 확인해 주세요.';
  return `녹화를 시작하지 못했어요. 다시 화면을 선택한 뒤 시도해 주세요. ${cleanError(error)}`;
}
function elapsedMs() {
  return elapsedBeforePause + (state === 'recording' ? performance.now() - startedAt : 0);
}
function updateClock() {
  const seconds = Math.floor(elapsedMs()/1000);
  $('clock').textContent = [Math.floor(seconds/3600), Math.floor(seconds/60)%60, seconds%60].map((value) => String(value).padStart(2,'0')).join(':');
  if (state === 'recording' || state === 'paused') {
    const actual = displayStream?.getVideoTracks()[0]?.getSettings() || {};
    const size = actual.width && actual.height ? `${actual.width} × ${actual.height}` : '';
    const fps = actual.frameRate ? `${Math.round(actual.frameRate)}fps` : '';
    $('recording-detail').textContent = [size, fps, `${(savedBytes/1048576).toFixed(1)} MB`, ...(sessionWarnings.length ? ['소리 안내 확인 필요'] : [])].filter(Boolean).join(' · ');
  }
}
async function enumerateMicrophones() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
    const previous = $('mic-device').value;
    $('mic-device').replaceChildren();
    const defaultOption = document.createElement('option'); defaultOption.value = 'default'; defaultOption.textContent = '기본 마이크'; $('mic-device').append(defaultOption);
    devices.filter((device) => device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications').forEach((device,index) => {
      const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `마이크 ${index+1}`; $('mic-device').append(option);
    });
    if ([...$('mic-device').options].some((option) => option.value === previous)) $('mic-device').value = previous;
  } catch { /* The default microphone remains usable without enumeration. */ }
}
$('microphone').addEventListener('change', () => {
  $('mic-controls').hidden = !$('microphone').checked;
  if ($('microphone').checked) enumerateMicrophones();
  refreshEnvironment().catch((error) => notify(cleanError(error), 'error'));
});
$('mic-volume').addEventListener('input', () => {
  $('mic-volume-value').value = `${$('mic-volume').value}%`;
  if (micGain) micGain.gain.value = Number($('mic-volume').value)/100;
});

async function releaseMedia() {
  clearInterval(clockTimer); clockTimer = null;
  for (const stream of [displayStream, micStream, mixedStream]) stream?.getTracks().forEach((track) => track.stop());
  displayStream = null; micStream = null; mixedStream = null; micGain = null;
  $('live-preview').srcObject = null; $('live-preview').hidden = true;
  if (audioContext) { await audioContext.close().catch(() => {}); audioContext = null; }
  $('source-preview').hidden = !selectedSource;
}

async function startRecording() {
  if (state !== 'idle' || !selectedSource) return;
  setState('preparing'); $('notice').hidden = true; sessionWarnings = []; stopRequested = false;
  recording = null; mediaRecorder = null; finalization = null; writeError = null; encoderError = null; finalizing = false; pendingBytes = 0;
  elapsedBeforePause = 0; savedBytes = 0; updateClock();
  try {
    const sourceId = selectedSource.id;
    await api.prepareCapture({sourceId, systemAudio: $('system-audio').checked, microphone: $('microphone').checked});
    const fps = Number($('fps').value), resolution = $('resolution').value;
    const videoConstraints = {frameRate:{ideal:fps,max:fps}};
    if (resolution !== 'native') {
      videoConstraints.width = {max:resolution === '1080' ? 1920 : 1280};
      videoConstraints.height = {max:Number(resolution)};
    }
    displayStream = await navigator.mediaDevices.getDisplayMedia({video:videoConstraints,audio:$('system-audio').checked});
    if (!$('system-audio').checked) displayStream.getAudioTracks().forEach((track) => { track.stop(); displayStream.removeTrack(track); });
    if ($('system-audio').checked && !displayStream.getAudioTracks().length) throw new Error(environment.mac
      ? '컴퓨터 소리를 가져오지 못했어요. 시스템 설정의 화면 및 시스템 오디오 녹음 권한을 확인하거나 컴퓨터 소리 옵션을 꺼 주세요.'
      : '컴퓨터 소리를 가져오지 못했어요. 오디오 출력 장치를 확인하거나 컴퓨터 소리 옵션을 꺼 주세요.');
    if (displayStream.getAudioTracks().some((track) => track.readyState !== 'live')) {
      throw new Error('컴퓨터 소리 녹음이 중단됐어요. 이 앱의 시스템 오디오 녹음 권한을 확인하거나 컴퓨터 소리 옵션을 꺼 주세요.');
    }
    const videoTrack = displayStream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== 'live') throw new Error('선택한 화면을 사용할 수 없어요. 화면 목록을 새로고침해 주세요.');
    mixedStream = new MediaStream([videoTrack]);
    if ($('microphone').checked) {
      const deviceId = $('mic-device').value;
      micStream = await navigator.mediaDevices.getUserMedia({video:false,audio:{...(deviceId !== 'default' ? {deviceId:{exact:deviceId}} : {}),echoCancellation:true,noiseSuppression:true,autoGainControl:false}});
      await enumerateMicrophones();
    }
    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length || micStream?.getAudioTracks().length) {
      audioContext = new AudioContext({sampleRate:48000});
      await audioContext.resume();
      const destination = audioContext.createMediaStreamDestination();
      if (audioTracks.length) {
        const source = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
        const gain = audioContext.createGain(); gain.gain.value = micStream ? 0.65 : 1;
        source.connect(gain).connect(destination);
      }
      if (micStream) {
        const source = audioContext.createMediaStreamSource(micStream);
        micGain = audioContext.createGain(); micGain.gain.value = Number($('mic-volume').value)/100;
        source.connect(micGain).connect(destination);
      }
      mixedStream.addTrack(destination.stream.getAudioTracks()[0]);
    }
    const format = availableFormats[Number($('format').value)];
    const bitrate = ($('quality').value === 'high' ? 16 : fps === 60 ? 12 : 8)*1000000;
    mediaRecorder = new MediaRecorder(mixedStream,{mimeType:format.mime,videoBitsPerSecond:bitrate,audioBitsPerSecond:192000});
    const selected = await api.beginRecording({extension:format.extension});
    if (selected.cancelled) {
      await releaseMedia(); setState('idle'); notify('저장 위치 선택을 취소했어요. 녹화를 시작하면 다시 선택할 수 있습니다.', 'warning'); return;
    }
    recording = selected; writeQueue = Promise.resolve();
    finalization = new Promise((resolve) => { resolveFinalization = resolve; });
    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (!event.data.size) return;
      pendingBytes += event.data.size;
      writeQueue = writeQueue.then(async () => {
        if (writeError) return;
        // timeslice is advisory: a suspended machine can deliver a large Blob.
        // Split the same container bytes without exceeding the IPC size limit.
        const sliceSize = 16*1048576;
        for (let offset = 0; offset < event.data.size; offset += sliceSize) {
          const chunk = await event.data.slice(offset,offset+sliceSize).arrayBuffer();
          const result = await api.writeChunk(recording.id,chunk);
          savedBytes = result.bytes;
        }
      }).catch((error) => {
        if (!writeError) { writeError = error; notify(`파일에 기록하지 못했어요. 저장 공간을 확인해 주세요. ${cleanError(error)}`,'error'); requestStop(); }
      }).finally(() => { pendingBytes -= event.data.size; });
      if (pendingBytes > 64*1048576 && state === 'recording') {
        sessionWarnings.push('저장 장치 속도가 느려 녹화를 중지했어요. 더 빠른 저장 장치를 선택해 주세요.');
        requestStop();
      }
    });
    mediaRecorder.addEventListener('stop', finishRecording, {once:true});
    mediaRecorder.addEventListener('error', (event) => {
      encoderError = event.error || new Error('영상 인코더 오류');
      notify(`영상 인코더가 중단됐어요. 녹화 파일을 보존합니다. ${cleanError(encoderError)}`,'error'); requestStop();
    });
    videoTrack.addEventListener('ended', () => {
      if (state === 'recording' || state === 'paused') { sessionWarnings.push('녹화 대상이 닫혀 자동으로 중지했어요.'); requestStop(); }
    },{once:true});
    const originalAudioTracks = [...displayStream.getAudioTracks(), ...(micStream?.getAudioTracks() || [])];
    originalAudioTracks.forEach((track) => track.addEventListener('ended', () => {
      if (state === 'recording' || state === 'paused') { sessionWarnings.push('녹음 장치가 연결 해제되어 녹화를 중지했어요.'); requestStop(); }
    },{once:true}));
    if ([...displayStream.getTracks(), ...(micStream?.getTracks() || [])].some((track) => track.readyState !== 'live')) {
      throw new Error('준비 중 녹화 대상이나 녹음 장치가 닫혔어요. 다시 선택해 주세요.');
    }
    await api.setActive({recording:true,paused:false});
    mediaRecorder.start(1000);
    startedAt = performance.now(); setState('recording');
    $('live-preview').srcObject = displayStream; $('live-preview').hidden = false;
    $('source-preview').hidden = true;
    clockTimer = setInterval(updateClock,250); updateClock();
    if (stopRequested) requestStop();
    else if ($('auto-minimize').checked) await api.minimize();
  } catch (error) {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') { encoderError = error; requestStop(); return; }
    if (recording) await api.abandonRecording(recording.id).catch(() => {});
    await releaseMedia(); await api.setActive({recording:false,paused:false}).catch(() => {});
    recording = null; mediaRecorder = null; setState('idle');
    if (resolveFinalization) { resolveFinalization(); resolveFinalization = null; }
    notify(captureError(error),'error');
    await refreshEnvironment().catch(() => {});
  }
}

function requestStop() {
  if (state === 'preparing') { stopRequested = true; return finalization; }
  if (state !== 'recording' && state !== 'paused') return finalization;
  if (state === 'recording') elapsedBeforePause += performance.now()-startedAt;
  setState('saving'); updateClock();
  clearInterval(clockTimer); clockTimer = null;
  // An encoder error can set the recorder inactive before its final dataavailable
  // and stop events. The stop listener must finish only after that last chunk.
  if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop();
  return finalization;
}
async function finishRecording() {
  if (!recording || finalizing) return;
  finalizing = true;
  const session = recording;
  try {
    await writeQueue;
    if (writeError || encoderError) {
      const result = await api.abandonRecording(session.id);
      const path = result?.path || `${session.path}.recording`;
      const recovery = writeError ? '저장 공간을 확인한 뒤 다시 시도해 주세요.' : '화질이나 프레임을 낮춰 다시 시도해 주세요.';
      notify(`녹화가 중단됐어요. 임시 파일을 보존했습니다: ${path}. ${recovery}`,'error',path);
    } else {
      const result = await api.finishRecording(session.id);
      savedBytes = result.bytes;
      const filename = result.path.split(/[\\/]/).pop();
      notify(`${sessionWarnings.length ? sessionWarnings.join(' ')+' ' : ''}저장 완료: ${filename} · ${(result.bytes/1048576).toFixed(1)} MB`,sessionWarnings.length ? 'warning' : 'success',result.path);
    }
  } catch (error) {
    const result = await api.abandonRecording(session.id).catch(() => null);
    notify(`영상을 저장하지 못했어요. ${cleanError(error)}${result?.path ? ` 임시 파일: ${result.path}` : ''}`,'error',result?.path || null);
  } finally {
    await releaseMedia(); recording = null; mediaRecorder = null;
    await api.setActive({recording:false,paused:false}).catch(() => {});
    setState('idle');
    if (resolveFinalization) { resolveFinalization(); resolveFinalization = null; }
  }
}
async function togglePause() {
  if (state === 'recording') {
    mediaRecorder.pause(); elapsedBeforePause += performance.now()-startedAt;
    setState('paused'); updateClock();
    await api.setActive({recording:true,paused:true});
  } else if (state === 'paused') {
    mediaRecorder.resume(); startedAt = performance.now();
    setState('recording'); updateClock();
    await api.setActive({recording:true,paused:false});
  }
}
$('record').addEventListener('click', () => { if (state === 'idle') startRecording(); else requestStop(); });
$('pause').addEventListener('click', () => togglePause().catch((error) => { notify(cleanError(error),'error'); requestStop(); }));
$('refresh').addEventListener('click', refreshSources);
$('show-file').addEventListener('click', () => { if (lastSavedPath) api.showFile(lastSavedPath).catch((error) => notify(cleanError(error),'error')); });
api.onCommand((command) => {
  if (command === 'pause') togglePause().catch((error) => { notify(cleanError(error),'error'); requestStop(); });
  else if (command === 'stop') requestStop();
});
if (!availableFormats.length) notify('이 컴퓨터에서 지원하는 영상 인코더를 찾지 못했어요. 다른 컴퓨터에서 실행해 주세요.','error');
refreshSources();
