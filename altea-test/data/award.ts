import { reflect } from "@altea/altea/data/reflection";
import { entity, implementedBy, customLite, backReference, rowOrder } from "@altea/altea/data/decorators";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { type int, toInt } from "@altea/altea/data/basics";
import { ArtistEntity, type IAuthorEntity } from "./artist";
import { BandEntity, BandLite } from "./band";

// Abstract base — only the concrete subclasses get tables. Fields are inherited
// by the subclasses' reflection metadata.
@reflect
export abstract class AwardEntity extends Entity {
    year: int;
    category: string;
    result: AwardResult;
}

export enum AwardResult {
    Won,
    Nominated,
}

@entity("String", "Master")
export class GrammyAwardEntity extends AwardEntity { }

@entity("String", "Master")
export class AmericanMusicAwardEntity extends AwardEntity { }

@entity("String", "Master")
export class PersonalAwardEntity extends AwardEntity { }

@entity("Main", "Transactional")
export class AwardNominationEntity extends Entity {
    // A polymorphic (Artist|Band) lite author. Artists use their default custom lite (ArtistLite);
    // bands, whose default is a plain LiteImp, use BandLite ONLY on this field via @customLite
    // (Signum's [LiteModel(typeof(BandLite), ForEntityType = typeof(BandEntity))]).
    @customLite(() => BandLite, () => BandEntity)
    @implementedBy(() => [ArtistEntity, BandEntity])
    author: Lite<IAuthorEntity>;
    @implementedBy(() => [GrammyAwardEntity, PersonalAwardEntity, AmericanMusicAwardEntity])
    award: Lite<Entity>;
    year: int = toInt(0);   // C# value-type default; the loader leaves these unset
    order: int = toInt(0);
    // Signum's [PreserveOrder] MList<NominationPointEmbedded> Points → owned part rows.
    points: AwardNominationEntity_Points[];
}

// Owned child rows for AwardNominationEntity.points. NominationPointEmbedded held
// a single `Point` field, flattened in here.
@entity("Part")
export class AwardNominationEntity_Points extends Entity {
    @backReference
    awardNomination: Lite<AwardNominationEntity>;

    @rowOrder
    order: int;

    point: int;
}
