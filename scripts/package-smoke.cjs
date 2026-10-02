'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {_electron:electron}=require('playwright-core');
const supplied=path.resolve(process.argv[2]);
const macBundle=supplied.endsWith('.app');
const exe=macBundle?path.join(supplied,'Contents','MacOS','Screen Recorder'):supplied;
const profile=macBundle?path.join(path.dirname(supplied),'.package-test-profile'):path.join(path.dirname(exe),'resources','.package-test-profile');
let application;
(async()=>{
 const env={...process.env,SCREEN_RECORDER_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
 application=await electron.launch({executablePath:exe,args:['--test-mode'],env,timeout:30000});
 const page=await application.firstWindow();
 await page.waitForFunction(()=>document.querySelector('#format').options.length>0);
 assert.equal(await page.title(),'화면 녹화');assert(await page.locator('#record').isDisabled());
 assert((await page.locator('#format').textContent()).includes('MP4'));
 const metadata=await application.evaluate(({app})=>({packaged:app.isPackaged,name:app.getName(),version:app.getVersion()}));
 assert.equal(metadata.packaged,true);
 const environment=await page.evaluate(()=>window.recorder.getEnvironment());
 assert.equal(environment.mac,macBundle);
 if(macBundle){assert.match(environment.pauseLabel,/Cmd/);assert.equal(environment.permissionApp,'Screen Recorder');}
 console.log('Packaged executable startup passed:',JSON.stringify(metadata));
})().catch((error)=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(application)await application.close();});
