"""Конвейер данных: собирает поля из pipeline/fields.json и пишет их в web/data для GitHub Pages.

    python -m pipeline.build --out ../web/data [--only nep,m42] [--max-frames 40] [--no-known]

Ошибка одного поля не останавливает остальные; если не собралось ничего, остаётся прежний каталог.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import shutil
import time
from pathlib import Path

import httpx

from skywatch.field import FieldSpec, build_field

log = logging.getLogger("pipeline")


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="../web/data")
    ap.add_argument("--config", default=str(Path(__file__).with_name("fields.json")))
    ap.add_argument("--only", default="")
    ap.add_argument("--max-frames", type=int, default=40)
    ap.add_argument("--no-known", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    out = Path(args.out)
    (out / "fields").mkdir(parents=True, exist_ok=True)
    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))["fields"]
    only = {x for x in args.only.split(",") if x}
    index = []
    async with httpx.AsyncClient(headers={"User-Agent": "SPHEREx-SkyWatch-pipeline/1.0"}) as client:
        for f in cfg:
            if only and f["id"] not in only:
                continue
            spec = FieldSpec(**{k: v for k, v in f.items() if k in FieldSpec.__dataclass_fields__}, max_frames=args.max_frames)
            t0 = time.time()
            try:
                manifest, arrays = await build_field(client, spec, with_known=not args.no_known)
            except Exception as e:
                log.error("поле %s не собрано: %s", spec.id, e)
                continue
            if len(arrays) < 2:
                log.warning("поле %s: меньше двух пригодных снимков, пропускаю", spec.id)
                continue
            d = out / "fields" / spec.id
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True)
            for fr, arr in zip(manifest["frames"], arrays):
                fr["file"] = f"f{fr['i']:03d}.bin"
                (d / fr["file"]).write_bytes(arr.astype("<f4").tobytes())
            (d / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            index.append({k: manifest[k] for k in ("id", "name", "short", "ra", "dec", "band", "size", "visits", "candidates")} | {"frames": len(arrays)})
            log.info("поле %s: %d снимков за %.0f с", spec.id, len(arrays), time.time() - t0)
    if not index:
        log.error("не собрано ни одного поля")
        return 0
    (out / "fields.json").write_text(json.dumps({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "fields": index}, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
