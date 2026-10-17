'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { align, exportsModule, ALGORITHM, POLICY } = require('../src/native/video-structure/alignment');
const shotsAt = times => times.slice(0, -1).map((start, i) => ({ shot_id: `raw-${i}`, order: i + 1, start, end: times[i + 1], start_frame: i * 50, end_frame_exclusive: (i + 1) * 50 }));
const speech = (ranges, duration) => ({ duration, utterances: ranges.map(([start, end], i) => ({ utterance_id: `u${i}`, start, end, text: `第${i}句话保持完整` })) });
const voicedSpeech = (ranges, duration) => {
  const transcript = speech(ranges, duration);
  transcript.voice_timeline = { segments: transcript.utterances.map(u => ({ segment_id: `${u.utterance_id}:voice:1`, utterance_id: u.utterance_id, start: u.start, end: u.end })) };
  return transcript;
};
const overlaps = (u, s) => u.start < s.end && u.end > s.start;
function verify(raw, transcript, result) {
  assert.equal(result.algorithm_id, ALGORITHM);
  assert.equal(result.boundary_policy, POLICY);
  assert.equal(result.merged_boundary_count, 0);
  assert.equal(result.shots.length, raw.length);
  assert.equal(result.shots.reduce((sum, s) => sum + s.end_frame_exclusive - s.start_frame, 0), raw.at(-1).end_frame_exclusive);
  result.shots.forEach((s, i) => {
    for (const key of ['start','end','start_frame','end_frame_exclusive','order']) assert.equal(s[key], raw[i][key]);
    assert.deepEqual(s.source_shot_ids, [raw[i].shot_id]);
    assert.deepEqual(s.internal_boundaries, []);
    assert.deepEqual(s.utterance_ids, transcript.utterances.filter(u => overlaps(u, s)).map(u => u.utterance_id));
    assert.deepEqual(s.voice_segment_ids, (transcript.voice_timeline?.segments || []).filter(v => overlaps(v, s)).map(v => v.segment_id));
  });
  assert.equal(result.associations.length, transcript.utterances.length);
  for (const u of transcript.utterances) {
    const rows = result.associations.filter(a => a.utterance_id === u.utterance_id), owners = result.shots.filter(s => overlaps(u, s));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].start, u.start); assert.equal(rows[0].end, u.end);
    assert.deepEqual(rows[0].shot_ids, owners.map(s => s.shot_id));
    assert.deepEqual(rows[0].segments, owners.map(s => ({shot_id:s.shot_id,start:Math.max(u.start,s.start),end:Math.min(u.end,s.end)})));
    assert.equal(rows[0].segments[0].start,u.start); assert.equal(rows[0].segments.at(-1).end,u.end);
  }
  assert.deepEqual(result.boundary_decisions.map(d => d.time), raw.slice(1).map(s => s.start));
  assert(result.boundary_decisions.every(d => d.status === 'kept'));
}
async function main() {
  const raw = shotsAt([0, 2, 4, 6, 8, 10]);
  for (const ranges of [[], [[1,3]], [[1,7]], [[0,2],[2,4]], [[1,3],[2.5,5]], [[2.001,3.999]], [[0,10]], [[1.9,2.000001]]]) {
    const t=speech(ranges,10), copy=JSON.stringify({raw,t});
    verify(raw,t,align(raw,t,'test'));
    assert.equal(JSON.stringify({raw,t}),copy);
  }
  const three=speech([[1,5]],10), threeResult=align(raw,three,'three');
  assert.equal(threeResult.associations[0].shot_ids.length,3);
  const same=speech([[.2,.8],[1,1.8]],10), sameResult=align(raw,same,'same');
  assert.equal(sameResult.associations.length,2);
  assert.equal(sameResult.associations[0].shot_id,sameResult.associations[1].shot_id);
  const voice={...three,voice_timeline:{segments:[{segment_id:'v',start:1,end:5,text:three.utterances[0].text}]}};
  verify(raw,voice,align(raw,voice,'voice'));
  assert.throws(()=>align([{...raw[0]},{...raw[1],start:2.2}],speech([],4),'bad'),/时间缺口/);
  assert.throws(()=>align(shotsAt([1,3]),speech([[0,2]],3),'bad'),/超出/);
  // A VAD chain once collapsed the whole 47-second sequence into one clip.
  const longRaw=shotsAt([0,5,10,15,20,25,30,35,40,47]);
  const chained=speech([[1,11],[11.2,21],[21.2,31],[31.2,46]],47);
  const chainResult=align(longRaw,chained,'chain');verify(longRaw,chained,chainResult);
  assert.equal(chainResult.shots.length,9);
  assert.equal(Math.max(...chainResult.shots.map(s=>s.end-s.start)),7);
  for(let n=1;n<=100;n++){
    const ranges=Array.from({length:5},(_,i)=>{const a=((n*17+i*31)%90)/10;return[a,Math.min(10,a+((n+i)%13+1)/10)];}).sort((a,b)=>a[0]-b[0]);
    const varied=speech(ranges,10);verify(raw,varied,align(raw,varied,'varied'));
  }
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dialogue-boundaries-'));
  try{
    await fs.writeFile(path.join(dir,'clip.mp4'),'fixture');
    const t=voicedSpeech([[.1,5.1],[6.2,7.5],[8.2,9.2]],10);
    t.utterances[2].text=t.utterances[1].text;
    const final=align(raw,t,'export');
    const clipSet={boundary_policy:POLICY,alignment_algorithm_id:ALGORITHM,clips:final.shots.map(s=>({...s,path:'clip.mp4'}))};
    const run=(a=final,c=clipSet,spoken=t)=>exportsModule({taskId:'export',dir},a,c,spoken,dir);
    const exported=await run();
    assert.equal(exported.subtitle_cues.length,t.utterances.length);
    exported.subtitle_cues.forEach((cue,i)=>{const voice=t.voice_timeline.segments[i];assert.equal(cue.voice_segment_id,voice.segment_id);assert.equal(cue.text,t.utterances[i].text);assert.equal(cue.start,voice.start);assert.equal(cue.end,voice.end);assert.deepEqual(cue.shot_ids,final.associations[i].shot_ids);});
    const srt=(await fs.readFile(path.join(dir,'subtitles.srt'),'utf8')).trim().split(/\n\s*\n/);
    assert.equal(srt.length,3);
    assert.deepEqual(srt.map(block=>block.split('\n')[2]),t.utterances.map(u=>u.text));
    assert(srt[0].includes('00:00:00,100 --> 00:00:05,100'));
    for(const [mutate,message] of [
      [spoken=>delete spoken.voice_timeline,/缺少已校验的人声片段/],
      [spoken=>spoken.voice_timeline.segments=[],/已有音频片段与台词有声区间不一致/],
      [spoken=>delete spoken.voice_timeline.segments[0].utterance_id,/人声片段缺少台词关联/],
      [spoken=>spoken.voice_timeline.segments.pop(),/已有音频片段与台词有声区间不一致/],
    ]){const bad=structuredClone(t);mutate(bad);await assert.rejects(()=>run(align(raw,bad,'export'),clipSet,bad),message);}
    const corruptions=[
      a=>a.associations.pop(),
      a=>a.associations.push(a.associations[0]),
      a=>a.associations[0].utterance_id='missing',
      a=>a.associations[0].shot_ids.splice(1,1),
      a=>a.associations[0].shot_ids.push(a.associations[0].shot_ids[0]),
      a=>a.associations[0].shot_ids[1]='fake-shot',
      a=>a.associations[0].shot_ids.reverse(),
      a=>a.associations[0].segments[1].end-=.1,
      a=>a.associations[0].segments.pop(),
      a=>a.associations[0].end-=.1,
      a=>a.associations[0].shot_id=a.associations[0].shot_ids[0],
      a=>a.shots[1].utterance_ids=[],
      a=>a.shots[1].voice_segment_ids=[],
    ];
    for(const mutate of corruptions){const bad=structuredClone(final);mutate(bad);await assert.rejects(()=>run(bad),/台词|分镜|人声/);}
    const wrongClip=structuredClone(clipSet);wrongClip.clips[0].end+=.1;
    await assert.rejects(()=>run(final,wrongClip),/边界或来源不一致/);
    const wrongSource=structuredClone(clipSet);wrongSource.clips[0].source_shot_ids=['fake'];
    await assert.rejects(()=>run(final,wrongSource),/边界或来源不一致/);
    const precise=shotsAt([0,2.041666,4.083334]), spoken=voicedSpeech([[.1,2.041666],[2.041666,3.2]],4.083334);
    const rounded=align(precise,spoken,'rounding');
    const roundingClips={boundary_policy:POLICY,alignment_algorithm_id:ALGORITHM,clips:rounded.shots.map(s=>({...s,path:'clip.mp4'}))};
    await run(rounded,roundingClips,spoken);
    const roundedSrt=await fs.readFile(path.join(dir,'subtitles.srt'),'utf8');
    assert(roundedSrt.includes('00:00:00,100 --> 00:00:02,042'));
    assert(roundedSrt.includes('00:00:02,042 --> 00:00:03,200'));
    const tailShots=shotsAt([0,2.041666,4.083667]), tailSpeech=voicedSpeech([[.0004,4.083667]],4.083667);
    const tail=align(tailShots,tailSpeech,'tail');
    const tailClips={boundary_policy:POLICY,alignment_algorithm_id:ALGORITHM,clips:tail.shots.map(s=>({...s,path:'clip.mp4'}))};
    const tailExport=await run(tail,tailClips,tailSpeech);
    assert.equal(tailExport.subtitle_cues.length,1);
    assert.equal(tailExport.subtitle_cues[0].start,.0004);
    assert.equal(tailExport.subtitle_cues[0].end,4.083667);
    assert.equal(tailExport.subtitle_cues[0].shot_ids.length,2);
    assert.equal(tailExport.subtitle_cues[0].text,tailSpeech.utterances[0].text);
    assert(tailExport.subtitle_cues[0].end<=tailSpeech.duration);
    assert((await fs.readFile(path.join(dir,'subtitles.srt'),'utf8')).includes('00:00:00,000 --> 00:00:04,083'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
  console.log('PASS visual cuts unchanged, whole sentences across shots, 47-second merge regression, exact overlap indexes, voice-aligned subtitle cues, SRT precision and missing-voice/forged-map rejection');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
