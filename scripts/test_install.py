"""Portable installation/update tests; never touch the actual skills directory."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'SKILL.md').write_text('---\nname: wechat-agent-bridge\ndescription: test\n---\nversion one\n', encoding='utf-8')
        self.destinations = [self.root / 'codex' / installer.NAME, self.root / 'claude' / installer.NAME]

    def test_installs_both_without_runtime_or_secrets_and_refuses_overwrite(self):
        for relative in ('auth.json', 'login-qr.png', '.state/secret.md', 'state/secret.md', 'runtime/secret.py',
                         'assets/bridge/.state/secret.mjs', 'assets/bridge/node_modules/pkg/index.mjs',
                         'references/runtime/secret.md', 'scripts/__pycache__/secret.py', 'bridge.config.json'):
            target = self.source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('private', encoding='utf-8')
        script = self.source / 'scripts' / 'prepare.py'
        script.write_text('# allowed source', encoding='utf-8')
        for name in ('install-windows.ps1', 'prepare-windows.ps1'):
            (self.source / 'scripts' / name).write_text('# allowed PowerShell source', encoding='utf-8')
        (self.source / 'unexpected.ps1').write_text('# not packaged', encoding='utf-8')
        installed = installer.install_skill(self.source, self.destinations)
        self.assertEqual(installed, self.destinations)
        for target in self.destinations:
            self.assertEqual({p.relative_to(target).as_posix() for p in target.rglob('*') if p.is_file()}, {'SKILL.md', 'scripts/prepare.py', 'scripts/install-windows.ps1', 'scripts/prepare-windows.ps1'})
        with self.assertRaisesRegex(ValueError, 'Already exists'):
            installer.install_skill(self.source, self.destinations)
        self.assertTrue((self.destinations[0] / 'SKILL.md').exists())

    def test_dry_run_never_creates_target_and_preflights_all_destinations(self):
        installer.install_skill(self.source, self.destinations, dry_run=True)
        self.assertFalse(self.destinations[0].parent.exists())
        with self.assertRaises(ValueError):
            installer.install_skill(self.source, [self.destinations[0], self.source])
        self.assertFalse(self.destinations[0].exists())

    def test_update_preserves_both_previous_copies_and_installs_clean_source(self):
        installer.install_skill(self.source, self.destinations)
        for target in self.destinations:
            (target / '.state').mkdir()
            (target / '.state' / 'auth.json').write_text('old-private-data', encoding='utf-8')
        old = (self.source / 'SKILL.md').read_text(encoding='utf-8')
        (self.source / 'SKILL.md').write_text(old.replace('version one', 'version two'), encoding='utf-8')
        installed = installer.install_skill(self.source, self.destinations, update=True)
        self.assertEqual(set(installed.backups), set(self.destinations))
        for target in self.destinations:
            backup = installed.backups[target]
            self.assertTrue(backup.name.startswith('.wechat-agent-bridge.backup-'))
            self.assertEqual(backup.parent, target.parent.parent / '.skill-backups')
            self.assertNotIn(target.parent, backup.parents)
            self.assertEqual((backup / 'SKILL.md').read_text(encoding='utf-8'), old)
            self.assertEqual((backup / '.state' / 'auth.json').read_text(encoding='utf-8'), 'old-private-data')
            self.assertIn('version two', (target / 'SKILL.md').read_text(encoding='utf-8'))
            self.assertFalse((target / '.state').exists())
        self.assertFalse(list(self.root.rglob('*.install-lock')))

    def test_recovery_directory_rejects_symlinks_before_changing_installations(self):
        installer.install_skill(self.source, self.destinations)
        recovery = self.root / '.skill-backups'
        recovery.rmdir()
        outside = self.root / 'outside'
        outside.mkdir()
        try:
            recovery.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            self.skipTest(f'Symbolic links unavailable on this host: {error}')
        with self.assertRaisesRegex(ValueError, 'Backup paths'):
            installer.install_skill(self.source, self.destinations, update=True)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertIn('version one', (self.destinations[0] / 'SKILL.md').read_text(encoding='utf-8'))

    def test_different_volume_recovery_is_rejected_before_writes(self):
        def devices(path):
            return 2 if '.skill-backups' in path.parts else 1
        with mock.patch.object(installer, '_device', side_effect=devices):
            with self.assertRaisesRegex(ValueError, 'same volume'):
                installer.install_skill(self.source, self.destinations)
        self.assertFalse(self.destinations[0].parent.exists())
        self.assertFalse((self.root / '.skill-backups').exists())

    def test_changed_failed_installation_is_preserved_outside_skills_root(self):
        installer.install_skill(self.source, self.destinations)
        old = (self.source / 'SKILL.md').read_text(encoding='utf-8')
        (self.source / 'SKILL.md').write_text(old + 'new version\n', encoding='utf-8')
        real_rename = installer.os.rename
        def fail_second_publish(src, dst):
            if '.stage-' in Path(src).name and Path(dst) == self.destinations[1]:
                (self.destinations[0] / 'concurrent-user-file.txt').write_text('preserve', encoding='utf-8')
                raise OSError('simulated failure after concurrent edit')
            return real_rename(src, dst)
        with mock.patch.object(installer.os, 'rename', side_effect=fail_second_publish):
            with self.assertRaisesRegex(ValueError, 'preserved for recovery'):
                installer.install_skill(self.source, self.destinations, update=True)
        copies = list((self.root / '.skill-backups').glob('*.rollback-*'))
        self.assertEqual(len(copies), 1)
        self.assertEqual((copies[0] / 'concurrent-user-file.txt').read_text(encoding='utf-8'), 'preserve')
        for target in self.destinations:
            self.assertEqual((target / 'SKILL.md').read_text(encoding='utf-8'), old)
            self.assertEqual([p.name for p in target.parent.iterdir()], [installer.NAME])

    def test_update_dry_run_does_not_modify_existing_installations(self):
        installer.install_skill(self.source, self.destinations)
        before = {p.relative_to(self.root).as_posix() for p in self.root.rglob('*')}
        result = installer.install_skill(self.source, self.destinations, dry_run=True, update=True)
        self.assertEqual(result.backups, {})
        self.assertEqual(before, {p.relative_to(self.root).as_posix() for p in self.root.rglob('*')})

    def test_update_preflights_mismatched_skill_before_changing_any_target(self):
        installer.install_skill(self.source, self.destinations)
        bad = self.destinations[1] / 'SKILL.md'
        bad.write_text('---\nname: another-skill\n---\n', encoding='utf-8')
        first = (self.destinations[0] / 'SKILL.md').read_text(encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'different or missing name'):
            installer.install_skill(self.source, self.destinations, update=True)
        self.assertEqual((self.destinations[0] / 'SKILL.md').read_text(encoding='utf-8'), first)
        self.assertFalse(list(self.root.rglob('*.backup-*')))

    def test_bad_source_skill_name_is_rejected(self):
        (self.source / 'SKILL.md').write_text('---\nname: another-skill\n---\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'different or missing name'):
            installer.install_skill(self.source, self.destinations)
        self.assertFalse(self.destinations[0].exists())

    def test_failed_second_update_rolls_back_both_previous_copies(self):
        installer.install_skill(self.source, self.destinations)
        old = (self.source / 'SKILL.md').read_text(encoding='utf-8')
        (self.source / 'SKILL.md').write_text(old + 'new version\n', encoding='utf-8')
        real_rename = installer.os.rename
        def fail_second_publish(src, dst):
            if '.stage-' in Path(src).name and Path(dst) == self.destinations[1]:
                raise OSError('simulated second publish failure')
            return real_rename(src, dst)
        with mock.patch.object(installer.os, 'rename', side_effect=fail_second_publish):
            with self.assertRaisesRegex(OSError, 'simulated second publish'):
                installer.install_skill(self.source, self.destinations, update=True)
        for target in self.destinations:
            self.assertEqual((target / 'SKILL.md').read_text(encoding='utf-8'), old)
        self.assertFalse(list(self.root.rglob('*.stage-*')))
        self.assertFalse(list(self.root.rglob('*.install-lock')))

    def test_concurrent_destination_is_preserved(self):
        real_copy = installer._copy_source
        intruder = self.destinations[0]
        def add_concurrent_destination(source, files, staging):
            real_copy(source, files, staging)
            if not intruder.exists():
                intruder.mkdir()
                (intruder / 'user.txt').write_text('preserve', encoding='utf-8')
        with mock.patch.object(installer, '_copy_source', side_effect=add_concurrent_destination):
            with self.assertRaisesRegex(ValueError, 'appeared'):
                installer.install_skill(self.source, self.destinations)
        self.assertEqual((intruder / 'user.txt').read_text(encoding='utf-8'), 'preserve')
        self.assertFalse(self.destinations[1].exists())

    def test_source_and_existing_installation_symlinks_are_rejected(self):
        installer.install_skill(self.source, self.destinations)
        linked = self.destinations[0] / 'linked.md'
        try:
            linked.symlink_to(self.source / 'SKILL.md')
        except OSError as error:
            self.skipTest(f'Symbolic links unavailable on this host: {error}')
        with self.assertRaisesRegex(ValueError, 'symbolic links'):
            installer.install_skill(self.source, self.destinations, update=True)
        linked.unlink()
        skill = self.destinations[0] / 'SKILL.md'
        skill.unlink()
        skill.symlink_to(self.source / 'SKILL.md')
        with self.assertRaisesRegex(ValueError, 'symbolic links'):
            installer.install_skill(self.source, self.destinations, update=True)

    def test_update_can_install_a_previously_missing_target(self):
        installer.install_skill(self.source, self.destinations[:1])
        installed = installer.install_skill(self.source, self.destinations, update=True)
        self.assertEqual(len(installed.backups), 1)
        self.assertTrue((self.destinations[1] / 'SKILL.md').exists())


if __name__ == '__main__':
    unittest.main()
