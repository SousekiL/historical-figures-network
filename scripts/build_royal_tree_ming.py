#!/usr/bin/env python3
"""Build the inspectable Ming imperial-family layout model."""
import argparse, collections, json
from pathlib import Path
ANCHOR=30148

def load(p): return json.loads(p.read_text(encoding='utf-8'))
def build(families_path, network_path, royal_path):
    families, network, royal=load(families_path),load(network_path),load(royal_path)
    source=next((f for f in families['families'] if f['id']=='family-ming'),None)
    members=set(map(int,source['members'])) if source else set()
    people={int(x['id']):x for x in network['nodes']}; royal_by={int(x['id']):x for x in royal['members']}
    for x in royal['members']: members.add(int(x['id']));people.setdefault(int(x['id']),x)
    edges=[{'source':int(x['source']),'target':int(x['target']),'gap':1} for x in royal['relationships']]
    adj=collections.defaultdict(list); und=collections.defaultdict(set)
    for x in edges:
      a,b=x['source'],x['target'];adj[a].append((b,1));adj[b].append((a,-1));und[a].add(b);und[b].add(a)
    gen={ANCHOR:0};q=collections.deque([ANCHOR])
    while q:
      u=q.popleft()
      for v,d in adj[u]:
       if v not in gen:gen[v]=gen[u]+d;q.append(v)
    emperor_ids=[int(x['id']) for x in royal['members'] if x.get('is_emperor')]
    for i in members:gen.setdefault(i,0)
    gen[ANCHOR]=0
    core=set(members);spouse=set();
    dist={ANCHOR:0};q=collections.deque([ANCHOR])
    while q:
      u=q.popleft()
      for v in und[u]:
       if v not in dist:dist[v]=dist[u]+1;q.append(v)
    for i in members:dist.setdefault(i,None)
    anchors={i:i for i in core};q=collections.deque([ANCHOR])
    while q:
      u=q.popleft()
      for v in und[u]:
       if v not in anchors:anchors[v]=anchors[u];q.append(v)
    nodes={}
    for i in sorted(members):
      p=people.get(i,{});role='core' if i in core else 'affinal'
      nodes[str(i)]={'id':i,'name':p.get('name',royal_by.get(i,{}).get('name','')),'generation':gen[i],'family_role':role,'anchor_distance':dist[i],'anchor_id':anchors.get(i)}
      if i in royal_by:nodes[str(i)].update({k:royal_by[i][k] for k in ('temple_name','reign_start','reign_end','is_emperor') if k in royal_by[i]})
    expected={str(i):gen[i] for i in emperor_ids}
    return {'anchor':ANCHOR,'expected_emperor_generations':expected,'nodes':nodes,'source':'data/royal_houses_ming.json','metadata':{'family_id':'family-ming','member_count':len(nodes)}}
def main():
 p=argparse.ArgumentParser();p.add_argument('--families',type=Path,default=Path('data/families.json'));p.add_argument('--network',type=Path,default=Path('data/network.json'));p.add_argument('--royal',type=Path,default=Path('data/royal_houses_ming.json'));p.add_argument('--output',type=Path,default=Path('data/royal_tree_ming.json'));a=p.parse_args();r=build(a.families,a.network,a.royal);a.output.write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(f'Wrote {a.output} ({len(r["nodes"])} nodes)')
if __name__=='__main__':main()
