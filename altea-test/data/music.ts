// The "Music" domain (port of Signum.Test's Environment/Entities.cs), split into per-aggregate modules.
// This barrel re-exports them all, so `import { … } from ".../data/music"` keeps working AND importing it
// triggers every module's load-time registrations (@entity / @reflect + registerCustomLite + the
// *Operation init() declarations).
//
// Where Signum used MList<T>, altea has no MList: each collection becomes a "part" entity placed with its
// owner and named `<OwnerEntity>_<Property>` (e.g. AlbumEntity_Song). Cross-aggregate references are all
// lazy — `@implementedBy(() => […])` thunks, `@field` type thunks, `@customLite` — so the modules import
// one another freely without eval-time cycles. Query-only SQL functions live in the SERVER tier
// (server/musicExtensions.ts's MinimumExtensions), not here.
export * from "./note";
export * from "./artist";
export * from "./band";
export * from "./award";
export * from "./album";
export * from "./label";
export * from "./config";
export * from "./folder";
export * from "./simplePassage";
export * from "./views";
