#!/usr/bin/env python3
"""
Extract TOEIC LC questions (Part 1 photos + Part 3 & 4 questions) for all 10 tests.

Uses combined PDF: resources/ETS2026/LISTENING ETS 2026 .pdf
Each test occupies 14 pages; test N starts at page offset (N-1)*14.

Outputs per test N:
  data/questions-lc-testN.json
  data/images/lc-testN/part1/q{1-6}.jpg
  data/images/lc-testN/graphics/q{n}.png   (for "Look at the graphic" questions)

Usage:
  python3 extract_lc_questions.py          # all 10 tests
  python3 extract_lc_questions.py 1        # test 1 only
  python3 extract_lc_questions.py 2 3 4    # tests 2, 3, 4
"""

import re
import json
import subprocess
import sys
from pathlib import Path

try:
    import fitz
except ImportError:
    sys.exit("pip install pymupdf")

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

COMBINED_PDF = Path("resources/ETS2026/LISTENING ETS 2026 .pdf")
TEST_PAGE_STRIDE = 14  # pages per test in combined PDF

# Relative pages (from test start) that always need column split because
# they contain graphic tables that confuse tesseract's column detection.
REL_ALWAYS_SPLIT = {9, 10, 13}

# Relative page numbers (1-indexed from test start) → question ranges
REL_PAGE_Q = {
    7:  (32, 43),
    8:  (44, 55),
    9:  (56, 64),
    10: (65, 70),
    11: (71, 82),
    12: (83, 94),
    13: (95, 100),
}

# Relative page → (q_top, q_bottom) for Part 1 photos
REL_PART1 = {3: (1, 2), 4: (3, 4), 5: (5, 6)}

REL_DIR_PAGES = {"part1": 2, "part2": 6, "part3": 7, "part4": 11}

PART_RANGES = {3: (32, 70), 4: (71, 100)}

STOP_PATTERNS = re.compile(
    r"^(GO ON|TEST \d|PART \d|Directions:|Page \d+|^\d{1,3}$|"
    r"In the Listening test)"
)


# ── OCR ──────────────────────────────────────────────────────────────────────

def ocr_page(doc, pdf_page, test_num, clip=None, psm=3):
    page = doc[pdf_page - 1]
    pix = page.get_pixmap(matrix=fitz.Matrix(3.0, 3.0), clip=clip)
    suffix = f"_x{int(clip.x0)}" if clip else ""
    img = f"_toeic_t{test_num}_p{pdf_page}{suffix}.png"
    pix.save(f"/tmp/{img}")
    r = subprocess.run(
        ["tesseract", img, "stdout", "-l", "eng", "--psm", str(psm)],
        capture_output=True, text=True, cwd="/tmp",
    )
    return r.stdout


# ── Parsing ──────────────────────────────────────────────────────────────────

def clean(s):
    return " ".join(s.split())


_ARTICLE_MERGE_RE = re.compile(
    r"\bA(new|grand|community|trade|real|culinary|winter|conference|"
    r"fund|sports|city|national|fitness|promotional|cultural|local|"
    r"dental|medical|legal|survey|bakery|garden|studio|hotel|resort|"
    r"presentation|seminar|workshop|vendor|colleague|customer|supervisor)\b",
    re.IGNORECASE,
)


def fix_ocr(text):
    text = re.sub(r"^[^A-Za-z]+(?=[A-Za-z])", "", text)
    text = text.replace("Ata ", "At a ")
    text = _ARTICLE_MERGE_RE.sub(r"A \1", text)
    return text


def extract_bodies(text):
    lines = [l.rstrip() for l in text.split("\n")]
    n = len(lines)
    results = []
    i = 0
    while i < n:
        if not re.match(r"^\(A\)\s*\S", lines[i].strip()):
            i += 1
            continue
        qnum = None
        q_parts = []
        k = i - 1
        consec_blanks = 0
        while k >= 0:
            l = lines[k].strip()
            if not l:
                consec_blanks += 1
                if q_parts and consec_blanks >= 2:
                    break
                k -= 1
                continue
            consec_blanks = 0
            if STOP_PATTERNS.match(l):
                break
            if re.match(r"^\(D\)", l):
                break
            m = re.match(r"^(\d{1,3})\.\s+(.+)$", l)
            if m:
                qnum = int(m.group(1))
                q_parts.insert(0, m.group(2))
                break
            if re.match(r"^(\d{1,3})\.\s*$", l):
                if q_parts:
                    break   # classic orphan: we already have body text above
                else:
                    k -= 1  # skip interleaved orphan, keep scanning back
                    continue
            q_parts.insert(0, l)
            k -= 1
        q_text = clean(" ".join(q_parts))
        if not q_text:
            i += 1
            continue
        choices = {}
        j = i
        for letter in "ABCD":
            while j < n and not re.match(rf"^\({letter}\)", lines[j].strip()):
                if re.match(r"^\d{1,3}\.", lines[j].strip()) and j > i:
                    break
                j += 1
            if j >= n:
                break
            parts = [re.sub(r"^\([A-D]\)\s*", "", lines[j].strip())]
            j += 1
            while j < n:
                nl = lines[j].strip()
                if not nl or re.match(r"^\([A-D]\)", nl) or re.match(r"^\d{1,3}\.", nl):
                    break
                parts.append(nl)
                j += 1
            choices[letter] = clean(" ".join(parts))
        if len(choices) == 4:
            results.append((qnum, q_text, choices))
            i = j
        else:
            i += 1
    return results


