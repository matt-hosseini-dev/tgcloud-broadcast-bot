// Loaded with `node --import` before every test file. Maps the platform-only
// imports to test doubles so tgcloud modules load in plain Node:
//   'sdk'       -> fake-sdk.js     (api/db forward to the fakes a test installs)
//   'sdk/db'    -> fake-sdk-db.js  (schema DSL that records table declarations)
//   lib/config.js (git-ignored, generated) -> test-config.js
import { registerHooks } from 'node:module';

const here = (file) => new URL(file, import.meta.url).href;
const FAKES = {
  sdk: here('./fake-sdk.js'),
  'sdk/db': here('./fake-sdk-db.js'),
};
const TEST_CONFIG = here('./test-config.js');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(FAKES, specifier)) return { url: FAKES[specifier], shortCircuit: true };
    if (specifier === './config.js' && /\/tgcloud\/lib\/[^/]+$/.test(context.parentURL ?? '')) {
      return { url: TEST_CONFIG, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
