#!/usr/bin/env python3
"""Generate a reproducible, public retrofit-cost page from one audited Git delta."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any


CATEGORY_ORDER = ("production", "test", "spike")
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def _git(repo_root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update({"LC_ALL": "C", "LANG": "C"})
    return subprocess.run(
        ["git", "-C", str(repo_root), *args],
        check=check,
        capture_output=True,
        text=True,
        env=env,
    )


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load_config(config_path: Path, repo_root: Path) -> dict[str, Any]:
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    _require(isinstance(config, dict), "config must be an object")
    required = {
        "pinned_base",
        "public_head",
        "categories",
        "observed_wall_clock",
        "word_limit",
        "repository_url",
        "live_url",
    }
    _require(set(config) == required, "config keys do not match the public contract")

    base = config["pinned_base"]
    head = config["public_head"]
    _require(isinstance(base, str) and SHA_PATTERN.fullmatch(base) is not None, "invalid pinned base")
    _require(isinstance(head, str) and SHA_PATTERN.fullmatch(head) is not None, "invalid public head")
    for name, value in (("pinned base", base), ("public head", head)):
        resolved = _git(repo_root, "rev-parse", f"{value}^{{commit}}").stdout.strip()
        _require(resolved == value, f"{name} is not the exact local commit")
    _require(
        _git(repo_root, "merge-base", "--is-ancestor", base, head, check=False).returncode == 0,
        "pinned base is not an ancestor of public head",
    )
    _require(
        _git(repo_root, "merge-base", "--is-ancestor", head, "HEAD", check=False).returncode == 0,
        "public head is not in the checked-out history",
    )

    categories = config["categories"]
    _require(isinstance(categories, dict), "categories must be an object")
    _require(tuple(categories) == CATEGORY_ORDER, "categories must use canonical order")
    seen: set[str] = set()
    for category in CATEGORY_ORDER:
        paths = categories[category]
        _require(isinstance(paths, list) and paths, f"{category} must be a non-empty list")
        for path in paths:
            _require(isinstance(path, str) and path, "category path must be text")
            posix = PurePosixPath(path)
            _require(not posix.is_absolute() and ".." not in posix.parts, f"unsafe path: {path}")
            _require(path not in seen, f"path appears in more than one category: {path}")
            seen.add(path)

    clock = config["observed_wall_clock"]
    _require(
        isinstance(clock, dict) and set(clock) == {"start", "end", "minutes", "label"},
        "invalid observed clock",
    )
    start = datetime.fromisoformat(clock["start"])
    end = datetime.fromisoformat(clock["end"])
    _require(start.tzinfo is not None and end.tzinfo is not None, "clock must include offsets")
    elapsed_seconds = (end - start).total_seconds()
    _require(elapsed_seconds > 0 and elapsed_seconds % 60 == 0, "clock must be positive whole minutes")
    _require(clock["minutes"] == int(elapsed_seconds // 60), "recorded minutes do not match clock")
    _require(clock["label"] == "agent-assisted elapsed time", "clock label must stay qualified")

    _require(isinstance(config["word_limit"], int) and config["word_limit"] > 0, "invalid word limit")
    _require(config["repository_url"] == "https://github.com/hungson175/excalidraw-webmcp", "unexpected repository URL")
    _require(config["live_url"] == "https://hungson175.github.io/excalidraw-webmcp/", "unexpected live URL")
    return config


def collect_snapshot(repo_root: Path, config: dict[str, Any]) -> dict[str, Any]:
    result = _git(
        repo_root,
        "diff",
        "--numstat",
        "--no-renames",
        f"{config['pinned_base']}..{config['public_head']}",
        "--",
    )
    rows = []
    for raw_line in result.stdout.splitlines():
        parts = raw_line.split("\t")
        _require(len(parts) == 3, f"malformed numstat line: {raw_line}")
        added_text, deleted_text, path = parts
        _require(added_text.isdigit() and deleted_text.isdigit(), f"binary delta is unsupported: {path}")
        rows.append({"path": path, "added": int(added_text), "deleted": int(deleted_text)})
    rows.sort(key=lambda row: row["path"])

    category_by_path = {
        path: category
        for category in CATEGORY_ORDER
        for path in config["categories"][category]
    }
    diff_paths = {row["path"] for row in rows}
    declared_paths = set(category_by_path)
    unknown = sorted(diff_paths - declared_paths)
    missing = sorted(declared_paths - diff_paths)
    _require(not unknown, f"unclassified product paths: {', '.join(unknown)}")
    _require(not missing, f"declared paths absent from product delta: {', '.join(missing)}")

    categories = {
        category: {"files": 0, "added": 0, "deleted": 0}
        for category in CATEGORY_ORDER
    }
    for row in rows:
        row["category"] = category_by_path[row["path"]]
        subtotal = categories[row["category"]]
        subtotal["files"] += 1
        subtotal["added"] += row["added"]
        subtotal["deleted"] += row["deleted"]
    total = {
        key: sum(category[key] for category in categories.values())
        for key in ("files", "added", "deleted")
    }
    _require(total["files"] == len(rows), "category file total mismatch")
    return {"rows": rows, "categories": categories, "total": total}


def _render(config: dict[str, Any], snapshot: dict[str, Any]) -> str:
    base = config["pinned_base"]
    head = config["public_head"]
    clock = config["observed_wall_clock"]
    compare_url = f"{config['repository_url']}/compare/{base}...{head}"
    lines = [
        "# What it cost to retrofit WebMCP onto Excalidraw",
        "",
        "This is a measured retrofit of the existing MIT-licensed Excalidraw app, not a new canvas built for a demo. The normal editor remains usable; WebMCP adds a page-owned tool surface for exact scene operations while a person keeps control of the final write.",
        "",
        f"**[Open the live retrofit]({config['live_url']}) · [Inspect the exact product diff]({compare_url})**",
        "",
        "## Measured cost",
        "",
        f"The interval from assignment at 08:51 to independent public closure at 10:18 was **{clock['minutes']} minutes of {clock['label']}**. It includes the host spike, tests-first implementation, pair review, deploy, and two different public browser gates. It is not a claim about human engineer-hours, dollars, or causal speed.",
        "",
        f"Pinned snapshot: upstream `{base[:8]}` → audited public product `{head[:8]}`. The documentation generator is outside that snapshot, so the numbers do not count themselves.",
        "",
        "| Slice      |  Files |    Added | Deleted |",
        "| ---------- | -----: | -------: | ------: |",
    ]
    labels = {"production": "Product", "test": "Tests", "spike": "Host spike"}
    for category in CATEGORY_ORDER:
        subtotal = snapshot["categories"][category]
        lines.append(
            f"| {labels[category]:<10} | {subtotal['files']:>6} | "
            f"{subtotal['added']:>8} | {subtotal['deleted']:>7} |"
        )
    total = snapshot["total"]
    lines.extend(
        [
            f"| **Total**  | **{total['files']}** | **{total['added']}** |   **{total['deleted']}** |",
            "",
            "<details><summary>All measured paths</summary>",
            "",
            "| Path | Slice | + | − |",
            "| --- | --- | --: | --: |",
        ]
    )
    for row in snapshot["rows"]:
        lines.append(
            f"| `{row['path']}` | {labels[row['category']]} | {row['added']} | {row['deleted']} |"
        )
    lines.extend(
        [
            "",
            "</details>",
            "",
            "## What changed",
            "",
            "- **Eight host-facing product files.** The app mount changed by two lines, the Origin Trial tag added four, and the static-host base added two. The rest is an isolated panel, typed registry, adapter, and controller under `excalidraw-app/webmcp/`.",
            "- **Four composable tools.** `select_shapes` feeds `align_shapes`, `equalize_size`, and `connect_shapes`. Later calls read the pending projection, not stale canonical geometry.",
            "- **Public host seams only.** The retrofit uses `ExcalidrawImperativeAPI`, one exported `convertToExcalidrawElements` call for the complete binding graph, and `updateScene` as a storage boundary. It does not mutate an undocumented scene store.",
            "- **Progressive browser registration.** Unsupported browsers retain normal Excalidraw and register nothing. An owned `AbortSignal` prevents a partial or stale tool lifetime.",
            "",
            "## The safety boundary is visible",
            "",
            "Agent changes render as amber `UNCOMMITTED` ghosts while the saved scene stays unchanged. Duplicate or stale connector work refuses with `unsafe_retry`; cancellation leaves no delta. There is deliberately no commit tool. Only a trusted click on **Commit layout** atomically applies replacements and additions; Discard removes the proposal.",
            "",
            "## Public proof",
            "",
            "In stock Chrome 154 with no WebMCP flags or injection, the live page exposed exactly four tools. One gate composed six rectangles into six bound arrows while the scene stayed at seven elements until a trusted click changed it to thirteen. A separate independent gate used four rectangles and one diamond, refused a duplicate, and changed five elements to nine. Both fresh second profiles were empty and both runs recorded zero console, page, or request errors.",
            "",
            "- `browser_api=PASS`",
            "- `native_agent_invocation=UNPROVEN`",
            "",
            "## Why this belongs in the page, not an extension",
            "",
            "An extension could reach undocumented app internals in the main world, but it would break with host releases and need a different extension for every app. This retrofit is shipped by the page against explicit seams—the friction a shared browser standard is meant to remove.",
            "",
            "## Reproduce this page",
            "",
            "```bash",
            "python3 artifacts/retrofit-cost-ledger/generate_retrofit_md.py --config artifacts/retrofit-cost-ledger/config.json --output RETROFIT.md --check",
            "```",
            "",
            "The command uses only Python's standard library and the pinned local Git commits.",
        ]
    )
    return "\n".join(lines) + "\n"


def generate_report(repo_root: Path, config_path: Path) -> str:
    config = load_config(config_path, repo_root)
    snapshot = collect_snapshot(repo_root, config)
    report = _render(config, snapshot)
    _require(len(report.split()) <= config["word_limit"], "generated report exceeds word limit")
    return report


def write_report(repo_root: Path, config_path: Path, output_path: Path) -> str:
    report = generate_report(repo_root, config_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=output_path.parent,
        prefix=f".{output_path.name}.",
        delete=False,
    ) as handle:
        handle.write(report)
        temp_path = Path(handle.name)
    temp_path.replace(output_path)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    repo_root = Path(__file__).resolve().parents[2]
    try:
        report = generate_report(repo_root, args.config)
        if args.check:
            _require(args.output.is_file(), "checked output is absent")
            _require(args.output.read_text(encoding="utf-8") == report, "checked output is stale")
            status = "PASS"
        else:
            write_report(repo_root, args.config, args.output)
            status = "WRITTEN"
        snapshot = collect_snapshot(repo_root, load_config(args.config, repo_root))
        print(
            f"RETROFIT_REPORT={status} words={len(report.split())} "
            f"files={snapshot['total']['files']} additions={snapshot['total']['added']}"
        )
        return 0
    except (OSError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"RETROFIT_REPORT=FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
