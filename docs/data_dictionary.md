# 数据字典

## `data/network.json`

```json
{
  "nodes": [
    {
      "id": 3257,
      "name": "朱熹",
      "dynasty_tier": "宋",
      "dynasty_tiers": ["宋"],
      "gender": "男",
      "birth_year": 1130,
      "death_year": 1200,
      "courtesy_name": "仲晦、元晦",
      "style_name": "晦庵、晦翁",
      "dynasty": "宋",
      "category": "文學家",
      "degree": 1543,
      "x": 0.545314,
      "y": 0.480858
    }
  ],
  "edges": [
    {
      "source": 29603,
      "target": 127437,
      "type": "交往",
      "text_id": 0,
      "source_pages": "lgid=65712"
    }
  ],
  "metadata": {
    "node_count": 40263,
    "edge_count": 72925,
    "dynasty_tiers": ["春秋战国", "秦汉", "魏晋南北朝", "隋唐", "五代十国", "宋", "辽金西夏", "元", "明", "清"],
    "texts": ["江南通志", "宋人傳記資料索引(電子版)", "…"],
    "source": "CBDB (中国历代人物传记资料库) cbdb202409.db"
  }
}
```

## 人物字段（nodes[]）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int | CBDB 人物 ID（`BIOG_MAIN.c_personid`） |
| `name` | str | 中文姓名 |
| `dynasty_tier` | str | 主朝代档位（CBDB `c_dy` 所属，用于节点配色） |
| `dynasty_tiers` | list[str] | 全部所属档位（含跨朝代；朝代筛选以此为准） |
| `gender` | str | 性别（`c_female`：1=女、0=男；0 含不详） |
| `birth_year` | int | 出生年（0/缺失时不出现） |
| `death_year` | int | 卒年（0/缺失时不出现） |
| `courtesy_name` | str | 字（`ALTNAME_DATA` 类型 4；空时不出现） |
| `style_name` | str | 号 / 室名（`ALTNAME_DATA` 类型 5；空时不出现） |
| `dynasty` | str | CBDB 原朝代名（空时不出现） |
| `category` | str | 类别（推断值，见 methodology） |
| `degree` | int | 入选网络内的度数（度中心性） |
| `x` / `y` | float | 预计算布局坐标（igraph DrL，归一化到 [0,1]） |

## 关系字段（edges[]）

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` / `target` | int | 人物对（CBDB 人物 ID），无方向 |
| `type` | str | 简化关系类型（師生/好友/家族/同僚/政敵/唱和/交往） |
| `text_id` | int | 史料出处书名在 `metadata.texts` 中的下标 |
| `source_pages` | str | 出处页码（空时不出现） |

> 原始关系描述 `subtype` 与出处书名原文保留在 `data/processed/relationships.csv`；JSON 中为减小体积，书名经 `text_id` → `metadata.texts` 压缩存储。

## 数据字典文件

- `data/dictionaries/dynasty_tiers.json`：朝代档位 → CBDB `c_dy` 代码列表（扩展朝代时改这里）
- `data/dictionaries/relationship_codes.json`：简化关系类型 → 中文说明
- `data/families.json`：亲缘谱系候选。`families[].members` 为当前网络中的人物 ID；`edges[]` 为 CBDB `KIN_DATA` 直系亲缘边，重建后的边另含 `kin_code`、`generation_gap` 与 `direction`。

## CSV 字段

`data/processed/people.csv` 与 `data/processed/relationships.csv` 为 `network.json` 的扁平化导出（relationships.csv 额外含 `subtype` / `source_text` 原始字段）。
