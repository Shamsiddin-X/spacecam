"""SPHEREx Sky Watch API (FastAPI).

GET /api/health   — проверка
GET /api/epochs   — все снимки SPHEREx, покрывающие точку неба (по детектору), сгруппированные по визитам
GET /api/frame    — один снимок, совмещённый с общей сеткой, в виде PNG (для анимации)
GET /api/compare  — два снимка + разность + найденные изменения + известные малые тела (JPL)
Статика фронтенда раздаётся с «/», если каталог frontend доступен.
"""
from __future__ import annotations

import asyncio
import os
import time
from collections import OrderedDict
from pathlib import Path
from typing import Literal

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from . import imaging, irsa, sso
from .field import FieldSpec, build_field, inline_manifest
from .cutouts import PIXEL_SCALE_ARCSEC, Frame, load_and_reproject, png_pixel_to_sky, sky_to_png_pixel, target_grid

app = FastAPI(title="SpaceCam API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=1024)

_client: httpx.AsyncClient | None = None


@app.on_event("startup")
async def _startup() -> None:
    global _client
    _client = httpx.AsyncClient(headers={"User-Agent": "SPHEREx-SkyWatch/1.0 (open science viewer)"})


@app.on_event("shutdown")
async def _shutdown() -> None:
    if _client:
        await _client.aclose()


# ---------------------------------------------------------------- кэши
class TTLCache:
    def __init__(self, maxsize: int, ttl: float):
        self.maxsize, self.ttl, self.data = maxsize, ttl, OrderedDict()

    def get(self, key):
        item = self.data.get(key)
        if not item or time.time() - item[0] > self.ttl:
            return None
        self.data.move_to_end(key)
        return item[1]

    def put(self, key, value):
        self.data[key] = (time.time(), value)
        self.data.move_to_end(key)
        while len(self.data) > self.maxsize:
            self.data.popitem(last=False)


_epochs_cache = TTLCache(512, ttl=6 * 3600)
_frame_cache = TTLCache(256, ttl=24 * 3600)
_frame_locks: dict[tuple, asyncio.Lock] = {}

Band = Literal["D1", "D2", "D3", "D4", "D5", "D6"]
RA = Query(..., ge=0, lt=360, description="Прямое восхождение, градусы (ICRS)")
DEC = Query(..., ge=-90, le=90, description="Склонение, градусы (ICRS)")
SIZE = Query(0.2, ge=0.03, le=0.6, description="Сторона области, градусы")


def _key(*parts) -> tuple:
    return tuple(round(p, 6) if isinstance(p, float) else p for p in parts)


# ---------------------------------------------------------------- эндпоинты
@app.get("/api/health")
async def health():
    return {"ok": True, "service": "spherex-skywatch", "archive": irsa.IRSA}


@app.get("/api/epochs")
async def epochs(ra: float = RA, dec: float = DEC, band: Band = "D2"):
    key = _key(ra, dec, band)
    cached = _epochs_cache.get(key)
    if cached is None:
        try:
            obs = await irsa.query_observations(_client, ra, dec, band)
        except (irsa.ArchiveError, httpx.HTTPError) as e:
            raise HTTPException(502, f"Архив IRSA недоступен: {e}") from e
        cached = {"ra": ra, "dec": dec, "band": band, "observations": obs, "visits": irsa.summarize_visits(obs)}
        _epochs_cache.put(key, cached)
    return cached


async def _get_frame(ra: float, dec: float, size: float, uri: str) -> Frame:
    key = _key(uri, ra, dec, size)
    hit = _frame_cache.get(key)
    if hit is not None:
        return hit
    lock = _frame_locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _frame_cache.get(key)
        if hit is not None:
            return hit
        try:
            # вырезка с запасом: кадр SPHEREx повернут относительно сетки «север вверх»
            raw = await irsa.fetch_cutout(_client, uri, ra, dec, size * 1.5)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        except (irsa.ArchiveError, httpx.HTTPError) as e:
            raise HTTPException(502, str(e)) from e
        try:
            frame = await asyncio.to_thread(load_and_reproject, raw, ra, dec, size)
        except Exception as e:  # повреждённый/неожиданный FITS
            raise HTTPException(422, f"Не удалось обработать снимок: {e}") from e
        _frame_cache.put(key, frame)
    _frame_locks.pop(key, None)
    return frame


def _frame_meta(fr: Frame, mjd_fallback: float) -> dict:
    return {
        "mjd": fr.mjd if fr.mjd is not None else mjd_fallback,
        "wavelength_um": fr.wavelength_um,
        "version": fr.version,
        "valid_fraction": round(fr.valid_fraction, 3),
    }


@app.get("/api/frame")
async def frame(ra: float = RA, dec: float = DEC, size: float = SIZE, uri: str = Query(...), mjd: float = Query(...)):
    fr = await _get_frame(ra, dec, size, uri)
    if fr.valid_fraction < 0.05:
        raise HTTPException(404, "Снимок почти не покрывает выбранную область")

    def work():
        sig, _, _ = imaging.normalize(fr.data)
        return imaging.render_image(sig)

    png = await asyncio.to_thread(work)
    _, (n, _) = target_grid(ra, dec, size)
    return {"png": png, "n": n, "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC, **_frame_meta(fr, mjd)}


@app.get("/api/compare")
async def compare(
    ra: float = RA, dec: float = DEC, size: float = SIZE,
    uri_a: str = Query(...), mjd_a: float = Query(...),
    uri_b: str = Query(...), mjd_b: float = Query(...),
    threshold: float = Query(5.0, ge=3.0, le=20.0),
    known: bool = Query(True, description="Сверять с известными малыми телами JPL"),
):
    fa, fb = await asyncio.gather(_get_frame(ra, dec, size, uri_a), _get_frame(ra, dec, size, uri_b))
    ta = fa.mjd if fa.mjd is not None else mjd_a
    tb = fb.mjd if fb.mjd is not None else mjd_b
    dt_hours = abs(tb - ta) * 24.0

    def work():
        a, _, _ = imaging.normalize(fa.data)
        b, _, _ = imaging.normalize(fb.data)
        # общий верхний предел растяжки — чтобы мигание сравнивало яркость честно
        both = np.concatenate([a[np.isfinite(a)], b[np.isfinite(b)]])
        hi = float(np.percentile(both, 99.7)) if both.size else None
        dr = imaging.difference(a, b)
        cands = imaging.detect_changes(dr, a, b, threshold=threshold, dt_hours=dt_hours, pixel_scale_arcsec=PIXEL_SCALE_ARCSEC)
        return (imaging.render_image(a, hi=hi), imaging.render_image(b, hi=hi),
                imaging.render_diff(dr.diff, dr.valid), dr, cands)

    try:
        png_a, png_b, png_d, dr, cands = await asyncio.to_thread(work)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e

    _, (n, _) = target_grid(ra, dec, size)
    candidates = []
    for c in cands:
        cra, cdec = png_pixel_to_sky(c.x, c.y, ra, dec, size)
        item = {
            "x": c.x, "y": c.y, "ra": cra, "dec": cdec, "sign": c.sign, "snr": c.snr, "area": c.area,
            "kind": c.kind, "label": c.label, "pair_with": c.pair_with,
        }
        if c.rate_arcsec_h is not None:
            item["rate_arcsec_h"] = round(c.rate_arcsec_h, 2)
            item["label"] += f" · ~{c.rate_arcsec_h:.1f}″/ч"
        candidates.append(item)

    known_list, known_error = [], None
    if known:
        half = size / 2.0
        try:
            res = await asyncio.gather(
                sso.known_objects(_client, ra, dec, half, ta),
                sso.known_objects(_client, ra, dec, half, tb),
            )
            for epoch, objs in zip(("A", "B"), res):
                for o in objs:
                    x, y, _ = sky_to_png_pixel(o["ra"], o["dec"], ra, dec, size)
                    if -2 <= x <= n + 2 and -2 <= y <= n + 2:
                        known_list.append({**o, "epoch": epoch, "x": x, "y": y})
        except Exception as e:
            known_error = str(e)

    return {
        "ra": ra, "dec": dec, "size": size, "n": n, "pixel_scale_arcsec": PIXEL_SCALE_ARCSEC,
        "a": {"png": png_a, **_frame_meta(fa, mjd_a)},
        "b": {"png": png_b, **_frame_meta(fb, mjd_b)},
        "diff_png": png_d, "scale_k": dr.scale_k, "threshold": threshold,
        "candidates": candidates, "known": known_list, "known_error": known_error,
    }


@app.get("/api/field")
async def field(ra: float = RA, dec: float = DEC, band: Band = "D1", size: float = SIZE, max_frames: int = Query(24, ge=2, le=60)):
    """Все снимки точки, совмещённые на общей сетке, — в формате, который читает браузер."""
    spec = FieldSpec(id=f"api-{ra:.3f}-{dec:.3f}-{band}", name=f"Точка {ra:.4f} {dec:+.4f}", ra=ra, dec=dec, band=band, size=size, max_frames=max_frames)
    try:
        manifest, arrays = await build_field(_client, spec)
    except (irsa.ArchiveError, httpx.HTTPError) as e:
        raise HTTPException(502, f"Архив IRSA недоступен: {e}") from e
    if len(arrays) < 2:
        raise HTTPException(404, "Для этой точки пока меньше двух пригодных снимков")
    return inline_manifest(manifest, arrays)


# ---------------------------------------------------------------- фронтенд
_front = Path(os.environ.get("FRONTEND_DIR", Path(__file__).resolve().parents[2] / "web"))
if _front.is_dir():
    app.mount("/", StaticFiles(directory=str(_front), html=True), name="frontend")
