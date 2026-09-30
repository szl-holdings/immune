"""Local-only v2 reconciliation guards for compatibility runtime and image."""

from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
RUNTIME_PATH = ROOT / "python" / "immune" / "runtime.py"
DOCKER_PATH = ROOT / "frontend" / "deploy" / "Dockerfile"


class CompatibilityAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.storage = tempfile.TemporaryDirectory()
        self.addCleanup(self.storage.cleanup)
        self.environment = patch.dict(
            os.environ,
            {"IMMUNE_DATA_DIR": self.storage.name, "IMMUNE_SIGNING_KEY": ""},
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        from immune.runtime import ImmuneRuntime

        self.runtime = ImmuneRuntime()
        self.runtime.boot()

    def test_boot_has_no_genesis_pass_renewal_or_action_identity(self) -> None:
        before = self.runtime.snapshot()
        self.runtime.maybe_refresh()
        self.assertEqual(self.runtime.snapshot(), before)
        self.assertEqual(before["mode"], "SENTRA_REJECT")
        self.assertEqual(before["evidenceState"], "UNAVAILABLE")
        self.assertEqual(before["authority"]["version"], "immune.action.v2")
        self.assertFalse(before["authority"]["enabled"])
        self.assertTrue(before["authority"]["externalOperator"])
        self.assertIsNone(before["authority"]["keyId"])
        self.assertEqual(self.runtime.authority_receipts, [])
        self.assertEqual(self.runtime.ledger, [])
        self.assertFalse(hasattr(self.runtime, "_heartbeat"))
        self.assertEqual(list(Path(self.storage.name).iterdir()), [])

    def test_all_compatibility_action_entrypoints_refuse_without_writing(self) -> None:
        for operation in (
            lambda: self.runtime.apply_action({"type": "RESET"}, "test"),
            lambda: self.runtime.set_mode("PASS"),
            lambda: self.runtime.set_mode("SENTRA_REJECT"),
            lambda: self.runtime.set_mode("DEADMAN", "T07"),
            self.runtime.reset,
        ):
            with self.assertRaisesRegex(PermissionError, "EXTERNAL_ACTION_REQUIRED"):
                operation()
        self.assertFalse(self.runtime.readiness()["write_ready"])
        self.assertEqual(self.runtime.authority_receipts, [])
        self.assertEqual(list(Path(self.storage.name).iterdir()), [])

    def test_refused_cycle_can_record_evidence_but_not_success_or_authority(self) -> None:
        result = self.runtime.run_cycle("test", "observe inbound radar")
        self.assertFalse(result["pass"])
        self.assertFalse(result["sentra"]["accepted"])
        self.assertIsNone(result["receipt"])
        self.assertEqual(self.runtime.ledger_count(), 0)
        self.assertEqual(self.runtime.authority_receipts, [])
        self.assertEqual(len(self.runtime.evidence), 1)
        saved = json.loads(
            (Path(self.storage.name) / "runtime.json").read_text(encoding="utf-8")
        )
        self.assertEqual(saved["state"]["mode"], "SENTRA_REJECT")
        self.assertEqual(saved["authorityReceipts"], [])
        self.assertEqual(saved["ledger"], [])
        self.assertFalse(self.runtime.readiness()["authority_ready"])
        self.assertFalse(self.runtime.readiness()["write_ready"])

    def test_current_software_evidence_metadata_survives_without_faking_pass(self) -> None:
        source = RUNTIME_PATH.read_text(encoding="utf-8")
        for retired in (
            "load_or_create_operator_key",
            "_arm_heartbeat",
            "_result_for",
            '"liveOperator": True',
        ):
            self.assertNotIn(retired, source)
        tree = ast.parse(source)
        payloads = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Dict)
            and any(
                isinstance(key, ast.Constant) and key.value == "evidenceTier"
                for key in node.keys
            )
        ]
        self.assertEqual(len(payloads), 1)
        expected = {
            "evidenceTier": "SOFTWARE_RECEIPT",
            "directive": "RELEASE",
            "claims": {
                "execution": "SOFTWARE",
                "identity": "MEASURED",
                "input": "MEASURED",
                "policy": "MEASURED",
            },
            "adjacent": ["TRACE", "AIREP", "R+2", "AIR", "SLSA", "PUNKGO"],
            "scope": (
                "covers: SENTRA, YAWAR, HUKLLA, NEXUS organ · does-not-cover: "
                "TEE quotes, ATO, fold-38 · energy: UNAVAILABLE · tier: SOFTWARE_RECEIPT"
            ),
            "nexusOrgan": True,
        }
        observed = {
            key.value: ast.literal_eval(value)
            for key, value in zip(payloads[0].keys, payloads[0].values)
            if isinstance(key, ast.Constant) and key.value in expected
        }
        self.assertEqual(observed, expected)
        self.assertFalse(self.runtime.run_cycle("test", "observe inbound radar")["pass"])


class ImageBoundaryTests(unittest.TestCase):
    def test_ci_installs_runtime_dependencies_before_contract_imports(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(
            encoding="utf-8"
        )
        installation = "python3 -m pip install -r python/requirements.txt"
        contracts = "python3 -m unittest tests.test_assert_hf_space_operational"
        kernel = "PYTHONPATH=python python3 -m unittest discover -s python/tests -v"
        self.assertEqual(workflow.count(installation), 1)
        self.assertLess(workflow.index(installation), workflow.index(contracts))
        self.assertLess(workflow.index(contracts), workflow.index(kernel))
        self.assertIn("tests.test_immune_v2_packaging -v", workflow)

    def test_pinned_node24_and_process_only_healthcheck_are_preserved(self) -> None:
        docker = DOCKER_PATH.read_text(encoding="utf-8")
        self.assertIn(
            "FROM public.ecr.aws/docker/library/node:24-alpine@sha256:"
            "ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1",
            docker,
        )
        probe = docker.split("HEALTHCHECK ", 1)[1].split("\n\n", 1)[0]
        self.assertIn('CMD ["node", "-e",', probe)
        self.assertIn("'/healthz'", probe)
        self.assertNotIn("/readyz", probe)
        self.assertIn("AbortSignal.timeout(4000)", probe)

    def test_only_public_trust_is_packaged_and_demo_authority_is_absent(self) -> None:
        docker = DOCKER_PATH.read_text(encoding="utf-8")
        self.assertIn(
            "COPY dist/immune-action-trust.json ./immune-action-trust.json", docker
        )
        self.assertNotIn("IMMUNE_DEMO_OPERATOR", docker)
        self.assertNotIn("IMMUNE_ACTION_PRIVATE_KEY", docker)
        self.assertNotIn("IMMUNE_SIGNING_KEY", docker)
        self.assertIn("USER 1000", docker)

    def test_append_targets_are_durable_and_bundled_history_is_read_only(self) -> None:
        docker = DOCKER_PATH.read_text(encoding="utf-8")
        self.assertIn("IMMUNE_AUTHORITY_DATA_DIR=/data/immune", docker)
        self.assertIn("IMMUNE_DATA_DIR=/data/immune/evidence", docker)
        self.assertIn("COPY dist/data ./data", docker)
        self.assertIn("chmod -R a-w /app/data", docker)
        self.assertNotIn("chmod -R a+rwX", docker)
        self.assertNotIn("COPY dist/data /data", docker)
        self.assertNotIn("mkdir -p /data", docker)
        self.assertNotIn("cp -r", docker)


if __name__ == "__main__":
    unittest.main(verbosity=2)
