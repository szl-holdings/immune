# Copyright 2026 SZL Holdings — SPDX-License-Identifier: Apache-2.0
"""Offline provider-recording fixtures. No credential or provider call is used."""
from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import immune_publication_guard as guard

SOURCE = "a" * 40
PARENT = "b" * 40
COMMIT = "c" * 40
A = "SZLHOLDINGS/immune"
B = "SZLHOLDINGS/immune-lattice"


class Add:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class Delete:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def sdk(api):
    return SimpleNamespace(CommitOperationAdd=Add, CommitOperationDelete=Delete, HfApi=lambda **kwargs: api)


class Provider:
    endpoint = "https://huggingface.co"

    def __init__(self, space=A):
        self.space = space
        self.info = SimpleNamespace(id=space, private=False, sdk="docker", sha=PARENT)
        self.names = ["Dockerfile", "README.md", ".gitattributes", ".github/NOTICE", "weights.safetensors",
                      "data/ledger.jsonl", "dist/data/immune/ledger.jsonl", "dist/public/assets/old.js"]
        self.reads = []
        self.commits = []
        self.created = []
        self.settings = []
        self.read_error = None
        self.write_error = None
        self.oid = COMMIT

    def repo_info(self, **kw):
        self.reads.append(("info", kw))
        if self.read_error:
            raise self.read_error
        return self.info

    def list_repo_files(self, repo_id=None, **kw):
        self.reads.append(("files", {"repo_id": repo_id, **kw}))
        return self.names

    def create_commit(self, **kw):
        self.commits.append(kw)
        if self.write_error:
            raise self.write_error
        return SimpleNamespace(oid=self.oid)

    def create_repo(self, **kw):
        self.created.append(kw)

    def update_repo_settings(self, **kw):
        self.settings.append(kw)


class FixtureMixin:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.api = Provider()
        self.source_check = patch.object(guard, "require_main_source").start()
        self.addCleanup(patch.stopall)
        patch.dict(sys.modules, {"huggingface_hub": sdk(self.api)}).start()
        self.uploads = self.bundle(A)
        self.journal = self.root / "reports" / "attempt.json"

    def bundle(self, space):
        spec = guard.CONTRACTS[space]
        mapping = {}
        for remote in sorted(spec["required"]):
            if space == A:
                local = spec["root"] + "/" + ("dist/hf-deploy-manifest.json" if remote == "hf-deploy-manifest.json" else remote)
            else:
                local = "python/" + (remote if remote.startswith("immune/") or remote == "requirements.txt" else "space/" + ("run.py" if remote == "server.py" else remote))
            p = self.root / local
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("fixture\n")
            mapping[remote] = local
        return mapping

    def publish(self, **kwargs):
        args = dict(api=self.api, space=A, uploads=self.uploads, revision=SOURCE,
                    checkout=self.root, receipt_path=self.journal)
        args.update(kwargs)
        return guard.publish_existing(**args)

    def blocked(self, code=None, **kwargs):
        with self.assertRaises(guard.PublicationBoundaryError) as cm:
            self.publish(**kwargs)
        if code:
            self.assertEqual(str(cm.exception), code)
        self.assertEqual(self.api.commits, [])
        self.assertEqual(self.api.created, [])
        self.assertEqual(self.api.settings, [])
        return json.loads(self.journal.read_text()) if self.journal.exists() else None


