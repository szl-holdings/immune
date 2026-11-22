import unittest

from slsa_gov.provenance import (PASS_STRUCTURAL, ProvenanceError, ProvenanceRecord,
                                 REJECTED, Material, BuildDefinition, BuildRun, validate_record)

GOOD_SHA = "a" * 64
OTHER_SHA = "b" * 64


def make_record(claims=None):
    return ProvenanceRecord(
        definition=BuildDefinition("https://builder.example/szl", "https://slsa.dev/schema/v1",
                                   [Material("src", GOOD_SHA), Material("deps.lock", OTHER_SHA)]),
        run=BuildRun("ci-runner-1", started_ts=100.0, finished_ts=160.0),
        claims=claims if claims is not None else {"build_host": "runner-1"},
    )


class StructureTests(unittest.TestCase):
    def test_bad_digest_rejected(self):
        with self.assertRaises(ProvenanceError):
            Material("src", "zzzz")

    def test_empty_materials_rejected(self):
        with self.assertRaises(ProvenanceError):
            BuildDefinition("b", "t", [])

    def test_bad_timestamps_rejected(self):
        with self.assertRaises(ProvenanceError):
            BuildRun("env", started_ts=200.0, finished_ts=160.0)

    def test_wrong_type_to_validate_raises(self):
        with self.assertRaises(ProvenanceError):
            validate_record({"not": "a record"})


class ValidationTests(unittest.TestCase):
    def test_benign_claims_pass_structural(self):
        v = validate_record(make_record())
        self.assertEqual(v.result, PASS_STRUCTURAL)
        self.assertIn("NOT verification", v.reason)

    def test_signed_claim_rejected_fail_closed(self):
        v = validate_record(make_record({"status": "build SIGNED by CI"}))
        self.assertEqual(v.result, REJECTED)
        self.assertIn("fail-closed", v.reason)
        self.assertIn("OWNER_GATED", v.reason)

    def test_verified_claim_rejected_fail_closed(self):
        v = validate_record(make_record({"provenance": "VERIFIED"}))
        self.assertEqual(v.result, REJECTED)

    def test_unsigned_record_metadata(self):
        d = make_record().as_dict()
        self.assertEqual(d["status"], "PROPOSAL_UNSIGNED")
        self.assertEqual(d["signature_binding"], "OWNER_GATED")
        self.assertEqual(d["definition"]["materials"][0]["sha256"], GOOD_SHA)

    def test_verdict_as_dict(self):
        v = validate_record(make_record()).as_dict()
        self.assertEqual(v["result"], PASS_STRUCTURAL)


if __name__ == "__main__":
    unittest.main()
