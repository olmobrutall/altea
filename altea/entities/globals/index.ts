// Barrel for the global prototype/type extensions and shared helpers, split out of the
// former monolithic globals.ts. Importing this module (for side effects) installs every
// Array / String / RegExp / Temporal augmentation and re-exports the value helpers.

// Prototype / global augmentations (side-effect only — no value exports).
import "./arrayExtensions";
import "./stringExtensions";
import "./regExpExtensions";

// Modules that both augment (Temporal) and export values.
export * from "./dateTimeExtensions";

// Shared data structures and free helper functions.
export * from "./collections";
export * from "./helpers";
