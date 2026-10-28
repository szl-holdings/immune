"""Finding #7 (Appendix I): Python side of the canonical contract.

Legacy `canonical_bytes` is pinned byte-identical (it is what existing Python
compatibility records were hashed with). The new `szl.immune.canonical/v2`
profile must match the shared TS/Python vectors in
contracts/immune-canonical-v2-vectors.json.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from immune import canonical

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "immune-canonical-v2-vectors.json").read_text(encoding="utf-8")
)

# sha256 of legacy Python canonical_bytes at base 70754c5a (measured).
LEGACY_GOLDEN = [
    ("proto_obj", '{"__proto__":{"x":1},"b":2}', "457f656291eb5501ca1e04af2f0c663ac39d3bfb147e3aaac9a08f513e105e7f"),
    ("nested", '{"a":{"__proto__":{"secret":"s"},"k":1}}', "a394a26839f0e9bbccede45e9dfe0fd5677803e27dc33c12511f3e4584ae856e"),
    ("ctor", '{"constructor":{"x":1},"toString":2,"prototype":3}', "4b6c7286525e106403e34c7ec1923b866ba8c30e4fa41ed3274a79d455b8e567"),
    ("intkeys", '{"10":1,"9":2,"a":3,"-1":4,"01":5,"4294967295":6,"4294967294":7}', "c6bcf3a3e1f5877b430b07f6d81af8183640e408dd1a6d1c118e2e6f8c749b91"),
    ("astral", '{"\\uffff":1,"\\ud83d\\ude00":2}', "c07399259f29babc3ab550e5dcfa10f3ac14b9e55a39a6b3e9100fc6100ef936"),
    ("negz", '{"n":-0}', "f3013f933b9fb80ab6d995e7ad9da36f683837ba1d81e950c943d40111eac2f0"),
    ("maxsafe", '{"n":9007199254740991}', "e1da48c6a6089f06ecb4e0a2259e658e3786b2420f52baccdf929ec6460d7b41"),
]


def v2_code(value) -> str:
    try:
        canonical.canonical_bytes_v2(value)
    except canonical.CanonicalV2Error as exc:
        assert isinstance(exc, canonical.CanonicalError)
        return exc.code
    return "accepted"


class LegacyCanonicalTests(unittest.TestCase):
    def test_legacy_bytes_unchanged(self) -> None:
        for vid, text, sha in LEGACY_GOLDEN:
            self.assertEqual(canonical.sha256_hex(canonical.canonical_bytes(json.loads(text))), sha, vid)


class CanonicalV2Tests(unittest.TestCase):
    def test_profile_tag(self) -> None:
        self.assertEqual(canonical.CANONICAL_V2_PROFILE, "szl.immune.canonical/v2")
        self.assertEqual(VECTORS["profile"], canonical.CANONICAL_V2_PROFILE)
        digest, blob, profile = canonical.hash_canonical_v2({"a": 1})
        self.assertEqual(profile, canonical.CANONICAL_V2_PROFILE)
        self.assertEqual(digest, canonical.sha256_hex(blob))

    def test_shared_vectors(self) -> None:
        self.assertGreaterEqual(len(VECTORS["vectors"]), 20)
        for vector in VECTORS["vectors"]:
            value = json.loads(vector["input"])
            if "error" in vector:
                self.assertEqual(v2_code(value), vector["error"], vector["id"])
                continue
            blob = canonical.canonical_bytes_v2(value)
            self.assertEqual(blob.decode("utf-8"), vector["canonical"], vector["id"])
            self.assertEqual(canonical.sha256_hex(blob), vector["sha256"], vector["id"])

    def test_rejections_raise_canonical_error_not_codec_errors(self) -> None:
        self.assertEqual(v2_code({"k": "\ud800"}), "lone_surrogate")
        self.assertEqual(v2_code({"\udc00": 1}), "lone_surrogate")
        self.assertEqual(v2_code({"__proto__": {"x": 1}}), "proto_key")
        self.assertEqual(v2_code({1: "int key"}), "unsupported_type")
        self.assertEqual(v2_code((1, 2)), "unsupported_type")
        self.assertEqual(v2_code(float("nan")), "non_integer")

    def test_length_counts_utf16_code_units(self) -> None:
        self.assertEqual(v2_code({"k": "\U0001F600" * 32_768}), "accepted")
        self.assertEqual(v2_code({"k": "\U0001F600" * 32_769}), "too_long")
        self.assertEqual(v2_code({"k": "a" * 65_536}), "accepted")
        self.assertEqual(v2_code({"k": "a" * 65_537}), "too_long")

    def test_integral_floats_match_js_number_model(self) -> None:
        self.assertEqual(canonical.canonical_bytes_v2({"n": 1.0, "z": -0.0}), b'{"n":1,"z":0}')
        self.assertEqual(v2_code({"n": 1.000000001}), "non_integer")
        self.assertEqual(v2_code({"n": 2.0**53}), "unsafe_integer")

    def test_size_and_depth_bounds(self) -> None:
        self.assertEqual(v2_code({"t": ["y" * 60_000] * 20}), "too_large")
        deep = 0
        for _ in range(33):
            deep = [deep]
        self.assertEqual(v2_code(deep), "depth")


if __name__ == "__main__":
    unittest.main()
