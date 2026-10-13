"""End-to-end user-journey tests: a REAL browser (system Chrome) driving the
web learn flow exactly as a first-time learner would.

Skipped unless RUN_E2E=1 (needs `pip install playwright` + Google Chrome):

    RUN_E2E=1 python3.11 -m pytest tests/e2e/ -v

What each test plays as the end user:
- test_first_session_no_card_repeat: onboarding -> "Hôm nay" -> start a 5-card
  session, grade everything, verify no card repeats inside the session and the
  end-of-session summary appears (regression for the reported bug).
- test_good_word_disappears_until_due: grade "Nhớ" -> review page must NOT
  show it for 7 days (the exact complaint that triggered the fix).
- test_hard_word_resurfaces: grade "Chưa" -> it IS the first due card in review.
- test_placement_quiz_to_level: answer all 10 quiz items -> "Đạt mức B1".
- test_filter_survives_card_navigation: exam filter preserved card -> list.
- test_export_import_roundtrip: grade -> Xuất file -> wipe localStorage -> Nhập
  -> state restored + "Đã đồng bộ" badge.
- test_offline_grading_still_persists: block all sync endpoints, grading still
  lands in localStorage (offline-first).
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

NEEDS_E2E = os.environ.get("RUN_E2E") == "1" and sync_playwright is not None
pytestmark = pytest.mark.skipif(
    not NEEDS_E2E, reason="e2e disabled: set RUN_E2E=1 (needs playwright + system Chrome)"
)

SRS_KEY = "dict_srs_v2_vi_ja"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def server_url() -> str:
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "dict_factory", "web", "--port", str(port)],
        cwd=REPO,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(url + "/onboarding", timeout=1)
            break
        except Exception:
            time.sleep(0.2)
    else:
        proc.kill()
        raise RuntimeError("web server did not start")
    yield url
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture()
def page(server_url: str):
    """A fresh browser profile (empty localStorage) per test."""
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        ctx = browser.new_context()
        pg = ctx.new_page()
        pg.server_url = server_url  # type: ignore[attr-defined]
        pg.page_errors: list[str] = []  # type: ignore[attr-defined]
        pg.on("pageerror", lambda e: pg.page_errors.append(str(e)))  # type: ignore[attr-defined]
        pg.goto(server_url + "/")
        yield pg
        browser.close()


def assert_no_js_errors(page) -> None:
    assert not page.page_errors, f"uncaught browser exceptions: {page.page_errors}"


def start_session(page, new: int = 5) -> None:
    page.goto(f"{page.server_url}/session?base=vi&target=ja&cefr=A1&new={new}")
    page.wait_for_selector("#overview >> text=Hôm nay của bạn", timeout=15000)
    page.click("#start-btn")
    page.wait_for_selector("#card", timeout=15000)


def wait_card_loaded(page, index: int) -> str:
    page.wait_for_function(
        """(idx) => {
            const t = document.getElementById('card-target');
            const c = document.querySelector('#card .text-xs');
            return t && t.textContent !== '' && t.textContent !== '…'
                   && c && c.textContent.indexOf((idx + 1) + '/') === 0;
        }""",
        arg=index,
        timeout=15000,
    )
    return page.text_content("#card-target")


def grade(page, label: str) -> None:
    page.click(f"button:text-is('{label}')")


# ---------------------------------------------------------------------------

def test_first_session_no_card_repeat(page) -> None:
    # first-time learner: onboarding default is vi->ja; jump straight to a small
    # session and grade every card "Nhớ". No card may repeat within the session.
    start_session(page, new=5)
    seen: list[str] = []
    for i in range(5):
        word = wait_card_loaded(page, i)
        seen.append(word)
        page.click("#flip-btn")
        grade(page, "Nhớ (7 ngày)")
    page.wait_for_selector("#summary:not(.hidden)")
    assert "Hoàn thành buổi học" in page.text_content("#summary-body")
    assert len(seen) == 5
    assert len(set(seen)) == 5, f"card repeated within one session: {seen}"
    assert_no_js_errors(page)


def test_good_word_disappears_until_due(page) -> None:
    # The exact reported bug: pressing "Nhớ (7 days)" must NOT resurface the
    # word in review (or the next session's "due" list) for 7 days.
    start_session(page, new=1)
    word = wait_card_loaded(page, 0)
    page.click("#flip-btn")
    grade(page, "Nhớ (7 ngày)")
    page.wait_for_selector("#summary:not(.hidden)")

    page.goto(f"{page.server_url}/review?base=vi&target=ja&cefr=A1")
    page.wait_for_selector("#cards")
    assert "Không có thẻ nào đến hạn hôm nay" in page.text_content("#cards")

    # and the "Hôm nay" card on /learn must not count it as due either
    page.goto(f"{page.server_url}/learn?base=vi&target=ja&cefr=A1")
    page.wait_for_selector("#today-card:not(.hidden)")
    body = page.text_content("#today-body")
    assert "0 thẻ cần ôn" in body, body
    assert_no_js_errors(page)


def test_hard_word_resurfaces_in_review(page) -> None:
    start_session(page, new=1)
    word = wait_card_loaded(page, 0)
    page.click("#flip-btn")
    grade(page, "Chưa (1 ngày)")
    page.wait_for_selector("#summary:not(.hidden)")

    page.goto(f"{page.server_url}/review?base=vi&target=ja&cefr=A1")
    page.wait_for_selector("#session-est")
    page.wait_for_function(
        """() => {
            const t = document.getElementById('card-target');
            return t && t.textContent !== '' && t.textContent !== '…';
        }"""
    )
    assert page.text_content("#card-target") == word, "the 'Chưa' card must be the due card"
    assert "Buổi ôn hôm nay: 1 thẻ" in page.text_content("#session-est")
    assert_no_js_errors(page)


def test_placement_quiz_to_level(page) -> None:
    page.goto(f"{page.server_url}/placement?base=vi&target=ja")
    page.wait_for_function("typeof questions !== 'undefined' && questions.length > 0")
    n = page.evaluate("questions.length")
    for i in range(n):
        page.wait_for_function(f"document.getElementById('next-btn') !== null")
        # pick the correct option (test-side knowledge of the deterministic quiz)
        answer = page.evaluate(f"questions[{i}].answer")
        page.evaluate(
            """(ans) => {
                const btns = [...document.querySelectorAll('#quiz .opt')];
                btns.find((b) => b.textContent === ans)?.click();
            }""",
            answer,
        )
        page.click("#next-btn")
    page.wait_for_selector("#quiz >> text=Đạt mức B1")
    link = page.get_attribute("#quiz >> a:has-text('Bắt đầu học ở mức B1')", "href")
    assert link and "cefr=B1" in link
    assert_no_js_errors(page)


def test_filter_survives_card_navigation(page) -> None:
    page.goto(f"{page.server_url}/learn?base=vi&target=ja&exam=JLPT_N3")
    page.wait_for_selector(".unit-card")
    page.click(".unit-card")
    assert "/learn/" in page.url and "exam=JLPT_N3" in page.url
    # back to the list keeps the exam filter
    page.click("a:has-text('Lộ trình')")
    page.wait_for_load_state("networkidle")
    assert "exam=JLPT_N3" in page.url
    assert_no_js_errors(page)


def test_export_import_roundtrip(page) -> None:
    # learn one word, then export -> wipe -> import must restore the entry
    start_session(page, new=1)
    wait_card_loaded(page, 0)
    page.click("#flip-btn")
    grade(page, "Nhớ (7 ngày)")
    page.wait_for_selector("#summary:not(.hidden)")

    page.goto(f"{page.server_url}/learn?base=vi&target=ja&cefr=A1")
    page.wait_for_selector("#export-btn")
    with page.expect_download() as dl:
        page.click("#export-btn")
    payload = json.loads(dl.value.path().read_text(encoding="utf-8"))
    assert payload["base"] == "vi" and payload["target"] == "ja"
    assert len(payload["srs"]) >= 1

    # wipe local state, then import the file back
    page.evaluate(f"localStorage.removeItem('{SRS_KEY}')")
    page.click("#import-btn")
    page.set_input_files("#import-file", dl.value.path())
    page.wait_for_function(
        f"""() => {{
            const s = JSON.parse(localStorage.getItem('{SRS_KEY}') || '{{}}');
            return Object.keys(s).length > 0;
        }}"""
    )
    assert "Đã đồng bộ" in page.text_content("#sync-badge")
    assert_no_js_errors(page)


def test_listen_write_correct_flow(page) -> None:
    """Phase D3: /listen advanced flow — pick a concept, hear the sentence,
    type it back, grade it; SRS state lands under the drill-scoped key."""
    page.goto(f"{page.server_url}/listen?base=vi&target=en&topic=general")
    page.wait_for_selector(".concept-btn", timeout=15000)
    page.click(".concept-btn")
    page.wait_for_selector("#dl-input", timeout=20000)
    # reveal the answer, then retype it correctly
    page.click("#dl-reveal")
    answer = page.evaluate(
        """() => {
            const el = document.querySelector('#dl-result .font-mono');
            return el ? el.textContent : null;
        }"""
    )
    assert answer, "reveal must show the correct sentence"
    page.fill("#dl-input", answer)
    page.click("#dl-check")
    assert "Đúng!" in page.text_content("#dl-result")
    # grade the drill card "Nhớ" -> SRS entry under the drill-scoped id
    page.click("#dl-result .dl-g[data-g='good']")
    page.wait_for_selector("#dl-input", timeout=15000)  # advanced to next drill
    stored = page.evaluate(
        """() => {
            const s = JSON.parse(localStorage.getItem('dict_srs_v2_vi_en') || '{}');
            return Object.keys(s).filter((k) => k.indexOf('::') !== -1 && s[k] && s[k].grade === 'good');
        }"""
    )
    assert stored, "a drill-scoped SRS entry must be stored under dict_srs_v2_vi_en"
    assert_no_js_errors(page)


def test_listen_audio_button_never_crashes(page) -> None:
    """Phase E2: the NGHE button runs the TTS ladder (server standard voice,
    browser floor, or nothing) and must never raise a JS error."""
    page.goto(f"{page.server_url}/listen?base=vi&target=en&topic=general")
    page.wait_for_selector(".concept-btn", timeout=15000)
    page.click(".concept-btn")
    page.wait_for_selector("#dl-listen", timeout=20000)
    page.click("#dl-listen")
    page.wait_for_timeout(2000)  # give the ladder (fetch + fallback) time to settle
    assert_no_js_errors(page)
    # the voice label reflects whatever source actually played
    label = page.text_content("#dl-voice-label")
    assert label, "a voice-source label must be shown after pressing NGHE"


def test_listen_typo_shows_answer(page) -> None:
    """A misspelled attempt must show 'Chưa đúng' and reveal the correct sentence."""
    page.goto(f"{page.server_url}/listen?base=vi&target=en&topic=general")
    page.wait_for_selector(".concept-btn", timeout=15000)
    page.click(".concept-btn")
    page.wait_for_selector("#dl-input", timeout=20000)
    # reveal first to capture the sentence, then check a deliberate typo
    page.click("#dl-reveal")
    revealed = page.text_content("#dl-result .font-mono")
    typo = revealed[: max(3, len(revealed) // 2)] + "ZZZ"
    page.fill("#dl-input", typo)
    page.click("#dl-check")
    assert "Chưa đúng" in page.text_content("#dl-result")
    # grade it "hard" -> due tomorrow
    page.click("#dl-result .dl-g[data-g='hard']")
    assert_no_js_errors(page)


def test_session_advanced_drill_segment(page) -> None:
    """Phase D3: optional "Nâng cao" segment inside /session (en target): after
    the normal card queue, a listen-write drill runs; the summary shows
    "Luyện nghe–viết: x/y"."""
    page.goto(f"{page.server_url}/session?base=vi&target=en&cefr=A1&new=1")
    page.wait_for_selector("#overview >> text=Hôm nay của bạn", timeout=15000)
    page.check("#drills-toggle")
    page.click("#start-btn")
    # normal card first
    page.wait_for_function(
        """() => {
            const t = document.getElementById('card-target');
            return t && t.textContent && t.textContent !== '…';
        }"""
    )
    page.click("#flip-btn")
    grade(page, "Nhớ (7 ngày)")
    # advanced drill segment takes over the card area
    page.wait_for_selector("#card >> text=NÂNG CAO", timeout=20000)
    page.wait_for_selector("#dl-input", timeout=20000)
    page.click("#dl-reveal")
    answer = page.evaluate(
        """() => {
            const el = document.querySelector('#dl-result .font-mono');
            return el ? el.textContent : null;
        }"""
    )
    assert answer
    page.fill("#dl-input", answer)
    page.click("#dl-check")
    assert "Đúng!" in page.text_content("#dl-result")
    page.click("#dl-result .dl-g[data-g='good']")
    page.wait_for_selector("#summary:not(.hidden)", timeout=15000)
    assert "Luyện nghe–viết: 1/" in page.text_content("#summary-body")
    assert_no_js_errors(page)


def test_offline_grading_still_persists(page) -> None:
    # network failure must not block learning: state lands in localStorage.
    page.route("**/api/srs/**", lambda r: r.abort())
    page.route("**/api/sync/device", lambda r: r.abort())
    start_session(page, new=1)
    word = wait_card_loaded(page, 0)
    concept_id = page.evaluate("state.queue[state.idx].id")
    page.click("#flip-btn")
    grade(page, "Tạm (3 ngày)")
    page.wait_for_selector("#summary:not(.hidden)")
    entry = page.evaluate(
        """(cid) => {
            const s = JSON.parse(localStorage.getItem('dict_srs_v2_vi_ja') || '{}');
            return s[cid];
        }""",
        concept_id,
    )
    assert entry and entry["grade"] == "ok" and "due" in entry and "updated_at" in entry
    assert word  # sanity: the visible word was the graded card's target text
    assert_no_js_errors(page)


# ---------------------------------------------------------------------------

def test_screenshots_of_key_screens(page) -> None:
    """Visual snapshot for human review (not asserted; saved under out/e2e_shots/)."""
    shots = REPO / "out" / "e2e_shots"
    shots.mkdir(parents=True, exist_ok=True)
    page.goto(f"{page.server_url}/onboarding")
    page.screenshot(path=str(shots / "01_onboarding.png"))
    page.goto(f"{page.server_url}/learn?base=vi&target=ja&cefr=A1")
    page.wait_for_selector("#today-card:not(.hidden)")
    page.screenshot(path=str(shots / "02_learn_today_card.png"))
    page.goto(f"{page.server_url}/session?base=vi&target=ja&cefr=A1&new=3")
    page.wait_for_selector("#overview >> text=Hôm nay của bạn")
    page.screenshot(path=str(shots / "03_session_overview.png"))
    page.click("#start-btn")
    wait_card_loaded(page, 0)
    page.click("#flip-btn")
    page.wait_for_timeout(300)
    page.screenshot(path=str(shots / "04_session_player.png"))
    page.goto(f"{page.server_url}/placement?base=vi&target=ja")
    page.wait_for_selector("#quiz >> text=Câu 1/10")
    page.screenshot(path=str(shots / "05_placement_quiz.png"))
