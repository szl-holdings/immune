"""Dependency-free lint for this repository's reviewed Dependabot layout.

This checks the explicitly supported block layout; it is not a general YAML
parser or a claim that Dependabot has already generated a correct future lock.
The actual frozen install remains the dependency-graph acceptance gate.
"""
from pathlib import Path
import json
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


def npm_update_directories(text: str) -> list[str]:
    blocks = re.findall(r'(?ms)^  - package-ecosystem:.*?(?=^  - package-ecosystem:|\Z)', text)
    if not blocks:
        raise ValueError('Unsupported Dependabot layout; review the workspace lint with the configuration')
    directories = []
    for block in blocks:
        ecosystem = re.match(r'^  - package-ecosystem:\s*[\"\']?([a-z-]+)[\"\']?\s*(?:#.*)?$', block.splitlines()[0])
        if ecosystem is None:
            raise ValueError('Unsupported ecosystem declaration')
        if ecosystem.group(1) != 'npm':
            continue
        values = re.findall(r'(?m)^    directory:\s*[\"\']?(/[^\"\'\s#]*)[\"\']?\s*(?:#.*)?$', block)
        if len(values) != 1 or re.search(r'(?m)^    directories:', block):
            raise ValueError('npm must have one explicit shared-workspace directory')
        directories.extend(values)
    if directories != ['/']:
        raise ValueError('npm updates must target the single root-owned pnpm workspace')
    return directories


class DependencyWorkspaceContract(unittest.TestCase):
    def test_current_updater_targets_the_shared_workspace(self):
        text = (ROOT / '.github/dependabot.yml').read_text(encoding='utf-8')
        self.assertEqual(npm_update_directories(text), ['/'])

    def test_old_frontend_only_configuration_is_rejected(self):
        with self.assertRaises(ValueError):
            npm_update_directories('updates:\n  - package-ecosystem: "npm"\n    directory: "/frontend"\n')

    def test_overlapping_root_and_frontend_updaters_are_rejected(self):
        with self.assertRaises(ValueError):
            npm_update_directories('updates:\n  - package-ecosystem: "npm"\n    directory: "/"\n  - package-ecosystem: "npm"\n    directory: "/frontend"\n')

    def test_missing_or_ambiguous_workspace_scope_is_rejected(self):
        for text in ('updates: []', 'updates:\n  - package-ecosystem: "npm"\n',
                     'updates:\n  - package-ecosystem: "npm"\n    directories: ["/"]\n'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                npm_update_directories(text)

    def test_root_retains_the_shared_lock_and_frontend_importer(self):
        self.assertTrue((ROOT / 'package.json').is_file())
        self.assertTrue((ROOT / 'frontend/package.json').is_file())
        workspace = (ROOT / 'pnpm-workspace.yaml').read_text(encoding='utf-8')
        lock = (ROOT / 'pnpm-lock.yaml').read_text(encoding='utf-8')
        self.assertRegex(workspace, r'(?m)^\s*- frontend\s*$')
        self.assertRegex(lock, r'(?m)^  frontend:\s*$')
        self.assertFalse((ROOT / 'frontend/pnpm-lock.yaml').exists(), 'Do not introduce a competing workspace lock')

    def test_native_ci_retains_frozen_dependency_installation(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text(encoding='utf-8')
        self.assertIn('pnpm install --frozen-lockfile', workflow)
        self.assertNotIn('--no-frozen-lockfile', workflow)

    def test_vite_override_tracks_both_declared_build_dependencies(self):
        versions = [
            json.loads((ROOT / manifest).read_text(encoding='utf-8'))['devDependencies']['vite']
            for manifest in ('package.json', 'frontend/package.json')
        ]
        self.assertEqual(versions[0], versions[1], 'Both build entry points must request the same Vite')
        self.assertRegex(versions[0], r'^\d+\.\d+\.\d+$', 'Retain an exact reviewed Vite version')
        workspace = (ROOT / 'pnpm-workspace.yaml').read_text(encoding='utf-8')
        self.assertEqual(
            re.findall(r'(?m)^  vite:\s*(\S+)\s*$', workspace),
            [versions[0]],
            'A stale workspace override silently defeats a declared Vite upgrade',
        )


if __name__ == '__main__':
    unittest.main()
