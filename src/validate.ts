import { z } from 'zod';

import { badRequest } from './errors';

/** Validate a payload against a zod schema, throwing a 400 ApiError. */
export const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw badRequest(detail, 'validation');
  }
  return result.data;
};