// Test double for 'sdk/db': a schema DSL that only records what schema.js
// declares (columns, NOT NULL, primary keys, UNIQUE, defaults), so
// test/schema.test.js can compare it with test/helpers/schema.sql.

function column(name) {
  const col = { name, notNull: false, primaryKey: false, unique: false, default: undefined };
  const api = {
    __column: col,
    notNull: () => ((col.notNull = true), api),
    primaryKey: () => ((col.primaryKey = true), api),
    unique: () => ((col.unique = true), api),
    default: (value) => ((col.default = value), api),
  };
  return new Proxy(api, {
    get: (target, prop) =>
      prop in target ? target[prop] : prop === 'then' ? undefined : () => api,
  });
}

export const integer = column;
export const text = column;
export const boolean = column;
export const real = column;
export const json = column;
export const blob = column;

const inert = () =>
  new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : () => inert()) });

export const index = inert;
export const uniqueIndex = inert;
export const unique = inert;
export const check = inert;
export const sql = inert;
export const primaryKey = ({ columns }) => ({ __primaryKey: columns.map((c) => c.__ref) });

export function table(name, columns, extra) {
  const cols = Object.entries(columns).map(([key, c]) => ({
    ...c.__column,
    name: c.__column.name ?? key,
  }));
  const refs = Object.fromEntries(
    Object.entries(columns).map(([key, c]) => [key, { __ref: c.__column.name ?? key }]),
  );
  const constraints = extra ? Object.values(extra(refs)) : [];
  const composite = constraints.find((c) => Array.isArray(c?.__primaryKey))?.__primaryKey;
  return {
    __table: name,
    __columns: cols,
    __primaryKey: composite ?? cols.filter((c) => c.primaryKey).map((c) => c.name),
  };
}
