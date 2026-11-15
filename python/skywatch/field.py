"""Сборка «поля» для машины времени: все снимки SPHEREx одного участка неба,
совмещённые на общей сетке (север вверх, восток влево), в шкале σ фона.

Результат — манифест (JSON) + по одному массиву float32 на снимок. Этот формат одинаково
читают браузер (web/js/timemachine.js), конвейер GitHub Actions и живой API.
"""
from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass

import httpx
import numpy as np

from . import imaging, irsa, sso
from .cutouts import PIXEL_SCALE_ARCSEC, load_and_reproject, sky_to_png_pixel, target_grid

log = logging.getLogger("skywatch.field")


@dataclass
class FieldSpec:
    id: str
    name: str
    ra: float
    dec: float
    band: str = "D1"
    size: float = 0.2
    short: str = ""
    max_frames: int = 40
    per_visit: int = 6


def select_frames(obs: list[dict], max_frames: int, per_visit: int) -> list[dict]:
    """Равномерно по визитам: до per_visit снимков из каждого, всего не больше max_frames.
    Первый и последний визиты берутся всегда — так видно изменения за всю миссию."""
    if not obs:
        return []
    visits: dict[int, list[dict]] = {}
    for o in obs:
        visits.setdefault(o["visit"], []).append(o)
    keys = sorted(visits)
    budget_per_visit = max(1, min(per_visit, max_frames // max(1, len(keys))))
    if len(keys) * budget_per_visit > max_frames:
        # слишком много визитов: равномерно прорежаем, сохраняя первый и последний
        idx = np.unique(np.round(np.linspace(0, len(keys) - 1, max(2, max_frames // budget_per_visit))).astype(int))
        keys = [keys[i] for i in idx]
    out = []
    for k in keys:
        v = visits[k]
        if len(v) <= budget_per_visit:
            out.extend(v)
        else:
            idx = np.unique(np.round(np.linspace(0, len(v) - 1, budget_per_visit)).astype(int))
            out.extend(v[i] for i in idx)
    return sorted(out, key=lambda o: o["mjd"])[:max_frames]


async def build_field(client: httpx.AsyncClient, spec: FieldSpec, with_known: bool = True, concurrency: int = 6) -> tuple[dict, list[np.ndarray]]:
    obs = await irsa.query_observations(client, spec.ra, spec.dec, spec.band)
    chosen = select_frames(obs, spec.max_frames, spec.per_visit)
    log.info("%s: найдено %d снимков, беру %d", spec.id, len(obs), len(chosen))
    sem = asyncio.Semaphore(concurrency)

    async def one(o: dict):
        async with sem:
            try:
                raw = await irsa.fetch_cutout(client, o["uri"], spec.ra, spec.dec, spec.size * 1.5)
                fr = await asyncio.to_thread(load_and_reproject, raw, spec.ra, spec.dec, spec.size)
            except Exception as e:  # отдельный битый снимок не должен ронять всё поле
                log.warning("%s: пропускаю %s (%s)", spec.id, o["uri"], e)
                return None
            if fr.valid_fraction < 0.6:
                return None
            sig, _, _ = imaging.normalize(fr.data)
            sig = np.flipud(sig).astype("<f4")  # строка 0 = север, как в браузере
            known = []
            if with_known:
                try:
                    mjd = fr.mjd if fr.mjd is not None else o["mjd"]
                    for k in await sso.known_objects(client, spec.ra, spec.dec, spec.size / 2, mjd):
                        x, y_png, n = sky_to_png_pixel(k["ra"], k["dec"], spec.ra, spec.dec, spec.size)
                        if 0 <= x < n and 0 <= y_png < n:
                            known.append({**k, "x": round(x, 2), "y": round(y_png, 2)})
                except Exception as e:
                    log.info("%s: JPL недоступен для %s (%s)", spec.id, o["uri"], e)
            meta = {
                "mjd": fr.mjd if fr.mjd is not None else o["mjd"],
                "visit": o["visit"], "survey": o["survey"],
                "wavelength_um": fr.wavelength_um, "version": fr.version,
                "valid_fraction": round(fr.valid_fraction, 3), "known": known, "uri": o["uri"],
            }
            return meta, sig

    results = [r for r in await asyncio.gather(*(one(o) for o in chosen)) if r]
    results.sort(key=lambda r: r[0]["mjd"])
    # визиты перенумеровываем подряд после отбора
    remap = {v: i for i, v in enumerate(sorted({m["visit"] for m, _ in results}))}
    for m, _ in results:
        m["visit"] = remap[m["visit"]]
    _, (n, _) = target_grid(spec.ra, spec.dec, spec.size)

    # сводка: сколько изменений между первым и последним снимком (для карточки поля)
    n_cand = None
    if len(results) >= 2:
        try:
            a, b = np.flipud(results[0][1]), np.flipud(results[-1][1])
            dr = imaging.difference(a, b)
            n_cand = len(imaging.detect_changes(dr, a, b, threshold=5.0))
        except Exception:
            n_cand = None

    manifest = {
        "id": spec.id, "name": spec.name, "short": spec.short or spec.name,
        "ra": spec.ra, "dec": spec.dec, "band": spec.band, "size": spec.size,
        "n": n, "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC, "format": "float32-le, n×n, строка 0 = север, σ фона",
        "frames": [{**m, "i": i} for i, (m, _) in enumerate(results)],
        "visits": len(remap), "candidates": n_cand, "total_available": len(obs),
    }
    return manifest, [s for _, s in results]


def inline_manifest(manifest: dict, arrays: list[np.ndarray]) -> dict:
    """Для живого API: массивы прямо в JSON (base64)."""
    out = dict(manifest)
    out["frames"] = [{**f, "data": base64.b64encode(a.tobytes()).decode("ascii")} for f, a in zip(manifest["frames"], arrays)]
    return out