class BoundaryTests(FixtureMixin, unittest.TestCase):
    def test_existing_public_space_commits_once_with_parent(self):
        receipt = self.publish()
        self.assertEqual(len(self.api.commits), 1)
        args = self.api.commits[0]
        self.assertEqual(args['parent_commit'], PARENT)
        self.assertEqual(args['revision'], 'main')
        self.assertIs(args['create_pr'], False)
        self.assertIs(args['run_as_future'], False)
        self.assertEqual(receipt['state'], 'COMMITTED_LIVE_UNVERIFIED')
        self.assertIs(receipt['live_verified'], False)
        self.assertEqual(receipt['hub_commit'], COMMIT)
        self.assertEqual(self.api.created + self.api.settings, [])

    def test_tree_is_read_at_immutable_parent(self):
        self.publish()
        files = [kw for op, kw in self.api.reads if op == 'files']
        self.assertEqual(files, [{'repo_id': A, 'repo_type': 'space', 'revision': PARENT}])

    def test_preserves_weights_configuration_and_both_ledger_paths(self):
        receipt = self.publish()
        self.assertEqual(receipt['deleted_owned_paths'], ['dist/public/assets/old.js'])
        for name in ('.gitattributes', '.github/NOTICE', 'weights.safetensors', 'data/ledger.jsonl', 'dist/data/immune/ledger.jsonl'):
            self.assertIn(name, receipt['preserved_unowned_paths'])
        self.assertEqual([x.path_in_repo for x in self.api.commits[0]['operations'] if isinstance(x, Delete)], ['dist/public/assets/old.js'])

    def test_private_space_is_never_made_public(self):
        self.api.info.private = True
        self.blocked('SPACE_IDENTITY_OR_VISIBILITY_MISMATCH')

    def test_unknown_visibility_blocks(self):
        self.api.info.private = None
        self.blocked('SPACE_IDENTITY_OR_VISIBILITY_MISMATCH')

    def test_integer_false_visibility_blocks(self):
        self.api.info.private = 0
        self.blocked('SPACE_IDENTITY_OR_VISIBILITY_MISMATCH')

    def test_missing_space_does_not_create_replacement(self):
        self.api.read_error = FileNotFoundError('provider private diagnostics')
        self.blocked('SPACE_OBSERVATION_UNAVAILABLE')

    def test_permission_error_does_not_create_replacement(self):
        self.api.read_error = PermissionError('credential=never-print')
        report = self.blocked('SPACE_OBSERVATION_UNAVAILABLE')
        self.assertNotIn('credential', json.dumps(report))

    def test_timeout_does_not_create_replacement(self):
        self.api.read_error = TimeoutError('signed-url=never-print')
        self.blocked('SPACE_OBSERVATION_UNAVAILABLE')

    def test_wrong_repository_identity_blocks(self):
        self.api.info.id = B
        self.blocked('SPACE_IDENTITY_OR_VISIBILITY_MISMATCH')

    def test_non_docker_space_blocks(self):
        self.api.info.sdk = 'gradio'
        self.blocked('SPACE_SDK_MISMATCH')

    def test_custom_endpoint_blocks_before_provider_read(self):
        self.api.endpoint = 'https://example.invalid'
        self.blocked('UNEXPECTED_HUB_ENDPOINT')
        self.assertEqual(self.api.reads, [])

    def test_space_head_movement_blocks_before_commit(self):
        original = self.api.repo_info
        def moving(**kw):
            info = original(**kw)
            if len([x for x in self.api.reads if x[0] == 'info']) > 1:
                return SimpleNamespace(id=A, private=False, sdk='docker', sha='d'*40)
            return info
        self.api.repo_info = moving
        self.blocked('SPACE_REVISION_MOVED')

    def test_main_source_movement_blocks_before_commit(self):
        self.source_check.side_effect = [None, guard.PublicationBoundaryError('SOURCE_REVISION_MOVED')]
        self.blocked('SOURCE_REVISION_MOVED')

    def test_failed_tree_read_blocks(self):
        self.api.list_repo_files = lambda **kw: (_ for _ in ()).throw(ConnectionError('private data'))
        self.blocked('SPACE_TREE_UNAVAILABLE')

    def test_duplicate_remote_path_blocks(self):
        self.api.names = ['Dockerfile', 'Dockerfile']
        self.blocked('DUPLICATE_SPACE_PATH')

    def test_unknown_tree_shape_blocks(self):
        self.api.names = {'files': []}
        self.blocked('INVALID_SPACE_TREE')

    def test_remote_parent_traversal_blocks(self):
        self.api.names = ['../private']
        self.blocked('INVALID_PATH')

    def test_remote_absolute_path_blocks(self):
        self.api.names = ['/dist/public/assets/a.js']
        self.blocked('INVALID_PATH')

    def test_remote_path_control_character_blocks(self):
        self.api.names = ['dist/public/assets/\n.js']
        self.blocked('INVALID_PATH')

    def test_no_root_file_pruning(self):
        self.api.names = ['legacy-server.py', 'operator-notes.txt', 'hf-deploy-manifest-previous.json']
        report = self.publish()
        self.assertEqual(report['deleted_owned_paths'], [])
        self.assertEqual(report['preserved_unowned_paths'], sorted(self.api.names))

    def test_missing_required_application_file_blocks(self):
        del self.uploads['dist/public/index.html']
        self.blocked('INCOMPLETE_UPLOAD_SET')

    def test_missing_build_manifest_blocks(self):
        del self.uploads['hf-deploy-manifest.json']
        self.blocked('INCOMPLETE_UPLOAD_SET')

    def test_empty_required_artifact_blocks(self):
        (self.root/self.uploads['Dockerfile']).write_bytes(b'')
        self.blocked('EMPTY_REQUIRED_FILE')

    def test_missing_local_file_blocks(self):
        (self.root/self.uploads['README.md']).unlink()
        self.blocked('LOCAL_FILE_UNAVAILABLE')

    def test_directory_in_place_of_local_file_blocks(self):
        p = self.root/self.uploads['README.md']; p.unlink(); p.mkdir()
        self.blocked('LOCAL_FILE_BOUNDARY')

    def test_file_size_bound_blocks(self):
        with patch.object(guard, 'MAX_FILE_BYTES', 3):
            self.blocked('LOCAL_FILE_BOUNDARY')

    def test_bundle_size_bound_blocks(self):
        with patch.object(guard, 'MAX_TOTAL_BYTES', 10):
            self.blocked('LOCAL_BUNDLE_TOO_LARGE')

    def test_leaf_symlink_blocks(self):
        p = self.root/self.uploads['README.md']; p.unlink()
        (self.root/'hidden').write_text('secret'); p.symlink_to(self.root/'hidden')
        self.blocked('LOCAL_SYMLINK')

    def test_directory_symlink_blocks(self):
        external=self.root/'external'; external.mkdir(); (external/'file.js').write_text('fixture')
        (self.root/'frontend/deploy/link').symlink_to(external, target_is_directory=True)
        self.uploads['dist/public/assets/new.js']='frontend/deploy/link/file.js'
        self.blocked('LOCAL_SYMLINK')

    def test_local_path_outside_source_blocks(self):
        self.uploads['README.md']='private.txt'
        self.blocked('LOCAL_PATH_OUTSIDE_SOURCE')

    def test_local_parent_traversal_blocks(self):
        self.uploads['README.md']='frontend/deploy/../../private.txt'
        self.blocked('INVALID_PATH')

    def test_unknown_upload_destination_blocks(self):
        self.uploads['.env']='frontend/deploy/README.md'
        self.blocked('UPLOAD_OUTSIDE_OWNED_SCOPE')

    def test_frozen_bytes_match_receipt_digests(self):
        report=self.publish()
        for op in self.api.commits[0]['operations']:
            if isinstance(op, Add):
                self.assertIsInstance(op.path_or_fileobj, bytes)
                self.assertEqual(hashlib.sha256(op.path_or_fileobj).hexdigest(),report['upload_sha256'][op.path_in_repo])

    def test_local_change_after_freeze_does_not_change_uploaded_bytes(self):
        original=self.api.repo_info
        def change(**kw):
            (self.root/self.uploads['README.md']).write_text('changed after freeze')
            return original(**kw)
        self.api.repo_info=change
        self.publish()
        op=next(o for o in self.api.commits[0]['operations'] if isinstance(o,Add) and o.path_in_repo=='README.md')
        self.assertEqual(op.path_or_fileobj,b'fixture\n')

    def test_lattice_uses_only_its_own_prune_namespace(self):
        self.api.space=B; self.api.info.id=B
        self.api.names=['immune/retired.py','data/ledger.jsonl','nexus.html','.gitattributes','model.bin']
        report=self.publish(space=B,uploads=self.bundle(B))
        self.assertEqual(report['deleted_owned_paths'],['immune/retired.py'])
        self.assertIn('nexus.html',report['preserved_unowned_paths'])

    def test_commit_error_stays_unknown_no_retry(self):
        self.api.write_error=TimeoutError('Authorization: secret URL')
        with self.assertRaisesRegex(guard.PublicationBoundaryError,'UNKNOWN_AFTER_ATTEMPT'):
            self.publish()
        self.assertEqual(len(self.api.commits),1)
        raw=self.journal.read_text(); report=json.loads(raw)
        self.assertEqual(report['state'],'UNKNOWN_AFTER_ATTEMPT')
        self.assertFalse(report['live_verified'])
        self.assertNotIn('Authorization',raw)
        self.assertNotIn('secret URL',raw)

    def test_invalid_commit_identity_stays_unknown(self):
        self.api.oid=None
        with self.assertRaisesRegex(guard.PublicationBoundaryError,'UNKNOWN_AFTER_ATTEMPT'):
            self.publish()
        self.assertEqual(len(self.api.commits),1)
        self.assertEqual(json.loads(self.journal.read_text())['state'],'UNKNOWN_AFTER_ATTEMPT')

    def test_journal_exists_before_sdk_mutation(self):
        original=self.api.create_commit
        def inspect(**kw):
            self.assertEqual(json.loads(self.journal.read_text())['state'],'ATTEMPT_JOURNALED')
            return original(**kw)
        self.api.create_commit=inspect
        self.publish()

    def test_existing_journal_refuses_repeated_attempt(self):
        self.publish()
        with self.assertRaises(FileExistsError):
            self.publish()
        self.assertEqual(len(self.api.commits),1)

    def test_unknown_space_blocks(self):
        self.blocked('UNSUPPORTED_SPACE',space='SZLHOLDINGS/other')

    def test_zero_revision_blocks(self):
        self.blocked('INVALID_REVISION',revision='0'*40)

    def test_short_revision_blocks(self):
        self.blocked('INVALID_REVISION',revision='abc123')

    def test_missing_parent_identity_blocks(self):
        self.api.info.sha=None
        self.blocked('INVALID_REVISION')


