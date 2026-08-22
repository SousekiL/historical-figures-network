#!/usr/bin/env python3
"""Generate cautious Kong lineage from the published Da-zong sequence."""
import argparse, collections, json
from pathlib import Path
MAINLINE = ['孔丘（孔子）','孔鲤','孔伋（子思）','孔白','孔求','孔箕','孔穿','孔谦','孔腾','孔忠','孔武','孔延年','孔霸','孔福','孔房','孔均','孔志','孔损','孔曜','孔完','孔羨','孔震','孔嶷','孔抚','孔懿','孔鲜','孔乘','孔灵珍','孔文泰','孔渠','孔长孙','孔英悊','孔德伦','孔崇基','孔璲之','孔萱','孔齐卿','孔惟晊','孔策','孔振','孔昭俭','孔光嗣','孔仁玉','孔宜','孔延世','孔圣佑','孔宗愿','孔若蒙','孔端友','孔玠','孔搢','孔文远','孔万春','孔洙','孔思晦','孔克坚','孔希学','孔讷','孔公鉴','孔彦缙','孔承庆','孔弘绪','孔闻韶','孔贞干','孔尚贤','孔胤植','孔兴燮','孔毓圻','孔传铎','孔继濩','孔广棨','孔昭焕','孔宪培','孔庆镕','孔繁灏','孔祥珂','孔令贻']
CBDB={'孔丘（孔子）':15887,'孔洙':100411}
BRANCHES=[{'id':'kong-branch-kongfu','name':'孔鲋','generation':8,'note':'旁支'},{'id':'kong-branch-kongji','name':'孔吉','generation':13,'note':'旁支'},{'id':'kong-branch-kongruo','name':'孔若虚','generation':47,'note':'旁支'},{'id':'kong-branch-kongduancao','name':'孔端操','generation':48,'note':'旁支'},{'id':'kong-branch-kongfan','name':'孔璠','generation':49,'note':'支系候选'},{'id':'kong-branch-kongzong','name':'孔总','generation':50,'note':'支系候选'},{'id':'kong-branch-kongyuan','name':'孔元措','generation':51,'note':'支系候选'},{'id':'kong-branch-kongzhi','source_id':100409,'name':'孔治','generation':None,'note':'CBDB支线，非大宗结构'},{'id':'kong-branch-kongdao','source_id':15939,'name':'孔道辅','generation':None,'note':'CBDB后世支线，代数待核'},{'id':'kong-branch-kongzonghan','source_id':15941,'name':'孔宗翰','generation':None,'note':'CBDB后世支线，代数待核'},{'id':'kong-branch-kongyuanlong','source_id':37725,'name':'孔元龙','generation':None,'note':'CBDB gap99支线，非逐代结构'},{'id':'kong-branch-kongrong','name':'孔融','generation':None,'note':'旁支；无已确认CBDB ID'}]
def build(families_path):
 families=json.loads(families_path.read_text(encoding='utf-8')); nodes={}
 for generation,name in enumerate(MAINLINE):
  item={'id':'kong-g%02d'%generation,'name':name,'generation':generation,'family_role':'core','confidence':'source_claim','evidence_type':'Wiki 孔子世家大宗世系'}
  if name in CBDB:item.update(source_id=CBDB[name],confidence='cbdb_match' if generation else 'identity',evidence_type='CBDB + Wiki')
  nodes[item['id']]=item
 nodes['kong-g00']['id']='kong-15887'
 for branch in BRANCHES:
  item=dict(branch);item.update(family_role='affinal',confidence='source_claim',evidence_type='Wiki/CBDB branch',anchor_id='kong-15887',anchor_distance=None);nodes[item['id']]=item
 relationships=[]
 for generation in range(1,len(MAINLINE)):
  relationships.append({'source':'kong-15887' if generation==1 else 'kong-g%02d'%(generation-1),'target':'kong-g%02d'%generation,'relation':'父子/大宗承接','direction':'ancestor','generation_gap':1,'structural':True,'confidence':'source_claim','evidence_type':'Wiki世系页'})
 ids={str(x.get('source_id')) for x in BRANCHES if x.get('source_id') is not None};ids.add('15887');support=[]
 for edge in families.get('edges',[]):
  s,t=str(edge.get('source')),str(edge.get('target'))
  if s in ids or t in ids:support.append({'source':edge.get('source'),'target':edge.get('target'),'kin_code':edge.get('kin_code'),'generation_gap':edge.get('generation_gap'),'direction':edge.get('direction'),'structural':False,'evidence_type':'CBDB family edge'})
 return {'house':'孔氏家族（孔子世家大宗草案）','family_id':'family-kong','anchor':'kong-15887','status':'draft','source_urls':['https://zh.wikipedia.org/wiki/孔子世家大宗世系','https://zh.wikisource.org/wiki/史記/卷047','https://zh.wikisource.org/wiki/漢書/卷053'],'members':list(nodes.values()),'relationships':relationships,'support_edges':support,'metadata':{'mainline_count':len(MAINLINE),'mainline_generation_range':[0,len(MAINLINE)-1],'note':'主线按Wiki世系编号草案逐代连接，仍需版本卷页核验；CBDB gap45/99仅辅助。'}}
def main():
 p=argparse.ArgumentParser();p.add_argument('--families',type=Path,default=Path('data/families.json'));p.add_argument('--output',type=Path,default=Path('data/royal_houses_kong.json'));a=p.parse_args();r=build(a.families);a.output.write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print('Wrote %s (%d nodes, %d mainline edges)'%(a.output,len(r['members']),len(r['relationships'])))
if __name__=='__main__':main()