def parse_text(text, q_start, q_end, pdf_page):
    bodies = extract_bodies(text)
    numbered = {}
    unnumbered = []
    for qnum, q_text, choices in bodies:
        if qnum is not None and q_start <= qnum <= q_end:
            numbered[qnum] = (q_text, choices)
        else:
            unnumbered.append((q_text, choices))
    missing = [q for q in range(q_start, q_end + 1) if q not in numbered]
    for idx, (q_text, choices) in enumerate(unnumbered):
        if idx < len(missing):
            numbered[missing[idx]] = (q_text, choices)
    return {qnum: _make_q(qnum, *v, pdf_page) for qnum, v in numbered.items()}


def _make_q(qnum, q_text, choices, pdf_page):
    q_text = fix_ocr(q_text)
    choices = {k: fix_ocr(v) for k, v in choices.items()}
    has_graphic = bool(re.search(
        r"look at the (graphic|chart|table|schedule|map|floor plan)",
        q_text, re.IGNORECASE,
    ))
    part = next(p for p, (s, e) in PART_RANGES.items() if s <= qnum <= e)
    return {
        "part": part,
        "text": q_text,
        "choices": choices,
        "hasGraphic": has_graphic,
        "pdfPage": pdf_page,
    }


# ── Auto-split detection ──────────────────────────────────────────────────────

def parse_page_auto(doc, pdf_page, test_num, page_q_map, offset):
    """OCR page; use column split for graphic-heavy pages, auto-retry if short."""
    q_start, q_end = page_q_map[pdf_page]
    expected = q_end - q_start + 1
    rel_page = pdf_page - offset

    # Always split pages known to have graphic tables
    force_split = rel_page in REL_ALWAYS_SPLIT

    if not force_split:
        text = ocr_page(doc, pdf_page, test_num)
        questions = parse_text(text, q_start, q_end, pdf_page)
        if len(questions) == expected:
            print(f"  p{pdf_page} Q{q_start}–{q_end}: ✓")
            return questions, None

    # Column split: 9-q pages → 6+3, others → half+half
    total = q_end - q_start + 1
    mid_q = q_start + (6 if total == 9 else total // 2)
    l_range = (q_start, mid_q - 1)
    r_range = (mid_q, q_end)

    page = doc[pdf_page - 1]
    w, h = page.rect.width, page.rect.height
    mid = w / 2
    left_clip  = fitz.Rect(0,       15, mid - 5, h - 5)
    right_clip = fitz.Rect(mid + 5, 15, w,       h - 5)
    lt = ocr_page(doc, pdf_page, test_num, clip=left_clip,  psm=4)
    rt = ocr_page(doc, pdf_page, test_num, clip=right_clip, psm=4)
    questions = {
        **parse_text(lt, l_range[0], l_range[1], pdf_page),
        **parse_text(rt, r_range[0], r_range[1], pdf_page),
    }
    split_ranges = (l_range, r_range)

    found = len(questions)
    expected_total = q_end - q_start + 1
    status = "✓" if found == expected_total else f"⚠ {found}/{expected_total}"
    print(f"  p{pdf_page} Q{q_start}–{q_end}: {status} [split {l_range}+{r_range}]")
    return questions, split_ranges


# ── Directions ────────────────────────────────────────────────────────────────

def extract_direction(doc, pdf_page, test_num):
    text = ocr_page(doc, pdf_page, test_num)
    m = re.search(r"Directions:\s*(.*?)(?=\n\s*\n\d{1,3}\.|$)", text, re.DOTALL)
    return clean(m.group(1)) if m else ""


# ── Part 1 split detection ────────────────────────────────────────────────────

def find_part1_split(doc, pdf_page):
    """Find y-fraction of white gap between the two Part 1 photos on a page."""
    if not HAS_NUMPY:
        return 0.50
    page = doc[pdf_page - 1]
    pix = page.get_pixmap(matrix=fitz.Matrix(1.0, 1.0))
    h_px = pix.height
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(h_px, pix.width, pix.n)[:, :, :3]
    y0, y1 = int(h_px * 0.35), int(h_px * 0.62)
    strip = img[y0:y1, int(pix.width * 0.15):int(pix.width * 0.85)]
    row_mean = strip.mean(axis=(1, 2))
    for i, m in enumerate(row_mean):
        if m > 245:
            return (y0 + i + 5) / h_px
    return 0.50


# ── Image extraction ──────────────────────────────────────────────────────────

def extract_part1_images(doc, part1_pages, test_num, img_dir):
    d = img_dir / "part1"
    d.mkdir(parents=True, exist_ok=True)
    results = {}
    for pdf_page, (q_top, q_bot) in part1_pages.items():
        sp = find_part1_split(doc, pdf_page)
        page = doc[pdf_page - 1]
        w, h = page.rect.width, page.rect.height
        for qnum, (y0, y1) in [(q_top, (0, h * sp)), (q_bot, (h * sp, h * 0.97))]:
            clip = fitz.Rect(0, y0, w, y1)
            pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), clip=clip)
            out = d / f"q{qnum}.jpg"
            pix.save(str(out))
            results[qnum] = f"data/images/lc-test{test_num}/part1/q{qnum}.jpg"
    return results