class SourceReadbackTests(unittest.TestCase):
    def check(self, *, env=None, head=SOURCE, main=SOURCE+'\trefs/heads/main', error=None):
        with patch.dict(os.environ, env or {'GITHUB_REF':'refs/heads/main','GITHUB_REPOSITORY':'szl-holdings/immune'}, clear=True):
            with patch.object(guard.subprocess,'run',side_effect=error or [SimpleNamespace(stdout=head),SimpleNamespace(stdout=main)]) as run:
                guard.require_main_source(SOURCE,Path('.'))
                return run

    def test_actual_head_and_main_match(self):
        self.assertEqual(self.check().call_count,2)

    def test_nonmain_dispatch_blocks(self):
        with self.assertRaisesRegex(guard.PublicationBoundaryError,'SOURCE_NOT_CANONICAL_MAIN'):
            self.check(env={'GITHUB_REF':'refs/heads/feature','GITHUB_REPOSITORY':'szl-holdings/immune'})

    def test_wrong_repository_blocks(self):
        with self.assertRaisesRegex(guard.PublicationBoundaryError,'SOURCE_NOT_CANONICAL_MAIN'):
            self.check(env={'GITHUB_REF':'refs/heads/main','GITHUB_REPOSITORY':'other/immune'})

    def test_checkout_mismatch_blocks(self):
        with self.assertRaisesRegex(guard.PublicationBoundaryError,'SOURCE_REVISION_MOVED'):
            self.check(head='d'*40)

    def test_newer_remote_main_blocks(self):
        with self.assertRaisesRegex(guard.PublicationBoundaryError,'SOURCE_REVISION_MOVED'):
            self.check(main='d'*40+'\trefs/heads/main')

    def test_multiple_remote_rows_block(self):
        with self.assertRaisesRegex(guard.PublicationBoundaryError,'SOURCE_REVISION_MOVED'):
            self.check(main=SOURCE+'\trefs/heads/main\n'+SOURCE+'\trefs/heads/other')

    def test_git_failure_sanitizes_error(self):
        with self.assertRaisesRegex(guard.PublicationBoundaryError,'SOURCE_READBACK_UNAVAILABLE'):
            self.check(error=subprocess.CalledProcessError(1,['git'],stderr='hidden-provider-details'))


