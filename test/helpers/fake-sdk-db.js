// Test double for 'sdk/db': a schema DSL that only records what schema.js
// declares (table and column names), so it can be compared with schema.sql.

const chain = (data = {}) =>
  new Proxy(data, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      return () => chain(target);
    },
  });

const column = (name) => chain({ __column: name });
export const integer = column;
export const text = column;
export const boolean = column;
export const real = column;
export const json = column;
export const blob = column;

export const index = () => chain();
export const uniqueIndex = () => chain();
export const unique = () => chain();
export const primaryKey = () => chain();
export const check = () => chain();
export const sql = () => chain();

export function table(name, columns, extra) {
  const refs = Object.fromEntries(Object.keys(columns).map((k) => [k, chain()]));
  if (extra) extra(refs);
  return chain({
    __table: name,
    __columns: Object.entries(columns).map(([key, col]) => col.__column ?? key),
  });
}
