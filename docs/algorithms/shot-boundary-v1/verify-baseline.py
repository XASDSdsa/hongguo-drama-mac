from pathlib import Path
import hashlib,json,sys
from duration_policy import minimum_duration
b=Path(__file__).parent
manifest=json.loads((b/'manifest.json').read_text())
for name,digest in manifest['sha256'].items():
 assert hashlib.sha256((b/name).read_bytes()).hexdigest()==digest, 'Frozen baseline changed: '+name
f=json.loads((b/'accepted-baseline.json').read_text())
actual,warn=minimum_duration(f['verified_candidate_frames'],f['frame_times'],f['source_duration'],f['predictions']['single'],2)
assert actual==f['accepted']['cuts'] and warn is None
edges=[0]+actual+[f['frame_count']]
pts=f['frame_times']+[f['source_duration']]
assert len(edges)-1==22
assert min(pts[y]-pts[x] for x,y in zip(edges,edges[1:]))>=2-1e-9
assert sum(y-x for x,y in zip(edges,edges[1:]))==2270
if len(sys.argv)>1:
 import numpy as np
 from verify import verify,candidate_frames
 frames=np.load(sys.argv[1]);cuts,decisions=verify(frames,np.array(f['frame_times']),candidate_frames(f['predictions']['single']),f['source_duration'])
 assert cuts==f['verified_candidate_frames'], 'Temporal verification changed'
 assert [d['status'] for d in decisions]==[d['status'] for d in f['verification_decisions']]
print('PASS frozen hashes, 22 segments, minimum 2s, 2270 frames; temporal verified='+str(len(sys.argv)>1))
