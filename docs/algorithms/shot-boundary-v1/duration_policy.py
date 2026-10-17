"""Output-segment duration policy, separate from true shot-boundary detection."""
import math

def minimum_duration(cuts, frame_times, video_end, scores, seconds):
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError('minimum duration must be positive')
    n=len(frame_times)
    if n == 0 or len(scores)!=n:
        raise ValueError('timeline/score length mismatch')
    candidates=sorted(set(cuts))
    if any(c<=0 or c>=n for c in candidates):
        raise ValueError('candidate frame outside timeline')
    if any(not math.isfinite(float(scores[c])) for c in candidates):
        raise ValueError('invalid boundary score')
    if any(b<=a for a,b in zip(frame_times,frame_times[1:])) or video_end<=frame_times[-1]:
        raise ValueError('invalid frame timestamps')
    if video_end-frame_times[0]<seconds:
        return [], 'source_shorter_than_minimum'
    nodes=[0]+candidates+[n]
    times=[float(frame_times[c]) if c<n else float(video_end) for c in nodes]
    best=[float('-inf')]*len(nodes);parent=[None]*len(nodes);best[0]=0.0
    # Keep the strongest feasible set, rather than a left-to-right greedy merge.
    for j in range(1,len(nodes)):
        weight=0.0 if nodes[j]==n else float(scores[nodes[j]])
        for i in range(j):
            if times[j]-times[i]>=seconds-1e-9 and best[i]+weight>best[j]:
                best[j]=best[i]+weight;parent[j]=i
    if parent[-1] is None:
        raise AssertionError('full source should always be a feasible segment')
    keep=[];j=len(nodes)-1
    while parent[j] is not None:
        if nodes[j]<n:keep.append(nodes[j])
        j=parent[j]
    return list(reversed(keep)), None
