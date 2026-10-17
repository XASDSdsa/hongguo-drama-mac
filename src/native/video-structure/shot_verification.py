import numpy as np,cv2

def candidate_frames(scores,threshold=.5):
 r=[];i=0
 while i<len(scores):
  if scores[i]<threshold:i+=1;continue
  j=i
  while i+1<len(scores) and scores[i+1]>=threshold:i+=1
  r.append(j+int(np.argmax(scores[j:i+1])));i+=1
 return [x for x in r if 0<x<len(scores)]

def verify(frames,pts,candidates,video_end):
 # Prototype: permissive candidates, reject only evidenced continuity / leading fade.
 # Any inconclusive boundary remains a warning; short duration alone never deletes a cut.
 g=np.array([cv2.GaussianBlur(cv2.resize(cv2.cvtColor(f,cv2.COLOR_RGB2GRAY),(64,36)),(3,3),0) for f in frames],np.float32)/255
 avg=g.mean((1,2));sd=g.std((1,2));n=(g-avg[:,None,None])/np.maximum(sd[:,None,None],.04)
 def window(t1,t2):
  ids=np.flatnonzero((pts>=t1)&(pts<t2));return ids[np.linspace(0,len(ids)-1,min(4,len(ids)),dtype=int)] if len(ids) else ids
 def distance(a,b):
  if not len(a) or not len(b):return None
  ds=[]
  for i in a:
   for j in b:
    x=n[i,2:-2,2:-2];y=n[j]
    ds.append(min(float(np.mean((x-y[2+dy:34+dy,2+dx:62+dx])**2))/2 for dx in [-2,0,2] for dy in [-2,0,2]))
  return float(np.quantile(ds,.2))
 results=[]
 for k,c in enumerate(candidates):
  t=float(pts[c]);prev=float(pts[candidates[k-1]]) if k else 0;next_t=float(pts[candidates[k+1]]) if k+1<len(candidates) else float(video_end)
  span=min(.32,max(.08,(t-prev)*.6),max(.08,(next_t-t)*.6))
  left=window(max(prev,t-span-.04),t-.04);right=window(t+.04,min(next_t,t+span+.04));later=window(t+span/2,min(next_t,t+span*1.5+.04))
  d=distance(left,right);late=distance(left,later);reason='keep';status='kept'
  leading=k==0 and t<1 and avg[0]<.015 and sd[0]<.015
  bright_rise=float(avg[c]-avg[0])
  # Both temporal comparisons must support continuity. No nearest-frame-only decision.
  continuity=d is not None and late is not None and d<.23 and late<.25
  if leading and bright_rise>.025:status='rejected';reason='leading_fade'
  elif continuity:status='rejected';reason='persistent_same_structure'
  elif d is None or late is None or min(d,late)<.32:status='warn';reason='insufficient_or_ambiguous_structure'
  results.append({'frame':c,'time':t,'status':status,'reason':reason,'distance':d,'late_distance':late})
 return [r['frame'] for r in results if r['status']!='rejected'],results
