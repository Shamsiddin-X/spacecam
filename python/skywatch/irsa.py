"""Доступ к архиву NASA/IPAC IRSA: поиск снимков SPHEREx через TAP (ADQL) и загрузка вырезок.

Запрос повторяет официальный пример IRSA (tutorials/spherex/spherex_cutouts):
spherex.artifact JOIN spherex.plane, точка внутри p.poly, фильтр по детектору.
"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import os
import re
from pathlib import Path

import httpx

IRSA = "https://irsa.ipac.caltech.edu"
TAP_SYNC = f"{IRSA}/TAP/sync"
BANDS = {f"D{i}": f"SPHEREx-D{i}" for i in range(1, 7)}
URI_RE = re.compile(r"^[A-Za-z0-9_\-./]+\.fits$")

MISSION_START_MJD = 60796.0   # 2025-05-01, начало обзора неба
SURVEY_DAYS = 182.625         # ~полгода на обзор всего неба
VISIT_GAP_DAYS = 20.0         # разрыв, после которого начинается новый визит

CACHE_DIR = Path(os.environ.get("SKYWATCH_CACHE", "/tmp/skywatch-cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
_irsa_slots = asyncio.Semaphore(int(os.environ.get("SKYWATCH_IRSA_CONCURRENCY", "6")))


class ArchiveError(RuntimeError):
    pass


def build_query(ra: float, dec: float, band: str) -> str:
    if band not in BANDS:
        raise ValueError("band должен быть D1…D6")
    return (
        "SELECT a.uri, p.time_bounds_lower "
        "FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid "
        f"WHERE 1 = CONTAINS(POINT('ICRS', {ra:.6f}, {dec:.6f}), p.poly) "
        f"AND p.energy_bandpassname = '{BANDS[band]}' "
        "ORDER BY p.time_bounds_lower"
    )


def _parse_table(text: str) -> list[dict]:
    text = text.lstrip("\ufeff")
    if text.lstrip().startswith("<"):
        from astropy.io.votable import parse

        vot = parse(io.BytesIO(text.encode("utf-8")))
        for res in vot.resources:
            for info in res.infos:
                if info.name == "QUERY_STATUS" and str(info.value).upper() == "ERROR":
                    raise ArchiveError(f"IRSA TAP: {info.content or 'ошибка запроса'}")
        table = vot.get_first_table().to_table()
        return [{c: row[c] for c in table.colnames} for row in table]
    return list(csv.DictReader(io.StringIO(text)))


async def query_observations(client: httpx.AsyncClient, ra: float, dec: float, band: str) -> list[dict]:
    adql = build_query(ra, dec, band)
    async with _irsa_slots:
        r = await client.post(
            TAP_SYNC,
            data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql},
            timeout=120,
        )
    if r.status_code != 200:
        raise ArchiveError(f"IRSA TAP ответил {r.status_code}")
    rows = _parse_table(r.text)
    out: dict[int, dict] = {}
    for row in rows:
        uri = str(row.get("uri", "")).strip()
        try:
            mjd = float(row.get("time_bounds_lower"))
        except (TypeError, ValueError):
            continue
        if not uri.lower().endswith(".fits"):
            continue
        uri = uri.lstrip("/")
        if uri.startswith(IRSA):
            uri = uri[len(IRSA):].lstrip("/")
        if not URI_RE.match(uri):
            continue
        # один и тот же кадр может быть в нескольких выпусках обработки (QR/DR1): берём DR1
        key = int(round(mjd * 86400))
        prev = out.get(key)
        if prev is None or ("dr1" in uri.lower() and "dr1" not in prev["uri"].lower()):
            out[key] = {"uri": uri, "mjd": mjd}
    obs = sorted(out.values(), key=lambda o: o["mjd"])
    return annotate(obs)


def annotate(obs: list[dict]) -> list[dict]:
    """Добавляет номер обзора (полугодия) и номер визита (серии близких по времени снимков)."""
    visit = -1
    last = None
    for o in obs:
        if last is None or o["mjd"] - last > VISIT_GAP_DAYS:
            visit += 1
        o["visit"] = visit
        o["survey"] = max(1, int((o["mjd"] - MISSION_START_MJD) // SURVEY_DAYS) + 1)
        last = o["mjd"]
    return obs


def summarize_visits(obs: list[dict]) -> list[dict]:
    visits: dict[int, dict] = {}
    for o in obs:
        v = visits.setdefault(o["visit"], {"index": o["visit"], "start_mjd": o["mjd"], "end_mjd": o["mjd"], "count": 0, "survey": o["survey"]})
        v["end_mjd"] = o["mjd"]
        v["count"] += 1
    return [visits[k] for k in sorted(visits)]


def cutout_url(uri: str, ra: float, dec: float, size_deg: float) -> str:
    if not URI_RE.match(uri):
        raise ValueError("Недопустимый путь к файлу")
    return f"{IRSA}/{uri}?center={ra:.6f},{dec:.6f}d&size={size_deg:.4f}"


async def fetch_cutout(client: httpx.AsyncClient, uri: str, ra: float, dec: float, size_deg: float) -> bytes:
    url = cutout_url(uri, ra, dec, size_deg)
    path = CACHE_DIR / (hashlib.sha1(url.encode()).hexdigest() + ".fits")
    if path.exists() and path.stat().st_size > 0:
        return path.read_bytes()
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            async with _irsa_slots:
                r = await client.get(url, timeout=120, follow_redirects=True)
            if r.status_code == 200 and r.content[:6] == b"SIMPLE":
                tmp = path.with_suffix(".part")
                tmp.write_bytes(r.content)
                tmp.replace(path)
                return r.content
            last_err = ArchiveError(f"IRSA вернул {r.status_code} для вырезки")
        except httpx.HTTPError as e:
            last_err = e
        await asyncio.sleep(1.5 * (attempt + 1))
    raise ArchiveError(f"Не удалось скачать вырезку: {last_err}")
