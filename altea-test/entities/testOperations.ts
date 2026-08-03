import type { ConstructSymbol, From, FromMany, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { init } from "@altea/altea/data/reflection";
import { ArtistEntity, AlbumEntity } from "./music";

// Operation containers declared exactly as a real one would be (Signum's `[AutoInit]
// static class`). The symbol types are imported by name — the quote-transformer both
// rewrites each `init()` into `init(OperationSymbol, "<Container>.<member>", __fileInfo)`
// (base-walking the declared type to the concrete Symbol class) AND injects a value
// `import { OperationSymbol }` so that constructor is in scope at runtime (the `import
// type` above is erased).
export namespace ArtistOperation {
    export const Save: ExecuteSymbol<ArtistEntity> = init();
    export const Delete: DeleteSymbol<ArtistEntity> = init();
    export const Create: ConstructSymbol<ArtistEntity> = init();
    // A default-language operation label set inline (Signum's [Description] on the AutoInit field).
    // The transformer forwards the options object as the 4th init() argument.
    export const CreateFromScratch: ConstructSymbol<ArtistEntity> = init({ niceName: "Create Artist from scratch" });
}

// Phase 3 fixture: a small state-machine over AlbumEntity (AlbumState New/Saved). The
// second ConstructSymbol arg reads like a sentence — Simple (default) / From<F> / FromMany<F>.
export namespace AlbumOperation {
    export const Create: ConstructSymbol<AlbumEntity> = init();
    export const CreateInvalid: ConstructSymbol<AlbumEntity> = init();
    export const Clone: ConstructSymbol<AlbumEntity, From<AlbumEntity>> = init();
    export const CreateFromArtists: ConstructSymbol<AlbumEntity, FromMany<ArtistEntity>> = init();
    export const Save: ExecuteSymbol<AlbumEntity> = init();
    export const OnlyWhenSaved: ExecuteSymbol<AlbumEntity> = init();
    export const Delete: DeleteSymbol<AlbumEntity> = init();
}
