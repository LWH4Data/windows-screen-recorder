'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const project = path.resolve(__dirname,'..');
const work = path.resolve(project,'..');
const saveDir = path.join(work,'test-recordings');
const reviewDir = path.join(project,'.impeccable','review');
let application;
const errors = [];
(async () => {
  await fs.mkdir(reviewDir,{recursive:true});
  const env = {...process.env,SCREEN_RECORDER_TEST_USER_DATA:path.join(work,'test-user-data'),SCREEN_RECORDER_TEST_SAVE_DIR:saveDir};
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({executablePath:require('electron'),args:[project,'--test-mode'],env,timeout:30000});
  const page = await application.firstWindow();
  page.on('pageerror',(error) => errors.push(error.message));
  // A deterministic source fixture avoids taking thumbnails of personal windows
  // and lets this encoder/storage test run without macOS screen permission.
  await application.evaluate(({desktopCapturer, nativeImage, systemPreferences}) => {
    desktopCapturer.getSources = async () => [{id:'screen:synthetic:0',name:'합성 테스트 화면',thumbnail:nativeImage.createEmpty()}];
    if (process.platform === 'darwin') {
      systemPreferences.getMediaAccessStatus = () => 'granted';
      systemPreferences.askForMediaAccess = async () => true;
    }
  });
  await page.evaluate(() => refreshSources());
  await page.waitForSelector('.source-card',{timeout:20000});
  const support = await page.evaluate(() => [...document.querySelector('#format').options].map((option)=>option.textContent));
  assert(support.length>0,'At least one encoding format is available');
  console.log('Supported formats:',support.join(', '));
  assert(await page.locator('#record').isDisabled(),'Start is disabled without a selected source');
  // Replace thumbnail imagery for review only, so desktop contents never enter screenshots.
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width=640;canvas.height=360;
    const context=canvas.getContext('2d');context.fillStyle='#243349';context.fillRect(0,0,640,360);
    context.fillStyle='#d3dfef';context.font='24px sans-serif';context.fillText('Screen capture preview',35,60);
    context.fillStyle='#7ea7de';context.fillRect(35,100,370,12);context.fillRect(35,135,470,12);
    window.__testThumbnail=canvas.toDataURL();
    sources.forEach((source,index)=>{source.thumbnail=window.__testThumbnail;source.name=source.kind==='screen'?`화면 ${index+1}`:`테스트 창 ${index+1}`;});
    displaySources();
  });
  await page.locator('.source-card').first().click();
  await page.locator('#auto-minimize').uncheck();
  if (!process.env.SCREEN_RECORDER_TEST_NO_SCREENSHOTS) await page.screenshot({path:path.join(reviewDir,'desktop.png'),fullPage:true});
  console.log('Desktop screenshot captured.');
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(840,720));
  if (!process.env.SCREEN_RECORDER_TEST_NO_SCREENSHOTS) await page.screenshot({path:path.join(reviewDir,'compact.png'),fullPage:true});
  console.log('Compact screenshot captured.');
  const overflows=await page.evaluate(()=>({horizontal:document.documentElement.scrollWidth>innerWidth,vertical:document.documentElement.scrollHeight>innerHeight}));
  assert.equal(overflows.horizontal,false,'No horizontal overflow in the compact window');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1120,850));

  // Real MediaRecorder, mixer, IPC and disk writes; synthetic capture avoids personal footage.
  await page.evaluate(() => {
    window.__testCaptureContexts=[];window.__testDrawingTimers=[];
    navigator.mediaDevices.getDisplayMedia=async (options)=> {
      const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
      const context=canvas.getContext('2d');let frame=0;
      const draw=()=>{context.fillStyle='#19334c';context.fillRect(0,0,1920,1080);context.fillStyle='#fff';context.font='64px sans-serif';context.fillText(`Recorder test ${frame++}`,90,180);context.fillStyle='#e37053';context.fillRect(90+(frame*9)%1400,450,330,240);};
      draw();window.__testDrawingTimers.push(setInterval(draw,33));
      const stream=canvas.captureStream(30);
      if(options.audio){const audio=new AudioContext({sampleRate:48000});const oscillator=audio.createOscillator();oscillator.frequency.value=440;const destination=audio.createMediaStreamDestination();const volume=audio.createGain();volume.gain.value=.05;oscillator.connect(volume).connect(destination);oscillator.start();await audio.resume();stream.addTrack(destination.stream.getAudioTracks()[0]);window.__testCaptureContexts.push(audio);}
      return stream;
    };
    navigator.mediaDevices.getUserMedia=async()=>{const audio=new AudioContext({sampleRate:48000});const oscillator=audio.createOscillator();oscillator.frequency.value=880;const volume=audio.createGain();volume.gain.value=.05;const destination=audio.createMediaStreamDestination();oscillator.connect(volume).connect(destination);oscillator.start();await audio.resume();window.__testCaptureContexts.push(audio);return destination.stream;};
  });
  await page.locator('#microphone').check();
  await page.locator('#record').click();
  await page.waitForFunction(()=>document.querySelector('#state-label').textContent==='녹화 중');
  console.log('Synthetic recording started.');
  assert(await page.locator('#resolution').isDisabled(),'Settings lock during recording');
  await page.waitForFunction(()=>document.querySelector('#clock').textContent!=='00:00:00');
  await page.locator('#pause').click();
  await page.waitForFunction(()=>document.querySelector('#state-label').textContent==='일시정지');
  const paused=await page.locator('#clock').textContent();
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('#clock').textContent(),paused,'Paused time is excluded');
  await page.locator('#pause').click();
  await page.waitForFunction(()=>document.querySelector('#state-label').textContent==='녹화 중');
  await page.waitForTimeout(1300);
  await page.locator('#record').click();
  await page.waitForFunction(()=>document.querySelector('#notice-text').textContent.startsWith('저장 완료:'),{},{timeout:15000});
  const resultPath=await page.evaluate(()=>lastSavedPath);
  const encoded=await fs.readFile(resultPath);
  console.log('Encoded video saved:',encoded.length,'bytes.');
  assert(encoded.length>1000,'A nonempty video is saved');
  if(resultPath.endsWith('.mp4')){
    assert(encoded.includes(Buffer.from('ftyp')),'MP4 container header');
    assert(encoded.includes(Buffer.from('avc1'))||encoded.includes(Buffer.from('avc3')),'H.264 video track');
    assert(encoded.includes(Buffer.from('mp4a')),'AAC audio track');
  }
  const metadata=await page.evaluate(async({base64,mime})=>{
    const binary=atob(base64);const bytes=Uint8Array.from(binary,(character)=>character.charCodeAt(0));
    const url=URL.createObjectURL(new Blob([bytes],{type:mime}));const video=document.createElement('video');video.muted=true;video.src=url;
    await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Saved video cannot be decoded'));});
    await video.play();await new Promise((resolve)=>setTimeout(resolve,300));
    const result={width:video.videoWidth,height:video.videoHeight,duration:Number.isFinite(video.duration)?video.duration:'infinite',time:video.currentTime};video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);return result;
  },{base64:encoded.toString('base64'),mime:resultPath.endsWith('.mp4')?'video/mp4':'video/webm'});
  assert.equal(metadata.width,1920);assert.equal(metadata.height,1080);assert(metadata.time>0,'Saved video plays');
  assert.equal(await page.locator('#resolution').isDisabled(),false,'Settings unlock after saving');
  assert.equal(await page.locator('#pause').isDisabled(),true);

  // Permission errors are recoverable and expose the corresponding settings.
  if (process.platform === 'darwin') {
    assert.match(await page.locator('#pause-shortcut').textContent(), /Cmd/);
    await application.evaluate(({systemPreferences}) => {
      systemPreferences.getMediaAccessStatus = (kind) => kind === 'screen' ? 'denied' : 'granted';
    });
    await page.evaluate(() => refreshSources());
    assert.equal(await page.locator('#permissions').isVisible(),true);
    assert.equal(await page.locator('#screen-permission').isVisible(),true);
    assert.equal(await page.locator('#record').isDisabled(),true);
    await application.evaluate(({systemPreferences}) => {
      systemPreferences.getMediaAccessStatus = (kind) => kind === 'microphone' ? 'denied' : 'granted';
      systemPreferences.askForMediaAccess = async () => false;
    });
    await page.evaluate(() => refreshSources());
    await page.locator('.source-card').first().click();
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#notice-text').textContent.includes('마이크 접근을 허용하지 않았어요'));
    assert.equal(await page.locator('#mic-permission').isVisible(),true);
    assert.equal(await page.locator('#state-label').textContent(),'준비');
    await application.evaluate(({systemPreferences}) => {
      systemPreferences.getMediaAccessStatus = () => 'granted';
      systemPreferences.askForMediaAccess = async () => true;
    });
    await page.evaluate(() => refreshSources());
  }

  // A second recording exercises source-end auto-save and the screen-only path.
  await page.locator('#microphone').uncheck();await page.locator('#system-audio').uncheck();
  if (support.some((label)=>label.startsWith('WebM'))) await page.locator('#format').selectOption({label:'WebM · 대체 형식'});
  await page.locator('#record').click();await page.waitForFunction(()=>document.querySelector('#state-label').textContent==='녹화 중');
  await page.waitForTimeout(1200);
  await page.evaluate(()=>displayStream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await page.waitForFunction(()=>document.querySelector('#notice-text').textContent.includes('자동으로 중지했어요')&&document.querySelector('#state-label').textContent==='준비',{},{timeout:15000});
  const endedPath=await page.evaluate(()=>lastSavedPath);assert((await fs.stat(endedPath)).size>1000);
  await page.evaluate(()=>{window.__testDrawingTimers.forEach(clearInterval);return Promise.all(window.__testCaptureContexts.map((context)=>context.close()));});
  assert.deepEqual(errors,[],'No renderer uncaught errors');
  await fs.writeFile(path.join(work,'integration-result.json'),JSON.stringify({supportedFormats:support,savedVideo:path.basename(resultPath),bytes:encoded.length,metadata,compactWindow:overflows,rendererErrors:errors},null,2));
  console.log('Integration passed:',JSON.stringify({bytes:encoded.length,metadata,compactWindow:overflows}));
})().catch((error)=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(application)await application.close();});
