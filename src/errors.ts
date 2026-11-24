/** Structured API errors — every failure response has { error: { code, message } }.
 *  Same shape as miirra-api so the whole platform speaks one error envelope. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'bad_request') => new ApiError(400, code, message);
export const unauthorized = (message = 'Not signed in') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new ApiError(409, code, message);
export const tooManyRequests = (message: string, code = 'rate_limited') =>
  new ApiError(429, code, message);

/**
 * A provider/ledger failure surfaced to the caller. Distinct from a plain
 * badRequest: this means "we called out and the other side said no or broke".
 * Carries the downstream status so a route can map 429s and declines correctly.
 */
export class UpstreamError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    public downstreamStatus?: number,
    public downstreamBody?: unknown,
  ) {
    super(status, code, message);
  }
}

export const upstream = (message: string, downstreamStatus?: number, downstreamBody?: unknown) =>
  new UpstreamError(502, 'upstream_error', message, downstreamStatus, downstreamBody);

export const providerDeclined = (message: string, code = 'provider_declined') =>
  new UpstreamError(422, code, message);