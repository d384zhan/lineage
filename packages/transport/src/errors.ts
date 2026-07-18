import type { ErrorCode } from "@lineage/contracts";

export class TransportError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}
