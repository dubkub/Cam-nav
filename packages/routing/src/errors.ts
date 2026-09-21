/**
 * Routing failures a caller can act on, separated from failures they cannot.
 *
 * "Your destination is outside the area I have loaded" is the caller's problem
 * and should read as a 4xx; "the upstream engine returned a 500" is ours. An
 * API that reports both as a server error teaches users to ignore both.
 */
export type RoutingErrorKind =
  /** Origin or destination lies outside the loaded/served area. */
  | 'out_of_coverage'
  /** Points are in coverage but nothing connects them. */
  | 'no_route'
  /** Origin and destination are effectively the same place. */
  | 'degenerate'
  /** The upstream engine failed. */
  | 'engine_failure';

export class RoutingError extends Error {
  readonly kind: RoutingErrorKind;
  /** Suggested HTTP status, so transports do not have to re-derive it. */
  readonly statusCode: number;

  constructor(kind: RoutingErrorKind, message: string) {
    super(message);
    this.name = 'RoutingError';
    this.kind = kind;
    this.statusCode = kind === 'engine_failure' ? 502 : 422;
  }
}

export function isRoutingError(error: unknown): error is RoutingError {
  return error instanceof RoutingError;
}
