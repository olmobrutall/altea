import { SchemaBuilder } from "@altea/altea/logic/schema";
import {
    CountryEntity,
    LabelEntity,
    ArtistEntity,
    ArtistEntity_Friends,
    GrammyAwardEntity,
    AmericanMusicAwardEntity,
    PersonalAwardEntity,
    BandEntity,
    BandEntity_Members,
    BandEntity_OtherAwards,
    AlbumEntity,
    AlbumEntity_Songs,
    AwardNominationEntity,
    AwardNominationEntity_Points,
    ConfigEntity,
    ConfigEntity_Awards,
    NoteWithDateEntity,
    NoteWithDateEntity_Colaborators,
    FolderEntity,
    SimplePassageEntity,
} from "../entities/music";

// Registers every Music table in the schema. Mirrors Signum.Test's
// MusicLogic.Start (the include(...) calls): takes the SchemaBuilder and returns
// void, leaving the final sb.complete() to the starter. The abstract AwardEntity
// is not included directly — only its concrete subclasses get tables; it is
// reached polymorphically through @implementedBy. The junction / child entities
// that replace Signum's MList fields (ArtistEntity_Friends, BandEntity_Members,
// BandEntity_OtherAwards, AlbumEntity_Songs, AwardNominationEntity_Points,
// ConfigEntity_Awards, NoteWithDateEntity_Colaborators) are included too;
// include() also pulls in referenced types transitively, but listing the roots
// keeps the schema deterministic.
export namespace MusicLogic {
    export function start(sb: SchemaBuilder): void {
        sb.include(CountryEntity);
        sb.include(LabelEntity);

        sb.include(ArtistEntity);
        sb.include(ArtistEntity_Friends);

        sb.include(GrammyAwardEntity);
        sb.include(AmericanMusicAwardEntity);
        sb.include(PersonalAwardEntity);

        sb.include(BandEntity);
        sb.include(BandEntity_Members);
        sb.include(BandEntity_OtherAwards);

        sb.include(AlbumEntity);
        sb.include(AlbumEntity_Songs);

        sb.include(AwardNominationEntity);
        sb.include(AwardNominationEntity_Points);

        sb.include(ConfigEntity);
        sb.include(ConfigEntity_Awards);

        sb.include(NoteWithDateEntity);
        sb.include(NoteWithDateEntity_Colaborators);

        sb.include(FolderEntity);

        sb.include(SimplePassageEntity);
    }
}
