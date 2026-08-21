#!/usr/bin/env python3
"""Build inspectable Tang royal family layout data."""
import argparse, collections, json
from pathlib import Path
ANCHOR=13059

def load(path): return json.loads(path.read_text(encoding='utf-8'))
def build(families_path, network_path, royal_path):
    families, network, royal = load(families_path), load(network_path), load(royal_path)
    family=next(f for f in families['families'] if f['id']=='family-2')
    members={int(x) for x in family['members']}; royal_by={int(x['id']):x for x in royal['members']}
    people={int(x['id']):x for x in network['nodes']}
    for x in royal['members']:
        member_id = int(x['id'])
        # Royal records are authoritative: include known emperors even when
        # the source family graph does not yet contain the person.
        members.add(member_id)
        people.setdefault(member_id, x)
    edges=[]
    for x in royal.get('relationships',[]): edges.append({'source':int(x['source']),'target':int(x['target']),'gap':1})
    for x in families['edges']:
        a,b=int(x['source']),int(x['target']); g=int(x.get('generation_gap') or 0)
        if a in members and b in members and x.get('direction')=='ancestor' and 1<=g<=20: edges.append({'source':a,'target':b,'gap':g})
    adj=collections.defaultdict(list); und=collections.defaultdict(set)
    for x in edges:
        a,b,g=x['source'],x['target'],x['gap']; adj[a].append((b,g)); adj[b].append((a,-g)); und[a].add(b);und[b].add(a)
    gen={ANCHOR:0}; q=collections.deque([ANCHOR])
    while q:
        u=q.popleft()
        for v,d in sorted(adj[u],key=lambda z:(abs(z[1])!=1,abs(z[1]),z[0])):
            if v not in gen: gen[v]=gen[u]+d;q.append(v)
    for i in members: gen.setdefault(i,0)
    expected={int(x['id']):0 for x in royal['members']}
    # Canonical dynastic layers: cohorts share a layer despite succession intervals.
    expected.update({13059:0,13060:1,19241:2,93663:2,19242:3,19243:3,92998:4,19244:4,19245:5,19246:6,19247:7,447735:8,166933:9,189264:10,-20001:11,-20002:11,-20003:11,19254:12,93105:13,-20004:14,189298:14,339634:15})
    gen.update(expected)
    direct=collections.defaultdict(set)
    for x in edges:
        if x['gap']==1: direct[x['source']].add(x['target']);direct[x['target']].add(x['source'])
    reachable={ANCHOR};q=collections.deque([ANCHOR])
    while q:
        u=q.popleft()
        for v in sorted(direct[u]):
            if v not in reachable:reachable.add(v);q.append(v)
    emperors=set(expected); core={i for i in members if i in reachable and str(people.get(i,{}).get('name','')).startswith('李')};core|=emperors
    spouses=set()
    for x in edges:
        a,b=x['source'],x['target']
        if x['gap']==1 and ((a in core)^(b in core)):spouses.add(b if a in core else a)
    spouses-=core
    distance={ANCHOR:0};q=collections.deque([ANCHOR])
    while q:
        u=q.popleft()
        for v in sorted(und[u]):
            if v not in distance:distance[v]=distance[u]+1;q.append(v)
    for i in members:distance.setdefault(i,None)
    anchors={i:i for i in core};q=collections.deque(sorted(core))
    while q:
        u=q.popleft()
        for v in sorted(und[u]):
            if v not in anchors:anchors[v]=anchors[u];q.append(v)
    nodes={}
    for i in sorted(members):
        p=people.get(i,{}); role='core' if i in core else ('spouse' if i in spouses else 'affinal')
        nodes[str(i)]={'id':i,'name':p.get('name',royal_by.get(i,{}).get('name','')),'generation':gen[i],'family_role':role,'anchor_distance':distance[i],'anchor_id':anchors.get(i)}
        if i in royal_by:
            nodes[str(i)].update({k:royal_by[i][k] for k in ('temple_name','reign_start','reign_end','is_emperor') if k in royal_by[i]})
    return {'anchor':ANCHOR,'expected_emperor_generations':{str(k):v for k,v in expected.items()},'nodes':nodes,'source':'data/families.json + data/network.json + data/royal_houses_tang.json','metadata':{'family_id':'family-2','member_count':len(nodes)}}
def main():
 p=argparse.ArgumentParser();p.add_argument('--families',type=Path,default=Path('data/families.json'));p.add_argument('--network',type=Path,default=Path('data/network.json'));p.add_argument('--royal',type=Path,default=Path('data/royal_houses_tang.json'));p.add_argument('--output',type=Path,default=Path('data/royal_tree_tang.json'));a=p.parse_args(); result=build(a.families,a.network,a.royal); a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8'); print(f'Wrote {a.output} ({len(result["nodes"])} nodes)')
if __name__=='__main__':main()
