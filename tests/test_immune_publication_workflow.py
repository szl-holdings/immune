"""Run IDENTICAL policy regressions against supplied actual workflow Python blocks.

This harness uses recording SDK objects and temporary files only; it cannot call
an actual provider. BASE or REPAIRED is selected as a local workflow path.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(Path(__file__).resolve().parent))
import test_immune_publication_guard as fixtures
WORKFLOW=Path(os.environ.get('WORKFLOW_UNDER_TEST', str(ROOT/'.github/workflows/deploy-hf-space.yml')))


class ActualBlockTests(fixtures.FixtureMixin,unittest.TestCase):
    def exercise(self, channel, defect):
        space=fixtures.A if channel==0 else fixtures.B
        self.api.info.id=space
        self.bundle(space)
        if defect=='read_failure':
            self.api.read_error=PermissionError('inert denied-read fixture')
        elif defect=='private':
            self.api.info.private=True
        elif defect=='unmanaged':
            self.api.names=['.gitattributes','data/persisted-ledger.jsonl','weights.safetensors']
        block=fixtures.inline_publishers(WORKFLOW)[channel]
        before=Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ,{'HF_SPACE':space,'HF_TOKEN':'INERT_FIXTURE','GITHUB_SHA':fixtures.SOURCE}):
                with patch.dict(sys.modules,{'scripts.immune_publication_guard':fixtures.guard}):
                    with contextlib.redirect_stdout(io.StringIO()):
                        try:
                            exec(compile(textwrap.dedent(block),'ACTUAL_WORKFLOW_BLOCK','exec'),{})
                        except fixtures.guard.PublicationBoundaryError:
                            if defect not in {'read_failure','private'}:
                                raise
            if defect=='read_failure':
                self.assertEqual(self.api.created+self.api.commits+self.api.settings,[], 'failed observation must not cause any provider mutation')
            elif defect=='private':
                self.assertEqual(self.api.created+self.api.commits+self.api.settings,[], 'private Space must not be made public or modified')
            elif defect=='unmanaged':
                removed=[op.path_in_repo for x in self.api.commits for op in x['operations'] if isinstance(op,fixtures.Delete)]
                self.assertEqual(removed,[], 'unmanaged artifacts must not be pruned')
            elif defect=='parent':
                self.assertEqual(self.api.commits[0].get('parent_commit'),fixtures.PARENT, 'provider write must bind observed parent')
        finally:
            os.chdir(before)

for channel in (0,1):
    for defect in ('read_failure','private','unmanaged','parent'):
        def check(self,channel=channel,defect=defect):
            self.exercise(channel,defect)
        setattr(ActualBlockTests,f'test_channel_{channel}_{defect}',check)

class PublicTrustDiagnosticTests(unittest.TestCase):
    """Execute the actual trust gate with inert bytes, without publisher credentials."""

    def exercise_trust(self, trust_environment):
        workflow = WORKFLOW.read_text(encoding='utf-8')
        match = re.search(r"node --input-type=module <<'NODE'\n(.*?)\n\s+NODE", workflow, re.S)
        self.assertIsNotNone(match, 'actual public trust gate must remain present')
        source = textwrap.dedent(match.group(1)).replace(
            './server/action-trust.js', (ROOT/'server/action-trust.js').as_uri()
        )
        environment = {key: os.environ[key] for key in ('PATH', 'SystemRoot') if key in os.environ}
        environment.update(GITHUB_SHA=fixtures.SOURCE, **trust_environment)
        with tempfile.TemporaryDirectory() as scratch:
            result = subprocess.run(['node', '--input-type=module'], input=source,
                                    text=True, capture_output=True, cwd=scratch,
                                    env=environment, timeout=15)
            receipt = Path(scratch)/'reports/publication-boundary/channel-a-preflight.json'
            self.assertTrue(receipt.is_file(), 'blocked public trust must retain a preflight report')
            return result, json.loads(receipt.read_text(encoding='utf-8'))

    def test_unconfigured_trust_fails_with_retained_report(self):
        result, report = self.exercise_trust({})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report['status'], 'BLOCKED')
        self.assertEqual(report['reason'], 'PUBLIC_ACTION_TRUST_UNCONFIGURED')
        self.assertEqual(report['source_revision'], fixtures.SOURCE)
        self.assertFalse(report['publication_attempted'])
        self.assertFalse(report['public_trust_configured'])

    def test_invalid_public_trust_retains_sanitized_report(self):
        inert_value = 'INERT_INVALID_PUBLIC_TRUST_FIXTURE'
        result, report = self.exercise_trust({'IMMUNE_ACTION_PUBLIC_KEY': inert_value})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report['status'], 'BLOCKED')
        self.assertEqual(report['reason'], 'PUBLIC_ACTION_TRUST_INVALID')
        self.assertFalse(report['publication_attempted'])
        self.assertNotIn(inert_value, json.dumps(report))

    def test_configured_trust_passes_without_claiming_publication(self):
        fixture = """
        import crypto from 'node:crypto';
        import { actionTrustProofMessage } from 'TRUST_MODULE';
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const raw = publicKey.export({type:'spki', format:'der'}).subarray(-32);
        const publicKeyB64 = raw.toString('base64');
        const keyId = crypto.createHash('sha256').update(raw).digest('hex').slice(0,16);
        const epoch = 'a'.repeat(32);
        const volume = 'fixture/immutable';
        const proof = crypto.sign(null, actionTrustProofMessage(publicKeyB64, keyId, epoch, volume), privateKey).toString('base64');
        console.log(JSON.stringify({IMMUNE_ACTION_PUBLIC_KEY:publicKeyB64, IMMUNE_ACTION_TRUST_EPOCH:epoch, IMMUNE_ACTION_TRUST_PROOF_B64:proof, IMMUNE_AUTHORITY_VOLUME_SOURCE:volume}));
        """.replace('TRUST_MODULE', (ROOT/'server/action-trust.js').as_uri())
        environment = {key: os.environ[key] for key in ('PATH', 'SystemRoot') if key in os.environ}
        generated = subprocess.run(['node', '--input-type=module'], input=fixture,
                                   text=True, capture_output=True, env=environment,
                                   check=True, timeout=15)
        result, report = self.exercise_trust(json.loads(generated.stdout))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report['status'], 'DECLARED')
        self.assertEqual(report['reason'], 'PUBLIC_ACTION_TRUST_CONFIGURED')
        self.assertTrue(report['public_trust_configured'])
        self.assertFalse(report['publication_attempted'])
        self.assertNotIn('publicKeyB64', report)

    def test_preflight_report_is_always_uploaded(self):
        workflow = WORKFLOW.read_text(encoding='utf-8')
        upload = workflow.split('- name: Retain Channel A publication boundary evidence', 1)[1].split('  channel-b:', 1)[0]
        self.assertIn('if: always()', upload)
        self.assertIn('reports/publication-boundary/channel-a-preflight.json', upload)
        self.assertIn('if-no-files-found: error', upload)


if __name__=='__main__':
    unittest.main(verbosity=2)
