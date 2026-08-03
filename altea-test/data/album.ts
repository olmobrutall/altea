import { entity, implementedBy, backReference, rowOrder, forceNullable, quoted } from "@altea/altea/data/decorators";
import { Entity, EmbeddedEntity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { Temporal, type int, toInt } from "@altea/altea/data/basics";
import { init, reflect } from "@altea/altea/data/reflection";
import type { ConstructSymbol, From, FromMany, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { ArtistEntity, type IAuthorEntity } from "./artist";
import { BandEntity } from "./band";
import { LabelEntity } from "./label";

@entity("Main", "Master")
export class AlbumEntity extends Entity {
    name: string;
    year: int;
    @implementedBy(() => [ArtistEntity, BandEntity])
    author: IAuthorEntity;
    // Signum's [PreserveOrder] MList<SongEmbedded> Songs → owned part rows.
    songs: AlbumEntity_Songs[];
    bonusTrack: SongEmbedded | null; // single (nullable) embedded
    @forceNullable // Signum's [ForceNullable]: non-null field, nullable column
    label: LabelEntity;
    state: AlbumState;

    // Signum's [AutoExpressionField] ToString => $"{Name} ({Author})". `author` is an
    // @implementedBy reference; its `.toString()` lowers to a CASE over each implementation's
    // display string (Artist/Band → name). Computed inline, so no stored ToStr column.
    // (`.toString()` is explicit — the quote transform captures `${this.author}` as a bare
    // reference, unlike C# where the compiler inserts the ToString call.)
    @quoted
    toString(): string {
        return `${this.name} (${this.author.toString()})`;
    }
}

// Owned child rows for AlbumEntity.songs (the per-row equivalent of SongEmbedded,
// whose embedded fields are flattened in here).
@entity("Part")
export class AlbumEntity_Songs extends Entity {
    @backReference
    album: Lite<AlbumEntity>;

    @rowOrder
    order: int;

    name: string;
    duration: Temporal.Duration | null;
    seconds: int | null;
    index: int = toInt(0); // C# value-type default (0); the loader relies on it

    @quoted()
    toString(): string {
        return this.name;
    }
}

export enum AlbumState {
    New,
    Saved,
}

@reflect
export class SongEmbedded extends EmbeddedEntity {
    name: string;
    duration: Temporal.Duration | null;
    seconds: int | null;
    index: int = toInt(0); // C# value-type default (0); the loader relies on it

    toString(): string {
        return this.name;
    }
}

// ---- Operations -------------------------------------------------------------
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
