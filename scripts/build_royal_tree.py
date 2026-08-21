#!/usr/bin/env python3
"""Build the inspectable Song royal-family layout model.

The source family graph contains long-range kin records and occasional sentinel
``generation_gap`` values (notably 99).  This builder keeps every family-1
member, but uses direct one-generation ancestor edges first and only admits
ordinary long-range edges as fallback paths. Sentinel edges never determine a
main generation layer.
"""
from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path
from typing import Any


EXPECTED = {
    9001: 0,
    9002: 0,
    9003: 1,
    9004: 2,
    9005: 3,
    9006: 4,
    9007: 5,
    9008: 5,
    9009: 6,
    9010: 6,
    9011: 7,
    9012: 8,
    9013: 9,
    9014: 10,
    9015: 11,
    9016: 12,
    9017: 12,
    9018: 12,
}
ANCHOR = 9001
MAX_NORMAL_GAP = 20
DIRECT_COST = 1
FALLBACK_COST = 50


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def build(families_path: Path, network_path: Path, royal_path: Path) -> dict[str, Any]:
    families = load(families_path)
    network = load(network_path)
    royal = load(royal_path)
    family = next(item for item in families["families"] if item["id"] == "family-1")
    member_ids = {int(value) for value in family["members"]}
    royal_by_id = {int(item["id"]): item for item in royal["members"]}
    for item in royal["members"]:
        if item.get("supplemental"):
            member_ids.add(int(item["id"]))

    people = {int(item["id"]): item for item in network["nodes"]}
    for item in royal["members"]:
        people.setdefault(int(item["id"]), item)

    edges = []
    for edge in families["edges"]:
        source, target = int(edge["source"]), int(edge["target"])
        if source not in member_ids or target not in member_ids:
            continue
        if edge.get("direction") != "ancestor":
            continue
        gap = int(edge.get("generation_gap") or 0)
        if gap < 1 or gap > MAX_NORMAL_GAP:
            continue
        edges.append({"source": source, "target": target, "gap": gap})

    # A directed edge source -> target means descendant generation + gap.
    adjacency: dict[int, list[tuple[int, int]]] = collections.defaultdict(list)
    undirected: dict[int, set[int]] = collections.defaultdict(set)
    for edge in edges:
        source, target, gap = edge["source"], edge["target"], edge["gap"]
        adjacency[source].append((target, gap))
        adjacency[target].append((source, -gap))
        undirected[source].add(target)
        undirected[target].add(source)

    generation: dict[int, int] = {ANCHOR: 0}
    queue = collections.deque([ANCHOR])
    # Direct paths are always visited before ordinary fallback paths.
    while queue:
      current = queue.popleft()
      neighbors = sorted(adjacency[current], key=lambda item: (abs(item[1]) != 1, abs(item[1]), item[0]))
      for neighbor, delta in neighbors:
        candidate = generation[current] + delta
        if neighbor not in generation:
          generation[neighbor] = candidate
          queue.append(neighbor)

    # Disconnected records receive a bounded fallback generation, never a huge
    # layer jump.  The confirmed emperor generations are authoritative.
    for member_id in sorted(member_ids):
        generation.setdefault(member_id, 0)
    generation.update(EXPECTED)

    # Build a trusted one-generation reachability set. Surname alone is not
    # enough: collateral records with no direct path (for example 14750) stay
    # peripheral even when their name begins with Zhao.
    direct_graph: dict[int, set[int]] = collections.defaultdict(set)
    for edge in edges:
        if edge["gap"] == 1:
            direct_graph[edge["source"]].add(edge["target"])
            direct_graph[edge["target"]].add(edge["source"])
    direct_reachable = {ANCHOR}
    queue = collections.deque([ANCHOR])
    while queue:
        current = queue.popleft()
        for neighbor in sorted(direct_graph[current]):
            if neighbor not in direct_reachable:
                direct_reachable.add(neighbor)
                queue.append(neighbor)

    core_ids = {
        member_id
        for member_id in member_ids
        if member_id in direct_reachable
        and str(people.get(member_id, {}).get("name", "")).startswith(("趙", "赵"))
    }
    core_ids.update(royal_by_id)
    spouse_ids = set()
    for edge in edges:
        left, right = edge["source"], edge["target"]
        if edge["gap"] == 1 and ((left in core_ids) ^ (right in core_ids)):
            spouse_ids.add(right if left in core_ids else left)
    spouse_ids -= core_ids

    distance: dict[int, int | None] = {ANCHOR: 0}
    queue = collections.deque([ANCHOR])
    while queue:
        current = queue.popleft()
        for neighbor in sorted(undirected[current]):
            if neighbor not in distance:
                distance[neighbor] = int(distance[current] or 0) + 1
                queue.append(neighbor)
    for member_id in member_ids:
        distance.setdefault(member_id, None)

    # Every peripheral node receives a deterministic nearest core anchor for
    # visual placement; no round-robin assignment is needed in the renderer.
    anchor_by_id = {}
    anchor_queue = collections.deque(sorted(core_ids))
    for core_id in sorted(core_ids):
        anchor_by_id[core_id] = core_id
    while anchor_queue:
        current = anchor_queue.popleft()
        for neighbor in sorted(undirected[current]):
            if neighbor not in anchor_by_id:
                anchor_by_id[neighbor] = anchor_by_id[current]
                anchor_queue.append(neighbor)

    nodes = {}
    for member_id in sorted(member_ids):
        person = people.get(member_id, {})
        if member_id in core_ids:
            role = "core"
        elif member_id in spouse_ids:
            role = "spouse"
        else:
            role = "affinal"
        nodes[str(member_id)] = {
            "id": member_id,
            "name": person.get("name", royal_by_id.get(member_id, {}).get("name", "")),
            "generation": int(generation[member_id]),
            "family_role": role,
            "anchor_distance": distance[member_id],
            "anchor_id": anchor_by_id.get(member_id),
        }
        if member_id in royal_by_id:
            nodes[str(member_id)].update({
                key: royal_by_id[member_id][key]
                for key in ("temple_name", "reign_start", "reign_end", "is_emperor")
                if key in royal_by_id[member_id]
            })

    missing = [member_id for member_id in EXPECTED if str(member_id) not in nodes]
    if missing:
        raise ValueError(f"missing expected emperors: {missing}")
    bad = {member_id: nodes[str(member_id)]["generation"] for member_id in EXPECTED
           if nodes[str(member_id)]["generation"] != EXPECTED[member_id]}
    if bad:
        raise ValueError(f"emperor generation assertions failed: {bad}")

    return {
        "anchor": ANCHOR,
        "generation_definition": "generation_gap=1 paths are preferred; ordinary gaps are fallback; gap>=21 is excluded",
        "expected_emperor_generations": {str(key): value for key, value in EXPECTED.items()},
        "nodes": nodes,
        "source": "data/families.json + data/network.json + data/royal_houses.json",
        "metadata": {
            "family_id": "family-1",
            "member_count": len(nodes),
            "excluded_sentinel_edges": "generation_gap >= 21",
            "role_definition": "core=Zhao bloodline/emperors; spouse=direct one-generation non-core co-parent; affinal=remaining family context",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--families", type=Path, default=Path("data/families.json"))
    parser.add_argument("--network", type=Path, default=Path("data/network.json"))
    parser.add_argument("--royal", type=Path, default=Path("data/royal_houses.json"))
    parser.add_argument("--output", type=Path, default=Path("data/royal_tree_song.json"))
    args = parser.parse_args()
    result = build(args.families, args.network, args.royal)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output} ({len(result['nodes'])} nodes)")


if __name__ == "__main__":
    main()
