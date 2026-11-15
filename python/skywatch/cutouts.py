"""Вырезки SPHEREx: чтение многослойного FITS (IMAGE, FLAGS, VARIANCE, ZODI, PSF, WCS-WAVE),
вычитание зодиакального света, маска плохих пикселей и пересчёт на общую сетку неба.
"""
from __future__ import annotations

import io
import warnings
from dataclasses import dataclass

import numpy as np

PIXEL_SCALE_ARCSEC = 6.15  # шаг пикселя детекторов SPHEREx
# Биты маски, которые считаем непригодными (если они описаны в заголовке FLAGS)
BAD_FLAG_NAMES = ("NONFUNC", "MISSING_DATA", "HOT", "COLD", "NONLINEAR", "PERSIST", "SUR_ERROR")


@dataclass
class Frame:
    data: np.ndarray            # на общей сетке, исходные единицы (MJy/sr), NaN вне покрытия
    mjd: float | None
    wavelength_um: float | None
    version: str
    valid_fraction: float


def target_grid(ra: float, dec: float, size_deg: float):
    """Касательная проекция с севером вверх и востоком влево, шаг = пиксель SPHEREx."""
    from astropy.wcs import WCS

    step = PIXEL_SCALE_ARCSEC / 3600.0
    n = int(np.clip(np.ceil(size_deg / step), 16, 400))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    w.wcs.cdelt = [-step, step]
    w.wcs.cunit = ["deg", "deg"]
    return w, (n, n)


def _bad_mask(hdul) -> np.ndarray | None:
    if "FLAGS" not in hdul:
        return None
    flags_hdu = hdul["FLAGS"]
    flags = np.asarray(flags_hdu.data)
    bits = []
    for card in flags_hdu.header.cards:
        key, val = str(card.keyword), card.value
        if isinstance(val, int) and 0 <= val < 32 and any(name in key.upper() for name in BAD_FLAG_NAMES):
            bits.append(val)
    if not bits:
        return None
    m = 0
    for b in set(bits):
        m |= 1 << b
    return (flags.astype(np.int64) & m) != 0


def load_and_reproject(fits_bytes: bytes, ra: float, dec: float, size_deg: float) -> Frame:
    from astropy import units as u
    from astropy.coordinates import SkyCoord
    from astropy.io import fits
    from astropy.wcs import WCS, FITSFixedWarning
    from reproject import reproject_interp

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        warnings.simplefilter("ignore", RuntimeWarning)
        with fits.open(io.BytesIO(fits_bytes), memmap=False) as hdul:
            img_hdu = hdul["IMAGE"] if "IMAGE" in hdul else hdul[1]
            hdr = img_hdu.header
            data = np.asarray(img_hdu.data, dtype=np.float32)
            if "ZODI" in hdul:  # зодиакальный свет меняется между эпохами — убираем модель
                data = data - np.asarray(hdul["ZODI"].data, dtype=np.float32)
            bad = _bad_mask(hdul)
            if bad is not None and bad.shape == data.shape:
                data = np.where(bad, np.nan, data)
            wcs = WCS(hdr)

            wavelength = None
            try:
                spectral = WCS(hdr, fobj=hdul, key="W")
                spectral.sip = None
                x, y = wcs.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))
                wl, _bw = spectral.pixel_to_world(x, y)
                wavelength = float(u.Quantity(wl).to(u.um).value)
            except Exception:
                wavelength = None

            mjd = None
            for key in ("MJD-AVG", "MJD-OBS", "MJD-BEG"):
                if key in hdr:
                    mjd = float(hdr[key])
                    break
                if key in hdul[0].header:
                    mjd = float(hdul[0].header[key])
                    break
            version = str(hdul[0].header.get("VERSION", ""))

    out_wcs, shape = target_grid(ra, dec, size_deg)
    arr, footprint = reproject_interp((data, wcs.celestial), out_wcs, shape_out=shape, order="bilinear")
    arr = np.where(footprint > 0.5, arr, np.nan).astype(np.float32)
    return Frame(
        data=arr, mjd=mjd, wavelength_um=wavelength, version=version,
        valid_fraction=float(np.isfinite(arr).mean()),
    )


def sky_to_png_pixel(ra: float, dec: float, ra0: float, dec0: float, size_deg: float) -> tuple[float, float, int]:
    """RA/Dec → координаты в PNG (столбец, строка от верха) для сетки target_grid."""
    w, (n, _) = target_grid(ra0, dec0, size_deg)
    x, y = w.wcs_world2pix([[ra, dec]], 0)[0]
    return float(x), float(n - 1 - y), n


def png_pixel_to_sky(x: float, y_png: float, ra0: float, dec0: float, size_deg: float) -> tuple[float, float]:
    w, (n, _) = target_grid(ra0, dec0, size_deg)
    ra, dec = w.wcs_pix2world([[x, n - 1 - y_png]], 0)[0]
    return float(ra % 360.0), float(dec)
