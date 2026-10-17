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
      [script, project, '--name', 'ep1', '--output-root', path.join(tmp, 'drafts'), '--ffmpeg', ffmpeg, ...extra],
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
  for (const file of ['draft_info.json', 'draft_meta_info.json', 'hongguo-draft-manifest.json']) {
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
  assert.deepEqual(ranges, [
    [0, 2400000],
    [2400000, 1600000],
    [4000000, 2000000],
  ]);
  // 直接从原视频切：每段的素材起点等于它在时间线上的位置，不是另外导出的分镜文件。
  for (const segment of byName['视频'].segments) {
    assert.equal(segment.source_timerange.start, segment.target_timerange.start);
    assert.equal(segment.volume, 0, 'the video segments are muted; sound is on its own track');
  }
  assert.equal(byName['音频'].segments.length, 1);
  assert.equal(byName['音频'].segments[0].target_timerange.start, 0);
  assert.ok(byName['音频'].segments[0].target_timerange.duration >= 5900000);
  const texts = byName['文案'].segments;
  assert.equal(texts.length, 3);
  const [t1, t2, t3] = texts.map((segment) => segment.target_timerange);
  assert.ok(
    t1.start + t1.duration <= t2.start && t2.start + t2.duration <= t3.start,
    'cues never overlap on the 文案 track',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'hongguo-draft-manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'hongguo-jianying-draft/simple-v1');
  assert.equal(manifest.tracks.video.clip_count, 3);

  // 同名草稿不覆盖，--force 才覆盖。
  assert.notEqual(run().status, 0, 'an existing draft is not overwritten silently');
  assert.equal(run(['--force']).status, 0);

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
  console.log('PASS jianying simple draft: 视频 / 音频 / 文案 three tracks cut from the original video');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