def extract_graphic_images(doc, questions, split_pages_info, page_q_map, test_num, img_dir):
    d = img_dir / "graphics"
    d.mkdir(parents=True, exist_ok=True)
    results = {}
    for qnum, q in questions.items():
        if not q.get("hasGraphic"):
            continue
        pdf_page = q["pdfPage"]
        if pdf_page in split_pages_info:
            (l_start, l_end), _ = split_pages_info[pdf_page]
            col = "left" if l_start <= qnum <= l_end else "right"
        else:
            q_start, q_end = page_q_map[pdf_page]
            mid_q = q_start + (q_end - q_start + 1) // 2
            col = "left" if qnum < mid_q else "right"
        page = doc[pdf_page - 1]
        w, h = page.rect.width, page.rect.height
        mid = w / 2
        x0 = 5       if col == "left" else mid + 5
        x1 = mid - 5 if col == "left" else w - 5
        clip = fitz.Rect(x0, 15, x1, h * 0.52)
        pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), clip=clip)
        out = d / f"q{qnum}.png"
        pix.save(str(out))
        results[qnum] = f"data/images/lc-test{test_num}/graphics/q{qnum}.png"
        print(f"    graphic Q{qnum} ({col}, p{pdf_page})")
    return results


# ── Main per-test extraction ──────────────────────────────────────────────────

def extract_test(doc, test_num):
    offset = (test_num - 1) * TEST_PAGE_STRIDE
    page_q_map  = {k + offset: v for k, v in REL_PAGE_Q.items()}
    part1_pages = {k + offset: v for k, v in REL_PART1.items()}
    dir_pages   = {k: v + offset for k, v in REL_DIR_PAGES.items()}

    img_dir  = Path(f"data/images/lc-test{test_num}")
    out_json = Path(f"data/questions-lc-test{test_num}.json")

    print(f"\n── Test {test_num} (page offset +{offset}) ──")

    # Directions
    directions = {}
    for key, pdf_page in dir_pages.items():
        if key in ("part1", "part2"):
            d = extract_direction(doc, pdf_page, test_num)
            directions[key] = d

    # Part 3 & 4 questions
    all_questions = {}
    split_pages_info = {}
    for pdf_page in sorted(page_q_map):
        qs, split_ranges = parse_page_auto(doc, pdf_page, test_num, page_q_map, offset)
        all_questions.update(qs)
        if split_ranges:
            split_pages_info[pdf_page] = split_ranges
        for key, dpage in dir_pages.items():
            if dpage == pdf_page and key in ("part3", "part4"):
                img_name = f"_toeic_t{test_num}_p{pdf_page}.png"
                t = subprocess.run(
                    ["tesseract", img_name, "stdout", "-l", "eng", "--psm", "3"],
                    capture_output=True, text=True, cwd="/tmp",
                ).stdout
                m = re.search(r"Directions:\s*(.*?)(?=\n\s*\n\d{1,3}\.|$)", t, re.DOTALL)
                if m:
                    directions[key] = clean(m.group(1))

    # Part 1 images
    part1_imgs = extract_part1_images(doc, part1_pages, test_num, img_dir)

    # Graphic images
    graphic_paths = extract_graphic_images(
        doc, all_questions, split_pages_info, page_q_map, test_num, img_dir
    )
    for qnum, path in graphic_paths.items():
        if qnum in all_questions:
            all_questions[qnum]["graphicImagePath"] = path

    # Build output
    part1_entries = {qnum: {"part": 1, "imagePath": path}
                     for qnum, path in sorted(part1_imgs.items())}
    all_output = {**part1_entries, **{k: all_questions[k] for k in sorted(all_questions)}}

    result = {
        "test": f"ets2026-t{test_num:02d}",
        "directions": directions,
        "questions": {str(k): all_output[k] for k in sorted(all_output)},
    }
    out_json.write_text(json.dumps(result, indent=2, ensure_ascii=False))

    found = len(all_questions)
    missing = sorted(set(range(32, 101)) - set(all_questions))
    graphics = sorted(graphic_paths)
    print(f"  → {found}/69 questions, {len(part1_imgs)}/6 Part1 imgs, {len(graphics)} graphics")
    if missing:
        print(f"  ⚠ missing: {missing}")
    print(f"  → {out_json}")
    return found


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    tests = [int(a) for a in sys.argv[1:]] if sys.argv[1:] else range(1, 11)
    doc = fitz.open(str(COMBINED_PDF))
    print(f"Combined PDF: {len(doc)} pages, extracting tests {list(tests)}")
    Path("data").mkdir(exist_ok=True)
    for t in tests:
        extract_test(doc, t)
    print("\nDone.")


if __name__ == "__main__":
    main()
