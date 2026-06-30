import { SchemaBuilder } from "@altea/altea/logic/schema";
import { table } from "@altea/altea/logic/table";
import { withQuoted } from "@altea/altea/entities/decorators";
import {
    CountryEntity,
    LabelEntity,
    ArtistEntity,
    GrammyAwardEntity,
    AmericanMusicAwardEntity,
    PersonalAwardEntity,
    BandEntity,
    AlbumEntity,
    AwardNominationEntity,
    ConfigEntity,
    NoteWithDateEntity,
    FolderEntity,
    SimplePassageEntity,
} from "../entities/music";

// Registers every Music table in the schema. Mirrors Signum.Test's
// MusicLogic.Start (the include(...) calls): takes the SchemaBuilder and returns
// void, leaving the final sb.complete() to the starter. The abstract AwardEntity
// is not included directly — only its concrete subclasses get tables; it is
// reached polymorphically through @implementedBy.
//
// The part entities that replace Signum's MList fields (ArtistEntity_Friends,
// BandEntity_Members, BandEntity_OtherAwards, AlbumEntity_Songs,
// AwardNominationEntity_Points, ConfigEntity_Awards, NoteWithDateEntity_Colaborators)
// are pulled in transitively via the owners' @include(() => Child) collections
// (and, for Colaborators, via NoteWithDateEntity's ColaboratorsMixin) — so they
// are intentionally NOT listed here.
export namespace MusicLogic {
    export function start(sb: SchemaBuilder): void {
        sb.include(CountryEntity);
        sb.include(LabelEntity);

        sb.include(ArtistEntity);

        sb.include(GrammyAwardEntity);
        sb.include(AmericanMusicAwardEntity);
        sb.include(PersonalAwardEntity);

        sb.include(BandEntity);

        sb.include(AlbumEntity);

        sb.include(AwardNominationEntity);

        sb.include(ConfigEntity);

        sb.include(NoteWithDateEntity);

        sb.include(FolderEntity);

        sb.include(SimplePassageEntity);
    }
}

// Cross-entity expression member (Signum's [AutoExpressionField] ArtistEntity.AlbumCount):
// it counts albums whose author is this artist, which needs a query source (`table`) from
// the logic layer — so it's defined here (logic), augmenting the entity, rather than in
// the pure-entity music.ts. `withQuoted` captures the body as the translatable expression.
declare module "../entities/music" {
    interface ArtistEntity {
        albumCount(): Promise<number>;
    }
}

ArtistEntity.prototype.albumCount = withQuoted(function (this: ArtistEntity): Promise<number> {
    return table(AlbumEntity).filter(a => a.author.is(this)).count();
});
