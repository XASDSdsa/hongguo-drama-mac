const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {MODULES,VERSION,envelope,descendants,fingerprint}=require('../src/native/video-structure/contracts');
const {timeline,media,audio}=require('../src/native/video-structure/media');
const {buildShots,ALGORITHM}=require('../src/native/video-structure/shots');
const {clips}=require('../src/native/video-structure/clips');
const {align,srt,exportsModule,ALGORITHM:ALIGNMENT_ALGORITHM,POLICY:BOUNDARY_POLICY}=require('../src/native/video-structure/alignment');
const {mapTranscript,voiceSegments,voiceFilter,timelineFilter}=require('../src/native/video-structure/speech');
const {createVideoStructurePipeline,implementationFilesFor,brief,canMigrateLegacyInput}=require('../src/native/video-structure/pipeline');
const {atomicJson,run,sha256}=require('../src/native/video-structure/io');
async function main(){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'structure-test-'));
 try{
 const currentImplementation={'contracts.js':'84b5836d1b2d89b67b4f5bf610ee3c71b635794a1c1b3b136b78da1f907aa662','runtime.js':'unchanged-runtime','io.js':'unchanged-io','media.js':'unchanged-media'};
 const previousImplementation={...currentImplementation,'contracts.js':'ad34a66d6a01dd26aec0887016342d61c70eccc33e4717dc1d5fc708e473878c'};
 const identity={module:'media',version:VERSION,implementation:currentImplementation,source:'source',source_path:'/video.mp4',params:{},model:{},deps:{},tools:{ffmpeg:'tool'}};
 const previousStage={implementation:previousImplementation,input_fingerprint:fingerprint({...identity,implementation:previousImplementation})};
 const migrationCurrent={implementation:currentImplementation,identity};
 assert(canMigrateLegacyInput('media',previousStage,migrationCurrent));
 assert.equal(canMigrateLegacyInput('transcript',previousStage,migrationCurrent),false);
 const runtimeCurrent='c98d19953084796b65eb00bd853d41ad113ba9a30b46bcb7b69810695999d14e';
 const sentenceRuntimePrevious='f3b81266da74af2c02214a13c2c6047719bd7a1e25d977c31a563a40bf431ed2';
 assert.equal(await sha256(path.resolve(__dirname,'../src/native/video-structure/runtime.js')),runtimeCurrent);
 for(const id of ['media','audio','shots','separation']){
   const implementation={...currentImplementation,'runtime.js':runtimeCurrent};
   const previous={...implementation,'runtime.js':sentenceRuntimePrevious};
   const current={...identity,module:id,implementation};
   const stage={implementation:previous,model_identity:{},input_fingerprint:fingerprint({...current,implementation:previous})};
   assert(canMigrateLegacyInput(id,stage,{implementation,identity:current}));
   assert.equal(canMigrateLegacyInput(id,stage,{implementation,identity:{...current,tools:{ffmpeg:'changed'}}}),false);
   const unknown={...previous,'runtime.js':'f'.repeat(64)};
   assert.equal(canMigrateLegacyInput(id,{...stage,implementation:unknown,input_fingerprint:fingerprint({...current,implementation:unknown})},{implementation,identity:current}),false);
 }
 const runtimePrevious='74e2041213866bc07f3ccc86119902749805d8c47ea4bb4f1b3bb136451add5b';
 const alignmentCurrent='b2da11c798105420a5e8ab1ef833e6e3dde264f097ec26e3cf6929834c43e66d';
 const alignmentPrevious='c34a07d380372038bba35d27ff474125d9d4448bf99aa90c4836810856758bc9';
 assert.equal(await sha256(path.resolve(__dirname,'../src/native/video-structure/alignment.js')),alignmentCurrent);
 const alignmentImplementation={'contracts.js':currentImplementation['contracts.js'],'runtime.js':runtimeCurrent,'io.js':'unchanged-io','alignment.js':alignmentCurrent};
 const oldAlignmentImplementation={...alignmentImplementation,'alignment.js':alignmentPrevious};
 const alignmentIdentity={...identity,module:'alignment',implementation:alignmentImplementation,tools:null,deps:{shots:'shots',transcript:'transcript'}};
 const alignmentStage={implementation:oldAlignmentImplementation,model_identity:{},input_fingerprint:fingerprint({...alignmentIdentity,implementation:oldAlignmentImplementation})};
 const alignmentMigration={implementation:alignmentImplementation,identity:alignmentIdentity};
 assert(canMigrateLegacyInput('alignment',alignmentStage,alignmentMigration));
 const interimAlignmentImplementation={...alignmentImplementation,'alignment.js':'6003f27126f4492bbff5fd9a26e18b9544d84361b063b49a4ba8badb34ee4c34'};
 const interimAlignmentStage={...alignmentStage,implementation:interimAlignmentImplementation,input_fingerprint:fingerprint({...alignmentIdentity,implementation:interimAlignmentImplementation})};
 assert(canMigrateLegacyInput('alignment',interimAlignmentStage,alignmentMigration));
 assert.equal(canMigrateLegacyInput('export',interimAlignmentStage,alignmentMigration),false);
 assert.equal(canMigrateLegacyInput('alignment',interimAlignmentStage,{...alignmentMigration,identity:{...alignmentIdentity,deps:{...alignmentIdentity.deps,transcript:'changed'}}}),false);
 assert.equal(canMigrateLegacyInput('export',alignmentStage,alignmentMigration),false);
 for(const altered of [{...alignmentIdentity,source:'changed'},{...alignmentIdentity,source_path:'/moved.mp4'},{...alignmentIdentity,params:{changed:true}},{...alignmentIdentity,model:{changed:'model'}},{...alignmentIdentity,deps:{...alignmentIdentity.deps,transcript:'changed'}},{...alignmentIdentity,tools:{ffmpeg:'changed'}}])assert.equal(canMigrateLegacyInput('alignment',alignmentStage,{...alignmentMigration,identity:altered}),false);
 for(const [file,hash] of [['alignment.js','b'.repeat(64)],['runtime.js',sentenceRuntimePrevious],['contracts.js',previousImplementation['contracts.js']],['io.js','b'.repeat(64)]]){
   const previous={...oldAlignmentImplementation,[file]:hash};
   assert.equal(canMigrateLegacyInput('alignment',{...alignmentStage,implementation:previous,input_fingerprint:fingerprint({...alignmentIdentity,implementation:previous})},alignmentMigration),false);
 }
 const futureAlignment={...alignmentImplementation,'alignment.js':'f'.repeat(64)};
 assert.equal(canMigrateLegacyInput('alignment',alignmentStage,{implementation:futureAlignment,identity:{...alignmentIdentity,implementation:futureAlignment}}),false);
 const workerCurrent='f42b81f8d52c7e7c46d85b7fe00a5242bf570513ab0e9c9284680e0e2eae8139';
 const workerPrevious='bc484eb50b225b9b578312c607238a8038e5cfd7cabad9d346481266cdb659c4';
 const runtimeManifestCurrent='2a27406c7013ef528990e34ed015176c2938870abcc9eef1a2797b07397431e4';
 const runtimeManifestPrevious='386405ae3c52bc1142870ac62d5706180c870287fbb997d231634b3828bca91b';
 const speechCurrent='a83a1e3e081f06ccf79f19847ebfa2743c730a618c9b1ce442b7ea5e83e5ddc8';
 const speechPrevious='47ff03c880ce466ed6e4a37f32d591e9717685bb1a68ec9bd66ea545a1b53e2b';
 const separationImplementation={...currentImplementation,'runtime.js':runtimeCurrent,'speech.js':speechCurrent};
 const oldSeparationImplementation={...separationImplementation,'runtime.js':runtimePrevious,'speech.js':speechPrevious};
 const separationIdentity={...identity,module:'separation',implementation:oldSeparationImplementation};
 const separationStage={implementation:oldSeparationImplementation,model_identity:{},input_fingerprint:fingerprint(separationIdentity)};
 assert.equal(canMigrateLegacyInput('separation',separationStage,{implementation:separationImplementation,identity:{...separationIdentity,implementation:separationImplementation}}),true);
 const unknownSpeechImplementation={...oldSeparationImplementation,'speech.js':'d'.repeat(64)};
 assert.equal(canMigrateLegacyInput('separation',{...separationStage,implementation:unknownSpeechImplementation,input_fingerprint:fingerprint({...separationIdentity,implementation:unknownSpeechImplementation})},{implementation:separationImplementation,identity:{...separationIdentity,implementation:separationImplementation}}),false);
 assert.equal(canMigrateLegacyInput('transcript',separationStage,{implementation:separationImplementation,identity:{...separationIdentity,module:'transcript',implementation:separationImplementation}}),false);
 const shotImplementation={...currentImplementation,'runtime.js':runtimeCurrent};
 const oldShotImplementation={...shotImplementation,'runtime.js':runtimePrevious};
 const shotModel={'/fixture/worker/hongguo-structure':workerCurrent,'/fixture/runtime.json':runtimeManifestCurrent};
 const oldShotModel={'/fixture/worker/hongguo-structure':workerPrevious,'/fixture/runtime.json':runtimeManifestPrevious};
 const shotIdentity={...identity,module:'shots',implementation:oldShotImplementation,model:oldShotModel};
 const shotStage={implementation:oldShotImplementation,model_identity:oldShotModel,input_fingerprint:fingerprint(shotIdentity)};
 assert.equal(canMigrateLegacyInput('shots',shotStage,{implementation:shotImplementation,identity:{...shotIdentity,implementation:shotImplementation,model:shotModel}}),true);
 assert.equal(canMigrateLegacyInput('separation',shotStage,{implementation:shotImplementation,identity:{...shotIdentity,module:'separation',implementation:shotImplementation,model:shotModel}}),false);
 assert.equal(canMigrateLegacyInput('transcript',shotStage,{implementation:shotImplementation,identity:{...shotIdentity,module:'transcript',implementation:shotImplementation,model:shotModel}}),false);
 const alteredWorker={...shotModel,'/fixture/worker/hongguo-structure':'c'.repeat(64)};
 assert.equal(canMigrateLegacyInput('shots',shotStage,{implementation:shotImplementation,identity:{...shotIdentity,implementation:shotImplementation,model:alteredWorker}}),false);
 for(const altered of [
   {...identity,source:'changed'}, {...identity,source_path:'/moved.mp4'}, {...identity,model:{model:'changed'}},
   {...identity,params:{threads:99}}, {...identity,deps:{audio:'changed'}}, {...identity,tools:{ffmpeg:'changed'}},
 ]) assert.equal(canMigrateLegacyInput('media',previousStage,{...migrationCurrent,identity:altered}),false);
 const futureImplementation={...currentImplementation,'contracts.js':'f'.repeat(64)};
 assert.equal(canMigrateLegacyInput('media',previousStage,{implementation:futureImplementation,identity:{...identity,implementation:futureImplementation}}),false);
 const unknownImplementation={...previousImplementation,'io.js':'unknown'};
 assert.equal(canMigrateLegacyInput('media',{implementation:unknownImplementation,input_fingerprint:fingerprint({...identity,implementation:unknownImplementation})},migrationCurrent),false);
 const m=timeline([{pts:5,duration:.04},{pts:5.04,duration:.08},{pts:5.12,duration:.04}],{format:{start_time:'5',duration:'.2'},streams:[{index:0,codec_type:'video',time_base:'1/1000000'},{index:1,codec_type:'audio',start_time:'5.02',duration:'.18'}]});
 assert.equal(m.frame_rate_type,'vfr');assert.equal(m.origin_pts,5);assert(Math.abs(m.duration-.2)<1e-9);assert(Math.abs(m.video_end-.16)<1e-9);
 assert.throws(()=>timeline([{pts:0,duration:.04},{pts:0,duration:.04}],{streams:[{codec_type:'video'}]}),/重复/);
 const verified=(media,cuts)=>({algorithm_id:ALGORITHM,threshold:.5,minimum_duration:2,frame_count:media.frame_count,cuts,decisions:cuts.map(frame=>({frame,status:'kept'}))});
 const scores3={single:[0,.8,0],all:[0,.9,0]};
 assert.throws(()=>buildShots(m,scores3,'task'),/复核/);
 assert.throws(()=>buildShots(m,scores3,'task',verified(m,[1])),/最短2秒/);
 const short=buildShots(m,scores3,'task',verified(m,[]));assert.equal(short.shots.length,1);assert.equal(short.shots[0].end_frame_exclusive,3);
 const warned=verified(m,[]);warned.warnings=[{reason:'边界结构不充分'}];warned.decisions.push({frame:2,status:'warn',reason:'候选边界被合并'});const warnedShots=buildShots(m,scores3,'warned',warned);assert.equal(warnedShots.needs_review,true);assert.equal(warnedShots.review_items.length,2);assert.equal(warnedShots.review_items.some(item=>item.frame===2),true);assert.equal(warnedShots.review_items[0].status,'needs_review');assert.equal(brief(warnedShots).needs_review,true);assert.equal(brief(warnedShots).review_items.length,2);assert.equal(brief({review_items:[{review_id:'x'}]}).warning_count,1);
 const offset={...m,duration:3,video_start:2.1,video_end:2.26,frames:m.frames.map(f=>({...f,start:f.start+2.1}))};assert.equal(buildShots(offset,scores3,'offset',verified(offset,[])).shots[0].start,2.1);
 const shot=envelope('task',{shots:[{shot_id:'left',start:0,end:.04,start_frame:0,end_frame_exclusive:1},{shot_id:'right',start:.04,end:.16,start_frame:1,end_frame_exclusive:3}]});
 const t=mapTranscript({sample_rate:16000,duration:.2,segments:[{start_sample:0,end_sample_exclusive:1600,text:'跨镜头的话'}]},{offset:.02},m,'task');
 t.voice_timeline={segments:t.utterances.map(u=>({segment_id:`${u.utterance_id}:voice:1`,utterance_id:u.utterance_id,start:u.start,end:u.end}))};
 const vs=voiceSegments({segments:[{start:.02,end:.08,text:'说话'}]},{offset:.01},{video_end:.2});assert.deepEqual(vs.map(x=>[x.start,x.end]),[[.03,.09]]);assert.match(voiceFilter(vs),/^volume=0:enable='not\(/);assert.equal(voiceFilter([]),'volume=0');
 // VAD-only intervals are candidates for ASR, not confirmed human speech.
 // They must be muted in place instead of being copied into the vocal track.
 const vadOnly=voiceSegments({segments:[],vad_segments:[{start:.10,end:.16,text:''}]},{offset:.01},{video_end:.2});assert.deepEqual(vadOnly,[]);assert.equal(voiceFilter(vadOnly),'volume=0');
 const emptyText=voiceSegments({segments:[{start:.10,end:.16,text:'   '}],vad_segments:[{start:.10,end:.16}]},{offset:.01},{video_end:.2});assert.deepEqual(emptyText,[]);
 const emptyTranscript=mapTranscript({sample_rate:16000,duration:.2,segments:[],warnings:[]},{offset:.02},m,'empty');assert.equal(emptyTranscript.utterances.length,0);assert(emptyTranscript.warnings.length>0);assert.equal(emptyTranscript.duration,m.video_end);
 const a=align(shot.shots,t,'task');assert.equal(a.associations.length,1);assert.equal(a.shots.length,2);assert.equal(a.merged_boundary_count,0);assert.equal(a.associations[0].shot_ids.length,2);assert.equal(a.associations[0].utterance_id,t.utterances[0].utterance_id);
 assert.equal((srt(t.utterances).match(/-->/g)||[]).length,1);assert(srt(t.utterances).includes('00:00:00,020 --> 00:00:00,120'));
 assert.equal(align([{shot_id:'a',start:0,end:1,start_frame:0,end_frame_exclusive:25},{shot_id:'b',start:1,end:2,start_frame:25,end_frame_exclusive:50}],{duration:2,utterances:[{utterance_id:'x',start:1,end:2,text:'边界'}]},'t').associations.length,1);
 assert.deepEqual(MODULES.map(s=>s.id),['media','audio','shots','separation','transcript','alignment','clips','export']);assert.deepEqual(descendants('shots'),['alignment','clips','export']);assert.deepEqual(descendants('transcript'),['alignment','clips','export']);
 assert.deepEqual(implementationFilesFor('shots').map(file=>path.basename(file)),['contracts.js','io.js','runtime.js','shots.js']);assert.deepEqual(implementationFilesFor('transcript').map(file=>path.basename(file)),['contracts.js','io.js','runtime.js','speech.js']);
 const cd=path.join(temp,'clips'),ed=path.join(temp,'export');await fs.mkdir(cd);await fs.mkdir(ed);await fs.writeFile(path.join(cd,'a.mp4'),'fixture');
 const ex=await exportsModule({dir:ed,taskId:'task'},a,{boundary_policy:a.boundary_policy,alignment_algorithm_id:a.algorithm_id,clips:a.shots.map(s=>({...s,path:'a.mp4',audio_mode:'original'}))},t,cd);assert.equal(ex.utterance_count,1);assert.equal('csv' in ex,false);await assert.rejects(()=>fs.access(path.join(ed,'shots.csv')));for(const f of ex.media_files)await fs.access(path.resolve(ed,f.path));
 await scheduler(temp);
 const ffmpeg=process.env.STRUCTURE_TEST_FFMPEG,ffprobe=process.env.STRUCTURE_TEST_FFPROBE;
 if(ffmpeg&&ffprobe){
 const input=path.join(temp,'vfr.mp4');await run(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=192x108:rate=24:duration=3','-itsoffset','0.17','-f','lavfi','-i','sine=frequency=400:sample_rate=44100:duration=1.7','-vf',"setpts='if(gte(N,8),PTS*2,PTS)'",'-c:v','libx264','-c:a','aac','-fps_mode','passthrough',input]);
 const dir=path.join(temp,'real');await fs.mkdir(dir);const ctx={taskId:'vfr',input,dir,ffmpeg,ffprobe,params:{threads:2,audio_mode:'original'}};const real=await media(ctx);assert.equal(real.frame_rate_type,'vfr');assert((await audio(ctx,real)).offset>0);
 const scores=Array(real.frame_count).fill(0);scores[40]=.9;const cc=await clips(ctx,real,align(buildShots(real,{single:scores,all:scores},'vfr',verified(real,[40])).shots,{duration:real.video_end,utterances:[]},'vfr'));assert.equal(cc.clips.reduce((n,c)=>n+c.frame_count,0),real.frame_count);await assert.rejects(()=>audio(ctx,{has_audio:false}),/没有音轨/);
 // Real PCM regression: a non-zero audio offset must be represented on the
 // video clock, and masking must preserve speech samples only in the selected
 // interval. The output is padded/truncated to exactly video_end (sample
 // precision) without concatenating the retained ranges.
 const wavIn=path.join(temp,'timeline-input.wav'),wavOut=path.join(temp,'timeline-output.wav');
 await run(ffmpeg,['-nostdin','-y','-v','error','-f','lavfi','-i','sine=frequency=1000:sample_rate=8000:duration=0.3','-c:a','pcm_s16le',wavIn]);
 const filter=voiceFilter([{start:.15,end:.22}],{offset:.05,videoEnd:.4,sourceDuration:.3,sampleRate:8000,channels:1});
 await run(ffmpeg,['-nostdin','-y','-v','error','-i',wavIn,'-af',filter,'-ar','8000','-ac','1','-c:a','pcm_s16le',wavOut]);
 const wave=await readPcm16(wavOut);assert(Math.abs(wave.duration-.4)<=1/8000);assert(wave.rms(0,.14)<50);assert(wave.rms(.16,.20)>500);assert(wave.rms(.25,.39)<50);
 // When ASR returns no text, the whole human track must stay silent while
 // retaining the exact video duration and clock.
 const noVoiceOut=path.join(temp,'timeline-no-voice.wav');
 await run(ffmpeg,['-nostdin','-y','-v','error','-i',wavIn,'-af',voiceFilter([],{offset:.05,videoEnd:.4,sourceDuration:.3,sampleRate:8000,channels:1}),'-ar','8000','-ac','1','-c:a','pcm_s16le',noVoiceOut]);
 const noVoiceWave=await readPcm16(noVoiceOut);assert(Math.abs(noVoiceWave.duration-.4)<=1/8000);assert(noVoiceWave.rms(0,.4)<1);
 const backgroundOut=path.join(temp,'background-output.wav');
 await run(ffmpeg,['-nostdin','-y','-v','error','-i',wavIn,'-af',timelineFilter(null,{offset:.05,videoEnd:.4,sourceDuration:.3,sampleRate:8000,channels:1}),'-ar','8000','-ac','1','-c:a','pcm_s16le',backgroundOut]);
 const backgroundWave=await readPcm16(backgroundOut);assert(Math.abs(backgroundWave.duration-.4)<=1/8000);assert(backgroundWave.rms(0,.04)<50);assert(backgroundWave.rms(.08,.28)>500);
 console.log('PASS real FFmpeg VFR frame count, PTS, audio offset and missing audio');
 }
 console.log('PASS structure contracts, alignment, exports and orchestration');
 }finally{await fs.rm(temp,{recursive:true,force:true});}
}
async function readPcm16(file){
 const data=await fs.readFile(file);assert.equal(data.toString('ascii',0,4),'RIFF');const channels=data.readUInt16LE(22),rate=data.readUInt32LE(24),bits=data.readUInt16LE(34);assert.equal(bits,16);let pos=12,samples=null;
 while(pos+8<=data.length){const size=data.readUInt32LE(pos+4),id=data.toString('ascii',pos,pos+4);if(id==='data'){samples=data.subarray(pos+8,pos+8+size);break;}pos+=8+size+(size%2);}
 assert(samples);const frameSize=channels*2;const values=[];for(let i=0;i+1<samples.length;i+=frameSize){let sum=0;for(let c=0;c<channels;c++)sum+=Math.abs(samples.readInt16LE(i+c*2));values.push(sum/channels);}
 return {duration:values.length/rate,rms(start,end){const a=Math.max(0,Math.floor(start*rate)),b=Math.min(values.length,Math.ceil(end*rate));if(b<=a)return 0;return values.slice(a,b).reduce((s,v)=>s+v,0)/(b-a);}};
}
async function scheduler(temp){
 const rt=path.join(temp,'runtime'),exe=process.platform==='win32'?'.exe':'';
 for(const name of ['worker/hongguo-structure'+exe,'bin/sherpa-onnx-offline-source-separation'+exe,'models/transnetv2.pth','models/UVR-MDX-NET-Inst_HQ_3.onnx','models/silero_vad.onnx','models/sherpa-onnx-paraformer-zh-small-2024-03-09/model.int8.onnx','models/sherpa-onnx-paraformer-zh-small-2024-03-09/tokens.txt','models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/model.int8.onnx']){const f=path.join(rt,name);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,'fixture');}
 for(const name of ['hongguo-transcribe'+exe,...['model.bin','config.json','tokenizer.json','vocabulary.txt'].map(file=>'models/tiny/'+file)]){const f=path.join(rt,'faster-whisper',name);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,'fixture');}
 const input=path.join(temp,'episode.mp4');await fs.writeFile(input,'source');const records={},calls={};let settings={structure_runtime_dir:rt,resourcesPath:rt,isPackaged:true},fail=null,hold=null;
 const handlers=Object.fromEntries(MODULES.map(s=>[s.id,async ctx=>{calls[s.id]=(calls[s.id]||0)+1;if(fail===s.id)throw Error('fixture failure');if(hold===s.id)await new Promise((r,j)=>ctx.signal.addEventListener('abort',()=>j(Error('stopped')),{once:true}));const d=envelope(ctx.taskId,{fixture:s.id,...(s.id==='alignment'?{algorithm_id:ALIGNMENT_ALGORITHM,boundary_policy:BOUNDARY_POLICY}:{}),...(s.id==='export'?{subtitle_policy:'voice-segments-v1'}:{})});await atomicJson(path.join(ctx.dir,s.file),d);return d;}]));
 const opt={getSettings:()=>settings,getFfmpegPath:()=>process.execPath,getFfprobePath:()=>process.execPath,getProjectRecord:id=>records[id],saveProjectRecord:(id,r)=>records[id]=r,handlers};
 const p=createVideoStructurePipeline(opt),payload={inputPath:input,outputRoot:temp,projectId:'fixture'};
 await p.start({...payload,module:'clips'});assert.equal((await p.wait('fixture')).status,'blocked');assert.equal(Object.keys(calls).length,0);
 await p.start(payload);assert.equal((await p.wait('fixture')).status,'completed');assert(MODULES.every(s=>calls[s.id]===1));
 await p.start(payload);let result=await p.wait('fixture');assert(MODULES.every(s=>calls[s.id]===1));assert(result.modules.export.reused);
 settings={...settings,structure_threshold:.6};await p.start(payload);await p.wait('fixture');assert.equal(calls.shots,1);
 settings={...settings,structure_device:'mps'};await p.start(payload);await p.wait('fixture');assert.equal(calls.media,1);assert.equal(calls.shots,2);assert.equal(calls.clips,2);assert.equal(calls.transcript,1);
 result=await p.status('fixture');await fs.writeFile(path.join(result.projectDir,result.modules.transcript.result_path),'corrupted');await p.start(payload);await p.wait('fixture');assert.equal(calls.transcript,2);assert.equal(calls.shots,2);
 fail='clips';await p.start({...payload,module:'clips',force:true});result=await p.wait('fixture');assert.equal(result.modules.clips.status,'failed');assert.equal(result.modules.export.status,'stale');assert.equal(result.modules.alignment.status,'succeeded');
 fail=null;await p.start({...payload,module:'clips'});assert.equal((await p.wait('fixture')).status,'partial');await p.start(payload);assert.equal((await p.wait('fixture')).status,'completed');
 assert.equal((await createVideoStructurePipeline(opt).status('fixture')).status,'completed');
 const many=await Promise.allSettled([p.start(payload),p.start(payload)]);assert.equal(many.filter(r=>r.status==='fulfilled').length,1);await p.wait('fixture');
 hold='clips';await p.start({...payload,module:'clips',force:true});while((await p.status('fixture')).stage!=='clips')await new Promise(r=>setTimeout(r,10));await new Promise(r=>setTimeout(r,20));p.cancel('fixture');assert.equal((await p.wait('fixture')).status,'stopped');hold=null;
 await p.start(payload);result=await p.wait('fixture');assert.equal(result.status,'completed');for(const s of MODULES)assert.equal((await fs.readdir(path.join(result.projectDir,'modules',s.id))).length,1);
 // Upgrading an existing 8-step project must generate a draft without
 // repeating completed media work, even if runtime settings have changed.
 const beforeDraft={...calls};let draftCalls=0,draftFailure=false;
 const draftOptions={...opt,createDraft:async ctx=>{
   draftCalls++;if(draftFailure)throw Error('draft failure');
   assert.equal(ctx.projectDir,result.projectDir);
   ctx.onProgress({progress:42,message:'生成特效声 2/4'});
   const control=path.join(temp,'draft_info.json');await fs.writeFile(control,'draft');
   const data=envelope(ctx.taskId,{draft_path:temp,validated:true,control_files:[{path:control,sha256:require('node:crypto').createHash('sha256').update('draft').digest('hex')}]});
   await atomicJson(path.join(ctx.dir,'jianying.json'),data);return data;
 }};
 const withDraft=createVideoStructurePipeline(draftOptions);
 settings={...settings,structure_threads:3};
 await withDraft.start({...payload,module:'jianying'});result=await withDraft.wait('fixture');
 assert.equal(result.status,'completed');assert.equal(result.modules.jianying.summary.draft_path,temp);assert.deepEqual(calls,beforeDraft);assert.equal(draftCalls,1);
 assert.equal((await createVideoStructurePipeline(draftOptions).status('fixture')).modules.jianying.status,'succeeded');
 draftFailure=true;await withDraft.start({...payload,module:'jianying',force:true});result=await withDraft.wait('fixture');
 assert.equal(result.status,'failed');assert(MODULES.every(s=>result.modules[s.id].status==='succeeded'));assert.deepEqual(calls,beforeDraft);
 draftFailure=false;await withDraft.start({...payload,module:'jianying'});result=await withDraft.wait('fixture');assert.equal(result.status,'completed');
 await fs.writeFile(path.join(result.projectDir,result.modules.transcript.result_path),'tampered');
 await withDraft.start({...payload,module:'jianying',force:true});result=await withDraft.wait('fixture');assert.equal(result.status,'failed');assert.match(result.error,/结果缺失或已修改/);assert.equal(draftCalls,3);
 // A graph-only contract upgrade preserves exact verified upstream keys,
 // but legacy overlap-based alignment must never be exported as a new draft.
 const upgradePayload={...payload,projectId:'legacy-dialogue'};
 const upgrade=createVideoStructurePipeline({...opt,createDraft:draftOptions.createDraft});
 await upgrade.start({...upgradePayload,module:'media'});await upgrade.wait(upgradePayload.projectId);
 const upgradeBase=createVideoStructurePipeline(opt);
 await upgradeBase.start(upgradePayload);let upgraded=await upgradeBase.wait(upgradePayload.projectId);assert.equal(upgraded.status,'completed');
 const legacyManifest=JSON.parse(await fs.readFile(upgraded.manifestPath,'utf8'));
 const upstreamIds=['media','audio','shots','separation','transcript'];
 const toolHashes={[process.execPath]:await sha256(process.execPath)};
 function legacyKey(state,spec,stage){return fingerprint({module:spec.id,version:VERSION,implementation:stage.implementation,source:state.source_sha256,source_path:state.input_path,params:stage.params,model:stage.model_identity,deps:Object.fromEntries(spec.deps.map(id=>[id,state.modules[id].result_fingerprint])),tools:['media','audio','shots','clips','separation','transcript'].includes(spec.id)?toolHashes:null});}
 const LEGACY_CONTRACTS_SHA256='c299cb54e833473622be91598c1199ce1a6a537c3eec4d3631b6bbb7b45a0542';
 for(const spec of MODULES.filter(spec=>upstreamIds.includes(spec.id))){const stage=legacyManifest.modules[spec.id];stage.implementation={...stage.implementation,'contracts.js':LEGACY_CONTRACTS_SHA256};if(spec.id==='transcript')delete stage.params.sentence_alignment;stage.input_fingerprint=legacyKey(legacyManifest,spec,stage);}
 const legacyAligned=path.join(upgraded.projectDir,legacyManifest.modules.alignment.result_path);
 await atomicJson(legacyAligned,envelope(upgradePayload.projectId,{associations:[],shots:[]}));
 legacyManifest.modules.alignment.output_files[0].sha256=await sha256(legacyAligned);
 legacyManifest.modules.alignment.result_fingerprint=fingerprint(legacyManifest.modules.alignment.output_files);
 await atomicJson(upgraded.manifestPath,legacyManifest);
 const migrationBefore={...calls};let unexpectedDraftCalls=0;
 const migration=createVideoStructurePipeline({...opt,createDraft:async()=>{unexpectedDraftCalls++;throw Error('must not export old alignment')}});
 const oldStatus=await migration.status(upgradePayload.projectId);
 assert.equal(oldStatus.status,'partial');for(const id of ['alignment','clips','export'])assert.equal(oldStatus.modules[id].status,'stale');
 assert.equal(oldStatus.modules.transcript.status,'stale');assert.match(oldStatus.modules.transcript.message,/继续完整流程/);assert.match(oldStatus.modules.alignment.message,/继续完整流程/);
 assert(oldStatus.modules.transcript.legacy_result_path);await fs.access(path.join(oldStatus.projectDir,oldStatus.modules.transcript.legacy_result_path));
 await migration.start({...upgradePayload,module:'jianying'});upgraded=await migration.wait(upgradePayload.projectId);
 assert.equal(upgraded.status,'failed');assert.match(upgraded.error,/继续完整流程/);assert.equal(unexpectedDraftCalls,0);assert.deepEqual(calls,migrationBefore);
 await upgradeBase.start(upgradePayload);upgraded=await upgradeBase.wait(upgradePayload.projectId);
 assert.equal(upgraded.status,'completed');for(const id of upstreamIds.filter(id=>id!=='transcript'))assert.equal(calls[id],migrationBefore[id]);assert.equal(calls.transcript,migrationBefore.transcript+1);
 for(const id of ['alignment','clips','export'])assert.equal(calls[id],migrationBefore[id]+1);
 // Unknown contract versions must never use the one-time migration.
 const unsafe=JSON.parse(await fs.readFile(upgraded.manifestPath,'utf8'));
 const unsafeStage=unsafe.modules.separation;unsafeStage.implementation={...unsafeStage.implementation,'contracts.js':'b'.repeat(64)};unsafeStage.input_fingerprint=legacyKey(unsafe,MODULES.find(s=>s.id==='separation'),unsafeStage);
 await atomicJson(upgraded.manifestPath,unsafe);const unsafeBefore={...calls};
 await upgradeBase.start(upgradePayload);upgraded=await upgradeBase.wait(upgradePayload.projectId);assert.equal(upgraded.status,'completed');
 assert.equal(calls.separation,unsafeBefore.separation+1);assert.equal(calls.transcript,unsafeBefore.transcript+1);for(const id of ['media','audio','shots'])assert.equal(calls[id],unsafeBefore[id]);
 // Even the allowlisted contract cannot hide changes to speech processing.
 const changedSpeech=JSON.parse(await fs.readFile(upgraded.manifestPath,'utf8'));
 const speechStage=changedSpeech.modules.transcript;speechStage.implementation={...speechStage.implementation,'contracts.js':LEGACY_CONTRACTS_SHA256,'speech.js':'b'.repeat(64)};speechStage.input_fingerprint=legacyKey(changedSpeech,MODULES.find(s=>s.id==='transcript'),speechStage);
 await atomicJson(upgraded.manifestPath,changedSpeech);const speechBefore={...calls};
 await upgradeBase.start(upgradePayload);upgraded=await upgradeBase.wait(upgradePayload.projectId);assert.equal(upgraded.status,'completed');
 assert.equal(calls.transcript,speechBefore.transcript+1);for(const id of upstreamIds.filter(id=>id!=='transcript'))assert.equal(calls[id],speechBefore[id]);
 // A sentence-to-punctuation upgrade reuses verified upstream work and
 // invalidates the old transcript and every dependent export, including draft.
 const punctuationPayload={...payload,projectId:'punctuation-upgrade'};let punctuationDraftCalls=0;
 const punctuationOptions={...opt,createDraft:async ctx=>{
   punctuationDraftCalls++;const control=path.join(temp,'punctuation-draft.json');await fs.writeFile(control,'draft');
   const data=envelope(ctx.taskId,{draft_path:temp,validated:true,control_files:[{path:control,sha256:await sha256(control)}]});
   await atomicJson(path.join(ctx.dir,'jianying.json'),data);return data;
 }};
 const punctuation=createVideoStructurePipeline(punctuationOptions);await punctuation.start(punctuationPayload);
 let punctuationResult=await punctuation.wait(punctuationPayload.projectId);assert.equal(punctuationResult.status,'completed');
 const oldPunctuation=JSON.parse(await fs.readFile(punctuationResult.manifestPath,'utf8'));
 for(const spec of MODULES){const stage=oldPunctuation.modules[spec.id];stage.implementation={...stage.implementation,'runtime.js':'f3b81266da74af2c02214a13c2c6047719bd7a1e25d977c31a563a40bf431ed2'};if(spec.id==='transcript')stage.params.sentence_alignment='paraformer-ct-global-whisper-sentences-v1';stage.input_fingerprint=legacyKey(oldPunctuation,spec,stage);}
 await atomicJson(punctuationResult.manifestPath,oldPunctuation);const punctuationBefore={...calls},punctuationDraftBefore=punctuationDraftCalls;
 const punctuationMigration=createVideoStructurePipeline(punctuationOptions);
 punctuationResult=await punctuationMigration.status(punctuationPayload.projectId);assert.equal(punctuationResult.status,'partial');
 for(const id of ['media','audio','shots','separation'])assert.equal(punctuationResult.modules[id].status,'succeeded');
 for(const id of ['transcript','alignment','clips','export','jianying'])assert.equal(punctuationResult.modules[id].status,'stale');
 assert.match(punctuationResult.modules.transcript.message,/音频真实停顿/);
 await punctuationMigration.start({...punctuationPayload,module:'jianying'});punctuationResult=await punctuationMigration.wait(punctuationPayload.projectId);
 assert.equal(punctuationResult.status,'failed');assert.match(punctuationResult.error,/继续完整流程/);assert.deepEqual(calls,punctuationBefore);assert.equal(punctuationDraftCalls,punctuationDraftBefore);
 await punctuationMigration.start(punctuationPayload);punctuationResult=await punctuationMigration.wait(punctuationPayload.projectId);assert.equal(punctuationResult.status,'completed');
 for(const id of ['media','audio','shots','separation']){assert.equal(calls[id],punctuationBefore[id]);assert.equal(punctuationResult.modules[id].reused,true);}
 for(const id of ['transcript','alignment','clips','export'])assert.equal(calls[id],punctuationBefore[id]+1);
 assert.equal(punctuationDraftCalls,punctuationDraftBefore+1);assert.equal(punctuationResult.modules.transcript.params.sentence_alignment,'paraformer-ct-global-whisper-audio-pause-v4');
 console.log('PASS visual-cut stage order, legacy sentence/draft rejection, exact upstream migration and implementation invalidation');
 // Subtitle-only changes must preserve all seven completed media stages.
 const subtitlePayload={...payload,projectId:'subtitle-upgrade'};let subtitleDraftCalls=0;
 const subtitleOptions={...opt,createDraft:async ctx=>{
   subtitleDraftCalls++;const control=path.join(temp,'subtitle-draft.json');await fs.writeFile(control,'draft');
   const data=envelope(ctx.taskId,{draft_path:temp,validated:true,control_files:[{path:control,sha256:await sha256(control)}]});
   await atomicJson(path.join(ctx.dir,'jianying.json'),data);return data;
 }};
 const subtitle=createVideoStructurePipeline(subtitleOptions);await subtitle.start(subtitlePayload);
 let subtitleResult=await subtitle.wait(subtitlePayload.projectId);assert.equal(subtitleResult.status,'completed');
 const oldSubtitle=JSON.parse(await fs.readFile(subtitleResult.manifestPath,'utf8'));
 const oldExportFile=path.join(subtitleResult.projectDir,oldSubtitle.modules.export.result_path);
 const oldExport=JSON.parse(await fs.readFile(oldExportFile,'utf8'));delete oldExport.subtitle_policy;await atomicJson(oldExportFile,oldExport);
 oldSubtitle.modules.export.output_files[0].sha256=await sha256(oldExportFile);oldSubtitle.modules.export.result_fingerprint=fingerprint(oldSubtitle.modules.export.output_files);
 for(const id of ['alignment','export']){const stage=oldSubtitle.modules[id];stage.implementation={...stage.implementation,'alignment.js':'c34a07d380372038bba35d27ff474125d9d4448bf99aa90c4836810856758bc9'};stage.input_fingerprint=legacyKey(oldSubtitle,MODULES.find(spec=>spec.id===id),stage);}
 await atomicJson(subtitleResult.manifestPath,oldSubtitle);const subtitleBefore={...calls},subtitleDraftBefore=subtitleDraftCalls;
 const preserved=MODULES.filter(spec=>spec.id!=='export').map(spec=>spec.id);
 const subtitleStatus=createVideoStructurePipeline(opt);subtitleResult=await subtitleStatus.status(subtitlePayload.projectId);
 assert.equal(subtitleResult.status,'partial');
 for(const id of preserved)assert.deepEqual(subtitleResult.modules[id],oldSubtitle.modules[id]);
 for(const id of ['export','jianying']){assert.equal(subtitleResult.modules[id].status,'stale');assert(subtitleResult.modules[id].legacy_result_path);}
 assert.match(subtitleResult.modules.export.message,/单步运行“导出字幕与文件清单”/);assert.doesNotMatch(subtitleResult.modules.export.message,/继续完整流程/);
 assert.equal((await createVideoStructurePipeline(opt).status(subtitlePayload.projectId)).modules.jianying.status,'stale');
 await atomicJson(subtitleResult.manifestPath,oldSubtitle);
 const subtitleMigration=createVideoStructurePipeline(subtitleOptions);
 await subtitleMigration.start({...subtitlePayload,module:'jianying'});subtitleResult=await subtitleMigration.wait(subtitlePayload.projectId);
 assert.equal(subtitleResult.status,'failed');assert.match(subtitleResult.error,/单步运行“导出字幕与文件清单”/);assert.doesNotMatch(subtitleResult.error,/继续完整流程/);assert.deepEqual(calls,subtitleBefore);assert.equal(subtitleDraftCalls,subtitleDraftBefore);
 for(const id of preserved)assert.deepEqual(subtitleResult.modules[id],oldSubtitle.modules[id]);
 for(const id of ['export','jianying'])assert.equal(subtitleResult.modules[id].status,'stale');
 await subtitleMigration.start({...subtitlePayload,module:'export'});subtitleResult=await subtitleMigration.wait(subtitlePayload.projectId);assert.equal(subtitleResult.status,'partial');
 for(const id of preserved){assert.equal(calls[id],subtitleBefore[id]);assert.equal(subtitleResult.modules[id].run_id,oldSubtitle.modules[id].run_id);assert.equal(subtitleResult.modules[id].result_fingerprint,oldSubtitle.modules[id].result_fingerprint);}
 assert.equal(calls.export,subtitleBefore.export+1);assert.equal(subtitleDraftCalls,subtitleDraftBefore);
 assert.equal(JSON.parse(await fs.readFile(path.join(subtitleResult.projectDir,subtitleResult.modules.export.result_path),'utf8')).subtitle_policy,'voice-segments-v1');
 await subtitleMigration.start({...subtitlePayload,module:'jianying'});subtitleResult=await subtitleMigration.wait(subtitlePayload.projectId);assert.equal(subtitleResult.status,'completed');assert.equal(subtitleDraftCalls,subtitleDraftBefore+1);
 for(const id of preserved)assert.equal(calls[id],subtitleBefore[id]);
 // Even an exact implementation migration must reject modified output bytes.
 const damaged=JSON.parse(await fs.readFile(subtitleResult.manifestPath,'utf8'));const damagedAlignment=damaged.modules.alignment;damagedAlignment.implementation={...damagedAlignment.implementation,'alignment.js':'c34a07d380372038bba35d27ff474125d9d4448bf99aa90c4836810856758bc9'};damagedAlignment.input_fingerprint=legacyKey(damaged,MODULES.find(spec=>spec.id==='alignment'),damagedAlignment);
 await atomicJson(subtitleResult.manifestPath,damaged);await fs.appendFile(path.join(subtitleResult.projectDir,damagedAlignment.result_path),' ');
 const damagedBefore={...calls};await subtitleMigration.start({...subtitlePayload,module:'export'});subtitleResult=await subtitleMigration.wait(subtitlePayload.projectId);
 assert.equal(subtitleResult.status,'blocked');assert.equal(subtitleResult.modules.alignment.status,'stale');assert.equal(subtitleResult.modules.clips.status,'stale');assert.deepEqual(calls,damagedBefore);
 console.log('PASS subtitle-only upgrade: seven stages preserved, export/draft invalidated, single-step recovery and output integrity');
 // Metadata-only changes during a module must not discard valid output.
 // A same-size content change must still fail, even with mtime restored.
 let sourceMutation=null;
 const integrityHandlers=Object.fromEntries(MODULES.map(spec=>[spec.id,async ctx=>{
   if(spec.id==='shots'&&sourceMutation)await sourceMutation();
   const data=envelope(ctx.taskId,{fixture:spec.id,...(spec.id==='alignment'?{algorithm_id:ALIGNMENT_ALGORITHM,boundary_policy:BOUNDARY_POLICY}:{}),...(spec.id==='export'?{subtitle_policy:'voice-segments-v1'}:{})});
   await atomicJson(path.join(ctx.dir,spec.file),data);return data;
 }]));
 const integrity=createVideoStructurePipeline({...opt,handlers:integrityHandlers});
 const integrityPayload={...payload,projectId:'source-integrity'};
 sourceMutation=async()=>{const st=await fs.stat(input);await fs.chmod(input,st.mode^0o100);await fs.utimes(input,st.atime,new Date(st.mtimeMs+2000));};
 await integrity.start(integrityPayload);result=await integrity.wait(integrityPayload.projectId);
 assert.equal(result.status,'completed');assert.equal(result.modules.shots.status,'succeeded');
 sourceMutation=null;await integrity.start(integrityPayload);result=await integrity.wait(integrityPayload.projectId);
 assert.equal(result.status,'completed');assert(MODULES.every(spec=>result.modules[spec.id].reused));
 sourceMutation=async()=>{const st=await fs.stat(input);await fs.writeFile(input,'SOURCE');await fs.utimes(input,st.atime,st.mtime);};
 await integrity.start({...integrityPayload,module:'shots',force:true});result=await integrity.wait(integrityPayload.projectId);
 assert.equal(result.status,'failed');assert.equal(result.modules.shots.status,'failed');assert.match(result.error,/SHA-256/);
 assert.equal(result.modules.clips.status,'stale');
 assert.equal((await fs.readdir(path.join(result.projectDir,'modules','shots'))).some(name=>name.endsWith('.partial')),false);
 console.log('PASS source metadata changes, existing-project reuse, and real content-change rejection');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
