#!/usr/bin/env python3
"""
从 CBDB（中国历代人物传记资料库）提取跨朝代「历史文化名人」关系网络。

数据源：CBDB SQLite 数据库（cbdb202409.db）
产出：
  - data/processed/people.csv         人物表
  - data/processed/relationships.csv  关系表
  - data/network.json                 前端直接使用（nodes + edges）
  - data/dictionaries/dynasty_tiers.json     朝代档位字典
  - data/dictionaries/relationship_codes.json 关系类型字典

用法：
    python scripts/extract_cbdb.py [--db PATH] [--outdir PATH] [--min-degree N]

口径说明（详见 docs/methodology.md）：
  - 名人筛选：以「关系度」为代理——社交关系度（ASSOC_DATA，去重后）权重 2
    + 亲属关系度（KIN_DATA，去重后）权重 1，按朝代档位取 top-K。
    知名度高的历史人物往往留下更多可考的社会关系记录，故以此作为可追溯的筛选信号。
  - 关系提取：仅保留两端都在入选人物集合内的关系（保证网络连通）。
  - 关系方向：ASSOC_DATA 中每条关系双向各存一条（ego/alter），构建时按
    (min_id, max_id, code) 去重。
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

# --------------------------------------------------------------------------- #
# 朝代档位（8 档）。键为档位名，值为 CBDB 的 c_dy 朝代代码列表。
# 档位字典同时写入 data/dictionaries/dynasty_tiers.json，便于前端读取与后续扩展。
# --------------------------------------------------------------------------- #
DYNASTY_TIERS: dict[str, list[int]] = {
    "春秋战国": [1],                                        # 漢前 (-1100 ~ -206)
    "秦汉": [2, 61, 83, 29, 46, 25],                        # 秦漢 及 贏秦/漢/西漢/新/東漢
    "魏晋南北朝": [3, 26, 53, 42, 82, 23, 27, 4, 28, 32,
                   44, 37, 24, 30, 41, 40, 35, 31, 68],     # 三國/晉/南北朝 及主要割据政权
    "隋唐": [5, 6, 77],                                     # 隋/唐/武周
    "宋": [15],
    "元": [18],
    "明": [19, 80],                                         # 明/南明
    "清": [20],
}

# 各档位的年代区间（由 DYNASTIES.c_start/c_end 聚合而来）。
# 用于「跨朝代」判定：人物生卒区间与某档位区间有交叠即归入该档位。
# 注意：宋/元、明/清 的区间刻意保留交叠，以容纳宋元之际、明清之际的跨朝人物。
TIER_RANGES: dict[str, tuple[int, int]] = {
    "春秋战国": (-1100, -206),
    "秦汉": (-221, 220),
    "魏晋南北朝": (220, 589),
    "隋唐": (581, 907),
    "宋": (960, 1279),
    "元": (1234, 1367),
    "明": (1368, 1661),
    "清": (1644, 1911),
}

# 每档目标人数（可被数据量限制而低于目标）
QUOTAS: dict[str, int] = {
    "春秋战国": 15,
    "秦汉": 22,
    "魏晋南北朝": 25,
    "隋唐": 35,
    "宋": 40,
    "元": 25,
    "明": 28,
    "清": 25,
}

# 关系类型简化映射（基于 ASSOC_TYPES 的 level-1 代码）。
# 键为 ASSOC_TYPES.c_assoc_type_id（level-1），值为简化关系类型。
REL_TYPE_BY_ASSOC_TYPE: dict[str, str] = {
    "0202": "師生",   # 師生關係
    "0207": "唱和",   # 文學藝術交往
    "0301": "好友",   # 朋友關係（籠統）
    "0402": "同僚",   # 官場關係（平級）
    "0403": "同僚",   # 官場關係（下屬）
    "0404": "同僚",   # 官場關係（上司）
    "0405": "同僚",   # 政治奧援
    "0406": "同僚",   # 薦舉保任
    "0407": "政敵",   # 政治對抗
    "0901": "家族",   # 家庭關係（籠統）
}

# 关系类型字典（写入 dictionaries），供前端图例/筛选使用
RELATIONSHIP_CODES: dict[str, str] = {
    "師生": "师生 / 问学 / 师承",
    "好友": "朋友关系",
    "家族": "亲属关系（含 KIN_DATA）",
    "同僚": "官场 / 政治协作关系",
    "政敵": "政治对抗关系",
    "唱和": "诗文 / 书画 / 著述交往",
    "交往": "一般社会交往（含学术、军事、宗教等）",
}

# 人物类别映射：由人物主要关系类型推断（见 methodology.md）
CATEGORY_BY_DOMINANT_REL: dict[str, str] = {
    "唱和": "文學家",
    "師生": "學者",
    "好友": "文人",
    "同僚": "政治家",
    "政敵": "政治家",
    "家族": "名門",
    "交往": "文化名人",
}


def _tier_of(dy: int | None) -> str | None:
    if dy is None:
        return None
    for tier, dys in DYNASTY_TIERS.items():
        if dy in dys:
            return tier
    return None


def tiers_of_person(dy: int | None, birth: int | None, death: int | None,
                    index_year: int | None) -> list[str]:
    """返回该人物所属的所有朝代档位（去重、按档位字典顺序）。

    口径：跨朝代人物归入其生卒区间覆盖的每一个档位（生卒与档位区间有交叠）。
    - 始终保留 CBDB 主标注 `c_dy` 所属档位（primary），保证年代缺失时仍有归属；
    - 有生卒年时，用 [生年, 卒年] 与各档位 [start, end] 求交叠，交叠即归入；
    - 生卒年缺失但有序年 index_year 时，用该点年判定；
    - 全缺失时仅归 primary。
    """
    primary = _tier_of(dy)
    tiers: list[str] = []
    if primary:
        tiers.append(primary)

    lo = hi = None
    if birth is not None or death is not None:
        lo = birth if birth is not None else death
        hi = death if death is not None else birth
    elif index_year is not None:
        lo = hi = index_year

    if lo is not None and hi is not None:
        for tier, (s, e) in TIER_RANGES.items():
            if tier in tiers:
                continue
            if lo <= e and hi >= s:  # 区间交叠
                tiers.append(tier)

    return tiers if tiers else ([primary] if primary else [])


def _simplified_rel_type(assoc_type_id: str | None, is_kin: bool = False) -> str:
    if is_kin:
        return "家族"
    if assoc_type_id is None:
        return "交往"
    if assoc_type_id in REL_TYPE_BY_ASSOC_TYPE:
        return REL_TYPE_BY_ASSOC_TYPE[assoc_type_id]
    # 05xx 著述 → 唱和；06xx 軍事、08xx 宗教、10xx 財務 → 交往
    if assoc_type_id.startswith("05"):
        return "唱和"
    return "交往"


def load_mappings(con: sqlite3.Connection) -> tuple[dict, dict, dict, dict]:
    """加载 assoc_code → 类型/描述、文本标题、朝代名、亲属关系描述映射。"""
    # assoc_code -> (assoc_type_id, assoc_desc_chn, role_type)
    assoc_code_map: dict[int, tuple[str, str, str]] = {}
    for code, type_id, desc_chn, role in con.execute(
        """SELECT ac.c_assoc_code, rel.c_assoc_type_id, ac.c_assoc_desc_chn,
                  ac.c_assoc_role_type
           FROM ASSOC_CODES ac
           LEFT JOIN ASSOC_CODE_TYPE_REL rel ON ac.c_assoc_code = rel.c_assoc_code"""
    ).fetchall():
        assoc_code_map[code] = (type_id, desc_chn or "", role or "")

    # textid -> title_chn
    text_map: dict[int, str] = {}
    for tid, title in con.execute(
        "SELECT c_textid, c_title_chn FROM TEXT_CODES WHERE c_title_chn IS NOT NULL"
    ).fetchall():
        text_map[tid] = title

    # dy -> dynasty_chn
    dyn_map: dict[int, str] = {}
    for dy, name in con.execute(
        "SELECT c_dy, c_dynasty_chn FROM DYNASTIES"
    ).fetchall():
        dyn_map[dy] = name or ""

    # kin_code -> kinrel_chn
    kin_map: dict[int, str] = {}
    for code, rel in con.execute(
        "SELECT c_kincode, c_kinrel_chn FROM KINSHIP_CODES"
    ).fetchall():
        kin_map[code] = rel or ""

    return assoc_code_map, text_map, dyn_map, kin_map


def build_altnames(con: sqlite3.Connection, ids: set[int]) -> tuple[dict, dict]:
    """返回 (字, 號) 两个字典：personid -> 合并字符串。"""
    courtesy: dict[int, str] = defaultdict(list)
    style: dict[int, str] = defaultdict(list)
    for pid, type_code, name in con.execute(
        """SELECT c_personid, c_alt_name_type_code, c_alt_name_chn
           FROM ALTNAME_DATA
           WHERE c_personid IN ({})
             AND c_alt_name_type_code IN (4, 5)""".format(",".join("?" * len(ids))),
        list(ids),
    ).fetchall():
        if not name:
            continue
        if type_code == 4:
            courtesy[pid].append(name)
        elif type_code == 5:
            style[pid].append(name)
    return (
        {k: "、".join(dict.fromkeys(v)) for k, v in courtesy.items()},
        {k: "、".join(dict.fromkeys(v)) for k, v in style.items()},
    )


def compute_scores(con: sqlite3.Connection, tier_dys: dict[str, list[int]]) -> dict[int, tuple[int, int, str]]:
    """为每个朝代人计算 (social_degree, kin_degree, tier)，返回 personid -> 元组。

    度数用一次 GROUP BY 聚合计算（全局），再按朝代映射到档位，避免逐行相关子查询。
    """
    social_deg: dict[int, int] = {
        pid: cnt for pid, cnt in con.execute(
            "SELECT c_personid, COUNT(DISTINCT c_assoc_id) FROM ASSOC_DATA GROUP BY c_personid"
        ).fetchall()
    }
    kin_deg: dict[int, int] = {
        pid: cnt for pid, cnt in con.execute(
            "SELECT c_personid, COUNT(DISTINCT c_kin_id) FROM KIN_DATA GROUP BY c_personid"
        ).fetchall()
    }

    # 收集所有档位涉及的 c_dy
    all_dys = sorted({dy for dys in tier_dys.values() for dy in dys})
    ph = ",".join("?" * len(all_dys))
    result: dict[int, tuple[int, int, str]] = {}
    for pid, dy in con.execute(
        f"SELECT c_personid, c_dy FROM BIOG_MAIN WHERE c_dy IN ({ph})", all_dys
    ).fetchall():
        tier = _tier_of(dy)
        if tier is None:
            continue
        result[pid] = (social_deg.get(pid, 0), kin_deg.get(pid, 0), tier)
    return result


def select_people(scores: dict[int, tuple[int, int, str]]) -> set[int]:
    """按档位、按 (social_degree, kin_degree) 降序选 top-K。

    知名度信号以「社交关系度」为主（名人留下更多可考的师友/同僚/唱和等社会关系），
    亲属关系度仅作同分时 tiebreaker——亲属数据多为族谱自动生成，不宜单独作为知名度依据。
    """
    by_tier: dict[str, list[tuple[int, int, int]]] = defaultdict(list)
    for pid, (soc, kin, tier) in scores.items():
        if soc == 0:
            continue  # 无任何可考社会关系者不入选（避免族谱节点混入）
        by_tier[tier].append((pid, soc, kin))
    selected: set[int] = set()
    for tier, quota in QUOTAS.items():
        lst = sorted(by_tier.get(tier, []), key=lambda x: (-x[1], -x[2], x[0]))[:quota]
        selected.update(pid for pid, _, _ in lst)
    return selected


def extract_people(con, selected: set[int], assoc_code_map, dyn_map) -> list[dict]:
    courtesy, style = build_altnames(con, selected)
    people: list[dict] = []
    for pid in sorted(selected):
        row = con.execute(
            """SELECT c_name_chn, c_index_year, c_birthyear, c_deathyear, c_dy
               FROM BIOG_MAIN WHERE c_personid = ?""", (pid,)
        ).fetchone()
        if row is None:
            continue
        name, index_year, birth, death, dy = row
        tiers = tiers_of_person(dy, birth, death, index_year)
        if not tiers:
            continue
        people.append({
            "id": pid,
            "name": name or f"ID{pid}",
            "courtesy_name": courtesy.get(pid, ""),
            "style_name": style.get(pid, ""),
            "dynasty_tier": tiers[0],           # 主档位（CBDB c_dy 所属），用于节点配色
            "dynasty_tiers": tiers,             # 全部档位（含跨朝代），用于朝代筛选
            "dynasty": dyn_map.get(dy, ""),
            "birth_year": birth,
            "death_year": death,
            "index_year": index_year if index_year is not None else birth,
        })
    return people


def extract_edges(con, selected: set[int], assoc_code_map, text_map, kin_map) -> list[dict]:
    """提取两端均在入选集合内的关系（社交 + 亲属），并按 (min,max,code,source) 去重。"""
    edges: dict[tuple, dict] = {}
    sids = sorted(selected)

    # --- 社交关系 ASSOC_DATA ---
    for p1, p2, code, source, pages, year in con.execute(
        """SELECT c_personid, c_assoc_id, c_assoc_code, c_source, c_pages, c_assoc_year
           FROM ASSOC_DATA WHERE c_personid IN ({}) AND c_assoc_id IN ({})""".format(
            ",".join("?" * len(sids)), ",".join("?" * len(sids))
        ),
        sids + sids,
    ).fetchall():
        if p1 == p2:
            continue
        a, b = min(p1, p2), max(p1, p2)
        type_id, desc_chn, role = assoc_code_map.get(code, (None, "", ""))
        rel_type = _simplified_rel_type(type_id)
        key = (a, b, rel_type, code, source or 0)
        if key in edges:
            continue
        edges[key] = {
            "source": p1, "target": p2,
            "type": rel_type,
            "subtype": desc_chn,
            "direction": role,
            "source_text": text_map.get(source, "") if source else "",
            "source_pages": pages or "",
            "year": year,
            "assoc_code": code,
        }

    # --- 亲属关系 KIN_DATA ---
    for p1, p2, code, source, pages in con.execute(
        """SELECT c_personid, c_kin_id, c_kin_code, c_source, c_pages
           FROM KIN_DATA WHERE c_personid IN ({}) AND c_kin_id IN ({})""".format(
            ",".join("?" * len(sids)), ",".join("?" * len(sids))
        ),
        sids + sids,
    ).fetchall():
        if p1 == p2:
            continue
        a, b = min(p1, p2), max(p1, p2)
        rel_type = "家族"
        subtype = kin_map.get(code, "")
        key = (a, b, rel_type, code, source or 0)
        if key in edges:
            continue
        edges[key] = {
            "source": p1, "target": p2,
            "type": rel_type,
            "subtype": subtype,
            "direction": "",
            "source_text": text_map.get(source, "") if source else "",
            "source_pages": pages or "",
            "year": None,
            "assoc_code": code,
        }
    return list(edges.values())


def infer_category(con, pid: int, rel_type_counter: Counter) -> str:
    """由主要社会关系类型推断人物类别（忽略「家族」——亲属是关系类型而非人物类别）。"""
    social = Counter({k: v for k, v in rel_type_counter.items() if k != "家族"})
    if not social:
        return "名門士族" if rel_type_counter.get("家族", 0) > 0 else "文化名人"
    top = social.most_common(1)[0][0]
    return CATEGORY_BY_DOMINANT_REL.get(top, "文化名人")


def build_bio(p: dict) -> str:
    parts = []
    if p.get("courtesy_name"):
        parts.append(f"字{p['courtesy_name']}")
    if p.get("style_name"):
        parts.append(f"號{p['style_name']}")
    yrs = []
    if p.get("birth_year") is not None:
        yrs.append(f"生{p['birth_year']}年")
    if p.get("death_year") is not None:
        yrs.append(f"卒{p['death_year']}年")
    if yrs:
        parts.append("".join(yrs))
    return "，".join(parts)


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract cross-dynasty famous figures network from CBDB")
    parser.add_argument("--db", type=Path,
                        default=Path("/Users/sousekilyu/Documents/Data/biography_literature_CBDB_china_historical/cbdb202409.db"))
    parser.add_argument("--outdir", type=Path, default=Path("data"))
    parser.add_argument("--min-degree", type=int, default=0,
                        help="仅保留在入选网络内度数 >= 该值的人物（0 = 保留全部）")
    args = parser.parse_args()

    if not args.db.exists():
        print(f"Error: DB not found: {args.db}")
        return 1

    con = sqlite3.connect(str(args.db))
    assoc_code_map, text_map, dyn_map, kin_map = load_mappings(con)

    # 1) 计算各档人物分数并筛选
    scores = compute_scores(con, DYNASTY_TIERS)
    selected = select_people(scores)
    print(f"Selected {len(selected)} people (pre-edge-filter)")

    # 2) 提取人物
    people = extract_people(con, selected, assoc_code_map, dyn_map)

    # 3) 提取关系
    edges = extract_edges(con, selected, assoc_code_map, text_map, kin_map)
    print(f"Extracted {len(edges)} raw edges (deduped)")

    # 4) 计算入选网络内的度数，过滤孤立节点
    degree: Counter = Counter()
    for e in edges:
        degree[e["source"]] += 1
        degree[e["target"]] += 1

    kept_ids = {p["id"] for p in people if degree[p["id"]] >= max(1, args.min_degree)}
    people = [p for p in people if p["id"] in kept_ids]
    edges = [e for e in edges if e["source"] in kept_ids and e["target"] in kept_ids]
    dropped = len(selected) - len(people)
    print(f"After edge filter: {len(people)} people ({dropped} isolated dropped), {len(edges)} edges")

    # 5) 人物类别推断（基于其在入选网络内的关系类型分布）
    rel_counter_by_person: dict[int, Counter] = defaultdict(Counter)
    for e in edges:
        rel_counter_by_person[e["source"]][e["type"]] += 1
        rel_counter_by_person[e["target"]][e["type"]] += 1
    for p in people:
        p["category"] = infer_category(con, p["id"], rel_counter_by_person[p["id"]])
        p["bio"] = build_bio(p)
        p["degree"] = degree[p["id"]]

    # 6) 写出 CSV + JSON
    proc = args.outdir / "processed"
    dicts = args.outdir / "dictionaries"
    proc.mkdir(parents=True, exist_ok=True)
    dicts.mkdir(parents=True, exist_ok=True)

    people_fields = ["id", "name", "courtesy_name", "style_name", "dynasty_tier",
                     "dynasty_tiers", "dynasty", "birth_year", "death_year",
                     "index_year", "category", "degree"]
    with open(proc / "people.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(people_fields)
        for p in people:
            row = []
            for k in people_fields:
                v = p.get(k, "")
                if k == "dynasty_tiers" and isinstance(v, list):
                    v = "、".join(v)
                row.append(v)
            w.writerow(row)

    rel_fields = ["source", "target", "type", "subtype", "direction",
                  "source_text", "source_pages", "year", "assoc_code"]
    with open(proc / "relationships.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(rel_fields)
        for e in edges:
            w.writerow([e.get(k, "") for k in rel_fields])

    network = {
        "nodes": people,
        "edges": edges,
        "metadata": {
            "node_count": len(people),
            "edge_count": len(edges),
            "dynasty_tiers": list(DYNASTY_TIERS.keys()),
            "source": "CBDB (中国历代人物传记资料库) cbdb202409.db",
            "generated": None,
        },
    }
    with open(args.outdir / "network.json", "w", encoding="utf-8") as f:
        json.dump(network, f, ensure_ascii=False, indent=2)

    # 数据字典
    with open(dicts / "dynasty_tiers.json", "w", encoding="utf-8") as f:
        json.dump(DYNASTY_TIERS, f, ensure_ascii=False, indent=2)
    with open(dicts / "relationship_codes.json", "w", encoding="utf-8") as f:
        json.dump(RELATIONSHIP_CODES, f, ensure_ascii=False, indent=2)

    # 7) 汇总
    print("\n=== 朝代分布（跨朝代人物计入其所属的每个档位）===")
    dist = Counter()
    multi = 0
    for p in people:
        dist.update(p["dynasty_tiers"])
        if len(p["dynasty_tiers"]) > 1:
            multi += 1
    for t in DYNASTY_TIERS:
        print(f"  {t}: {dist.get(t, 0)} 人")
    print(f"  （跨朝代人物 {multi} 人，占 {len(people)} 人的 {multi/len(people)*100:.1f}%）")
    print("\n=== 关系类型分布 ===")
    for t, c in Counter(e["type"] for e in edges).most_common():
        print(f"  {t}: {c}")
    print("\n=== 度中心性 Top 5 ===")
    for p in sorted(people, key=lambda x: -x["degree"])[:5]:
        print(f"  {p['name']} ({p['dynasty_tier']}): degree {p['degree']}")

    con.close()
    print(f"\nDone. network.json -> {args.outdir / 'network.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
