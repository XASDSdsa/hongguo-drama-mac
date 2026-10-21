'use strict';
// 三分轨（文案 / 视频 / 音频）剪映草稿：直接用结构项目的分镜和字幕切原视频，不渲染分镜文件，不拆人声/背景/特效轨。
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, 'create-jianying-simple-draft.py');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

const probe = spawnSync(python, ['-c', 'import pyJianYingDraft'], { encoding: 'utf8' });
if (probe.status !== 0) {
  if (process.env.REQUIRE_JIANYING === '1') {
    console.error(`pyJianYingDraft is required here but could not be imported: ${probe.stderr || probe.error}`);
    process.exit(1);
  }
  console.log('SKIP jianying simple draft (pyJianYingDraft is not installed here)');
  process.exit(0);
}
if (spawnSync(ffmpeg, ['-version']).status !== 0) {
  console.log('SKIP jianying simple draft (no ffmpeg)');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jy-simple-'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
try {
  const video = path.join(tmp, '第001集.mp4');
  const made = spawnSync(ffmpeg, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100',
    '-t',
    '6',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    video,
  ]);
  assert.equal(made.status, 0, String(made.stderr));

  const project = path.join(tmp, 'project');
  const result = (name, body) => {
    write(path.join(project, 'modules', name, `${name}.json`), body);
    return { status: 'succeeded', result_path: `modules/${name}/${name}.json` };
  };
  const modules = {
    media: result('media', {
      streams: [{ codec_type: 'video', width: 320, height: 568, avg_frame_rate: '25/1' }, { codec_type: 'audio' }],
      video_end: 6,
    }),
    clips: result('clips', {
      clips: [
        { shot_id: 's1', order: 1, start: 0, end: 2.4 },
        { shot_id: 's2', order: 2, start: 2.4, end: 4.0 },
        { shot_id: 's3', order: 3, start: 4.0, end: 6 },
      ],
    }),
    export: result('export', {
      subtitle_cues: [
        { start: 0.4, end: 2.0, text: '第一句文案' },
        { start: 2.2, end: 3.5, text: '第二句\n换行' },
        { start: 3.4, end: 5.5, text: '第三句和上一句有一点重叠' },
      ],
    }),
  };
  write(path.join(project, 'project.json'), { input_path: video, modules });

  const run = (extra = []) =>
    spawnSync(
      python,
      [
        script,
        project,
        '--name',
        'ep1',
        '--output-root',
        path.join(tmp, '短剧', '剪映草稿'),
        '--ffmpeg',
        ffmpeg,
        ...extra,
      ],
      {
        encoding: 'utf8',
      },
    );
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const created = JSON.parse(
    first.stdout
      .split('\n')
      .filter((line) => !line.startsWith('{"type"'))
      .join('\n'),
  );
  assert.equal(created.success, true);
  assert.equal(created.clip_count, 3);
  assert.equal(created.subtitle_count, 3);

  const dir = created.draft_dir;
  for (const file of ['draft_info.json', 'draft_meta_info.json', 'draft-manifest.json']) {
    assert.ok(fs.existsSync(path.join(dir, file)), file);
  }
  assert.ok(fs.existsSync(path.join(dir, '素材', '视频', '第001集.mp4')), '素材拷进草稿文件夹');
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8'));
  const byName = Object.fromEntries(info.tracks.map((track) => [track.name, track]));
  assert.deepEqual(Object.keys(byName).sort(), ['文案', '视频', '音频'].sort(), 'exactly three tracks');
  assert.equal(byName['视频'].type, 'video');
  assert.equal(byName['音频'].type, 'audio');
  assert.equal(byName['文案'].type, 'text');
  const ranges = byName['视频'].segments.map((segment) => [
    segment.target_timerange.start,
    segment.target_timerange.duration,
  ]);
  // 最后一个镜头的末尾可能为了让素材够用被让掉不到 1/4 帧（25fps = 10ms）。
  assert.deepEqual(
    ranges.map(([start]) => start),
    [0, 2400000, 4000000],
  );
  assert.deepEqual(ranges[0], [0, 2400000]);
  assert.deepEqual(ranges[1], [2400000, 1600000]);
  assert.ok(ranges[2][1] >= 2000000 - 10000 && ranges[2][1] <= 2000000);
  // 直接从原视频切：素材起点 = 时间线位置后移 1/4 帧（25fps = 10ms），保证取到的是这个镜头自己的第一帧，不是前一个镜头的最后一帧。
  for (const segment of byName['视频'].segments) {
    assert.equal(segment.source_timerange.start, segment.target_timerange.start + 10000);
    assert.equal(segment.source_timerange.duration, segment.target_timerange.duration);
    assert.equal(segment.volume, 0, 'the video segments are muted; sound is on its own track');
  }
  // 音频按同样的镜头边界切开：一个镜头一段，时间线位置和素材位置一致，首尾相接。
  const audioSegments = byName['音频'].segments;
  assert.equal(audioSegments.length, 3, 'audio is cut at every shot boundary');
  assert.deepEqual(
    audioSegments.map((segment) => segment.target_timerange.start),
    ranges.map(([start]) => start),
    'audio cuts line up with the video cuts',
  );
  for (const [index, segment] of audioSegments.entries()) {
    assert.equal(segment.source_timerange.start, segment.target_timerange.start, 'audio is not shifted');
    assert.equal(segment.source_timerange.duration, segment.target_timerange.duration);
    if (index < 2) assert.equal(segment.target_timerange.duration, ranges[index][1], 'same length as its shot');
    const next = audioSegments[index + 1];
    if (next)
      assert.equal(
        segment.target_timerange.start + segment.target_timerange.duration,
        next.target_timerange.start,
        'no gap or overlap between audio pieces',
      );
  }
  const audioEnd = audioSegments.at(-1).target_timerange.start + audioSegments.at(-1).target_timerange.duration;
  assert.ok(audioEnd >= 5900000, 'audio runs to the end of the episode');
  const texts = byName['文案'].segments;
  assert.equal(texts.length, 3);
  // 和多分轨的字幕轨一致：隐藏（静音）并缩放 1%。
  assert.equal(byName['文案'].attribute, 1, 'the 文案 track is hidden/muted like the multi-track subtitle track');
  for (const segment of texts) {
    assert.equal(segment.clip.scale.x, 0.01);
    assert.equal(segment.clip.scale.y, 0.01);
  }
  const [t1, t2, t3] = texts.map((segment) => segment.target_timerange);
  assert.ok(
    t1.start + t1.duration <= t2.start && t2.start + t2.duration <= t3.start,
    'cues never overlap on the 文案 track',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'draft-manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'jianying-draft/simple-v2');
  assert.equal(manifest.tracks.video.clip_count, 3);
  assert.equal(manifest.tracks.audio.scope, 'per_shot');
  assert.equal(manifest.tracks.audio.clip_count, 3);

  // 同名草稿不覆盖，--force 才覆盖。
  assert.notEqual(run().status, 0, 'an existing draft is not overwritten silently');
  assert.equal(run(['--force']).status, 0);

  // 草稿里记的每个素材都在、都在草稿自己的文件夹里；Windows 上是剪映自己的写法（正斜杠）。
  const materials = [...info.materials.videos, ...info.materials.audios].filter((item) => item.path);
  assert.ok(materials.length >= 2, 'video and audio materials');
  for (const material of materials) {
    assert.ok(fs.statSync(material.path).isFile(), `material exists: ${material.path}`);
    const relative = path.relative(dir, material.path);
    assert.ok(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      `inside the draft: ${material.path}`,
    );
    if (process.platform === 'win32') assert.ok(!material.path.includes('\\'), `forward slashes: ${material.path}`);
  }
  if (process.env.GITHUB_ACTIONS)
    console.log(`::notice title=剪映草稿素材路径（${process.platform}）::${materials[0].path}`);
  // 整个草稿文件夹挪到别处（老位置没了）：软件把素材路径改到新位置。
  const movedDir = path.join(tmp, '挪到这里', path.basename(dir));
  fs.mkdirSync(path.dirname(movedDir), { recursive: true });
  fs.cpSync(dir, movedDir, { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  const relink = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'native', 'jianying-relink.js'))}).relinkDraft(process.argv[1]).then((r) => console.log(JSON.stringify(r)))`,
      movedDir,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(relink.status, 0, relink.stderr);
  const relinked = JSON.parse(relink.stdout.trim());
  assert.equal(relinked.status, 'fixed');
  assert.equal(relinked.fixed, materials.length);
  const movedInfo = JSON.parse(fs.readFileSync(path.join(movedDir, 'draft_info.json'), 'utf8'));
  for (const material of [...movedInfo.materials.videos, ...movedInfo.materials.audios].filter((item) => item.path)) {
    assert.ok(fs.statSync(material.path).isFile(), `relinked material exists: ${material.path}`);
    assert.ok(!path.relative(movedDir, material.path).startsWith('..'), `relinked inside: ${material.path}`);
  }

  // 分镜有缺口时拒绝生成，不出半成品。
  const broken = JSON.parse(fs.readFileSync(path.join(project, 'modules', 'clips', 'clips.json'), 'utf8'));
  broken.clips[1].start = 2.9;
  write(path.join(project, 'modules', 'clips', 'clips.json'), broken);
  const bad = spawnSync(
    python,
    [script, project, '--name', 'ep2', '--output-root', path.join(tmp, 'drafts'), '--ffmpeg', ffmpeg],
    {
      encoding: 'utf8',
    },
  );
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /缺口|反向/);
  console.log(
    'PASS jianying simple draft: 视频 / 音频 / 文案 three tracks; 视频 and 音频 cut at the same shot boundaries',
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
