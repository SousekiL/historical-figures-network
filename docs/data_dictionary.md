# 数据字典

## `data/network.json`

```json
{
  "nodes": [
    {
      "id": 32540,
      "name": "李白",
      "courtesy_name": "太白",
      "style_name": "青蓮居士",
      "dynasty_tier": "隋唐",
      "dynasty": "唐",
      "birth_year": 701,
      "death_year": 762,
      "index_year": 701,
      "category": "文學家",
      "bio": "字太白，號青蓮居士。生701年，卒762年。",
      "degree": 35
    }
  ],
  "edges": [
    {
      "source": 3915,
      "target": 32540,
      "type": "唱和",
      "subtype": "贈詩、文",
      "direction": "A",
      "source_text": "唐五代人交往詩索引",
      "source_pages": "1112",
      "year": null,
      "assoc_code": 437
    }
  ],
  "metadata": {
    "node_count": 189,
    "edge_count": 2902,
    "dynasty_tiers": ["春秋战国", "秦汉", "魏晋南北朝", "隋唐", "宋", "元", "明", "清"],
    "source": "CBDB (中国历代人物传记资料库) cbdb202409.db"
  }
}
```

## 人物字段（nodes[]）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int | CBDB 人物 ID（`BIOG_MAIN.c_personid`） |
| `name` | str | 中文姓名 |
| `courtesy_name` | str | 字（`ALTNAME_DATA` 类型 4） |
| `style_name` | str | 号 / 室名（`ALTNAME_DATA` 类型 5） |
| `dynasty_tier` | str | 朝代档位（8 档之一） |
| `dynasty` | str | CBDB 原朝代名 |
| `birth_year` | int | 出生年（可空） |
| `death_year` | int | 卒年（可空） |
| `index_year` | int | CBDB 索引年 |
| `category` | str | 类别（推断值，见 methodology） |
| `bio` | str | 由字 / 号 / 生卒年拼合的简述 |
| `degree` | int | 入选网络内的度数（度中心性） |

## 关系字段（edges[]）

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` / `target` | int | 人物对（CBDB 人物 ID） |
| `type` | str | 简化关系类型（師生/好友/家族/同僚/政敵/唱和/交往） |
| `subtype` | str | CBDB 原始关系描述（如「贈詩、文」「友」「墓誌銘由Y所作」） |
| `direction` | str | CBDB 关系方向（A=主动 / P=被动 / M=相互） |
| `source_text` | str | 史料出处（书名） |
| `source_pages` | str | 出处页码 |
| `year` | int | 关系年份（可空） |
| `assoc_code` | int | CBDB 关系类型代码 |

## 数据字典文件

- `data/dictionaries/dynasty_tiers.json`：朝代档位 → CBDB `c_dy` 代码列表（扩展朝代时改这里）
- `data/dictionaries/relationship_codes.json`：简化关系类型 → 中文说明

## CSV 字段

`data/processed/people.csv` 与 `data/processed/relationships.csv` 为 `network.json` 的扁平化导出，字段与上表对应。
