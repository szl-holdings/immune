/**
 * DECLARED type-candidate policy, not measured persistence or certification.
 * A match permits the existing observations to continue; it proves neither
 * physical locality, correct sync/locking behavior nor restart continuity.
 * Network/object-backed and unknown types fail closed. No environment bypass.
 */
export function isDeclaredLocalFilesystemCandidate(
  value: unknown,
): value is "ext4" | "xfs" | "btrfs" {
  return value === "ext4" || value === "xfs" || value === "btrfs";
}
