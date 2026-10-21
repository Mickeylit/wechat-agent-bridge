"""Isolated deployment tests; no network, npm, agent, or WeChat calls."""

import importlib.util
import errno
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("bridge_prepare", Path(__file__).with_name("prepare.py"))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.skill = self.root / "fake-skill"
        self.source = self.skill / "assets" / "bridge"
        self.source.mkdir(parents=True)
        self.expected = {"cli.mjs", "package.json", "package-lock.json", "lib/agent.mjs", "test/agent.test.mjs"}
        for name in self.expected:
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("{}" if name.endswith(".json") else "// fixture\n", encoding="utf-8")
        self.destination = self.root / "deployment"

    def run_prepare(self, **options):
        return prepare.prepare(self.destination, source=self.source, **options)

    def test_copies_source_and_private_config_for_both_engines(self):
        for engine in ("codex", "claude"):
            with self.subTest(engine=engine):
                result = self.run_prepare(engine=engine)
                files = {p.relative_to(self.destination).as_posix() for p in self.destination.rglob("*") if p.is_file()}
                self.assertEqual(files, self.expected | {"bridge.config.json"})
                self.assertEqual(result["source_file_count"], len(self.expected))
                config = self.destination / "bridge.config.json"
                self.assertEqual(json.loads(config.read_text()), {"engine": engine, "stateDir": "./.state"})
                if not prepare.IS_WINDOWS:
                    self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
                    self.assertEqual(stat.S_IMODE((self.destination / "cli.mjs").stat().st_mode), 0o644)
                self.assertFalse((self.destination / ".state").exists())
                shutil.rmtree(self.destination)

    def test_rejects_nonempty_destination_and_preserves_it(self):
        self.destination.mkdir()
        sentinel = self.destination / "user.txt"
        sentinel.write_text("keep me")
        with self.assertRaisesRegex(prepare.PrepareError, "not empty"):
            self.run_prepare()
        self.assertEqual(sentinel.read_text(), "keep me")
        self.assertEqual(list(self.destination.iterdir()), [sentinel])
        self.assertFalse(list(self.root.glob(".deployment.prepare-*")))

    def test_accepts_an_existing_empty_destination(self):
        self.destination.mkdir()
        self.run_prepare()
        self.assertTrue((self.destination / "cli.mjs").exists())

    def test_allowlist_excludes_credentials_runtime_artifacts_and_nested_files(self):
        for name in ("auth.json", "state.json", "service.log", "runtime.json", "login-qr.png", "bridge.config.json",
                     ".state/auth.json", "node_modules/pkg/index.mjs", "lib/secrets.json", "lib/nested/auth.mjs",
                     "test/fixture/auth.json", "test/.credential.mjs", "random.mjs", "README.md"):
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("DO_NOT_COPY")
        self.run_prepare()
        files = {p.relative_to(self.destination).as_posix() for p in self.destination.rglob("*") if p.is_file()}
        self.assertEqual(files, self.expected | {"bridge.config.json"})
        self.assertNotIn("DO_NOT_COPY", "".join(p.read_text() for p in self.destination.rglob("*") if p.is_file()))

    def test_dry_run_does_not_write_anything(self):
        before = {str(p.relative_to(self.root)) for p in self.root.rglob("*")}
        result = self.run_prepare(dry_run=True)
        self.assertTrue(result["dry_run"])
        self.assertEqual(result["source"], str(self.source.resolve()))
        self.assertEqual(result["destination"], str(self.destination.resolve()))
        self.assertEqual(result["source_file_count"], 5)
        self.assertEqual(before, {str(p.relative_to(self.root)) for p in self.root.rglob("*")})

    def test_rejects_relative_paths_and_skill_runtime(self):
        with self.assertRaisesRegex(prepare.PrepareError, "absolute"):
            prepare.prepare(Path("relative"), source=self.source)
        with self.assertRaisesRegex(prepare.PrepareError, "outside"):
            prepare.prepare(self.skill / "runtime", source=self.source)

    def test_rejects_source_and_destination_symlinks(self):
        target = self.source / "lib/agent.mjs"
        target.unlink()
        external = self.root / "external.mjs"
        external.write_text("secret")
        try:
            target.symlink_to(external)
        except OSError as error:
            self.skipTest(f"Symbolic links unavailable on this host: {error}")
        with self.assertRaisesRegex(prepare.PrepareError, "symbolic"):
            self.run_prepare()
        target.unlink()
        target.write_text("// normal")
        empty = self.root / "empty"
        empty.mkdir()
        self.destination.symlink_to(empty, target_is_directory=True)
        with self.assertRaisesRegex(prepare.PrepareError, "symbolic"):
            self.run_prepare()

    def test_copy_failure_cleans_staging_and_does_not_publish(self):
        with mock.patch.object(prepare.shutil, "copyfile", side_effect=OSError("simulated copy failure")):
            with self.assertRaisesRegex(OSError, "simulated"):
                self.run_prepare()
        self.assertFalse(self.destination.exists())
        self.assertFalse(list(self.root.glob(".deployment.prepare-*")))

    def test_cli_resolves_its_own_assets_and_quotes_next_commands(self):
        scripts = self.skill / "scripts"
        scripts.mkdir()
        script = scripts / "prepare.py"
        shutil.copyfile(Path(prepare.__file__), script)
        destination = self.root / "deploy ' quoted $(unsafe)"
        result = subprocess.run([sys.executable, str(script), "--dest", str(destination), "--engine", "claude"],
                                cwd=self.root, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads((destination / "bridge.config.json").read_text())["engine"], "claude")
        self.assertIn("Next commands (not executed)", result.stdout)
        if prepare.IS_WINDOWS:
            expected = prepare.next_commands(str(destination.resolve()), windows=True)[0]
            self.assertIn(expected, result.stdout)
        else:
            cd_line = next(line for line in result.stdout.splitlines() if line.startswith("cd -- "))
            self.assertEqual(prepare.shlex.split(cd_line), ["cd", "--", str(destination.resolve())])

    def test_windows_empty_directory_replace_fallback(self):
        self.destination.mkdir()
        with mock.patch.object(prepare, "IS_WINDOWS", True), mock.patch.object(prepare.os, "replace", side_effect=PermissionError(errno.EACCES, "Windows empty directory")):
            self.run_prepare()
        self.assertTrue((self.destination / "cli.mjs").exists())

    def test_windows_fallback_preserves_concurrent_content(self):
        self.destination.mkdir()
        def concurrent_write(*_):
            (self.destination / "new-user-file.txt").write_text("preserve")
            raise PermissionError(errno.EACCES, "Windows existing directory")
        with mock.patch.object(prepare, "IS_WINDOWS", True), mock.patch.object(prepare.os, "replace", side_effect=concurrent_write):
            with self.assertRaisesRegex(prepare.PrepareError, "changed"):
                self.run_prepare()
        self.assertEqual((self.destination / "new-user-file.txt").read_text(), "preserve")

    def test_powershell_commands_quote_apostrophes_without_expansion(self):
        commands = prepare.next_commands("C:\\Users\\O'Brien\\bridge $(unsafe)", windows=True)
        self.assertEqual(commands[0], "Set-Location -LiteralPath 'C:\\Users\\O''Brien\\bridge $(unsafe)'")
        self.assertTrue(commands[1].startswith("npm.cmd ci "))
        self.assertEqual(commands[-1], "node cli.mjs login --web --auto-start")


if __name__ == "__main__":
    unittest.main()
