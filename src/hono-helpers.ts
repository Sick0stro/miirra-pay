import type { Context } from 'hono';

import { notFound } from './errors';
import { isUuid } from './ids';

/** Route params are always present when the route matched — assert once, here. */
export const param = (c: Context, name: string): string => c.req.param(name) as string;

/**
 * Param for routes whose id is a uuid column. Garbage ids (a template rendering
 * `undefined` into the path) become 404s instead of Postgres 500s.
 */
export const uuidParam = (c: Context, name: string): string => {
  const v = param(c, name);
  if (!isUuid(v)) throw notFound('Resource not found');
  return v;
};