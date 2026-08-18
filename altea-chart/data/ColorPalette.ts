import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import {
    entity, backReference, rowOrder, implementedByAll, stringLengthValidator, uniqueIndex, quoted,
} from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";
import { msg } from "@altea/altea/data/utils/localization";

// Port of Signum's Signum.Chart/ColorPalette/ColorPalette.cs (ColorPaletteEntity + SpecificColorEmbedded).
// A ColorPalette is a per-TYPE custom color palette: a base color scheme (categoryName) + seed used to
// deterministically assign a color to each entity/enum value, plus an optional list of hand-picked
// overrides (specificColors). Charts colour their category axes from the palette registered for the
// column's type (see ChartClient.getColor / getPalletes + ColorPaletteClient).
//
// altea divergences, documented inline:
//  - Signum's `[PreserveOrder, NoRepeatValidator, BindParent] MList<SpecificColorEmbedded> SpecificColors`
//    becomes a per-owner `@part` row collection (altea has no MList — a collection is a plain array of
//    @part row entities). ColorPaletteEntity_SpecificColor is therefore a `@entity("Part")` OWNED by ColorPaletteEntity
//    (Signum's BindParent), carrying the back-pointing FK (`@backReference colorPalette`) + a row-order int
//    (Signum's PreserveOrder). It is NOT an EmbeddedEntity (altea can't persist an embedded array on a table).
//  - Signum's SpecificColorEmbedded `[ImplementedByAll, UniqueIndex] Lite<Entity> Entity` keeps the
//    @implementedByAll polymorphic reference, but the per-row UNIQUE index (Signum's [UniqueIndex] +
//    NoRepeatValidator on the MList element) is NOT reproduced as a DB index: in altea the part table has a
//    single owner and a bare unique index on the (type,id) discriminator columns would be GLOBALLY unique
//    across every palette. The intended "no repeated entity within one palette" rule is a per-owner
//    validation concern (Signum's PropertyValidation), deferred here.
//  - Signum's `[Format(FormatAttribute.Color)] string Color` — altea has no [Format(Color)] attribute; the
//    editor renders the color picker/scheme selector itself (see ColorPalette.tsx).
//  - Signum's `As.Expression` ToString (IsNew ? NewNiceName : NiceName + " " + Type) → a `@quoted` toString
//    that navigates the (required, non-null) Type reference — SQL-translatable for query projection.

// Signum's SpecificColorEmbedded (one color override: an entity/enum value → a color).
@entity("Part")
export class ColorPaletteEntity_SpecificColor extends Entity {
    @backReference colorPalette: Lite<ColorPaletteEntity>;
    @rowOrder order: int;

    // Signum's `[ImplementedByAll] Lite<Entity> Entity` — the entity (or enum-entity row) this color is for.
    @implementedByAll entity: Lite<Entity>;

    // Signum's `[StringLengthValidator(Max = 100)] string Color`.
    @stringLengthValidator({ max: 100 }) color: string;
}

// Signum's ColorPaletteEntity.
@reflect
@entity("Main", "Master")
export class ColorPaletteEntity extends Entity {
    // Signum's `[UniqueIndex] TypeEntity Type` — at most one palette per type.
    @uniqueIndex type: TypeEntity;

    // Signum's `[StringLengthValidator(Max = 100)] string CategoryName` — the base color-scheme key
    // (ColorUtils.colorSchemes).
    @stringLengthValidator({ max: 100 }) categoryName: string;

    // Signum's `int Seed` — mixed into the hash so identical value sets get distinct palettes.
    seed: int = toInt(0);

    // Signum's `[PreserveOrder, NoRepeatValidator, BindParent] MList<SpecificColorEmbedded>`.
    specificColors: ColorPaletteEntity_SpecificColor[];

    @quoted
    toString(): string {
        return this.type.toString();
    }
}

// Signum's `[AutoInit] static class ColorPaletteOperation`.
export namespace ColorPaletteOperation {
    export const Save: ExecuteSymbol<ColorPaletteEntity> = init();
    export const Delete: DeleteSymbol<ColorPaletteEntity> = init();
}

// Signum's ColorPaletteMessage enum → an altea msg() container (member name = identity, value = label).
export const ColorPaletteMessage = {
    FillAutomatically: msg(),
    Select0OnlyIfYouWantToOverrideTheAutomaticColor: msg("Select {0} only if you want to override the automatic color"),
    ShowPalette: msg(),
    ShowList: msg(),
};
