import { entity, implementedByAll, backReference, valueField, quoted } from "@altea/altea/data/decorators";
import { Entity } from "@altea/altea/data/entity";
import type { PrimaryKey } from "@altea/altea/data/entity";
import { Lite, LiteImp, registerCustomLite } from "@altea/altea/data/lite";
import { init, reflect } from "@altea/altea/data/reflection";
import type { ConstructSymbol, ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";

// Signum's IAuthorEntity: the shared interface behind AlbumEntity.Author /
// AwardNominationEntity.Author, implemented by ArtistEntity and BandEntity. altea has
// no runtime interface type — this is a compile-time contract so a polymorphic
// `author` reference can navigate the members both implementations share. It is the
// static type `combineUnion()` / `combineCase()` return (they are `(): this`), which
// is what makes `a.author.combineUnion().name` / `.lastAward` / `.fullName()` typecheck.
export interface IAuthorEntity extends Entity {
    name: string;
    lastAward: Entity | null;
    fullName(): string;
    lonely(): boolean;
}

@entity("Main", "Master")
export class ArtistEntity extends Entity implements IAuthorEntity {
    name: string;
    dead: boolean;
    sex: Sex;
    status: Status | null;
    @implementedByAll
    lastAward: Entity | null;
    // Signum's MList<Lite<ArtistEntity>> Friends → self many-to-many part entity.
    friends: ArtistEntity_Friends[];
    // Signum's MList<AwardNominationEntity> Nominations is a *virtual* MList keyed
    // by AwardNominationEntity.author (an @implementedBy reference, so it can't be
    // a plain part entity here). Navigate it through AwardNominationEntity.

    // Computed query members (Signum's [AutoExpressionField]) — @quoted captures the body as a
    // translatable expression (no real column); methods, so the @field transformer skips them.
    // The binder inlines the @quoted body when the member is called in a query (fromQuoted reads
    // `__quoted` off the method), so `a.isMale()`, `a.fullName()`, `a.friendsCovariant()`, etc.
    // translate to SQL like any other expression.
    @quoted
    isMale(): boolean { return this.sex == Sex.Male; }
    @quoted
    fullName(): string { return this.name; }
    // albumCount (a cross-entity subquery: count albums where author == this) needs a
    // query source from the logic layer, so it's defined+implemented in MusicLogic, which
    // augments this interface (the data layer must not reference the server layer).
    @quoted
    lonely(): boolean { return this.friends.length == 0; }
    // Signum's ArtistEntity.FriendsCovariant() => (IEnumerable<Lite<Entity>>)Friends — a covariant
    // downcast to the base type, exercising covariant collection handling. altea returns Entity[]
    // (the friends navigated to their full entities, widened to the Entity base).
    @quoted
    friendsCovariant(): Entity[] { return this.friends.map(f => f.friend.entity); }

    // Signum's [AutoExpressionField] ToString => Name: a translatable expression, so
    // it's expanded inline in queries and the entity carries no stored ToStr column.
    @quoted
    toString(): string {
        return this.name;
    }
}

// Self many-to-many link rows for ArtistEntity.friends (MList<Lite<ArtistEntity>>).
@entity("Part")
export class ArtistEntity_Friends extends Entity {
    @backReference
    artist: Lite<ArtistEntity>;

    @valueField
    friend: Lite<ArtistEntity>;
}

export enum Sex {
    Male,
    Female,
    Undefined,
}

export enum Status {
    Single,
    Married,
}

// ---- Custom lite (Signum's LiteModel) ---------------------------------------
// The DEFAULT custom lite for an artist: carries the artist's sex. `sex` is a plain column, so the
// fromEntity model translates to SQL and a query returns ArtistLite too (not just a LiteImp).
export class ArtistLite extends LiteImp<ArtistEntity> {
    constructor(id: PrimaryKey, toStr: string, readonly sex: Sex) {
        super(id, ArtistEntity, toStr);
    }
    static isCompatible(json: Record<string, unknown>): boolean {
        return typeof json.sex === "number";
    }
    static fromJson(json: Record<string, unknown>): Lite<ArtistEntity> {
        return new ArtistLite(json.id as PrimaryKey, (json.toStr as string) ?? "", json.sex as Sex);
    }
}

// `fromEntity` is a Quoted lambda: it runs verbatim in memory (toLite/toCustomLite) and the query
// provider translates its body — `new ArtistLite(a.id, a.toString(), a.sex)` — into projected columns.
registerCustomLite(ArtistEntity, ArtistLite, a => new ArtistLite(a.id, a.toString(), a.sex), true);

// ---- Operations (Signum's [AutoInit] static class) --------------------------
// Declared exactly as a real one would be. The quote-transformer rewrites each `init()` into
// `init(OperationSymbol, "<Container>.<member>", __fileInfo)` (base-walking the declared type to the
// concrete Symbol class) AND injects a value `import { OperationSymbol }` so the ctor is in scope.
export namespace ArtistOperation {
    export const Save: ExecuteSymbol<ArtistEntity> = init();
    export const Delete: DeleteSymbol<ArtistEntity> = init();
    export const Create: ConstructSymbol<ArtistEntity> = init();
    // A default-language operation label set inline (Signum's [Description] on the AutoInit field).
    export const CreateFromScratch: ConstructSymbol<ArtistEntity> = init({ niceName: "Create Artist from scratch" });
}
