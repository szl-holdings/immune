import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  actionTrustDocumentFromEnvironment,
  actionTrustProofMessage,
  parseActionTrustDocument,
} from "../server/action-trust.js";
import { requireExactCiSuccess } from "../scripts/require-exact-ci-success.mjs";
import { assertAuthorityVolumeMatchesTrust } from "../server/tools/immune-authority-action";

function signedTrustEnvironment() {
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyB64 = publicDer.subarray(-32).toString("base64");
  const keyId = crypto
    .createHash("sha256")
    .update(publicDer.subarray(-32))
    .digest("hex")
    .slice(0, 16);
  const trustEpoch = "ab".repeat(16);
  const volumeSource = "SZLHOLDINGS/immune-authority";
  const proof = crypto
    .sign(
      null,
      actionTrustProofMessage(publicKeyB64, keyId, trustEpoch, volumeSource),
      pair.privateKey,
    )
    .toString("base64");
  return {
    IMMUNE_ACTION_PUBLIC_KEY: publicKeyB64,
    IMMUNE_ACTION_TRUST_EPOCH: trustEpoch,
    IMMUNE_ACTION_TRUST_PROOF_B64: proof,
    IMMUNE_AUTHORITY_VOLUME_SOURCE: volumeSource,
  };
}

test("public trust bootstrap requires a matching owner-key possession proof", () => {
  assert.deepEqual(actionTrustDocumentFromEnvironment({}), {
    schema: "szl.immune-action-trust/v1",
    configured: false,
  });
  assert.throws(
    () =>
      actionTrustDocumentFromEnvironment({
        IMMUNE_ACTION_PUBLIC_KEY: "partial",
      }),
    /canonical base64/,
  );
  const environment = signedTrustEnvironment();
  const configured = actionTrustDocumentFromEnvironment(environment);
  assert.equal(configured.configured, true);
  if (!configured.configured) assert.fail("trust unexpectedly unconfigured");
  assert.match(configured.keyId, /^[a-f0-9]{16}$/);
  assert.equal(configured.trustEpoch, environment.IMMUNE_ACTION_TRUST_EPOCH);
  assert.throws(
    () =>
      parseActionTrustDocument({
        ...configured,
        trustEpoch: "cd".repeat(16),
      }),
    /possession proof/,
  );
  assert.throws(
    () => parseActionTrustDocument({ ...configured, extra: true }),
    /unknown fields/,
  );
});

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("provider bucket must exactly match the owner-signed trust volume", () => {
  const trust = actionTrustDocumentFromEnvironment(signedTrustEnvironment());
  if (!trust.configured) assert.fail("trust unexpectedly unconfigured");
  const observed = {
    type: "bucket" as const,
    source: trust.durability.source,
    mountPath: "/data" as const,
    readOnly: false as const,
  };
  assert.doesNotThrow(() => assertAuthorityVolumeMatchesTrust(observed, trust));
  // Even a release receipt agreeing with provider bucket B must not override
  // the owner's independently signed trust binding to bucket A.
  for (const source of ["SZLHOLDINGS/other-authority", `${observed.source} `, ""]) {
    assert.throws(
      () => assertAuthorityVolumeMatchesTrust({ ...observed, source }, trust),
      /provider authority volume does not match owner-signed trust binding/,
    );
  }
});

test("production gate requires successful exact-head CI and stable main", async () => {
  const revision = "a".repeat(40);
  const requests: string[] = [];
  const evidence = await requireExactCiSuccess({
    environment: {
      GITHUB_REPOSITORY: "szl-holdings/immune",
      GITHUB_SHA: revision,
      GITHUB_TOKEN: "test-token",
      CI_WAIT_ATTEMPTS: "1",
    },
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/commits/main")) return response({ sha: revision });
      return response({
        workflow_runs: [
          {
            id: 42,
            head_sha: revision,
            head_branch: "main",
            event: "push",
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
            created_at: "2026-08-30T12:00:00Z",
          },
        ],
      });
    },
    sleep: async () => {},
  });
  assert.equal(evidence.conclusion, "success");
  assert.equal(requests.filter((url) => url.endsWith("/commits/main")).length, 2);
  assert.equal(evidence.workflows.length, 6);
  assert.equal(
    requests.filter((url) => url.includes("/actions/workflows/")).length,
    6,
  );
});

test("production gate rejects red CI and protected-main drift", async () => {
  const revision = "a".repeat(40);
  await assert.rejects(
    requireExactCiSuccess({
      environment: {
        GITHUB_REPOSITORY: "szl-holdings/immune",
        GITHUB_SHA: revision,
        GITHUB_TOKEN: "test-token",
        CI_WAIT_ATTEMPTS: "1",
      },
      fetchImpl: async (input) =>
        String(input).endsWith("/commits/main")
          ? response({ sha: revision })
          : response({
              workflow_runs: [
                {
                  id: 43,
                  head_sha: revision,
                  head_branch: "main",
                  event: "push",
                  status: "completed",
                  conclusion: "failure",
                  created_at: "2026-08-30T12:00:00Z",
                },
              ],
            }),
      sleep: async () => {},
    }),
    /terminal failure/,
  );
  await assert.rejects(
    requireExactCiSuccess({
      environment: {
        GITHUB_REPOSITORY: "szl-holdings/immune",
        GITHUB_SHA: revision,
        GITHUB_TOKEN: "test-token",
        CI_WAIT_ATTEMPTS: "1",
      },
      fetchImpl: async () => response({ sha: "b".repeat(40) }),
      sleep: async () => {},
    }),
    /main drifted/,
  );
});

