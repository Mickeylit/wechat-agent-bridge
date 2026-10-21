#!/usr/bin/env python3
"""Copy the bundled bridge source into a separate runtime directory."""

from __future__ import annotations

import argparse
import errno
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile


TOP_LEVEL_FILES = ("cli.mjs", "package.json", "package-lock.json")
SOURCE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*\.mjs\Z")
IS_WINDOWS = os.name == "nt"


class PrepareError(Exception):
    """An actionable error that is safe to show without a traceback."""


def bundled_source() -> Path:
    return Path(__file__).resolve().parent.parent / "assets" / "bridge"


def is_link(path: Path) -> bool:
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        return True
    try:
        return bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)
    except FileNotFoundError:
        return False


def publish_directory(temporary: Path, destination: Path) -> None:
    """Publish without ever removing a nonempty destination directory."""
    try:
        os.replace(temporary, destination)
    except OSError as error:
        # Windows does not replace existing directories, even when empty. A
        # rmdir is an atomic emptiness check, so a concurrent writer is preserved.
        if not IS_WINDOWS or error.errno not in (errno.EACCES, errno.EPERM, errno.EEXIST, errno.ENOTEMPTY):
            raise
        if is_link(destination) or not destination.is_dir() or any(destination.iterdir()):
            raise PrepareError("The destination changed during preparation; nothing overwritten.") from error
        destination.rmdir()
        try:
            # On Windows rename also refuses a target that appeared meanwhile.
            os.rename(temporary, destination)
        except OSError:
            if not destination.exists() and not is_link(destination):
                destination.mkdir()
            raise


def next_commands(destination: str, *, windows: bool | None = None) -> list[str]:
    windows = IS_WINDOWS if windows is None else windows
    if windows:
        location = "Set-Location -LiteralPath '" + destination.replace("'", "''") + "'"
        install = "npm.cmd ci --ignore-scripts --no-audit --no-fund"
    else:
        location = f"cd -- {shlex.quote(destination)}"
        install = "npm ci --ignore-scripts --no-audit --no-fund"
    return [location, install, "node cli.mjs doctor", "node cli.mjs login --web --auto-start"]


def source_files(source: Path) -> list[Path]:
    """Return only known source files; never walk runtime or dependency trees."""
    if not source.is_dir() or is_link(source):
        raise PrepareError(f"Bundled bridge source is missing or invalid: {source}")
    files = []
    for name in TOP_LEVEL_FILES:
        candidate = source / name
        if is_link(candidate) or not candidate.is_file():
            raise PrepareError(f"Required source file is missing or invalid: {candidate}")
        files.append(Path(name))
    for directory in ("lib", "test"):
        folder = source / directory
        if is_link(folder):
            raise PrepareError(f"Source directories must not be symbolic links: {folder}")
        if not folder.exists():
            if directory == "lib":
                raise PrepareError(f"Required source directory is missing: {folder}")
            continue
        if not folder.is_dir():
            raise PrepareError(f"Source directory is invalid: {folder}")
        for candidate in sorted(folder.iterdir()):
            if not SOURCE_NAME.fullmatch(candidate.name):
                continue
            if is_link(candidate):
                raise PrepareError(f"Source files must not be symbolic links: {candidate}")
            if candidate.is_file():
                files.append(Path(directory) / candidate.name)
    if not any(file.parts[0] == "lib" for file in files):
        raise PrepareError("The bundled bridge has no lib/*.mjs source files.")
    return files


def validate_destination(destination: Path, source: Path) -> Path:
    if not destination.is_absolute():
        raise PrepareError("--dest must be an absolute path.")
    # Keep a runtime installation outside the entire skill, including scripts/.
    if is_link(destination):
        raise PrepareError("The destination must not be a symbolic link.")
    resolved = destination.resolve()
    skill_root = source.resolve().parent.parent
    if resolved == skill_root or skill_root in resolved.parents:
        raise PrepareError("The runtime destination must be outside the skill directory.")
    if destination.exists():
        if not destination.is_dir():
            raise PrepareError("The destination already exists and is not a directory.")
        if any(destination.iterdir()):
            raise PrepareError("The destination is not empty; existing files will not be overwritten.")
    if not destination.parent.is_dir():
        raise PrepareError("The destination's parent directory must already exist.")
    return resolved


def prepare(destination: Path, engine: str = "codex", *, dry_run: bool = False,
            source: Path | None = None) -> dict:
    """Stage an allowlisted deployment, then atomically publish it."""
    if engine not in ("codex", "claude"):
        raise PrepareError("The engine must be codex or claude.")
    source = source if source is not None else bundled_source()
    files = source_files(source)
    destination = validate_destination(destination, source)
    result = {
        "source": str(source.resolve()),
        "destination": str(destination),
        "engine": engine,
        "source_file_count": len(files),
        "generated_file_count": 1,
        "dry_run": dry_run,
    }
    if dry_run:
        return result

    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}.prepare-", dir=destination.parent))
    try:
        # POSIX uses restrictive staging permissions. Windows chmod does not set
        # an ACL; this stage contains source/config only, never credentials.
        for relative in files:
            target = temporary / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            # Recheck immediately before copying, including directory symlinks.
            candidate = source / relative
            if is_link(candidate) or is_link(candidate.parent) or not candidate.is_file():
                raise PrepareError(f"Source file changed during preparation: {candidate}")
            shutil.copyfile(candidate, target, follow_symlinks=False)
            target.chmod(0o644)
        config = temporary / "bridge.config.json"
        fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"engine": engine, "stateDir": "./.state"}, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        # A new directory or an existing empty directory can be replaced. If a
        # concurrent process fills the target, rename fails rather than deleting it.
        validate_destination(destination, source)
        publish_directory(temporary, destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", required=True, type=Path, metavar="ABS_PATH",
                        help="New or empty runtime directory, outside this skill")
    parser.add_argument("--engine", choices=("codex", "claude"), default="codex")
    parser.add_argument("--dry-run", action="store_true", help="Validate and show the plan without writing files")
    args = parser.parse_args(argv)
    try:
        result = prepare(args.dest, args.engine, dry_run=args.dry_run)
    except (PrepareError, OSError) as error:
        print(f"Preparation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not args.dry_run:
        print("\nNext commands (not executed):")
        for command in next_commands(result['destination']):
            print(command)
        if IS_WINDOWS:
            print("\nUse PowerShell. Credential-directory ACLs are applied by the bridge when it starts; chmod is not an ACL on Windows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
