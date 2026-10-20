"""Build an offline runtime. Users do not need Python, pip or model downloads."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import runpy
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[1]
def digest(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()
def main():
    target, build_id = sys.argv[1:3]
    out = ROOT / 'build/video-structure' / target
    cache = ROOT / '.cache/video-structure'
    subprocess.run([sys.executable, str(ROOT/'scripts/setup-video-structure.py')], check=True)
    subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--clean','--distpath',str(cache/'dist'/target),'--workpath',str(cache/'work'/target),str(ROOT/'scripts/video-structure.spec')],cwd=ROOT,check=True)
    worker=out/'worker'
    if worker.exists(): shutil.rmtree(worker)
    shutil.copytree(cache/'dist'/target/'structure-worker',worker,symlinks=True)
    executable=worker/('structure-worker.exe' if sys.platform=='win32' else 'structure-worker')
    env={**os.environ,'PATH':str(Path(os.environ['SystemRoot'])/'System32') if sys.platform=='win32' else '/usr/bin:/bin','PYTHONNOUSERSITE':'1'}
    env.pop('PYTHONHOME',None);env.pop('PYTHONPATH',None)
    minimum_macos = runpy.run_path(str(ROOT/'scripts/build-faster-whisper.py'))['check_macos_compatibility'](out) if sys.platform == 'darwin' else None
    versions=json.loads(subprocess.check_output([str(executable),'status'],env=env))
    algorithm_id='transnetv2-temporal-min2s-v2'
    if versions.get('opencv')!='4.11.0' or versions.get('shot_algorithm')!=algorithm_id:raise RuntimeError('Frozen shot verifier version mismatch')
    models=out/'models';sample=models/'sherpa-onnx-paraformer-zh-small-2024-03-09/test_wavs/0.wav';test=cache/'frozen-transcript.json'
    subprocess.run([str(executable),'transcript','--input',str(sample),'--output',str(test),'--model',str(models/'sherpa-onnx-paraformer-zh-small-2024-03-09/model.int8.onnx'),'--tokens',str(models/'sherpa-onnx-paraformer-zh-small-2024-03-09/tokens.txt'),'--vad',str(models/'silero_vad.onnx')],env=env,check=True)
    if not json.loads(test.read_text(encoding='utf-8'))['segments']:raise RuntimeError('Frozen offline speech self-test returned no segments')
    punct_model = models/'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/model.int8.onnx'
    before = json.loads(test.read_text(encoding='utf-8'))['segments']
    subprocess.run([str(executable),'transcript','--input',str(sample),'--output',str(test),'--model',str(models/'sherpa-onnx-paraformer-zh-small-2024-03-09/model.int8.onnx'),'--tokens',str(models/'sherpa-onnx-paraformer-zh-small-2024-03-09/tokens.txt'),'--vad',str(models/'silero_vad.onnx'),'--punctuation',str(punct_model)],env=env,check=True)
    punctuated = json.loads(test.read_text(encoding='utf-8'))
    if punctuated.get('sentence_boundary_source') != 'ct_transformer_global' or len(punctuated['segments']) != len(before): raise RuntimeError('Frozen punctuation self-test failed')
    frames=cache/'frozen-frames.rgb';frames.write_bytes(bytes(27*48*3*10));test=cache/'frozen-shots.json'
    subprocess.run([str(executable),'shots','--input',str(frames),'--output',str(test),'--model',str(models/'transnetv2.pth')],env=env,check=True)
    if len(json.loads(test.read_text(encoding='utf-8'))['single'])!=10:raise RuntimeError('Frozen TransNet self-test failed')
    review_frames=cache/'frozen-review-frames.rgb';review_frames.write_bytes(bytes(160*90*3*10))
    timeline=cache/'frozen-timeline.json';timeline.write_text(json.dumps(dict(frame_count=10,video_end=2.5,frames=[dict(start=2.1+i/25) for i in range(10)])),encoding='utf-8')
    verification=cache/'frozen-shot-verification.json'
    subprocess.run([str(executable),'verify-shots','--input',str(review_frames),'--timeline',str(timeline),'--predictions',str(test),'--threshold','0.5','--output',str(verification)],env=env,check=True)
    verified=json.loads(verification.read_text(encoding='utf-8'))
    if verified.get('algorithm_id')!=algorithm_id or verified.get('minimum_duration')!=2 or verified.get('cuts')!=[] or verified.get('frame_count')!=10 or verified.get('warnings')!=['source_shorter_than_minimum']:raise RuntimeError('Frozen shot verifier self-test failed')
    invalid_output=cache/'frozen-invalid-threshold.json';invalid_output.unlink(missing_ok=True)
    invalid=subprocess.run([str(executable),'verify-shots','--input',str(review_frames),'--timeline',str(timeline),'--predictions',str(test),'--threshold','0.6','--output',str(invalid_output)],env=env,capture_output=True,text=True)
    if invalid.returncode==0 or invalid_output.exists() or 'Invalid verification timeline or prediction scores' not in invalid.stderr:raise RuntimeError('Frozen shot verifier accepted an unapproved threshold')
    license_dir=out/'licenses';license_dir.mkdir(exist_ok=True)
    for name in ['torch','sherpa-onnx','numpy','opencv-python-headless','sympy','networkx','filelock','fsspec','jinja2','markupsafe','mpmath']:
        dist=importlib.metadata.distribution(name)
        for entry in dist.files or []:
            if any(t in str(entry).lower() for t in ('license','notice','copying')):
                source=dist.locate_file(entry)
                if source.is_file():
                    destination=license_dir/name/str(entry).replace('..','_');destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,destination)
    shutil.copyfile(ROOT/'src/native/video-structure/vendor/TRANSNET-LICENSE.txt',license_dir/'TransNetV2-MIT.txt')
    files={str(p.relative_to(out)).replace(os.sep,'/'):digest(p) for p in out.rglob('*') if p.is_file() and p.name not in ['bundle.json']}
    (out/'bundle.json').write_text(json.dumps(dict(platform=target,minimumMacOS=minimum_macos,buildId=build_id,offlineSelfTest=True,shotVerifierSelfTest=True,punctuationSelfTest=True,versions=versions,sha256=files),indent=2),encoding='utf-8')
    print('Offline structured runtime verified:',out)
if __name__=='__main__':main()
