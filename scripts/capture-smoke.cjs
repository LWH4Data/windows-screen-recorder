'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const {_electron:electron}=require('playwright-core');
const project=path.resolve(__dirname,'..'),work=path.resolve(project,'..');
let application;
(async()=>{
  const env={...process.env,SCREEN_RECORDER_TEST_USER_DATA:path.join(work,'capture-smoke-profile')};delete env.ELECTRON_RUN_AS_NODE;
  application=await electron.launch({executablePath:require('electron'),args:[project,'--test-mode'],env,timeout:30000});
  const page=await application.firstWindow();
  await page.waitForSelector('.source-card');
  await page.evaluate(()=>{
    const button=document.createElement('button');button.id='capture-smoke';button.textContent='Test';button.style.position='fixed';button.style.top='0';button.style.left='0';button.style.zIndex='9999';
    button.addEventListener('click',async()=>{
      let stream;
      try{
        const available=await window.recorder.getSources();const source=available.find((item)=>item.kind==='screen');
        if(!source)throw new Error('No display capture source');
        await window.recorder.prepareCapture({sourceId:source.id,systemAudio:true});
        stream=await navigator.mediaDevices.getDisplayMedia({video:{width:{max:1920},height:{max:1080},frameRate:{ideal:30,max:30}},audio:true});
        const settings=stream.getVideoTracks()[0].getSettings();
        window.__captureSmoke={videoTracks:stream.getVideoTracks().length,audioTracks:stream.getAudioTracks().length,videoReady:stream.getVideoTracks()[0].readyState,width:settings.width,height:settings.height};
      }catch(error){window.__captureSmoke={error:error.name+': '+error.message};}
      finally{stream?.getTracks().forEach((track)=>track.stop());}
    });document.body.append(button);
  });
  await page.locator('#capture-smoke').click();
  await page.waitForFunction(()=>window.__captureSmoke,{},{timeout:15000});
  const result=await page.evaluate(()=>window.__captureSmoke);
  assert(!result.error,result.error);assert.equal(result.videoTracks,1);assert.equal(result.videoReady,'live');assert.equal(result.audioTracks,1);
  await fs.writeFile(path.join(work,'capture-smoke-result.json'),JSON.stringify(result,null,2));
  console.log('Native display + system audio capture passed:',JSON.stringify(result));
})().catch((error)=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(application)await application.close();});
