// Build machine only; Electron never invokes this script.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),target=process.platform+'-'+process.arch;
const sources=['scripts/setup-video-structure.py','scripts/build-video-structure.py','scripts/video-structure.spec','scripts/video-structure-requirements.txt','src/native/video-structure/runner.py','src/native/video-structure/vendor/transnetv2_pytorch.py'];
sources.push(...fs.readdirSync(path.join(root,'src/native/video-structure')).filter(f=>f.endsWith('.py')&&f!=='runner.py').sort().map(f=>'src/native/video-structure/'+f));
const buildId=createHash('sha256').update(Buffer.concat(sources.map(f=>fs.readFileSync(path.join(root,f))))).digest('hex');
function run(exe,args){const r=spawnSync(exe,args,{cwd:root,stdio:'inherit',windowsHide:true});if(r.error||r.status!==0)throw Error(r.error?.message||exe+' exited '+r.status);}
try{
 if(!['darwin-arm64','win32-x64'].includes(target))throw Error('Unsupported build target '+target);
 const manifest=path.join(root,'build/video-structure',target,'bundle.json');
 if(fs.existsSync(manifest)&&JSON.parse(fs.readFileSync(manifest)).buildId===buildId&&!process.argv.includes('--force')){require('./check-video-structure-bundle.cjs').verifyBundle(root,process.platform,process.arch);console.log('结构化拆解运行时已经就绪');process.exit(0);}
 const candidates=process.env.STRUCTURE_BUILD_PYTHON?[[process.env.STRUCTURE_BUILD_PYTHON]]:process.platform==='win32'?[['py','-3.12'],['python']]:[['python3.12'],['python3']];
 const found=candidates.find(([exe,...args])=>spawnSync(exe,[...args,'-c','import sys;sys.exit(0 if sys.version_info[:2]==(3,12) else 1)'],{windowsHide:true}).status===0);
 if(!found)throw Error('构建机需要 Python 3.12，可设置 STRUCTURE_BUILD_PYTHON；用户安装包不需要此环境');
 const venv=path.join(root,'.cache/video-structure','venv-'+target),python=path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');
 if(!fs.existsSync(python))run(found[0],[...found.slice(1),'-m','venv',venv]);
 if(process.platform==='win32')run(python,['-m','pip','install','torch==2.5.1','--index-url','https://download.pytorch.org/whl/cpu']);
 run(python,['-m','pip','install','--only-binary=:all:','-r',sources[3]]);
 run(python,['scripts/build-video-structure.py',target,buildId]);
}catch(e){console.error(e.message);process.exitCode=1;}
