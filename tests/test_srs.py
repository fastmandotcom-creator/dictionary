from __future__ import annotations

from dict_factory import srs


def test_interval_map() -> None:
    assert srs.GRADE_INTERVAL_DAYS == {"hard": 1, "ok": 3, "good": 7}


def test_next_due_dates() -> None:
    assert srs.next_due("hard", "2026-10-10") == "2026-10-11"
    assert srs.next_due("ok", "2026-10-10") == "2026-10-13"
    assert srs.next_due("good", "2026-10-10") == "2026-10-17"


def test_next_due_rejects_unknown_grade() -> None:
    import pytest

    with pytest.raises(ValueError):
        srs.next_due("meh", "2026-10-10")


def test_is_done() -> None:
    assert srs.is_done(None) is False
    assert srs.is_done({"grade": "hard", "due": "2026-10-11"}) is False
    assert srs.is_done({"grade": "ok", "due": "2026-10-13"}) is True
    assert srs.is_done(None, "good") is True
    assert srs.is_done(None, "ok") is False  # legacy v1 only had 'good' as done


def test_is_due_new_card() -> None:
    # never learned => "new", NOT due (avoids flooding the review pool)
    assert srs.is_due(None, "2026-10-10") is False


def test_is_due_legacy_card_comes_back_once() -> None:
    # v1 legacy has no due date: any recorded card comes back for one pass
    assert srs.is_due(None, "2026-10-10", legacy_value="good") is True


def test_is_due_hard_always_resurfaces() -> None:
    entry = {"grade": "hard", "due": "2026-10-11"}
    assert srs.is_due(entry, "2026-10-10") is True
    assert srs.is_due(entry, "2026-12-25") is True


def test_is_due_ok_good_only_when_past_due() -> None:
    entry = {"grade": "good", "due": "2026-10-17"}
    assert srs.is_due(entry, "2026-10-10") is False  # not yet due
    assert srs.is_due(entry, "2026-10-17") is True
    assert srs.is_due(entry, "2026-12-25") is True
    entry2 = {"grade": "ok", "due": "2026-10-13"}
    assert srs.is_due(entry2, "2026-10-12") is False
    assert srs.is_due(entry2, "2026-10-13") is True


def test_is_due_missing_due_treats_as_due() -> None:
    assert srs.is_due({"grade": "good"}, "2026-10-10") is True


def test_shuffle_deterministic_with_rng() -> None:
    import random

    a = srs.shuffle([1, 2, 3, 4, 5], rng=random.Random(42))
    b = srs.shuffle([1, 2, 3, 4, 5], rng=random.Random(42))
    assert a == b
    assert sorted(a) == [1, 2, 3, 4, 5]


def test_shuffle_does_not_mutate_input() -> None:
    import random

    src = [1, 2, 3]
    srs.shuffle(src, rng=random.Random(1))
    assert src == [1, 2, 3]


def test_keys_per_pair() -> None:
    assert srs.srs_key("vi", "ja") == "dict_srs_v2_vi_ja"
    assert srs.legacy_key("vi", "ja") == "dict_learn_progress_vi_ja"
