#!/usr/bin/env python3
"""Builds THIRD-PARTY-LICENSES.txt: the full licence text of every Rust crate listed in THIRD-PARTY-NOTICES.md and of the npm
runtime packages (package.json "dependencies"), grouped by identical text with the list of packages under each text.

Python 3 standard library only. Needs `cargo` on PATH and the crate sources in the cargo registry
(run `cargo fetch --locked` in src-tauri first if they are missing) and `npm ci` done for node_modules.

    python3 scripts/gen-licenses.py

For a crate with several licence files (an `A OR B` expression usually ships one file per option) every file is kept.
Files read: LICENSE*, LICENCE*, COPYING*, UNLICENSE*, NOTICE*, COPYRIGHT* in the package root, files inside a root folder named
LICENSE(S)/LICENCE(S), and the file named by `license-file` in Cargo.toml.
"""
import json
import os
import re
import subprocess
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME_RX = re.compile(r"^(licen[sc]e|copying|unlicense|notice|copyright)([-_.].*)?$", re.I)
DIR_RX = re.compile(r"^licen[sc]es?$", re.I)
OUT = os.path.join(ROOT, "THIRD-PARTY-LICENSES.txt")


def read_text(path):
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in text.strip("\n").split("\n"))


def license_files(pkg_dir, extra=None):
    """Relative paths of the licence files of one package, sorted."""
    found = set()
    for entry in sorted(os.listdir(pkg_dir)):
        full = os.path.join(pkg_dir, entry)
        if os.path.isfile(full) and NAME_RX.match(entry):
            found.add(entry)
        elif os.path.isdir(full) and DIR_RX.match(entry):
            for dp, _, fns in os.walk(full):
                for fn in sorted(fns):
                    found.add(os.path.relpath(os.path.join(dp, fn), pkg_dir))
    if extra and os.path.isfile(os.path.join(pkg_dir, extra)):
        found.add(os.path.normpath(extra))
    return sorted(found)


def notice_crates():
    """(name, version) rows of the Rust crate table in THIRD-PARTY-NOTICES.md."""
    rows = []
    in_rust = False
    for line in open(os.path.join(ROOT, "THIRD-PARTY-NOTICES.md"), encoding="utf-8"):
        if line.startswith("## "):
            in_rust = line.startswith("## Rust crates")
        elif in_rust:
            m = re.match(r"^\| ([^|\s]+) \| (\d[^|\s]*) \| ", line)
            if m:
                rows.append((m.group(1), m.group(2)))
    return rows


def main():
    meta = json.loads(
        subprocess.check_output(
            ["cargo", "metadata", "--locked", "--format-version", "1"],
            cwd=os.path.join(ROOT, "src-tauri"),
        )
    )
    by_key = {(p["name"], p["version"]): p for p in meta["packages"]}
    texts = defaultdict(set)  # text -> {"name version", ...}
    without = []
    problems = []

    rows = notice_crates()
    if not rows:
        sys.exit("no crate rows found in THIRD-PARTY-NOTICES.md")
    for key in sorted(set(rows)):
        label = f"{key[0]} {key[1]} (Rust crate)"
        pkg = by_key.get(key)
        if pkg is None:
            problems.append(f"{label}: not in cargo metadata")
            continue
        pkg_dir = os.path.dirname(pkg["manifest_path"])
        if not os.path.isdir(pkg_dir):
            problems.append(f"{label}: source folder missing ({pkg_dir}); run cargo fetch --locked")
            continue
        files = license_files(pkg_dir, pkg.get("license_file"))
        if not files:
            without.append((label, pkg.get("license") or "no licence expression"))
            continue
        for rel in files:
            text = read_text(os.path.join(pkg_dir, rel))
            if text:
                texts[text].add(label)

    pj = json.load(open(os.path.join(ROOT, "package.json"), encoding="utf-8"))
    for name in sorted(pj.get("dependencies", {})):
        pkg_dir = os.path.join(ROOT, "node_modules", *name.split("/"))
        if not os.path.isdir(pkg_dir):
            problems.append(f"{name}: not in node_modules; run npm ci")
            continue
        version = json.load(open(os.path.join(pkg_dir, "package.json"), encoding="utf-8"))["version"]
        label = f"{name} {version} (npm package)"
        files = license_files(pkg_dir)
        if not files:
            without.append((label, "no licence file in the package"))
            continue
        for rel in files:
            text = read_text(os.path.join(pkg_dir, rel))
            if text:
                texts[text].add(label)

    if problems:
        sys.exit("cannot build the licence file:\n  " + "\n  ".join(problems))

    bar = "=" * 78
    out = [
        "THIRD-PARTY LICENCES for Usage Bar",
        "",
        "Full licence texts of the Rust crates listed in THIRD-PARTY-NOTICES.md and of the npm packages bundled into the app window.",
        "Packages whose texts are identical are grouped; the packages are listed above each text. A package offered under",
        "'A OR B' appears under each of its licence files. Generated by scripts/gen-licenses.py; do not edit by hand.",
        "",
        f"{len(texts)} distinct texts, {len({l for s in texts.values() for l in s})} packages.",
        "",
    ]
    # most widely shared texts first, then by first package name, so the file is stable
    for text, pkgs in sorted(texts.items(), key=lambda kv: (-len(kv[1]), sorted(kv[1])[0], kv[0])):
        out += [bar, f"Used by {len(pkgs)} package(s):"]
        out += ["  " + p for p in sorted(pkgs)]
        out += [bar, "", text, "", ""]
    if without:
        out += [bar, "Packages that ship no licence file in their package (see the licence they declare):"]
        out += [f"  {l}: {d}" for l, d in sorted(without)]
        out += [""]
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out))
    print(f"wrote {OUT}: {len(texts)} texts, {len(without)} packages without a licence file")
    for l, d in sorted(without):
        print("  no licence file:", l, "-", d)


if __name__ == "__main__":
    main()
