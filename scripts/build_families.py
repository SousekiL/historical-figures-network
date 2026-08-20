"""Build direct-line family candidates from a CBDB SQLite database.

Usage:
  python scripts/build_families.py --db /path/to/cbdb202409.db

The output is data/families.json. It intentionally excludes marriage and
collateral kinship steps; those relations are too broad for a clean lineage view.
"""
from __future__ import annotations

import argparse
import collections
import json
import sqlite3
from pathlib import Path


def build(db: Path, network_path: Path, output: Path) -> None:
    network = json.loads(network_path.read_text(encoding="utf-8"))
    ids = {int(n["id"]) for n in network["nodes"]}
    node = {int(n["id"]): n for n in network["nodes"]}
    con = sqlite3.connect(str(db))
    allowed = {
        row[0]
        for row in con.execute(
            """SELECT c_kincode FROM KINSHIP_CODES
               WHERE c_marstep = 0 AND c_colstep = 0
                 AND (c_upstep > 0 OR c_dwnstep > 0)"""
        )
    }
    rows = [
        row
        for row in con.execute(
            """SELECT k.c_personid, k.c_kin_id, k.c_kin_code,
                      c.c_upstep, c.c_dwnstep
               FROM KIN_DATA AS k
               JOIN KINSHIP_CODES AS c ON c.c_kincode = k.c_kin_code
               WHERE k.c_personid != k.c_kin_id"""
        )
        if row[0] in ids and row[1] in ids and row[2] in allowed
    ]
    parent = {person_id: person_id for person_id in ids}

    def find(value: int) -> int:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    for left, right, *_ in rows:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    groups = collections.defaultdict(list)
    for person_id in ids:
        groups[find(person_id)].append(person_id)
    groups = [members for members in groups.values() if len(members) >= 4]
    groups.sort(key=lambda members: (-len(members), min(members)))

    families = []
    for index, members in enumerate(groups[:80], 1):
        members.sort(key=lambda person_id: (node[person_id].get("birth_year") or 99999, node[person_id].get("name", "")))
        featured = sorted(
            members,
            key=lambda person_id: (-int(node[person_id].get("degree") or 0), node[person_id].get("name", "")),
        )[:3]
        names = [node[person_id].get("name", "") for person_id in featured]
        label = "、".join(names[:3]) + (" 等" if len(names) > 3 else "")
        families.append({"id": f"family-{index}", "label": f"{label}（{len(members)}人）", "members": members})

    # Collapse reciprocal CBDB records and multiple kin codes into one
    # directed parent -> descendant edge. Keeping kin_code in the key here
    # used to render the same pair more than once in the family view.
    pair_candidates = collections.defaultdict(list)
    for left, right, kin_code, upstep, dwnstep in rows:
        pair = (min(left, right), max(left, right))
        # c_upstep means right is an ancestor of left; c_dwnstep means
        # right is a descendant of left.
        if upstep and not dwnstep:
            source, target = right, left
        elif dwnstep and not upstep:
            source, target = left, right
        else:
            source, target = pair
        pair_candidates[pair].append((source, target, int(upstep or dwnstep or 0), kin_code))

    edges = []
    for pair, candidates in pair_candidates.items():
        counts = collections.Counter((source, target) for source, target, *_ in candidates)
        best_direction, _ = counts.most_common(1)[0]
        matching = [row for row in candidates if row[:2] == best_direction]
        source, target = best_direction
        gap = min((row[2] for row in matching if row[2]), default=0)
        kin_code = min((row[3] for row in matching), key=str)
        # If direction is not evidenced, prefer the older person as source.
        if not gap:
            source_year = node[source].get("birth_year") or 99999
            target_year = node[target].get("birth_year") or 99999
            if source_year > target_year:
                source, target = target, source
        edges.append({
            "source": source,
            "target": target,
            "kin_code": kin_code,
            "generation_gap": gap,
            "direction": "ancestor" if gap else "undirected",
        })

    payload = {
        "metadata": {
            "source": "CBDB KIN_DATA + KINSHIP_CODES",
            "definition": "直系血缘关系：保留有上下代步数且无婚姻/旁系步数的关系；仅纳入当前网络人物。候选家族按连通分量至少4人，展示前80组。连通分量可能包含通过共同子女相连的姻亲，页面按候选家族而非单一姓氏展示。",
        },
        "families": families,
        "edges": edges,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--network", type=Path, default=Path("data/network.json"))
    parser.add_argument("--output", type=Path, default=Path("data/families.json"))
    args = parser.parse_args()
    build(args.db, args.network, args.output)
    print(f"Wrote {args.output}")
