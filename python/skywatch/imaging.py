"""Обработка изображений: робастная статистика, разность эпох, поиск изменений, рендер PNG.

Модуль зависит только от numpy, scipy и Pillow, поэтому его легко тестировать
на синтетических массивах (см. tests/test_imaging.py).
Все массивы — в «шкале сигм» после normalize(): 0 = фон, 1 = шум фона.
Соглашение о координатах: массивы хранятся как в FITS (строка 0 = юг),
а координаты, которые уходят во фронтенд, — в системе PNG (строка 0 = север).
"""
from __future__ import annotations

import base64
import io
from dataclasses import dataclass, field

import numpy as np
from PIL import Image
from scipy import ndimage


# ---------------------------------------------------------------- статистика
def robust_stats(values: np.ndarray, sigma: float = 3.0, iters: int = 5) -> tuple[float, float]:
    """Медиана и σ по MAD с итеративным отсечением выбросов (звёзд)."""
    v = values[np.isfinite(values)]
    if v.size < 10:
        return 0.0, 1.0
    med = float(np.median(v))
    std = float(1.4826 * np.median(np.abs(v - med))) or float(np.std(v)) or 1.0
    for _ in range(iters):
        keep = np.abs(v - med) < sigma * std
        if keep.sum() < 10:
            break
        v2 = v[keep]
        new_med = float(np.median(v2))
        new_std = float(1.4826 * np.median(np.abs(v2 - new_med))) or std
        if abs(new_med - med) < 1e-6 * max(1.0, abs(med)) and abs(new_std - std) < 1e-6 * std:
            break
        med, std = new_med, new_std
    return med, max(std, 1e-12)


