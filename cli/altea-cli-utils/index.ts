// Everything the CLIs share. One import, so no tool has to know which file a helper lives in.
//
// This package exists because a CLI must not depend on another CLI: `altea-clone` needing `Git` is
// not a reason for it to depend on `altea-upgrade`. It declares NO dependencies of its own — node
// builtins only — so a tool built on it runs with nothing installed beyond itself.

export { ApplicationContext } from "./ApplicationContext.js";
export { Color, Console, type Style } from "./Console.js";
export { Git } from "./Git.js";
export { Prompt, type Choice } from "./Prompt.js";
export { parseArguments, type Arguments } from "./Arguments.js";
