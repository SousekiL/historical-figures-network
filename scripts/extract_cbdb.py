#!/usr/bin/env python3
"""
从 CBDB（中国历代人物传记资料库）提取跨朝代「历史文化名人」关系网络（全量版）。

数据源：CBDB SQLite 数据库（cbdb202409.db）

口径（详见 docs/methodology.md）：
  - 人物范围：不设知名度准入规则。纳入所有「有 ≥1 条可考社会关系」的人物
    （CBDB ASSOC_DATA 中作为主体或客体出现过、且朝代在本项目范围内），
    约 4 万人。孤立点（在范围内无任何关联）剔除。
  - 关系范围：仅社会关系 ASSOC_DATA；亲属关系 KIN_DATA 不纳入（族谱自动生成，
    会稀释「名人社会关系」语义）。
  - 关系去重：按 (min(person1,person2), 简化关系类型) 去重，边无方向。
  - 朝代：10 档（8 大朝代 + 五代十国 + 辽金西夏）。跨朝代人物按生卒区间与
    大朝代年代区间求交叠，归入其所属的每一个档位。
  - 性别：BIOG_MAIN.c_female（1=女，0=男；CBDB 中 0 含性别不详者）。
  - 布局：igraph DrL 力导向布局预计算（归一化到 [0,1]），前端直接渲染。

产出：
  - data/processed/people.csv / relationships.csv
  - data/network.json（nodes + edges + metadata，含 x/y 布局坐标）
  - data/dictionaries/dynasty_tiers.json / relationship_codes.json

用法：
    python scripts/extract_cbdb.py [--db PATH] [--outdir PATH] [--skip-layout]
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

# --------------------------------------------------------------------------- #
# 朝代档位（10 档）。键为档位名，值为 CBDB 的 c_dy 朝代代码列表。
# 档位字典同时写入 data/dictionaries/dynasty_tiers.json，便于前端读取与扩展。
# --------------------------------------------------------------------------- #
DYNASTY_TIERS: dict[str, list[int]] = {
    "春秋战国": [1],                                        # 漢前 (-1100 ~ -206)
    "秦汉": [2, 61, 83, 29, 46, 25],                        # 秦漢 及 贏秦/漢/西漢/新/東漢
    "魏晋南北朝": [3, 26, 53, 42, 82, 23, 27, 4, 28, 32,
                   44, 37, 24, 30, 41, 40, 35, 31, 68,      # 三國/晉/南北朝 及主要割据政权
                   39, 45, 50, 51, 60, 62, 63, 64, 65,      # 十六国
                   69, 70, 71, 72, 73, 74, 76],
    "隋唐": [5, 6, 77],                                     # 隋/唐/武周
    "五代十国": [7, 8, 9, 10, 11, 12, 13, 34, 36, 38,
                 47, 48, 49, 52, 55, 66, 75, 81],           # 五代 及 十国
    "宋": [15],
    "辽金西夏": [16, 17, 78, 79, 57, 59],                   # 遼/金/西夏/北元/偽齊/西遼
    "元": [18],
    "明": [19, 80],                                         # 明/南明
    "清": [20],
}

# 档位展示顺序（写入字典与前端 chips 顺序一致）
TIER_ORDER: list[str] = [
    "春秋战国", "秦汉", "魏晋南北朝", "隋唐", "五代十国",
    "宋", "辽金西夏", "元", "明", "清",
]

# 大朝代的年代区间（由 DYNASTIES.c_start/c_end 聚合）。
# 仅用于「跨朝代」判定：人物生卒区间与大朝代区间有交叠即归入该档位。
# 五代十国 / 辽金西夏 无独立区间（与宋元交叠），仅作为主标注档位存在，
# 其人物经生卒区间自然归入宋/元/唐等大朝代。
MAJOR_RANGES: dict[str, tuple[int, int]] = {
    "春秋战国": (-1100, -206),
    "秦汉": (-221, 220),
    "魏晋南北朝": (220, 589),
    "隋唐": (581, 907),
    "宋": (960, 1279),
    "元": (1234, 1367),
    "明": (1368, 1661),
    "清": (1644, 1911),
}

# 排除的 c_dy：朝鲜半岛政权 与 近现代（不在「历代历史文化名人」范围内）
EXCLUDED_DY: set[int] = {14, 67, 84, 58,   # 高麗/新羅/朝鮮/韓國
                         21, 22}           # 中華民國/中華人民共和國

# 关系类型简化映射（基于 ASSOC_TYPES 的 level-1 代码）。
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
    "0901": "家族",   # 家庭關係（籠統，ASSOC_DATA 内）
}

# 关系类型字典（写入 dictionaries），供前端图例/筛选使用
RELATIONSHIP_CODES: dict[str, str] = {
    "師生": "师生 / 问学 / 师承",
    "好友": "朋友关系",
    "家族": "家庭关系（仅 ASSOC_DATA 0901，不含 KIN_DATA）",
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
    "家族": "名門士族",
    "交往": "文化名人",
}


def _tier_of(dy) -> str | None:
    if dy is None:
        return None
    for tier, dys in DYNASTY_TIERS.items():
        if dy in dys:
            return tier
    return None


def _yr(y):
    """CBDB 用 0 表示年份不详（无公元 0 年），统一视为未知。"""
    return y if y else None


def tiers_of_person(dy, birth, death, index_year):
    """返回 (primary, tiers)。

    primary = c_dy 所属档位（可能为 None，如未詳）。
    tiers   = 该人物所属的全部档位（primary + 生卒区间与大朝代区间交叠），
              按 TIER_ORDER 时间序去重；无任何归属时返回 ["未詳"]。
    """
    primary = _tier_of(dy)
    tiers: set[str] = set()
    if primary:
        tiers.add(primary)

    birth, death, index_year = _yr(birth), _yr(death), _yr(index_year)
    lo = hi = None
    if birth is not None or death is not None:
        if birth is not None and death is not None:
            lo, hi = (birth, death) if birth <= death else (death, birth)
        else:
            lo = hi = birth if birth is not None else death
    elif index_year is not None:
        lo = hi = index_year

    if lo is not None and hi is not None:
        for tier, (s, e) in MAJOR_RANGES.items():
            if lo <= e and hi >= s:  # 区间交叠
                tiers.add(tier)

    ordered = [t for t in TIER_ORDER if t in tiers]
    if not ordered:
        ordered = ["未詳"]
    return primary, ordered


def _simplified_rel_type(assoc_type_id: str | None) -> str:
    if assoc_type_id is None:
        return "交往"
    if assoc_type_id in REL_TYPE_BY_ASSOC_TYPE:
        return REL_TYPE_BY_ASSOC_TYPE[assoc_type_id]
    if assoc_type_id.startswith("05"):
        return "唱和"
    return "交往"


def load_mappings(con: sqlite3.Connection) -> tuple[dict, dict, dict]:
    """加载 assoc_code → 类型/描述、文本标题、朝代名映射。"""
    assoc_code_map: dict[int, tuple[str, str, str]] = {}
    for code, type_id, desc_chn, role in con.execute(
        """SELECT ac.c_assoc_code, rel.c_assoc_type_id, ac.c_assoc_desc_chn,
                  ac.c_assoc_role_type
           FROM ASSOC_CODES ac
           LEFT JOIN ASSOC_CODE_TYPE_REL rel ON ac.c_assoc_code = rel.c_assoc_code"""
    ).fetchall():
        assoc_code_map[code] = (type_id, desc_chn or "", role or "")

    text_map: dict[int, str] = {}
    for tid, title in con.execute(
        "SELECT c_textid, c_title_chn FROM TEXT_CODES WHERE c_title_chn IS NOT NULL"
    ).fetchall():
        text_map[tid] = title

    dyn_map: dict[int, str] = {}
    for dy, name in con.execute("SELECT c_dy, c_dynasty_chn FROM DYNASTIES").fetchall():
        dyn_map[dy] = name or ""

    return assoc_code_map, text_map, dyn_map


def build_altnames(con: sqlite3.Connection) -> tuple[dict, dict]:
    """返回 (字, 號) 两个字典：personid -> 合并字符串（全表加载一次）。"""
    courtesy: dict[int, list[str]] = defaultdict(list)
    style: dict[int, list[str]] = defaultdict(list)
    for pid, type_code, name in con.execute(
        """SELECT c_personid, c_alt_name_type_code, c_alt_name_chn
           FROM ALTNAME_DATA
           WHERE c_alt_name_type_code IN (4, 5)"""
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


def extract_people(con, assoc_code_map, dyn_map) -> dict[int, dict]:
    """提取所有「有 ≥1 条社会关系、且在范围内」的人物。"""
    courtesy, style = build_altnames(con)
    ids: set[int] = set()
    for pid, in con.execute("SELECT c_personid FROM ASSOC_DATA").fetchall():
        ids.add(pid)
    for pid, in con.execute("SELECT c_assoc_id FROM ASSOC_DATA").fetchall():
        ids.add(pid)

    people: dict[int, dict] = {}
    for pid in ids:
        row = con.execute(
            """SELECT c_name_chn, c_index_year, c_birthyear, c_deathyear, c_dy, c_female
               FROM BIOG_MAIN WHERE c_personid = ?""", (pid,)
        ).fetchone()
        if row is None:
            continue
        name, index_year, birth, death, dy, female = row
        if dy in EXCLUDED_DY:
            continue
        primary, tiers = tiers_of_person(dy, birth, death, index_year)
        if primary is None:
            primary = tiers[0] if tiers[0] != "未詳" else "未詳"
        node = {
            "id": pid,
            "name": name or f"ID{pid}",
            "dynasty_tier": primary,           # 主档位（用于节点配色）
            "dynasty_tiers": tiers,            # 全部档位（含跨朝代，用于筛选）
            "gender": "女" if female == 1 else "男",
        }
        if birth:
            node["birth_year"] = birth
        if death:
            node["death_year"] = death
        cz = courtesy.get(pid, "")
        st = style.get(pid, "")
        dn = dyn_map.get(dy, "")
        if cz:
            node["courtesy_name"] = cz
        if st:
            node["style_name"] = st
        if dn:
            node["dynasty"] = dn
        people[pid] = node
    return people


def extract_edges(con, people: dict[int, dict], assoc_code_map, text_map) -> list[dict]:
    """提取两端都在入选集合内的社会关系，按 (min,max,type) 去重。"""
    ids = set(people)
    edges: dict[tuple, dict] = {}
    for p1, p2, code, source, pages, year in con.execute(
        """SELECT c_personid, c_assoc_id, c_assoc_code, c_source, c_pages, c_assoc_year
           FROM ASSOC_DATA"""
    ).fetchall():
        if p1 == p2 or p1 not in ids or p2 not in ids:
            continue
        a, b = min(p1, p2), max(p1, p2)
        type_id, desc_chn, role = assoc_code_map.get(code, (None, "", ""))
        rel_type = _simplified_rel_type(type_id)
        key = (a, b, rel_type)
        if key in edges:
            # 已有同类边：保留首条有出处的记录
            if not edges[key].get("source_text") and source:
                txt = text_map.get(source, "")
                if txt:
                    edges[key]["source_text"] = txt
                    edges[key]["source_pages"] = pages or ""
            continue
        e = {"source": a, "target": b, "type": rel_type}
        if desc_chn:
            e["subtype"] = desc_chn
        if source:
            txt = text_map.get(source, "")
            if txt:
                e["source_text"] = txt
        if pages:
            e["source_pages"] = pages
        edges[key] = e
    return list(edges.values())


def infer_category(pid: int, rel_type_counter: Counter) -> str:
    """由主要社会关系类型推断人物类别（忽略「家族」）。"""
    social = Counter({k: v for k, v in rel_type_counter.items() if k != "家族"})
    if not social:
        return "名門士族" if rel_type_counter.get("家族", 0) > 0 else "文化名人"
    top = social.most_common(1)[0][0]
    return CATEGORY_BY_DOMINANT_REL.get(top, "文化名人")


def compute_layout(people: list[dict], edges: list[dict]) -> dict[int, tuple[float, float]]:
    """用 igraph DrL 预计算布局，归一化到 [0,1]。"""
    import igraph as ig
    id_to_idx = {p["id"]: i for i, p in enumerate(people)}
    g = ig.Graph(
        n=len(people),
        edges=[(id_to_idx[e["source"]], id_to_idx[e["target"]]) for e in edges],
        directed=False,
    )
    lay = g.layout_drl()
    pos: dict[int, tuple[float, float]] = {}
    xs = [p[0] for p in lay]
    ys = [p[1] for p in lay]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    sx = (xmax - xmin) or 1.0
    sy = (ymax - ymin) or 1.0
    for i, p in enumerate(people):
        pos[p["id"]] = (
            round((lay[i][0] - xmin) / sx, 6),
            round((lay[i][1] - ymin) / sy, 6),
        )
    return pos


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract full cross-dynasty figures network from CBDB")
    parser.add_argument("--db", type=Path,
                        default=Path("/Users/sousekilyu/Documents/Data/biography_literature_CBDB_china_historical/cbdb202409.db"))
    parser.add_argument("--outdir", type=Path, default=Path("data"))
    parser.add_argument("--skip-layout", action="store_true",
                        help="跳过 DrL 布局（用于快速调试；节点坐标记为 0）")
    args = parser.parse_args()

    if not args.db.exists():
        print(f"Error: DB not found: {args.db}")
        return 1

    con = sqlite3.connect(str(args.db))
    assoc_code_map, text_map, dyn_map = load_mappings(con)

    # 1) 提取人物
    people_map = extract_people(con, assoc_code_map, dyn_map)
    print(f"Extracted {len(people_map)} people (in-scope, >=1 social rel)")

    # 2) 提取关系
    edges = extract_edges(con, people_map, assoc_code_map, text_map)
    print(f"Extracted {len(edges)} edges (deduped by pair+type)")

    # 3) 计算网络内度数，过滤孤立节点（其所有关联对象均不在范围内）
    degree: Counter = Counter()
    for e in edges:
        degree[e["source"]] += 1
        degree[e["target"]] += 1
    people = [p for pid, p in people_map.items() if degree[pid] > 0]
    kept_ids = {p["id"] for p in people}
    edges = [e for e in edges if e["source"] in kept_ids and e["target"] in kept_ids]
    print(f"After isolated filter: {len(people)} people, {len(edges)} edges")

    # 4) 布局
    if args.skip_layout:
        pos = {p["id"]: (0.0, 0.0) for p in people}
    else:
        print("Computing DrL layout (may take ~30s for ~40k nodes)...")
        pos = compute_layout(people, edges)

    # 5) 人物类别推断 + 组装
    rel_counter_by_person: dict[int, Counter] = defaultdict(Counter)
    for e in edges:
        rel_counter_by_person[e["source"]][e["type"]] += 1
        rel_counter_by_person[e["target"]][e["type"]] += 1
    nodes = []
    for p in people:
        p["category"] = infer_category(p["id"], rel_counter_by_person[p["id"]])
        p["degree"] = degree[p["id"]]
        p["x"], p["y"] = pos[p["id"]]
        nodes.append(p)
    # 稳定排序（按度数降序，便于前端直接取 top-N 标签）
    nodes.sort(key=lambda p: (-p["degree"], p["id"]))

    # 6) 写出 CSV + JSON
    proc = args.outdir / "processed"
    dicts = args.outdir / "dictionaries"
    proc.mkdir(parents=True, exist_ok=True)
    dicts.mkdir(parents=True, exist_ok=True)

    people_fields = ["id", "name", "courtesy_name", "style_name", "dynasty_tier",
                     "dynasty_tiers", "dynasty", "gender", "birth_year", "death_year",
                     "category", "degree", "x", "y"]
    with open(proc / "people.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(people_fields)
        for p in nodes:
            row = []
            for k in people_fields:
                v = p.get(k, "")
                if k == "dynasty_tiers" and isinstance(v, list):
                    v = "、".join(v)
                row.append(v)
            w.writerow(row)

    rel_fields = ["source", "target", "type", "subtype", "source_text", "source_pages"]
    with open(proc / "relationships.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(rel_fields)
        for e in edges:
            w.writerow([e.get(k, "") for k in rel_fields])

    # JSON 边：去掉 subtype（保留在 CSV），出处书名做字符串表压缩（text_id）
    text_table: list[str] = []
    text_idx: dict[str, int] = {}
    json_edges = []
    for e in edges:
        je = {"source": e["source"], "target": e["target"], "type": e["type"]}
        st = e.get("source_text")
        if st:
            if st not in text_idx:
                text_idx[st] = len(text_table)
                text_table.append(st)
            je["text_id"] = text_idx[st]
        if e.get("source_pages"):
            je["source_pages"] = e["source_pages"]
        json_edges.append(je)

    network = {
        "nodes": nodes,
        "edges": json_edges,
        "metadata": {
            "node_count": len(nodes),
            "edge_count": len(json_edges),
            "dynasty_tiers": TIER_ORDER,
            "texts": text_table,
            "source": "CBDB (中国历代人物传记资料库) cbdb202409.db",
            "generated": None,
        },
    }
    out_json = args.outdir / "network.json"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(network, f, ensure_ascii=False, separators=(",", ":"))

    # 数据字典
    ordered_tiers = {t: DYNASTY_TIERS[t] for t in TIER_ORDER}
    with open(dicts / "dynasty_tiers.json", "w", encoding="utf-8") as f:
        json.dump(ordered_tiers, f, ensure_ascii=False, indent=2)
    with open(dicts / "relationship_codes.json", "w", encoding="utf-8") as f:
        json.dump(RELATIONSHIP_CODES, f, ensure_ascii=False, indent=2)

    # 7) 汇总
    print("\n=== 朝代分布（跨朝代人物计入其所属的每个档位）===")
    dist = Counter()
    multi = 0
    for p in nodes:
        dist.update(p["dynasty_tiers"])
        if len(p["dynasty_tiers"]) > 1:
            multi += 1
    for t in TIER_ORDER:
        print(f"  {t}: {dist.get(t, 0)} 人")
    print(f"  （跨朝代人物 {multi} 人，占 {len(nodes)} 人的 {multi/len(nodes)*100:.1f}%）")
    print("\n=== 性别分布 ===")
    print(f"  男 {sum(1 for p in nodes if p['gender']=='男')} / 女 {sum(1 for p in nodes if p['gender']=='女')}")
    print("\n=== 关系类型分布 ===")
    for t, c in Counter(e["type"] for e in edges).most_common():
        print(f"  {t}: {c}")
    print("\n=== 度中心性 Top 10 ===")
    for p in nodes[:10]:
        print(f"  {p['name']} ({p['dynasty_tier']}): degree {p['degree']}")

    con.close()
    size_mb = out_json.stat().st_size / 1024 / 1024
    print(f"\nDone. network.json -> {out_json} ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
