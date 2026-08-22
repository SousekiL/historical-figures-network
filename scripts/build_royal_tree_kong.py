#!/usr/bin/env python3
import argparse,json
from pathlib import Path

def main():
 p=argparse.ArgumentParser();p.add_argument('--royal',type=Path,default=Path('data/royal_houses_kong.json'));p.add_argument('--families',type=Path,default=Path('data/families.json'));p.add_argument('--output',type=Path,default=Path('data/royal_tree_kong.json'));a=p.parse_args();src=json.loads(a.royal.read_text(encoding='utf-8')); families=json.loads(a.families.read_text(encoding='utf-8')); nodes={}
 for item in src['members']:
  x=dict(item); x['anchor_distance']=abs(int(x.get('generation') or 0)); x['anchor_id']='kong-15887'; nodes[str(x['id'])]=x
 ids={str(x.get('source_id')) for x in src['members'] if x.get('source_id') is not None}; ids.add('15887')
 support=[]
 for edge in families.get('edges',[]):
  s,t=str(edge.get('source')),str(edge.get('target'))
  if s in ids or t in ids:
   support.append({'source':edge.get('source'),'target':edge.get('target'),'kin_code':edge.get('kin_code'),'generation_gap':edge.get('generation_gap'),'direction':edge.get('direction'),'structural':False,'evidence_type':'CBDB family edge'})
 out={'anchor':'kong-15887','expected_anchor_generation':0,'nodes':nodes,'parent':{str(r['target']):str(r['source']) for r in src['relationships'] if r.get('structural')},'support_edges':support,'source':src['source_urls'],'metadata':src['metadata']}
 a.output.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(f'Wrote {a.output} ({len(nodes)} nodes, {len(support)} support edges)')
if __name__=='__main__':main()
