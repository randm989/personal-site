#!/usr/bin/env python3
"""Rebuild the resume PDF from the source docx, with clickable links injected.

Why this script exists: LibreOffice's headless PDF export silently drops every
hyperlink, so the blue LinkedIn/GitHub/joshrutz.com text and the Zipix heading all
come out unclickable. We convert with LibreOffice and then re-inject the link
annotations ourselves. Run this after editing the resume docx.

Links injected (anchor word -> target):
  joshrutz.com -> https://joshrutz.com
  LinkedIn     -> https://www.linkedin.com/in/joshua-rutz-b0a52a1a
  GitHub       -> https://github.com/randm989
  Zipix        -> https://playzipix.app   (heading; override via argv[1])

Each anchor is matched at its FIRST occurrence on page 1, which is where all four
sit (the three contact links in the header, the Zipix company heading below).

Usage:
  python3 scripts/build-resume.py [zipix_url]
"""
import subprocess, sys, re, os, tempfile
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Link

DOCX = os.path.expanduser("~/Documents/Josh Rutz Resume.docx")
OUT  = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public", "Josh-Rutz-Resume.pdf"))
ZIPIX_URL = sys.argv[1] if len(sys.argv) > 1 else "https://playzipix.app"
PAGE_H = 792.0  # US Letter height in points; matches the docx MediaBox

# anchor word (exact pdftotext token) -> URL. First occurrence on page 1 wins.
LINKS = [
    ("joshrutz.com", "https://joshrutz.com"),
    ("LinkedIn",     "https://www.linkedin.com/in/joshua-rutz-b0a52a1a"),
    ("GitHub",       "https://github.com/randm989"),
    ("Zipix",        ZIPIX_URL),
]

with tempfile.TemporaryDirectory() as tmp:
    # 1. docx -> pdf (LibreOffice)
    subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", tmp, DOCX],
                   check=True, capture_output=True)
    pdf = os.path.join(tmp, "Josh Rutz Resume.pdf")

    # 2. word boxes on page 1 (pdftotext: top-left origin, points)
    bbox = subprocess.run(["pdftotext", "-bbox", "-f", "1", "-l", "1", pdf, "-"],
                          check=True, capture_output=True, text=True).stdout

    reader = PdfReader(pdf)
    writer = PdfWriter()
    writer.append(reader)

    for anchor, url in LINKS:
        m = re.search(
            r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">'
            + re.escape(anchor) + r'</word>', bbox)
        if not m:
            sys.exit(f"error: anchor '{anchor}' not found on PDF page 1")
        x0, y0_top, x1, y1_top = map(float, m.groups())
        rect = (x0, PAGE_H - y1_top, x1, PAGE_H - y0_top)  # flip y to PDF bottom-left origin
        writer.add_annotation(page_number=0, annotation=Link(rect=rect, url=url))
        print(f"  {anchor:13s} -> {url}")

    with open(OUT, "wb") as f:
        writer.write(f)

print(f"Resume rebuilt -> {OUT}  ({len(LINKS)} links)")
