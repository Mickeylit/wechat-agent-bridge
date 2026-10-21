#!/usr/bin/env python3
"""Install or update this skill without starting models, pairing, or services."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
import uuid

NAME = 'wechat-agent-bridge'


class InstallResult(list):
    """Keep the original list return API while exposing recoverable backups."""
    def __init__(self, destinations, backups=None):
        super().__init__(destinations)
        self.backups = backups or {}


def _is_link(path):
    if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
        return True
    try:
        return bool(getattr(path.lstat(), 'st_file_attributes', 0) & 0x400)
    except FileNotFoundError:
        return False


def _identity(path):
    info = path.lstat()
    return info.st_dev, info.st_ino


def _device(path):
    """Read the device of the closest existing ancestor without creating paths."""
    while not path.exists():
        path = path.parent
    return path.stat().st_dev


def _recovery_root(target, source=None, create=False):
    """Keep backups/staging outside the directory scanned for installed skills."""
    skills_root = target.parent
    recovery = skills_root.parent / '.skill-backups'
    if recovery == skills_root or skills_root in recovery.parents:
        raise ValueError(f'Cannot place backups outside the skills directory: {skills_root}')
    if source and (recovery == source or source in recovery.parents):
        raise ValueError('The backup directory must be outside the source skill.')
    for item in (recovery, *recovery.parents):
        if _is_link(item):
            raise ValueError(f'Backup paths must not contain symbolic links or reparse points: {item}')
    if recovery.exists() and not recovery.is_dir():
        raise ValueError(f'Backup path is not a directory: {recovery}')
    if _device(recovery) != _device(skills_root):
        raise ValueError('The sibling .skill-backups directory must be on the same volume as the skills directory.')
    if create:
        recovery.mkdir(mode=0o700, parents=True, exist_ok=True)
        if _is_link(recovery) or _device(recovery) != _device(skills_root):
            raise ValueError('The backup directory changed or is not on the same volume.')
    return recovery


def _validate_skill(root):
    skill = root / 'SKILL.md'
    if _is_link(root) or _is_link(skill) or not root.is_dir() or not skill.is_file():
        raise ValueError(f'Skill directory and SKILL.md must be real files, not symbolic links: {root}')
    lines = skill.read_text(encoding='utf-8-sig').splitlines()
    if not lines or lines[0].strip() != '---':
        raise ValueError(f'SKILL.md must declare name: {NAME}: {root}')
    try:
        end = next(index for index, line in enumerate(lines[1:], 1) if line.strip() == '---')
    except StopIteration:
        raise ValueError(f'SKILL.md has incomplete frontmatter: {root}') from None
    names = [line for line in lines[1:end] if re.match(r'^name\s*:', line)]
    expected = rf'name\s*:\s*(?:{NAME}|"{NAME}"|\'{NAME}\')\s*(?:#.*)?'
    if len(names) != 1 or not re.fullmatch(expected, names[0]):
        raise ValueError(f'Refusing a skill with a different or missing name; expected {NAME}: {root}')


def _source_files(source):
    """Only known source locations; arbitrary extensions elsewhere are not enough."""
    files = [Path('SKILL.md')]
    if (source / 'README.md').is_file() or _is_link(source / 'README.md'):
        files.append(Path('README.md'))
    layouts = [
        ('scripts', '.py'), ('scripts', '.ps1'), ('references', '.md'), ('agents', '.yaml'),
        ('assets/bridge/lib', '.mjs'), ('assets/bridge/test', '.mjs'),
    ]
    for directory, suffix in layouts:
        folder = source / directory
        for ancestor in [folder, *folder.parents]:
            if ancestor == source:
                break
            if _is_link(ancestor):
                raise ValueError(f'Symbolic links are not packaged: {ancestor}')
        if not folder.exists():
            continue
        if not folder.is_dir():
            raise ValueError(f'Invalid source directory: {folder}')
        for candidate in sorted(folder.iterdir()):
            if candidate.name.startswith('.') or candidate.suffix != suffix:
                continue
            if _is_link(candidate):
                raise ValueError(f'Symbolic links are not packaged: {candidate}')
            if candidate.is_file():
                files.append(candidate.relative_to(source))
    for name in ('cli.mjs', 'package.json', 'package-lock.json'):
        candidate = source / 'assets' / 'bridge' / name
        if candidate.exists() or _is_link(candidate):
            files.append(candidate.relative_to(source))
    for relative in files:
        candidate = source / relative
        if _is_link(candidate) or not candidate.is_file():
            raise ValueError(f'Invalid source file: {relative}')
    return sorted(set(files))


def _validate_existing(target):
    _validate_skill(target)
    # Moving an old installation must not move linked external state or skills.
    for folder, directories, files in os.walk(target, followlinks=False):
        for name in directories + files:
            candidate = Path(folder) / name
            if _is_link(candidate):
                raise ValueError(f'Refusing to update an installation containing symbolic links: {candidate}')


def _signature(root):
    signature = []
    for item in sorted(root.rglob('*')):
        if _is_link(item):
            return None
        if item.is_file():
            signature.append((item.relative_to(root).as_posix(), hashlib.sha256(item.read_bytes()).hexdigest()))
    return signature


def _copy_source(source, files, staging):
    for relative in files:
        item = source / relative
        if _is_link(item) or not item.is_file():
            raise ValueError(f'Source file changed during installation: {relative}')
        output = staging / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item, output, follow_symlinks=False)
        output.chmod(0o644)


def _restore(entries):
    problems = []
    for entry in reversed(entries):
        target, backup = entry['target'], entry.get('backup')
        try:
            if entry.get('published'):
                if not target.exists() or _is_link(target) or _identity(target) != entry['published']:
                    problems.append(f'Changed installation was preserved: {target}; old backup: {backup}')
                    continue
                displaced = _recovery_root(target, create=True) / f'.{NAME}.rollback-{uuid.uuid4().hex}'
                os.rename(target, displaced)
                if _signature(displaced) == entry['signature']:
                    shutil.rmtree(displaced)
                else:
                    problems.append(f'Changed files were preserved for recovery: {displaced}')
            if backup and backup.exists():
                if target.exists() or _is_link(target):
                    problems.append(f'Restore old backup manually; destination now exists: {backup} -> {target}')
                else:
                    os.rename(backup, target)
        except (OSError, ValueError) as error:
            problems.append(f'Recovery needs attention: {backup} -> {target} ({error})')
    return problems


def install_skill(source, destinations, dry_run=False, update=False):
    """Install clean source; --update preserves old copies and rolls back failures."""
    raw_source = Path(source).expanduser().absolute()
    if _is_link(raw_source):
        raise ValueError('The source skill must not be a symbolic link.')
    source = raw_source.resolve()
    _validate_skill(source)
    files = _source_files(source)
    targets = []
    for value in destinations:
        raw = Path(value).expanduser().absolute()
        if _is_link(raw):
            raise ValueError(f'Destination must not be a symbolic link: {raw}')
        targets.append(raw.resolve())
    if len(set(targets)) != len(targets):
        raise ValueError('Destination directories must be different.')
    entries = []
    for target in targets:
        if target == source or source in target.parents or target in source.parents:
            raise ValueError('Install outside the source skill directory and its ancestors.')
        if any(other != target and (other in target.parents or target in other.parents) for other in targets):
            raise ValueError('Destination directories must not contain each other.')
        previous = None
        if target.exists():
            if not update:
                raise ValueError(f'Already exists; nothing overwritten: {target}')
            _validate_existing(target)
            previous = _identity(target)
        recovery = _recovery_root(target, source=source)
        if any(recovery == other.parent or other.parent in recovery.parents for other in targets):
            raise ValueError('The backup directory must be outside every skills discovery directory.')
        entries.append({'target': target, 'previous': previous, 'recovery': recovery})
    if dry_run:
        return InstallResult(targets)

    locks = []
    try:
        # Lock all targets before staging any change. A stale lock requires user
        # inspection; we never assume an existing lock belongs to a dead process.
        for target in sorted(targets):
            target.parent.mkdir(parents=True, exist_ok=True)
            lock = target.parent / f'.{target.name}.install-lock'
            try:
                lock.mkdir(mode=0o700)
            except FileExistsError:
                raise ValueError(f'Installation lock already exists; check another installer before retrying: {lock}') from None
            locks.append(lock)
        for entry in entries:
            target = entry['target']
            recovery = _recovery_root(target, source=source, create=True)
            staging = Path(tempfile.mkdtemp(prefix=f'.{NAME}.stage-', dir=recovery))
            entry['staging'] = staging
            _copy_source(source, files, staging)
            entry['signature'] = _signature(staging)
            entry['staging_identity'] = _identity(staging)
        for entry in entries:
            target = entry['target']
            if entry['previous'] is not None:
                _validate_existing(target)
                if _identity(target) != entry['previous']:
                    raise ValueError(f'Destination changed during installation: {target}')
                recovery = _recovery_root(target, source=source, create=True)
                backup = recovery / f'.{NAME}.backup-{time.strftime("%Y%m%d-%H%M%S")}-{uuid.uuid4().hex[:8]}'
                os.rename(target, backup)
                entry['backup'] = backup
            if target.exists() or _is_link(target):
                raise ValueError(f'Destination appeared during installation: {target}')
            os.rename(entry['staging'], target)
            entry['published'] = entry['staging_identity']
    except Exception as error:
        problems = _restore(entries)
        if problems:
            raise ValueError(f'{error}\n' + '\n'.join(problems)) from error
        raise
    finally:
        for entry in entries:
            staging = entry.get('staging')
            if staging and staging.exists():
                shutil.rmtree(staging)
        for lock in reversed(locks):
            lock.rmdir()
    return InstallResult(targets, {entry['target']: entry['backup'] for entry in entries if entry.get('backup')})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=['codex', 'claude', 'both'], default='both')
    parser.add_argument('--scope', choices=['user', 'project'], default='user')
    parser.add_argument('--project', type=Path, help='Project directory for project scope')
    parser.add_argument('--codex-root', type=Path, help='Override the Codex skills root')
    parser.add_argument('--claude-root', type=Path, help='Override the Claude Code skills root')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--update', action='store_true', help='Update matching skills and keep recoverable old copies')
    args = parser.parse_args(argv)
    if args.scope == 'project' and (not args.project or not args.project.is_absolute() or not args.project.is_dir()):
        parser.error('--scope project needs an existing absolute --project directory')
    base = args.project if args.scope == 'project' else Path.home()
    codex = args.codex_root or base / '.agents' / 'skills'
    claude = args.claude_root or base / '.claude' / 'skills'
    targets = []
    if args.target in ('codex', 'both'):
        targets.append(codex / NAME)
    if args.target in ('claude', 'both'):
        targets.append(claude / NAME)
    try:
        installed = install_skill(Path(__file__).resolve().parent.parent, targets, args.dry_run, update=args.update)
    except (ValueError, OSError) as error:
        print(f'Installation failed: {error}', file=sys.stderr)
        return 1
    for target in installed:
        print(('Would install/update: ' if args.dry_run else 'Installed: ') + str(target))
        if target in installed.backups:
            print('Previous copy preserved: ' + str(installed.backups[target]))
            print('To restore: move the new installation aside, then move this backup back to the installation path.')
    print('Only skill files were installed. No model, credentials, pairing or background service were started or changed.' if not args.dry_run else 'Dry run: no files changed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
