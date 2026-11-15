// Test double for the platform's 'sdk' module. `api` and `db` forward to the
// fakes installed with installSdkFakes(), so each test gets fresh ones.
export { FakeBotApiError as BotApiError } from './fake-api.js';

let current = null;

export function installSdkFakes(fakes) {
  current = fakes;
}

const forward = (key) =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (!current) throw new Error(`sdk.${key} used before installSdkFakes()`);
        const value = current[key][prop];
        return typeof value === 'function' ? value.bind(current[key]) : value;
      },
    },
  );

export const api = forward('api');
export const db = forward('db');