def normalize(img: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Вычитает фон и делит на шум: результат в единицах σ фона."""
    med, std = robust_stats(img)
    return ((img - med) / std).astype(np.float32), med, std


# ---------------------------------------------------------------- разность
@dataclass
class DiffResult:
    diff: np.ndarray            # (B − k·A) / σ_diff
    valid: np.ndarray           # маска пикселей, где обе эпохи надёжны
    scale_k: float              # фотометрическое выравнивание B ≈ k·A
    noise: float                # σ разности до нормировки
    bright: np.ndarray = field(repr=False, default=None)  # маска ярких звёзд (артефакты PSF)


def difference(a: np.ndarray, b: np.ndarray, edge: int = 3, bright_sigma: float = 60.0) -> DiffResult:
    """Разность двух кадров одного участка, уже совмещённых на общей сетке.

    Длины волн двух снимков SPHEREx в одной точке слегка различаются (фильтр LVF),
    поэтому яркость B подгоняется к A общим коэффициентом k по звёздам, яркие в обоих кадрах.
    """
    valid = np.isfinite(a) & np.isfinite(b)
    if edge > 0:
        valid = ndimage.binary_erosion(valid, iterations=edge, border_value=0)
    if valid.sum() < 50:
        raise ValueError("Кадры почти не перекрываются: выберите другие снимки или меньшую область.")
    both = valid & (a > 8) & (b > 8) & (a < 2000) & (b < 2000)
    k = 1.0
    if both.sum() >= 8:
        ratio = b[both] / a[both]
        k = float(np.clip(np.median(ratio), 0.25, 4.0))
    d = np.where(valid, b - k * a, np.nan)
    _, noise = robust_stats(d[valid])
    d = (d / noise).astype(np.float32)
    bright = valid & ((a > bright_sigma) | (b > bright_sigma))
    bright = ndimage.binary_dilation(bright, iterations=2)
    return DiffResult(diff=d, valid=valid, scale_k=k, noise=noise, bright=bright)


# ---------------------------------------------------------------- поиск изменений
@dataclass
class Candidate:
    x: float          # PNG-координаты (столбец)
    y: float          # PNG-координаты (строка, 0 = верх/север)
    sign: int         # +1 ярче в B, −1 ярче в A
    snr: float
    area: int
    kind: str
    label: str
    near_bright: bool
    pair_with: int | None = None
    rate_arcsec_h: float | None = None


def detect_changes(
    dr: DiffResult,
    a: np.ndarray,
    b: np.ndarray,
    threshold: float = 5.0,
    min_area: int = 2,
    max_candidates: int = 40,
    include_bright: bool = False,
    dt_hours: float | None = None,
    pixel_scale_arcsec: float = 6.15,
    pair_max_px: float = 40.0,
) -> list[Candidate]:
    """Ищет компактные области |разность| > threshold и классифицирует их.

    * «появился в B»: в B есть источник, в A на этом месте пусто (<3σ);
    * «исчез к B»: наоборот;
    * «изменил яркость»: источник есть в обоих кадрах (переменная звезда и т. п.).
    Пара «исчез/появился» поблизости помечается как возможное движение.
    """
    ny = dr.diff.shape[0]
    d = np.where(dr.valid, dr.diff, 0.0)
    found: list[Candidate] = []
    for sign in (+1, -1):
        mask = (sign * d) > threshold
        labels, n = ndimage.label(mask)
        if n == 0:
            continue
        idx = np.arange(1, n + 1)
        areas = ndimage.sum(mask, labels, idx)
        peaks = ndimage.maximum(sign * d, labels, idx)
        coms = ndimage.center_of_mass(np.clip(sign * d, 0, None), labels, idx)
        for area, peak, (cy, cx) in zip(areas, peaks, coms):
            if area < min_area:
                continue
            iy, ix = int(round(cy)), int(round(cx))
            near_bright = bool(dr.bright[iy, ix]) if dr.bright is not None else False
            if near_bright and not include_bright:
                continue
            here_a = float(np.nanmax(a[max(0, iy - 1):iy + 2, max(0, ix - 1):ix + 2]))
            here_b = float(np.nanmax(b[max(0, iy - 1):iy + 2, max(0, ix - 1):ix + 2]))
            if sign > 0:
                kind = "appeared" if here_a < 3 else "brightened"
                label = "Появился в B" if kind == "appeared" else "Стал ярче в B"
            else:
                kind = "vanished" if here_b < 3 else "faded"
                label = "Исчез к B" if kind == "vanished" else "Стал тусклее в B"
            found.append(Candidate(
                x=float(cx), y=float(ny - 1 - cy), sign=sign, snr=float(peak), area=int(area),
                kind=kind, label=label, near_bright=near_bright,
            ))
    found.sort(key=lambda c: -c.snr)
    found = found[:max_candidates]

    # пары «исчез в A-позиции → появился в B-позиции» = кандидат в движущийся объект
    pos = [i for i, c in enumerate(found) if c.kind == "appeared"]
    neg = [i for i, c in enumerate(found) if c.kind == "vanished"]
    used: set[int] = set()
    for i in pos:
        best, best_d = None, pair_max_px
        for j in neg:
            if j in used:
                continue
            dist = float(np.hypot(found[i].x - found[j].x, found[i].y - found[j].y))
            if 1.5 < dist < best_d:
                best, best_d = j, dist
        if best is not None:
            used.add(best)
            found[i].pair_with, found[best].pair_with = best, i
            rate = None
            if dt_hours and dt_hours > 0:
                rate = best_d * pixel_scale_arcsec / dt_hours
            for k in (i, best):
                found[k].kind = "moving"
                found[k].rate_arcsec_h = rate
            found[i].label = "Сдвинулся: новое положение (B)"
            found[best].label = "Сдвинулся: старое положение (A)"
    return found


# ---------------------------------------------------------------- рендер
_IR_STOPS = np.array([
    [0.00, 2, 3, 10],
    [0.22, 36, 18, 84],
    [0.45, 150, 40, 110],
    [0.68, 240, 120, 60],
    [0.86, 255, 205, 120],
    [1.00, 255, 252, 240],
], dtype=np.float32)


def _lut(stops: np.ndarray, n: int = 256) -> np.ndarray:
    t = np.linspace(0, 1, n)
    return np.stack([np.interp(t, stops[:, 0], stops[:, c]) for c in (1, 2, 3)], axis=1).astype(np.uint8)


IR_LUT = _lut(_IR_STOPS)


def _to_png_b64(rgb: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(np.flipud(rgb), "RGB").save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def render_image(sig: np.ndarray, lo: float = -2.0, hi: float | None = None, soft: float = 8.0) -> str:
    """Кадр в σ-шкале → PNG (asinh-растяжка, инфракрасная палитра)."""
    v = sig.copy()
    finite = np.isfinite(v)
    if hi is None:
        hi = float(np.percentile(v[finite], 99.7)) if finite.any() else 10.0
    hi = max(hi, lo + 6.0)
    s = np.arcsinh(np.clip((v - lo) / (hi - lo), 0, 1) * soft) / np.arcsinh(soft)
    s[~finite] = 0
    rgb = IR_LUT[(s * 255).astype(np.uint8)]
    return _to_png_b64(rgb)


def render_diff(diff: np.ndarray, valid: np.ndarray, scale: float = 8.0) -> str:
    """Разность → PNG: красное ярче в B, синее ярче в A, тёмное — без изменений."""
    v = np.where(valid, diff, 0.0)
    s = np.arcsinh(np.clip(v / scale, -1, 1) * 4) / np.arcsinh(4)
    base = np.array([6, 8, 20], np.float32)
    pos = np.array([255, 92, 70], np.float32)
    neg = np.array([70, 160, 255], np.float32)
    sp = np.clip(s, 0, 1)[..., None]
    sn = np.clip(-s, 0, 1)[..., None]
    rgb = base * (1 - sp - sn) + pos * sp + neg * sn
    rgb[~valid] = [0, 0, 0]
    return _to_png_b64(np.clip(rgb, 0, 255).astype(np.uint8))
