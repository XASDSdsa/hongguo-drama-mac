const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createDownloadRouter} = require('./download-source-router');
const row = {url:'https://cdn.example/full.mp4',vid:'11',width:1080,height:1920,format:'mp4',codec:'hevc',contentKey:'1'.repeat(32),sourceProvider:'openhongguo'};
test('new provider precedes official and selects full HD MP4 with compatible backups', async () => {
  const route = createDownloadRouter(async (vid,options) => {
    assert.equal(vid,'11'); assert.equal(options.quality,'720p');
    return {candidates:[{...row,width:720,height:1280},row,{...row,url:'https://cdn.example/backup.mp4'}]};
  });
  const selected = await route('11',()=>assert.fail('must not request official after success'));
  assert.equal(selected.width,1080); assert.equal(selected.backupUrls.length,1);
});
test('limited, failed, missing, wrong-episode, HLS and low quality fall back once', async () => {
  for (const value of ['ANONYMOUS_LIMITED','ERR_NETWORK',null,{...row,vid:'12'},{...row,format:'hls'},{...row,width:360}]) {
    let calls=0;
    const route=createDownloadRouter(async()=>{if(typeof value==='string')throw Object.assign(new Error(value),{code:value});return value || {};});
    assert.equal(await route('11',()=>{calls++;return 'official';}),'official'); assert.equal(calls,1);
  }
});
test('cancellation and invalid episode never start fallback', async()=>{
  const route=createDownloadRouter(async()=>{throw Object.assign(new Error('cancel'),{code:'ERR_CANCELED'});});
  await assert.rejects(route('11',()=>assert.fail()),{code:'ERR_CANCELED'});
  await assert.rejects(route('../11',()=>assert.fail()),/分集编号/);
});
test('anonymous limit uses SDK before official fallback', async()=>{
  const route=createDownloadRouter(async()=>{throw Object.assign(new Error('limited'),{code:'ANONYMOUS_LIMITED'});},async vid=>{assert.equal(vid,'11');return {...row,sourceProvider:'sdk'};});
  assert.equal((await route('11',()=>assert.fail('SDK succeeded'))).sourceProvider,'sdk');
});
