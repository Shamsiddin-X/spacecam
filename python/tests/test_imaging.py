"""Тесты алгоритма поиска изменений на синтетических кадрах (не реальные данные SPHEREx).
Запуск: cd python && python -m pytest -q
"""
import numpy as np

from skywatch import imaging


def gaussian(n, x, y, amp, sigma=1.1):
    yy, xx = np.mgrid[0:n, 0:n]
    return amp * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2))


def make_pair(seed=1, n=120):
    rng = np.random.default_rng(seed)
    a = rng.normal(0, 1, (n, n))
    b = rng.normal(0, 1, (n, n))
    for _ in range(25):  # неподвижные звёзды в обоих кадрах
        x, y, amp = rng.uniform(10, n - 10), rng.uniform(10, n - 10), rng.uniform(15, 40)
        a += gaussian(n, x, y, amp)
        b += gaussian(n, x, y, amp * 1.1)  # другая длина волны → общий множитель
    return a, b


def test_robust_stats_ignores_stars():
    a, _ = make_pair()
    med, std = imaging.robust_stats(a)
    assert abs(med) < 0.2 and 0.8 < std < 1.3


def test_scale_factor_recovered():
    a, b = make_pair()
    dr = imaging.difference(*(imaging.normalize(x)[0] for x in (a, b)))
    assert 1.0 < dr.scale_k < 1.25


def test_moving_object_detected_as_pair():
    n = 120
    a, b = make_pair(n=n)
    a += gaussian(n, 40, 60, 25)   # объект в эпоху A
    b += gaussian(n, 52, 66, 25)   # тот же объект сдвинулся к эпохе B
    an, bn = imaging.normalize(a)[0], imaging.normalize(b)[0]
    dr = imaging.difference(an, bn)
    cands = imaging.detect_changes(dr, an, bn, threshold=5, dt_hours=10, pixel_scale_arcsec=6.15)
    moving = [c for c in cands if c.kind == "moving"]
    assert len(moving) == 2, [(c.kind, round(c.x), round(c.y)) for c in cands]
    new = next(c for c in moving if c.sign > 0)
    assert abs(new.x - 52) < 1.5 and abs((n - 1 - new.y) - 66) < 1.5
    assert new.rate_arcsec_h is not None and 7 < new.rate_arcsec_h < 10


def test_static_field_has_no_false_alarms():
    a, b = make_pair(seed=7)
    an, bn = imaging.normalize(a)[0], imaging.normalize(b)[0]
    dr = imaging.difference(an, bn)
    cands = imaging.detect_changes(dr, an, bn, threshold=6)
    assert len(cands) <= 1


def test_render_outputs_png():
    a, _ = make_pair()
    png = imaging.render_image(imaging.normalize(a)[0])
    assert png.startswith("data:image/png;base64,")
