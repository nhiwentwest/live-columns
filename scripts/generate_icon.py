#!/usr/bin/env python3
"""
Generate a simple two-column SVG icon for the Live Columns plugin.
Runs in-place and writes ../icon.svg
"""
from pathlib import Path

SVG = """<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" fill="none">
  <rect x="10" y="18" width="35" height="64" rx="6" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="4"/>
  <rect x="55" y="18" width="35" height="64" rx="6" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="4"/>
</svg>
"""


def main():
    out = Path(__file__).parent.parent / "icon.svg"
    out.write_text(SVG, encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
