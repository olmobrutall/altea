import { reflect } from "@altea/altea/data/reflection";
import { entity, implementedBy, backReference, valueField, quoted } from "@altea/altea/data/decorators";
import { Entity } from "@altea/altea/data/entity";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { Lite, LiteImp, registerCustomLite } from "@altea/altea/data/lite";
import { ArtistEntity, type IAuthorEntity } from "./artist";
import { GrammyAwardEntity, AmericanMusicAwardEntity } from "./award";

@entity("Main", "Master")
export class BandEntity extends Entity implements IAuthorEntity {
    name: string;
    // Signum's MList<ArtistEntity> Members → band/member part entity.
    members: BandEntity_Members[];
    @implementedBy(() => [GrammyAwardEntity, AmericanMusicAwardEntity])
    lastAward: Entity | null;
    // Signum's MList<AwardEntity> OtherAwards → band/award part entity.
    otherAwards: BandEntity_OtherAwards[];

    // Computed query members (Signum's [AutoExpressionField]) — see ArtistEntity.
    @quoted
    fullName(): string { return this.name; }
    @quoted
    lonely(): boolean { return this.members.length == 0; }

    // Signum's [AutoExpressionField] ToString => Name (see ArtistEntity): expanded
    // inline, no stored ToStr column.
    @quoted
    toString(): string {
        return this.name;
    }
}

// Many-to-many link rows for BandEntity.members (MList<ArtistEntity>).
@entity("Part")
export class BandEntity_Members extends Entity {
    @backReference
    band: Lite<BandEntity>;

    @valueField
    member: ArtistEntity;
}

// Link rows for BandEntity.otherAwards (MList<AwardEntity>, polymorphic award).
@entity("Part")
export class BandEntity_OtherAwards extends Entity {
    @backReference
    band: Lite<BandEntity>;

    @implementedBy(() => [GrammyAwardEntity, AmericanMusicAwardEntity])
    @valueField
    award: Entity;
}

// A NON-default custom lite for a band: carries the member count (a translatable subquery). Because
// it is not the default, band.toLite() yields a plain LiteImp; BandLite is reached via
// band.toCustomLite(BandLite) or the @customLite override on AwardNominationEntity.author.
export class BandLite extends LiteImp<BandEntity> {
    constructor(id: PrimaryKey, toStr: string, readonly memberCount: number) {
        super(id, BandEntity, toStr);
    }
    static isCompatible(json: Record<string, unknown>): boolean {
        return typeof json.memberCount === "number";
    }
    static fromJson(json: Record<string, unknown>): Lite<BandEntity> {
        return new BandLite(json.id as PrimaryKey, (json.toStr as string) ?? "", json.memberCount as number);
    }
}

registerCustomLite(BandEntity, BandLite, b => new BandLite(b.id, b.toString(), b.members.length), false);
