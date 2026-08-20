#!/usr/bin/env python3
"""
生成公众号配图（符合「公众号手机端生图规范」）。

产出：
  - images/network_overview_16x9.png  横版 16:9（1080×608）全图概览

规范要点（详见 README「公众号配图规范」）：
  1. 尺寸：横版 1080×608（16:9）
  2. 字体：节点标签 ≥28px、图注 ≥20px，中文水平排列、不重叠
  3. 配色：浅色底（#FAFAFA）、正文深灰 #333、节点色板 ≥6 色且色盲友好（Okabe-Ito）
  4. 右下角标注数据来源（CBDB）与生成日期

用法：
    python scripts/generate_images.py [--input data/network.json]
"""

from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import networkx as nx
import numpy as np
from matplotlib import font_manager
from matplotlib.patches import Patch

# 与前端一致的 8 朝代色板（Okabe-Ito 系，色盲友好）
DYNASTY_COLORS = {
    "春秋战国": "#0072B2",
    "秦汉": "#E69F00",
    "魏晋南北朝": "#009E73",
    "隋唐": "#CC79A7",
    "宋": "#56B4E9",
    "元": "#D55E00",
    "明": "#F0E442",
    "清": "#8C564B",
}

FONT_SANS = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_SERIF = "/System/Library/Fonts/Supplemental/Songti.ttc"

# 概览图仅标注度数最高的前 N 人，避免密集区域标签重叠（其余节点以颜色/大小呈现结构）
TOP_LABELS = 26


def register_fonts() -> dict[str, str]:
    fam = {}
    for alias, path in [("sans", FONT_SANS), ("serif", FONT_SERIF)]:
        font_manager.fontManager.addfont(path)
        fam[alias] = font_manager.FontProperties(fname=path).get_name()
    return fam


def load_graph(network_path: Path) -> tuple[nx.Graph, dict]:
    data = json.loads(network_path.read_text(encoding="utf-8"))
    G = nx.Graph()
    for n in data["nodes"]:
        G.add_node(str(n["id"]), **n)
    for e in data["edges"]:
        G.add_edge(str(e["source"]), str(e["target"]), **e)
    return G, data


def normalize_pos(pos: dict) -> dict:
    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    span = max(xmax - xmin, ymax - ymin) or 1.0
    cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
    return {n: ((p[0] - cx) / span + 0.5, (p[1] - cy) / span + 0.5) for n, p in pos.items()}


def repel_labels(pos: dict, labeled: list[str], min_dist: float = 0.16, iters: int = 30) -> dict:
    """把标注节点相互推开（只移动标签位置，不改节点位置），缓解重叠并限制在安全边界内。"""
    lp = {n: np.array(pos[n], dtype=float) for n in labeled}
    origin = dict(lp)
    margin = 0.07  # 标签中心的安全边界，避免贴边被裁切
    for _ in range(iters):
        for i in range(len(labeled)):
            for j in range(i + 1, len(labeled)):
                a, b = labeled[i], labeled[j]
                d = lp[a] - lp[b]
                dist = float(np.linalg.norm(d))
                if 1e-6 < dist < min_dist:
                    push = d / dist * (min_dist - dist) * 0.5
                    lp[a] += push
                    lp[b] -= push
        # 轻微回拉 + 边界夹取
        for n in labeled:
            lp[n] = lp[n] * 0.92 + origin[n] * 0.08
            lp[n] = np.clip(lp[n], margin, 1.0 - margin)
    return {n: tuple(p) for n, p in lp.items()}


def overview_16x9(G: nx.Graph, out: Path, fam: dict[str, str]) -> None:
    # 精确 1080×608（16:9）：figsize 10.8×6.08 英寸 @ dpi 100
    fig = plt.figure(figsize=(10.8, 6.08), dpi=100, facecolor="#FAFAFA")
    ax = fig.add_axes([0.015, 0.045, 0.97, 0.86])  # 留出标题与底部来源空间
    ax.set_facecolor("#FAFAFA")

    # 使用 data/network.json 中预计算的 DrL 布局坐标（避免对全量图跑 O(n^2) 的 spring_layout）
    pos = {n: (float(G.nodes[n]["x"]), float(G.nodes[n]["y"])) for n in G.nodes()}
    pos = normalize_pos(pos)
    # 边
    nx.draw_networkx_edges(G, pos, ax=ax, edge_color="#d8d8d8", width=0.45, alpha=0.55)

    # 节点：颜色=朝代，大小=度数
    deg = dict(G.degree())
    maxd = max(deg.values()) if deg else 1
    node_colors = [DYNASTY_COLORS.get(G.nodes[n].get("dynasty_tier", ""), "#999999") for n in G.nodes()]
    node_sizes = [30 + 1500 * (deg[n] / maxd) ** 0.6 for n in G.nodes()]
    nx.draw_networkx_nodes(G, pos, ax=ax, node_color=node_colors, node_size=node_sizes,
                           linewidths=0.3, edgecolors="#ffffff")

    # 标签：只标注度数最高 TOP_LABELS 人，repel 推开
    ranked = sorted(G.nodes(), key=lambda n: -deg[n])
    labeled = ranked[:TOP_LABELS]
    lab_pos = repel_labels(pos, labeled)
    for n in labeled:
        x, y = lab_pos[n]
        ax.text(x, y, G.nodes[n]["name"], fontsize=21, ha="center", va="center",
                fontfamily=fam["sans"], color="#333333",
                bbox=dict(boxstyle="round,pad=0.16", fc="#FFFFFF", ec="#CCCCCC", lw=0.4, alpha=0.92),
                zorder=4)

    ax.set_xlim(-0.02, 1.02)
    ax.set_ylim(-0.02, 1.02)
    ax.axis("off")

    # 标题（顶部居中）
    fig.text(0.5, 0.955, "历代历史文化名人关系网络", ha="center", va="top",
             fontsize=25, fontfamily=fam["serif"], color="#333333")

    # 图例（朝代 → 颜色），右上角，两列
    handles = [Patch(facecolor=c, edgecolor="white", label=t) for t, c in DYNASTY_COLORS.items()]
    leg = fig.legend(handles=handles, loc="upper right", fontsize=12, frameon=True,
                     framealpha=0.92, ncol=2, handlelength=1.1, handleheight=0.9,
                     prop=font_manager.FontProperties(fname=FONT_SANS), borderpad=0.7,
                     bbox_to_anchor=(0.99, 0.945))

    # 右下角来源标注
    src = f"数据来源：CBDB 中国历代人物传记资料库 · 生成日期 {date.today().isoformat()}"
    fig.text(0.99, 0.012, src, ha="right", va="bottom", fontsize=13,
             fontfamily=fam["sans"], color="#666666")

    fig.savefig(out, dpi=100, facecolor="#FAFAFA")
    plt.close(fig)
    print(f"Saved {out}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=Path("data/network.json"))
    args = parser.parse_args()
    if not args.input.exists():
        print(f"Error: {args.input} not found")
        return 1
    G, _ = load_graph(args.input)
    fam = register_fonts()
    outdir = Path("images")
    outdir.mkdir(parents=True, exist_ok=True)
    overview_16x9(G, outdir / "network_overview_16x9.png", fam)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
