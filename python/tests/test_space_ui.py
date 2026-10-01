"""Execute the actual compatibility HUD scripts against hostile/failed status."""

from pathlib import Path
import shutil
import subprocess
import unittest


class SpaceUIContract(unittest.TestCase):
    def test_actual_browser_scripts_keep_channel_b_action_read_only(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is required for the executable UI contract")
        result = subprocess.run(
            [node, str(Path(__file__).with_name("space-ui-contract.mjs"))],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("7 scenarios passed", result.stdout)
