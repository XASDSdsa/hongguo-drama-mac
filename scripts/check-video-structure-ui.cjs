const { app, BrowserWindow } = require('electron'),
  path = require('path'),
  os = require('os'),
  fs = require('fs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-ui-'));
app.setPath('userData', profile);
let win;
const errors = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(code) {
  return win.webContents.executeJavaScript(code);
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'fixtures/video-structure-ui-preload.cjs'),
        contextIsolation: true,
      },
    });
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) errors.push(message);
    });
    await win.loadFile(path.resolve(__dirname, '../dist-react/index.html'));
    await delay(150);
    await check("[...document.querySelectorAll('.sidebar-item')].find(e=>e.textContent==='视频结构化拆解').click()");
    await delay(150);
    await check(
      "(()=>{if(document.querySelectorAll('.structure-module').length!==9)throw Error('module count');if(!document.querySelector('.structure-toolbar .btn-primary').disabled)throw Error('missing input must block');if(![...document.querySelectorAll('.reconstruction-card-title')].some(e=>e.textContent.includes('0 / 9')))throw Error('step total')})()",
    );
    await check(
      "[...document.querySelectorAll('.reconstruction-row button')].find(e=>e.textContent.includes('选择')).click()",
    );
    await delay(100);
    await check(
      "(()=>{const cards=[...document.querySelectorAll('.structure-module')];if(cards[0].querySelector('button').disabled)throw Error('media should run');if(cards.slice(1).some(c=>!c.querySelector('button').disabled))throw Error('dependencies enabled early');cards[0].querySelector('button').click()})()",
    );
    await delay(100);
    await check(
      "(()=>{if(document.querySelector('progress').value!==25)throw Error('progress');if(!document.querySelector('.structure-progress-label').textContent.includes('25%'))throw Error('progress label');if([...document.querySelectorAll('.structure-module button')].some(b=>!b.disabled))throw Error('parallel start not blocked')})()",
    );
    win.webContents.send('test-progress', {
      success: true,
      projectId: 'fixture',
      status: 'running',
      stage: 'separation',
      inputPath: '/tmp/fixture.mp4',
      projectDir: '/tmp',
      manifestPath: '/tmp/project.json',
      modules: {
        separation: {
          status: 'running',
          progress: null,
          started_at: new Date().toISOString(),
          message: '正在加载分离模型',
        },
      },
    });
    await delay(100);
    await check(
      "(()=>{const p=document.querySelector('progress');if(p.hasAttribute('value'))throw Error('unknown progress invented a value');const text=document.querySelector('.structure-progress-label').textContent;if(!text.includes('等待进度数据')||text.includes('%')||!text.includes('正在加载分离模型'))throw Error('unknown progress label')})()",
    );
    win.webContents.send('test-progress', {
      success: true,
      projectId: 'fixture',
      status: 'running',
      stage: 'separation',
      inputPath: '/tmp/fixture.mp4',
      projectDir: '/tmp',
      manifestPath: '/tmp/project.json',
      modules: {
        separation: {
          status: 'running',
          progress: 100 / 6,
          progress_unit: 'stages',
          progress_completed: 1,
          progress_total: 6,
          started_at: new Date(Date.now() - 5000).toISOString(),
          message: '正在分离人声与背景',
        },
      },
    });
    await delay(100);
    await check(
      "(()=>{const card=[...document.querySelectorAll('.structure-module')][3],p=card.querySelector('progress');if(p.value!==1||p.max!==6||p.getAttribute('aria-valuetext')!=='阶段 1/6')throw Error('stage progress scale');const text=card.querySelector('.structure-progress-label').textContent;if(!text.includes('阶段 1/6')||text.includes('%'))throw Error('stages must not be time percentage');const phases=[...card.querySelectorAll('.structure-phase-list li')];if(phases.length!==6||!phases[0].classList.contains('is-done')||phases[1].getAttribute('aria-current')!=='step')throw Error('stage markers');if(!['模型启动','推理完成','音轨写入','人声校验','背景校验','结果保存'].every((name,i)=>phases[i].textContent.includes(name)))throw Error('stage labels');if(!card.querySelector('.structure-elapsed').textContent.includes('已运行'))throw Error('running elapsed label')})()",
    );
    const elapsedBefore = await check("document.querySelector('.structure-elapsed').textContent");
    await delay(1100);
    const elapsedAfter = await check("document.querySelector('.structure-elapsed').textContent");
    if (elapsedBefore === elapsedAfter) throw Error('running elapsed not updating');
    win.webContents.send('test-progress', {
      success: true,
      projectId: 'fixture',
      status: 'partial',
      stage: null,
      inputPath: '/tmp/fixture.mp4',
      projectDir: '/tmp',
      manifestPath: '/tmp/project.json',
      modules: {
        separation: {
          status: 'succeeded',
          progress: 100,
          progress_unit: 'stages',
          progress_completed: 6,
          progress_total: 6,
          elapsed_seconds: 6,
          message: '分离结果已保存',
        },
      },
    });
    await delay(100);
    await check(
      "(()=>{const phases=[...document.querySelectorAll('.structure-phase-list li')];if(phases.length!==6||phases.some(p=>!p.classList.contains('is-done')||p.hasAttribute('aria-current')))throw Error('six completed separation phases')})()",
    );
    win.webContents.send('test-progress', {
      success: true,
      projectId: 'fixture',
      status: 'partial',
      inputPath: '/tmp/fixture.mp4',
      projectDir: '/tmp',
      manifestPath: '/tmp/project.json',
      modules: {
        media: { status: 'succeeded', progress: 100, result_path: 'media.json', summary: { frame_count: 100 } },
      },
    });
    await delay(100);
    await check(
      "(()=>{const c=[...document.querySelectorAll('.structure-module')];if(c[1].querySelector('button').disabled||c[2].querySelector('button').disabled)throw Error('independent branches should enable');if(!c[6].querySelector('button').disabled)throw Error('clips needs dialogue alignment');if(!c[8].querySelector('button').disabled)throw Error('jianying needs all upstream steps')})()",
    );
    const upstream = {};
    ['media', 'audio', 'shots', 'separation', 'transcript', 'alignment', 'clips', 'export'].forEach(
      (id) => (upstream[id] = { status: 'succeeded', progress: 100 }),
    );
    const legacy = {
      ...upstream,
      alignment: { status: 'stale', message: '旧分镜使用合并规则，请点击继续完整流程' },
      clips: { status: 'stale' },
      export: { status: 'stale' },
      jianying: { status: 'stale' },
    };
    win.webContents.send('test-progress', {
      success: true,
      projectId: 'fixture',
      status: 'partial',
      inputPath: '/tmp/fixture.mp4',
      projectDir: '/tmp',
      manifestPath: '/tmp/project.json',
      modules: legacy,
    });
    await delay(100);
    await check(
      "(()=>{const cards=[...document.querySelectorAll('.structure-module')];const labels=cards.map(c=>c.querySelector('strong').textContent);if(labels.join('|')!==['视频信息','提取整集音频','检测视觉分镜','分离人声与背景','识别台词','关联台词与分镜','导出最终分镜','导出字幕与文件清单','生成剪映草稿'].join('|'))throw Error('dialogue stage order');if(!document.querySelector('.structure-toolbar .btn-primary').textContent.includes('继续完整流程'))throw Error('legacy must continue workflow');if(!cards[6].querySelector('button').disabled||!cards[8].querySelector('button').disabled)throw Error('legacy clips/draft gate');if(cards[5].querySelector('button').disabled||!cards[5].textContent.includes('旧分镜'))throw Error('alignment upgrade action')})()",
    );
    win.webContents.send('test-progress', {
      success: true,
      projectId: 'fixture',
      status: 'partial',
      inputPath: '/tmp/fixture.mp4',
      projectDir: '/tmp',
      manifestPath: '/tmp/project.json',
      modules: {
        ...legacy,
        alignment: {
          status: 'succeeded',
          summary: { raw_shot_count: 39, shot_count: 39, association_count: 23, merged_boundary_count: 0 },
        },
      },
    });
    await delay(100);
    await check(
      "(()=>{const cards=[...document.querySelectorAll('.structure-module')];if(cards[6].querySelector('button').disabled)throw Error('final clips gate');if(!cards[5].textContent.includes('保留视觉分镜 39 个 · 台词分段 23 条 · 人声字幕同步，允许跨镜头'))throw Error('alignment count summary');if(cards[5].textContent.includes('合并句中切点')||!cards[5].textContent.includes('连续说话可跨镜头'))throw Error('obsolete merge policy');if(!cards[8].querySelector('button').disabled)throw Error('draft awaits clips/export')})()",
    );
    win.webContents.send('test-progress', {
      success: true,
      projectId: 'fixture',
      status: 'completed',
      inputPath: '/tmp/fixture.mp4',
      projectDir: '/tmp',
      manifestPath: '/tmp/project.json',
      modules: upstream,
    });
    await delay(100);
    await check(
      "(()=>{const cards=[...document.querySelectorAll('.structure-module')];if(!document.querySelector('.structure-toolbar .btn-primary').textContent.includes('生成剪映草稿'))throw Error('draft action');if(cards[8].querySelector('button').disabled)throw Error('jianying should enable after 8 steps');if(![...document.querySelectorAll('.reconstruction-card-title')].some(e=>e.textContent.includes('8 / 9')))throw Error('draft must still be incomplete');if(document.querySelector('.reconstruction-status').textContent==='全部完成')throw Error('legacy completion must exclude missing draft')})()",
    );
    await check("document.querySelector('.structure-toolbar .btn-primary').click()");
    await delay(100);
    await check(
      "(()=>{const draft=[...document.querySelectorAll('.structure-module')][8];if(draft.querySelector('progress').value!==42)throw Error('draft progress');if(!draft.querySelector('.structure-progress-label').textContent.includes('42%'))throw Error('draft progress label')})()",
    );
    win.webContents.send('test-progress', {
      success: true,
      projectId: 'fixture',
      status: 'completed',
      inputPath: '/tmp/fixture.mp4',
      projectDir: '/tmp',
      manifestPath: '/tmp/project.json',
      modules: {
        ...upstream,
        jianying: { status: 'succeeded', progress: 100, summary: { draft_path: '/tmp/drafts/fixture' } },
      },
    });
    await delay(100);
    await check(
      "(()=>{const draft=[...document.querySelectorAll('.structure-module')][8];if(!draft.textContent.includes('打开草稿文件夹'))throw Error('draft folder action');if(![...document.querySelectorAll('.reconstruction-card-title')].some(e=>e.textContent.includes('9 / 9')))throw Error('draft complete count');draft.querySelector('.structure-result').click()})()",
    );
    const opened = await check('window.electronAPI.getOpenedPath()');
    if (opened !== '/tmp/drafts/fixture') throw Error('draft folder path');
    if (errors.length) throw Error(errors.join(';'));
    console.log(
      'PASS hidden renderer: 9 steps, input gate, dependency gates, progress updates, busy gate, draft gate, draft progress, draft folder action',
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    win?.destroy();
    app.quit();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
