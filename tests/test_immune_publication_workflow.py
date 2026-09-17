"""Run IDENTICAL policy regressions against supplied actual workflow Python blocks.

This harness uses recording SDK objects and temporary files only; it cannot call
an actual provider. BASE or REPAIRED is selected as a local workflow path.
"""
import contextlib
import io
import os
from pathlib import Path
import sys
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

if __name__=='__main__':
    unittest.main(verbosity=2)
