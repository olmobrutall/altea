import { SchemaBuilder } from "@altea/altea/logic/schema";
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
