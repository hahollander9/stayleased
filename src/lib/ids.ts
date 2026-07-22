import { randomBytes } from 'node:crypto';

let counter = 0;

/** Sortable, prefixed, collision-safe id: `<prefix>_<time36><counter><rand>` */
export function id(prefix: string): string {
  counter = (counter + 1) % 1296;
  const t = Date.now().toString(36).padStart(9, '0');
  const c = counter.toString(36).padStart(2, '0');
  const r = randomBytes(5).toString('hex');
  return `${prefix}_${t}${c}${r}`;
}

export function token(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
