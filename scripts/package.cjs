'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const project = path.resolve(__dirname,'..');
  const outputs = process.env.SCREEN_RECORDER_OUTPUT_DIR ? path.resolve(process.env.SCREEN_RECORDER_OUTPUT_DIR) : path.join(project,'dist');
  const destination = path.join(outputs,'ScreenRecorder-Windows');
  const electronDist = path.dirname(require('electron'));
  const exe = path.join(destination,'ScreenRecorder.exe');
  try { await fs.access(exe); throw new Error('A previous package exists. Choose a new output name.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(destination,{recursive:true});
  // Copy the runtime and its bundled license notices without changing the installation.
  await fs.cp(electronDist,destination,{recursive:true});
  await fs.rename(path.join(destination,'electron.exe'),exe);
  const appDir = path.join(destination,'resources','app');
  await fs.mkdir(appDir,{recursive:true});
  const files = ['main.cjs','preload.cjs','recording-store.cjs','renderer.js','index.html','style.css'];
  for (const file of files) await fs.copyFile(path.join(project,file),path.join(appDir,file));
  await fs.writeFile(path.join(appDir,'package.json'),JSON.stringify({name:'screen-recorder',version:'1.0.0',main:'main.cjs',private:true},null,2)+'\n');
  await fs.copyFile(path.join(project,'사용법.txt'),path.join(destination,'사용법.txt'));
  await fs.copyFile(path.join(project,'사용법.txt'),path.join(outputs,'화면녹화-사용법.txt'));
  console.log(exe);
})().catch((error) => { console.error(error); process.exitCode=1; });
