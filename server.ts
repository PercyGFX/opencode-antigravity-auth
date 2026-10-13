// opencode v2 entry point. v2 loads a plugin package's `server` export (or a plugin directory's
// `server.*` file) and accepts only a default export; v1 keeps loading `index.ts` as before.
import { createAntigravityV2Plugin } from "./src/opencode-v2";

export default createAntigravityV2Plugin();
