// Register the web test resolver hook from a distinct module.
//
// Older Node 22 loader-worker builds are stricter when a module calls
// module.register() on its own URL and then gets re-imported as the hook module.
// Keep the registration side effect here, and keep web-ts-alias-loader.mjs as
// the pure hook implementation.
import { register } from "node:module";

if (!globalThis.__careerOpsWebAliasRegistered) {
  globalThis.__careerOpsWebAliasRegistered = true;
  register(new URL("./web-ts-alias-loader.mjs", import.meta.url), import.meta.url);
}