test("production workflows preserve bounded publication and separate authority release proof", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const deploy = fs.readFileSync(
    path.join(root, ".github/workflows/deploy-hf-space.yml"),
    "utf8",
  );
  const authority = fs.readFileSync(
    path.join(root, ".github/workflows/immune-authority-action.yml"),
    "utf8",
  );
  const dockerfile = fs.readFileSync(
    path.join(root, "frontend/deploy/Dockerfile"),
    "utf8",
  );
  const operator = fs.readFileSync(
    path.join(root, "server/tools/immune-authority-action.ts"),
    "utf8",
  );

  const concurrencyGroup = (workflow: string) =>
    workflow.match(/concurrency:\s*\r?\n\s+group:\s*([^\s#]+)/)?.[1] ?? null;
  assert.equal(concurrencyGroup(deploy), "immune-production-mutation");
  assert.equal(concurrencyGroup(authority), "immune-production-mutation");
  assert.match(deploy, /cancel-in-progress:\s*false/);
  assert.match(authority, /cancel-in-progress:\s*false/);

  const exactCi = deploy.indexOf("node scripts/require-exact-ci-success.mjs");
  const publisher = deploy.indexOf("result = publish_existing(");
  assert.ok(exactCi >= 0);
  assert.ok(publisher > exactCi);
  const publicTrust = deploy.indexOf("const trust = actionTrustDocumentFromEnvironment()");
  const firstCredential = deploy.indexOf("HF_TOKEN: ${{ secrets.HF_TOKEN }}");
  assert.ok(publicTrust > exactCi && firstCredential > publicTrust);
  assert.match(deploy, /if \(!trust\.configured\) throw new Error/);
  assert.match(deploy, /IMMUNE_ACTION_TRUST_PROOF_B64/);
  assert.match(deploy, /IMMUNE_AUTHORITY_VOLUME_SOURCE/);
  assert.equal((deploy.match(/result = publish_existing\(/g) ?? []).length, 2);
  assert.doesNotMatch(deploy, /create_repo\(|update_repo_settings\(|add_space_variable\(|api\.create_commit\(|CommitOperationDelete/);
  // A source publication boundary receipt must never masquerade as the
  // separately qualified, attested live receipt required by the operator.
  assert.match(deploy, /NOT an external-authority release/);
  assert.doesNotMatch(deploy, /actions\/attest@|subject-path:\s*immune-hf-release-receipt/);

  assert.match(authority, /expected_authority_instance_id:/);
  assert.match(authority, /expected_revision:/);
  assert.match(authority, /expected_receipt_hash:/);
  assert.match(
    authority,
    /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/,
  );
  assert.match(authority, /run-id:\s*\$\{\{ steps\.discovery\.outputs\.deploy_run_id \}\}/);
  assert.match(authority, /name:\s*immune-hf-release-\$\{\{ github\.sha \}\}/);
  assert.match(
    authority,
    /gh attestation verify[\s\S]*--signer-workflow "szl-holdings\/immune\/\.github\/workflows\/deploy-hf-space\.yml"/,
  );
  assert.match(authority, /--deny-self-hosted-runners/);
  assert.match(
    authority,
    /\/usr\/bin\/env -i[\s\S]*IMMUNE_ACTION_SIGNING_PKCS8_B64="\$\{ACTION_PRIVATE_KEY\}"[\s\S]*immune-authority-signer\.mjs/,
  );
  assert.equal(
    (
      authority.match(
        /secrets\.IMMUNE_ACTION_SIGNING_PKCS8_B64/g,
      ) ?? []
    ).length,
    2,
  );
  const networkStepNames = [
    "Discover immutable deploy run without signer access",
    "Prepare exact unsigned intent without signer access",
    "Submit exactly once and reconcile exact action",
    "Prepare bounded fail-closed cleanup after uncertain submit",
    "Submit one bounded fail-closed cleanup and reconcile it",
  ];
  for (const name of networkStepNames) {
    const start = authority.indexOf(`- name: ${name}`);
    assert.ok(start >= 0, name);
    const next = authority.indexOf("\n      - name:", start + 1);
    const step = authority.slice(start, next < 0 ? authority.length : next);
    assert.doesNotMatch(step, /IMMUNE_ACTION_SIGNING_PKCS8_B64/, name);
  }
  assert.match(authority, /default:\s*"15"/);
  assert.match(authority, /prepare-reject/);
  assert.match(
    authority,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g,
  );
  assert.match(authority, /immune-authority-application-evidence\.json/);
  assert.match(authority, /immune-authority-failclosed-evidence\.json/);
  assert.match(authority, /retention-days:\s*90/);
  assert.match(
    authority,
    /steps\.apply-action\.outcome == 'failure' && inputs\.mode == 'PASS'/,
  );
  assert.doesNotMatch(authority, /\+\s{8,}(?:discover|--|immune-authority)/);

  assert.match(
    dockerfile,
    /COPY dist\/immune-action-trust\.json \.\/immune-action-trust\.json/,
  );
  assert.match(operator, /receipt\.authority\.instance_id/);
  assert.match(operator, /assertAuthorityVolumeMatchesTrust\(volume, trust\)/);
  assert.match(operator, /receipt\.outputs\.files/);
  assert.match(operator, /pollExactReceipt/);
  assert.match(operator, /Do not retry this mutation/);
  assert.match(operator, /signedEnvelope:\s*envelope/);
  assert.match(operator, /appliedReceipt:\s*receipt/);
  assert.match(operator, /retained-in-evidence-artifact/);
  assert.doesNotMatch(operator, /IMMUNE_ACTION_SIGNING_PKCS8_B64/);
  assert.match(deploy, /reports\/publication-boundary\/channel-a\.json/);
  assert.match(authority, /immune-hf-release-\$\{\{ github\.sha \}\}/);
});
