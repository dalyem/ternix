import { z } from 'zod';

export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'registration_closed',
  'invalid_invite',
  'email_taken',
  'key_version_mismatch',
  'internal',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** The `error` object inside the envelope. */
export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Body of every non-2xx response: `{"error": {"code", "message"}}`. */
export const errorEnvelopeSchema = z.object({ error: apiErrorSchema });
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * HTTP status the server uses for each code. The protocol fixes only 401, 404 and
 * 409 explicitly; the rest follow the usual meaning.
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  registration_closed: 403,
  invalid_invite: 400,
  email_taken: 409,
  key_version_mismatch: 409,
  internal: 500,
};
