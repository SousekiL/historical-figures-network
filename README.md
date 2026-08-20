# 历代历史文化名人关系网络

跨朝代的**历史文化名人关系网络**网站与配套数据。以 CBDB（中国历代人物传记资料库）为主要数据源，**不设知名度准入规则、纳入全部有可考社会关系的人物（约 4 万人）**，构建可筛选、可搜索、可追溯的人物关系网络，并导出符合公众号手机端规范的配图。

- **在线访问**：<https://sousekil.github.io/historical-figures-network/>
- **本地访问**：`python -m http.server` 后打开 <http://localhost:8000/>
- **数据源**：CBDB（中国历代人物传记资料库）`cbdb202409.db`

## 功能特性

- **全量网络图**（自研 Canvas 渲染 + igraph DrL 预计算布局）：约 4 万人物、7 万条关系，所有节点均显示为点
- **标签显示滑杆**：6 档（无 / 极少 / 较少 / 中等 / 较多 / 全部），按**度中心性**分位数决定标签密度；度数低的人物不显示标签、颜色更淡
- **性别区分**：节点形状区分男女（圆 = 男，三角 = 女），颜色按朝代着色
- **朝代筛选**：10 档（春秋战国 / 秦汉 / 魏晋南北朝 / 隋唐 / 五代十国 / 宋 / 辽金西夏 / 元 / 明 / 清），可任意组合开关；跨朝代人物归入其所属的每个档位
- **人物搜索**：按姓名 / 字 / 号检索，命中后聚焦该人物及其一阶邻居
- **节点详情**：点击查看朝代、性别、生卒年、类别、关系数与关联人物列表
- **响应式**：手机浏览器可用（双指缩放 / 平移、窄屏自适应）；本地 `python -m http.server` 同样可用

## 快速开始

```bash
# 1. 本地预览（纯静态，无需构建）
python -m http.server 8000
# 浏览器打开 http://localhost:8000/

# 2.（可选）重新生成数据 —— 需本地 CBDB 数据库（含 igraph 布局，约 30s）
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/extract_cbdb.py --db /path/to/cbdb202409.db

# 3.（可选）重新生成公众号配图
.venv/bin/python scripts/generate_images.py
```

## 数据

| 文件 | 说明 |
|------|------|
| `data/network.json` | 前端直接使用：`nodes`（人物，含 x/y 布局坐标）+ `edges`（关系）+ `metadata`（含出处书名表 `texts`） |
| `data/processed/people.csv` | 人物表（ID、姓名、字、号、朝代、性别、生卒年、类别、度数、坐标） |
| `data/processed/relationships.csv` | 关系表（人物对、关系类型、子类型、史料出处、页码） |
| `data/dictionaries/dynasty_tiers.json` | 朝代档位字典（10 档 ↔ CBDB `c_dy` 代码，便于扩展） |
| `data/dictionaries/relationship_codes.json` | 关系类型字典 |

### 数据口径（摘要，详见 `docs/methodology.md`）

- **人物范围**：不设知名度准入规则，纳入所有「有 ≥1 条可考社会关系」的人物，共 **40,263 人**。
- **关系范围**：仅社会关系 `ASSOC_DATA`（`KIN_DATA` 亲属数据不纳入，避免族谱稀释语义），按 `(min_id, max_id, 类型)` 去重，共 **72,925 条**。
- **朝代归属**：10 档；跨朝代人物按生卒区间与大朝代区间交叠归入**每一个**所属档位。
- **关系类型**（7 类）：師生 / 好友 / 家族 / 同僚 / 政敵 / 唱和 / 交往，由 CBDB 关系类型映射而来。
- **性别**：`c_female`（1=女，0=男；0 含不详）。
- **可追溯性**：人物保留 CBDB 人物 ID；关系保留史料出处（JSON 中经 `text_id` → `metadata.texts` 压缩存储）与页码。

### 当前数据统计

- 人物 **40,263** 人，关系 **72,925** 条，覆盖 **10** 个朝代档位（跨朝代人物 4,235 人，约占 10.5%）
- 朝代分布（跨朝代人物计入其所属每个档位）：宋 15,768 · 明 9,742 · 隋唐 6,083 · 元 6,063 · 清 5,771 · 魏晋南北朝 121 · 五代十国 201 · 辽金西夏 60 · 秦汉 40 · 春秋战国 9
- 性别：男 38,412 / 女 1,851
- 关系类型：唱和 53,654 · 師生 4,849 · 同僚 4,594 · 交往 4,112 · 好友 3,592 · 政敵 2,040 · 家族 84
- 度中心性 Top 5：朱熹（宋，1543）· 周必大（宋，575）· 蘇軾（宋，573）· 宋濂（明，540）· 劉克莊（宋，519）

> 注：CBDB 社会关系在唐 / 宋 / 元 / 明 / 清覆盖较丰富，先秦 / 秦汉 / 魏晋南北朝覆盖较薄（传世史料相对少）；「唱和」占比高，主要因为 CBDB 唐宋部分大量收录《唐五代人交往詩索引》《宋人傳記資料索引》等诗文交往记录。详见 `docs/methodology.md`。

## 公众号配图规范

公众号正文图片在手机竖屏阅读，配图单独按手机规范生成（`images/network_overview_16x9.png`，**非网站桌面截图**）：

1. **尺寸**：横版 16:9 = **1080×608**（用于文章顶部 / 关键图）
2. **字体**：节点标签 ≥28px、图注 ≥20px，中文水平排列、不重叠
3. **配色**：浅色底（`#FAFAFA`）、正文深灰 `#333`；节点色板 ≥6 色、色盲友好（Okabe-Ito 系，红 / 绿不并用）
4. **信息**：右下角标注数据来源（CBDB）与生成日期

生成命令：`python scripts/generate_images.py`（依赖 `requirements.txt`）。全量 4 万节点的概览图较密集，建议配合「局部放大」使用。

## 目录结构

```
historical-figures-network/
├── index.html                  # 网站入口
├── assets/
│   ├── style.css
│   └── app.js                  # 自研 Canvas 渲染器
├── data/
│   ├── network.json            # 前端数据（nodes + edges，含 x/y 布局）
│   ├── processed/              # people.csv / relationships.csv
│   └── dictionaries/           # 朝代档位 / 关系类型字典
├── scripts/
│   ├── extract_cbdb.py         # 数据提取管线（含 igraph DrL 布局）
│   └── generate_images.py      # 公众号配图生成
├── images/                     # 导出配图
└── docs/                       # methodology.md / data_dictionary.md
```

## 数据来源与许可

- **数据**：CBDB（中国历代人物传记资料库），<https://projects.iq.harvard.edu/cbdb>。数据按其许可协议使用，仅限非商业研究与学习用途。
- **代码**：MIT License（见 `LICENSE`）。

## 关联项目

- [poet-life-tang](https://github.com/SousekiL/poet-life-tang)（Tang-networks）：本项目的版式与数据管线参考来源。

