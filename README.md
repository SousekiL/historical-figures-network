# 历代历史文化名人关系网络

跨朝代的**历史文化名人关系网络**网站与配套数据。以 CBDB（中国历代人物传记资料库）为主要数据源，覆盖 **春秋战国 / 秦汉 / 魏晋南北朝 / 隋唐 / 宋 / 元 / 明 / 清** 8 个朝代档位，构建可筛选、可搜索、可追溯的人物关系网络，并导出符合公众号手机端规范的配图。

- **在线访问**：<https://sousekil.github.io/historical-figures-network/>
- **本地访问**：`python -m http.server` 后打开 <http://localhost:8000/>
- **数据源**：CBDB（中国历代人物传记资料库）`cbdb202409.db`

## 功能特性

- **力导向网络图**（ECharts graph）：节点为人物（中文姓名标签），边标注关系类型
- **朝代筛选**：8 档朝代，可任意组合开关
- **人物搜索**：按姓名 / 字 / 号检索，命中后聚焦该人物及其一阶邻居
- **节点详情**：点击节点查看生卒年、字、号、类别、简介、关系数与关联人物列表
- **响应式**：手机浏览器可用（双指缩放 / 平移、窄屏自适应、底部操作提示）
- **数据可追溯**：每条关系带史料出处（书名 + 页码）与 CBDB 人物 ID

## 快速开始

```bash
# 1. 本地预览（纯静态，无需构建）
python -m http.server 8000
# 浏览器打开 http://localhost:8000/

# 2.（可选）重新生成数据 —— 需本地 CBDB 数据库
pip install -r requirements.txt
python scripts/extract_cbdb.py --db /path/to/cbdb202409.db

# 3.（可选）重新生成公众号配图
python scripts/generate_images.py
```

## 数据

| 文件 | 说明 |
|------|------|
| `data/network.json` | 前端直接使用：`nodes`（人物）+ `edges`（关系）+ `metadata` |
| `data/processed/people.csv` | 人物表（ID、姓名、字、号、朝代、生卒年、类别、度数） |
| `data/processed/relationships.csv` | 关系表（人物对、关系类型、子类型、史料出处、页码） |
| `data/dictionaries/dynasty_tiers.json` | 朝代档位字典（8 档 ↔ CBDB `c_dy` 代码，便于扩展） |
| `data/dictionaries/relationship_codes.json` | 关系类型字典 |

### 数据口径（摘要，详见 `docs/methodology.md`）

- **人物范围**：8 个朝代档位内的知名历史文化名人，首版 **189 人**（可经脚本扩展）。
- **名人筛选**：以「社交关系度」（CBDB `ASSOC_DATA` 中去重后的关联人物数）为主信号——知名度高者往往留下更多可考的师友 / 同僚 / 唱和等社会关系；亲属关系度仅作同分 tiebreaker（亲属数据多为族谱自动生成，不宜单独作为知名度依据）。
- **关系提取**：仅保留两端都在入选集合内的社交关系（`ASSOC_DATA`）与亲属关系（`KIN_DATA`），按 `(min_id, max_id, 类型, 出处)` 去重。
- **关系类型**（7 类）：師生 / 好友 / 家族 / 同僚 / 政敵 / 唱和 / 交往，由 CBDB 关系类型（`ASSOC_TYPES`）映射而来；原始关系描述保留在 `subtype` 字段。
- **人物类别**：由主要社会关系类型推断（文学家 / 学者 / 文人 / 政治家 / 名門士族 / 文化名人），非人工标注。
- **可追溯性**：每个人物保留 CBDB 人物 ID；每条关系保留史料出处（`source_text`）与页码（`source_pages`）。

### 当前数据统计

- 人物 **189** 人，关系 **2902** 条，覆盖 **8** 个朝代档位
- 朝代分布：春秋战国 8 · 秦汉 20 · 魏晋南北朝 18 · 隋唐 35 · 宋 40 · 元 25 · 明 28 · 清 15
- 关系类型：唱和 2572 · 同僚 95 · 好友 73 · 交往 57 · 師生 54 · 政敵 28 · 家族 23
- 度中心性 Top 5：朱熹（宋，265）· 蘇軾（宋，159）· 歐陽修（宋，139）· 周必大（宋，135）· 虞集（元，126）

> 注：CBDB 社交关系在唐 / 宋 / 元 / 明 / 清覆盖较丰富，先秦 / 秦汉 / 魏晋南北朝覆盖较薄（传世史料相对少），故早期朝代人数较少；「唱和」占比高，主要因为 CBDB 唐宋部分大量收录《唐五代人交往詩索引》《宋人傳記資料索引》等诗文交往记录。详见 `docs/methodology.md`。

## 公众号配图规范

公众号正文图片在手机竖屏阅读，配图单独按手机规范生成（`images/network_overview_16x9.png`，**非网站桌面截图**）：

1. **尺寸**：横版 16:9 = **1080×608**（用于文章顶部 / 关键图）
2. **字体**：节点标签 ≥28px、图注 ≥20px，中文水平排列、不重叠
3. **配色**：浅色底（`#FAFAFA`）、正文深灰 `#333`；节点色板 8 色、色盲友好（Okabe-Ito 系，红 / 绿不并用）
4. **信息**：右下角标注数据来源（CBDB）与生成日期

生成命令：`python scripts/generate_images.py`（依赖 `requirements.txt`）。

## 目录结构

```
historical-figures-network/
├── index.html                  # 网站入口
├── assets/
│   ├── echarts.min.js          # 本地 vendored ECharts（离线可用）
│   ├── style.css
│   └── app.js
├── data/
│   ├── network.json            # 前端数据（nodes + edges）
│   ├── processed/              # people.csv / relationships.csv
│   └── dictionaries/           # 朝代档位 / 关系类型字典
├── scripts/
│   ├── extract_cbdb.py         # 数据提取管线
│   └── generate_images.py      # 公众号配图生成
├── images/                     # 导出配图
└── docs/                       # methodology.md / data_dictionary.md
```

## 数据来源与许可

- **数据**：CBDB（中国历代人物传记资料库），<https://projects.iq.harvard.edu/cbdb>。数据按其许可协议使用，仅限非商业研究与学习用途。
- **代码**：MIT License（见 `LICENSE`）。

## 关联项目

- [poet-life-tang](https://github.com/SousekiL/poet-life-tang)（Tang-networks）：本项目的版式与数据管线参考来源。
