'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const {spawn}=require('node:child_process');
const {_electron:electron}=require('playwright-core');
const project=path.resolve(__dirname,'..');
const bundle=process.argv[2]?path.resolve(process.argv[2]):null;
const work=bundle?path.dirname(bundle):path.resolve(project,'..');
let application;
let player;
const tonePath=path.join(work,'capture-smoke-tone.wav');
(async()=>{
  const env={...process.env,SCREEN_RECORDER_TEST_USER_DATA:path.join(work,'capture-smoke-profile')};delete env.ELECTRON_RUN_AS_NODE;
  application=await electron.launch({executablePath:bundle?path.join(bundle,'Contents','MacOS','Screen Recorder'):require('electron'),args:bundle?['--test-mode']:[project,'--test-mode'],env,timeout:30000});
  const page=await application.firstWindow();
  // Capture only a dedicated, synthetic native window. No video or thumbnails
  // of the user's desktop are saved or included in the result.
  await application.evaluate(async({BrowserWindow})=>{
    const target=new BrowserWindow({width:640,height:360,title:'Recorder native capture test',show:true,webPreferences:{nodeIntegration:false,contextIsolation:true}});
    await target.loadURL('data:text/html,'+encodeURIComponent('<!doctype html><title>Recorder native capture test</title><body style="background:#19334c;color:white;font:32px sans-serif">Screen Recorder capture test</body>'));
  });
  const environment=await page.evaluate(()=>window.recorder.getEnvironment());
  if(environment.mac&&environment.screenAccess!=='granted')throw new Error('Screen recording permission must be granted manually for this native capture test.');
  if(environment.mac&&environment.systemAudio){
    // A quiet synthetic tone verifies actual loopback samples; a live but silent
    // track is not sufficient evidence on macOS. The captured samples stay in RAM.
    const rate=48000,samples=rate*2,data=Buffer.alloc(44+samples*2);
    data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);
    data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(samples*2,40);
    for(let i=0;i<samples;i++)data.writeInt16LE(Math.round(330*Math.sin(2*Math.PI*440*i/rate)),44+i*2);
    await fs.writeFile(tonePath,data);
  }
  await page.evaluate(()=>{
    const button=document.createElement('button');button.id='capture-smoke';button.textContent='Test';button.style.position='fixed';button.style.top='0';button.style.left='0';button.style.zIndex='9999';
    button.addEventListener('click',async()=>{
      let stream;
      let context;
      try{
        const available=await window.recorder.getSources();const source=available.find((item)=>item.name==='Recorder native capture test');
        if(!source)throw new Error('No synthetic capture window');
        const environment=await window.recorder.getEnvironment();
        await window.recorder.prepareCapture({sourceId:source.id,systemAudio:environment.systemAudio,microphone:false});
        stream=await navigator.mediaDevices.getDisplayMedia({video:{width:{max:1920},height:{max:1080},frameRate:{ideal:30,max:30}},audio:environment.systemAudio});
        window.__captureReady=true;
        let peakRms=0;
        if(environment.mac&&stream.getAudioTracks().length){
          context=new AudioContext();await context.resume();
          const analyser=context.createAnalyser();analyser.fftSize=2048;
          context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(analyser);
          const samples=new Float32Array(analyser.fftSize);
          for(let i=0;i<30;i++){
            await new Promise(resolve=>setTimeout(resolve,50));analyser.getFloatTimeDomainData(samples);
            peakRms=Math.max(peakRms,Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length));
          }
        }else await new Promise(resolve=>setTimeout(resolve,1500));
        // Track creation alone can conceal a failed macOS audio backend.
        const settings=stream.getVideoTracks()[0].getSettings();
        window.__captureSmoke={videoTracks:stream.getVideoTracks().length,audioTracks:stream.getAudioTracks().length,videoReady:stream.getVideoTracks()[0].readyState,audioReady:stream.getAudioTracks()[0]?.readyState,width:settings.width,height:settings.height,systemAudioExpected:environment.systemAudio,peakRms};
      }catch(error){window.__captureSmoke={error:error.name+': '+error.message};}
      finally{stream?.getTracks().forEach((track)=>track.stop());await context?.close();}
    });document.body.append(button);
  });
  await page.locator('#capture-smoke').click();
  if(environment.mac&&environment.systemAudio){
    await page.waitForFunction(()=>window.__captureReady||window.__captureSmoke,{},{timeout:20000});
    if(await page.evaluate(()=>Boolean(window.__captureReady)))player=spawn('/usr/bin/afplay',[tonePath],{stdio:'ignore'});
  }
  await page.waitForFunction(()=>window.__captureSmoke,{},{timeout:20000});
  const result=await page.evaluate(()=>window.__captureSmoke);
  assert(!result.error,result.error);assert.equal(result.videoTracks,1);assert.equal(result.videoReady,'live');
  if(result.systemAudioExpected){assert.equal(result.audioTracks,1);assert.equal(result.audioReady,'live');}
  if(environment.mac&&environment.systemAudio)assert(result.peakRms>0.0001,'Native system audio contains the played test signal');
  await fs.writeFile(path.join(work,'capture-smoke-result.json'),JSON.stringify(result,null,2));
  console.log('Native synthetic window capture passed:',JSON.stringify(result));
})().catch((error)=>{console.error(error);process.exitCode=1;}).finally(async()=>{player?.kill();if(application)await application.close();await fs.rm(tonePath,{force:true});});
