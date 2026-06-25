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

// Registers every Music table in a fresh schema. Mirrors Signum.Test's
// MusicLogic.Start (the include(...) calls). The abstract AwardEntity is not
// included directly — only its concrete subclasses get tables; it is reached
// polymorphically through @implementedBy. Referenced types (e.g. SongEmbedded,
// CountryEntity) are pulled in transitively by include(), but listing the roots
// explicitly keeps the schema deterministic.
export function buildMusicSchema(): SchemaBuilder {
    const sb = new SchemaBuilder();

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

    sb.complete();
    return sb;
}
