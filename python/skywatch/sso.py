"""Известные малые тела (астероиды и кометы) в поле зрения на момент снимка:
NASA JPL SSD «Small-Body Identification API» (sb_ident.api).

Наблюдатель задаётся геоцентрически. SPHEREx находится на высоте ~700 км, поэтому
для очень близких околоземных объектов положение может отличаться на десятки угловых секунд;
для объектов главного пояса это доли пикселя SPHEREx (6.15″).
"""
from __future__ import annotations

import re

import httpx

SB_IDENT = "https://ssd-api.jpl.nasa.gov/sb_ident.api"


def _sexa(value: float, hours: bool) -> str:
    """Градусы → 'hh-mm-ss.ss' (RA) или 'dd-mm-ss.ss' (Dec, минус как 'M')."""
    sign = "M" if value < 0 else ""
    v = abs(value) / (15.0 if hours else 1.0)
    total = round(v * 3600.0, 2)
    if hours:
        total %= 24 * 3600
    d = int(total // 3600)
    m = int((total - d * 3600) // 60)
    s = total - d * 3600 - m * 60
    return f"{sign}{d:02d}-{m:02d}-{s:05.2f}"


_DEC_RE = re.compile(r"([+-]?)\s*(\d+)\s+(\d+)'\s*([\d.]+)")


def _parse_ra(s: str) -> float:
    h, m, sec = (float(x) for x in s.strip().split(":"))
    return (h + m / 60 + sec / 3600) * 15.0


def _parse_dec(s: str) -> float:
    m = _DEC_RE.search(s)
    if not m:
        raise ValueError(s)
    sign = -1.0 if m.group(1) == "-" else 1.0
    return sign * (float(m.group(2)) + float(m.group(3)) / 60 + float(m.group(4)) / 3600)


async def known_objects(client: httpx.AsyncClient, ra: float, dec: float, half_deg: float, mjd: float, vmag_lim: float = 22.0) -> list[dict]:
    import math

    params = {
        "obs-time": f"{mjd + 2400000.5:.6f}",
        "fov-ra-center": _sexa(ra % 360.0, hours=True),
        "fov-dec-center": _sexa(dec, hours=False),
        "fov-ra-hwidth": f"{min(180.0, half_deg / max(math.cos(math.radians(dec)), 0.05)):.4f}",
        "fov-dec-hwidth": f"{half_deg:.4f}",
        "two-pass": "true",
        "suppress-first-pass": "true",
        "mag-required": "false",
        "vmag-lim": str(vmag_lim),
    }
    observers = [{"xobs": "0,0,0"}, {"lat": "0", "lon": "0", "alt": "0"}]
    last = None
    for obs in observers:
        r = await client.get(SB_IDENT, params={**obs, **params}, timeout=90)
        if r.status_code == 200:
            return _parse(r.json())
        last = f"JPL ответил {r.status_code}"
    raise RuntimeError(last or "JPL недоступен")


def _parse(js: dict) -> list[dict]:
    fields = js.get("fields_second") or js.get("fields_first") or []
    rows = js.get("data_second_pass") or js.get("data_first_pass") or []
    if not fields or not rows:
        return []
    idx = {name: i for i, name in enumerate(fields)}

    def col(prefix: str):
        for name, i in idx.items():
            if name.startswith(prefix):
                return i
        return None

    i_name, i_ra, i_dec, i_v = col("Object name"), col("Astrometric RA"), col("Astrometric Dec"), col("Visual magnitude")
    out = []
    for row in rows:
        try:
            item = {"name": str(row[i_name]).strip(), "ra": _parse_ra(row[i_ra]), "dec": _parse_dec(row[i_dec])}
        except Exception:
            continue
        if i_v is not None:
            try:
                item["vmag"] = round(float(row[i_v]), 1)
            except (TypeError, ValueError):
                item["vmag"] = None
        out.append(item)
    return out
