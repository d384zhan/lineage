import type {
  IntentConflict,
  IntentRecord,
} from "@lineage/contracts";

function normalizeAssumptionValue(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll(/\s+/g, " ");
}

export function detectIntentConflicts(
  candidate: IntentRecord,
  activeIntents: readonly IntentRecord[],
  detectedAt: string,
): IntentConflict[] {
  const conflicts: IntentConflict[] = [];

  for (const existing of activeIntents) {
    if (existing.id === candidate.id || existing.status !== "active") continue;

    for (const left of existing.assumptions) {
      for (const right of candidate.assumptions) {
        if (left.key.trim().toLocaleLowerCase() !== right.key.trim().toLocaleLowerCase()) {
          continue;
        }
        if (normalizeAssumptionValue(left.value) === normalizeAssumptionValue(right.value)) {
          continue;
        }
        conflicts.push({
          type: "assumption_mismatch",
          key: right.key.trim(),
          left: {
            intentId: existing.id,
            author: existing.author,
            value: left.value,
          },
          right: {
            intentId: candidate.id,
            author: candidate.author,
            value: right.value,
          },
          detectedAt,
        });
      }
    }
  }

  return conflicts;
}
