/**
 * Decision Genome v1.
 *
 * Portable evidence and authority contract shared by reasoning planes such as
 * Immune and constrained action planes such as Killinchu. A Decision Genome is
 * append-only: observations, recommendations, approvals, denials, executions,
 * and outcomes are events tied to exact subject and predecessor digests.
 */
import { z } from 'zod';

export const DECISION_GENOME_SCHEMA_ID = 'urn:szl:contracts:decision-genome:v1' as const;

export const EvidenceLabelSchema = z.enum([
  'PROVED',
  'MEASURED',
  'VERIFIED',
  'MODELED',
  'UNAVAILABLE',
]);
export type EvidenceLabel = z.infer<typeof EvidenceLabelSchema>;

export const SourceStateSchema = z.enum([
  'LIVE',
  'CACHED',
  'STALE',
  'DEGRADED',
  'UNAVAILABLE',
  'CONFLICTED',
  'WITHDRAWN',
  'PLANNED',
]);
export type SourceState = z.infer<typeof SourceStateSchema>;

export const DecisionStateSchema = z.enum([
  'ALLOW_OBSERVE',
  'REVIEW_REQUIRED',
  'QUARANTINE_RECOMMENDED',
  'WITHHOLD',
]);
export type DecisionState = z.infer<typeof DecisionStateSchema>;

export const ActionClassSchema = z.enum([
  'OBSERVE',
  'OPEN_INCIDENT',
  'REQUEST_READ_ONLY_PROBE',
  'REQUEST_QUARANTINE_REVIEW',
  'EXPORT_RECEIPT',
]);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const DecisionSourceSchema = z.object({
  sourceName: z.string().min(1).max(128),
  sourceUrl: z.string().url().optional(),
  upstreamObjectId: z.string().max(512).optional(),
  upstreamVersion: z.string().max(256).optional(),
  publishedAt: z.string().datetime().optional(),
  modifiedAt: z.string().datetime().optional(),
  observedAt: z.string().datetime(),
  fetchedAt: z.string().datetime(),
  eventTime: z.string().datetime().optional(),
  ingestionRunId: z.string().max(256).optional(),
  parserVersion: z.string().max(128),
  rawPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  licenseSpdxOrTermsUrl: z.string().max(1024),
  distributionMarking: z.string().max(128),
  confidence: z.number().min(0).max(1),
  locationPrecision: z.string().max(128).optional(),
  expiresAt: z.string().datetime().optional(),
  supersedes: z.string().max(512).optional(),
  state: SourceStateSchema,
});
export type DecisionSource = z.infer<typeof DecisionSourceSchema>;

export const DecisionScoreSchema = z.object({
  novelty: z.number().min(0).max(1),
  dangerContext: z.number().min(0).max(1),
  baselineAnomaly: z.number().min(0).max(1),
  causalShift: z.number().min(0).max(1),
  propagationRisk: z.number().min(0).max(1),
  compositeRisk: z.number().min(0).max(1),
  conformalPValue: z.number().min(0).max(1).nullable(),
  falseAlertBudgetAlpha: z.number().gt(0).lt(1),
  uncertainty: z.number().min(0).max(1),
});
export type DecisionScore = z.infer<typeof DecisionScoreSchema>;

export const DecisionRecommendationSchema = z.object({
  state: DecisionStateSchema,
  action: ActionClassSchema,
  reasonCodes: z.array(z.string().min(1).max(128)).min(1),
  humanApprovalRequired: z.boolean(),
  executable: z.literal(false),
  evidenceLabel: EvidenceLabelSchema,
});
export type DecisionRecommendation = z.infer<typeof DecisionRecommendationSchema>;

export const AuthorizationLeaseSchema = z.object({
  leaseId: z.string().min(1).max(256),
  issuer: z.string().min(1).max(256),
  subject: z.string().min(1).max(256),
  missionId: z.string().min(1).max(256),
  allowedActions: z.array(ActionClassSchema).min(1),
  notBefore: z.string().datetime(),
  expiresAt: z.string().datetime(),
  maxUncertainty: z.number().min(0).max(1),
  decisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verification: z.enum(['UNVERIFIED', 'VERIFIED', 'INVALID']),
  signature: z.string().min(1).optional(),
  revokedAt: z.string().datetime().optional(),
});
export type AuthorizationLease = z.infer<typeof AuthorizationLeaseSchema>;

export const DecisionGenomeEventSchema = z.object({
  eventId: z.string().min(1).max(256),
  eventType: z.enum([
    'OBSERVATION',
    'NORMALIZATION',
    'FUSION',
    'RECOMMENDATION',
    'AUTHORIZATION',
    'DENIAL',
    'EXECUTION',
    'OUTCOME',
  ]),
  at: z.string().datetime(),
  actor: z.string().min(1).max(256),
  subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inputDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
  policyVersion: z.string().min(1).max(128),
  evidenceLabel: EvidenceLabelSchema,
  payload: z.record(z.unknown()),
});
export type DecisionGenomeEvent = z.infer<typeof DecisionGenomeEventSchema>;

export const DecisionGenomeSchema = z.object({
  schemaId: z.literal(DECISION_GENOME_SCHEMA_ID),
  decisionId: z.string().min(1).max(256),
  createdAt: z.string().datetime(),
  mode: z.enum(['shadow', 'advisory', 'operational']),
  subject: z.object({
    kind: z.string().min(1).max(128),
    id: z.string().min(1).max(512),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  sources: z.array(DecisionSourceSchema).min(1),
  scores: DecisionScoreSchema,
  recommendation: DecisionRecommendationSchema,
  authorizationLease: AuthorizationLeaseSchema.optional(),
  events: z.array(DecisionGenomeEventSchema).min(1),
  previousDecisionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DecisionGenome = z.infer<typeof DecisionGenomeSchema>;