def inline_publishers(path):
    text=path.read_text()
    return re.findall(r'          python3 <<\'PY\'\n(.*?)          PY\n',text,re.S)


class WorkflowTests(FixtureMixin, unittest.TestCase):
    def test_both_workflow_blocks_execute_guarded_publication(self):
        workflow=Path(__file__).resolve().parents[1]/'.github/workflows/deploy-hf-space.yml'
        blocks=inline_publishers(workflow)
        self.assertEqual(len(blocks),2)
        self.bundle(B)
        before=Path.cwd()
        try:
            os.chdir(self.root)
            for space, block in zip((A,B),blocks):
                self.api.info.id=space
                with patch.dict(os.environ,{'HF_SPACE':space,'HF_TOKEN':'inert-test-fixture','GITHUB_SHA':SOURCE}):
                    with patch.dict(sys.modules,{'scripts.immune_publication_guard':guard}):
                        exec(compile(textwrap.dedent(block),'native-workflow-block','exec'),{})
            self.assertEqual(len(self.api.commits),2)
            self.assertEqual(self.api.created+self.api.settings,[])
            for record in self.api.commits:
                self.assertEqual(record['parent_commit'],PARENT)
        finally:
            os.chdir(before)

    def test_management_secrets_are_not_job_environment(self):
        workflow=Path(__file__).resolve().parents[1]/'.github/workflows/deploy-hf-space.yml'
        text=workflow.read_text()
        self.assertNotRegex(text, r'(?m)^      HF_TOKEN:')
        self.assertEqual(len(re.findall(r'(?m)^          HF_TOKEN: \$\{\{ secrets\.HF_TOKEN \}\}',text)),4)
        allowed={'Require write-scoped HF_TOKEN',
                 'Publish existing Channel A with bounded ownership and parent guard',
                 'Publish existing Channel B with bounded ownership and parent guard'}
        for block in re.split(r'(?m)^      - ',text)[1:]:
            if 'secrets.HF_TOKEN' in block:
                self.assertIn(block.splitlines()[0].removeprefix('name: '),allowed)
        self.assertEqual(text.count('Require canonical main before credential use'),2)

    def test_management_api_origin_is_explicitly_pinned(self):
        workflow=Path(__file__).resolve().parents[1]/'.github/workflows/deploy-hf-space.yml'
        text=workflow.read_text()
        self.assertEqual(text.count('HfApi(endpoint="https://huggingface.co",'),4)
        self.assertNotIn('HfApi(token=',text)

    def test_original_mutation_fallbacks_absent(self):
        workflow=Path(__file__).resolve().parents[1]/'.github/workflows/deploy-hf-space.yml'
        for block in inline_publishers(workflow):
            tree=ast.parse(textwrap.dedent(block))
            calls={node.func.attr for node in ast.walk(tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute)}
            self.assertFalse(calls & {'create_repo','update_repo_settings','create_commit','list_repo_files'})
        s=workflow.read_text()
        self.assertIn('scripts/immune_publication_guard.py',s)
        self.assertEqual(s.count('Validate publication boundary offline'),2)
        self.assertEqual(s.count('immune-publication-boundary-'),2)



if __name__=='__main__':
    unittest.main()
