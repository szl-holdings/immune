export const ACTION_TRUST_SCHEMA: "szl.immune-action-trust/v1";

export type ActionTrustDocument =
  | {
      readonly schema: typeof ACTION_TRUST_SCHEMA;
      readonly configured: false;
    }
  | {
      readonly schema: typeof ACTION_TRUST_SCHEMA;
      readonly configured: true;
      readonly publicKeyB64: string;
      readonly keyId: string;
      readonly trustEpoch: string;
      readonly possessionProofB64: string;
      readonly durability: {
        readonly kind: "hf-write-volume-v1";
        readonly source: string;
        readonly mountPath: "/data";
        readonly authorityDataDir: "/data/immune";
      };
    };

export function actionTrustProofMessage(
  publicKeyB64: string,
  keyId: string,
  trustEpoch: string,
  volumeSource: string,
): Buffer;
export function parseActionTrustDocument(value: unknown): ActionTrustDocument;
export function actionTrustDocumentFromEnvironment(
  environment?: NodeJS.ProcessEnv,
): ActionTrustDocument;
export function loadActionTrustDocument(filePath: string): ActionTrustDocument;
