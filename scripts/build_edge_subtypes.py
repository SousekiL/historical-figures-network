#!/usr/bin/env python3
"""Build compact raw relationship details for edge hover tooltips."""
import csv, json
from pathlib import Path

def main():
    parser = __import__('argparse').ArgumentParser()
    parser.add_argument('--input', type=Path, default=Path('data/processed/relationships.csv'))
    parser.add_argument('--output', type=Path, default=Path('data/edge_subtypes.json'))
    args = parser.parse_args()
    details = {}
    with args.input.open(encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            source, target = str(row.get('source', '')).strip(), str(row.get('target', '')).strip()
            if not source or not target: continue
            key = source + '|' + target
            item = details.setdefault(key, {'subtype': row.get('subtype', '') or '', 'source_text': row.get('source_text', '') or '', 'source_pages': row.get('source_pages', '') or ''})
            for field in ('subtype', 'source_text', 'source_pages'):
                value = row.get(field, '') or ''
                if value and value not in item[field].split('；'):
                    item[field] = ('；'.join(filter(None, [item[field], value])))
    args.output.write_text(json.dumps(details, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'Wrote {args.output} ({len(details)} directed edges)')

if __name__ == '__main__': main()
