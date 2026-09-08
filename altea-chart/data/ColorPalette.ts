import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { entity, part, backReference, rowOrder, implementedByAll, uniqueIndex, quoted } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
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
//    @part row entities). ColorPaletteEntity_SpecificColor is therefore a `@part` OWNED by ColorPaletteEntity
//    (Signum's BindParent), carrying the back-pointing FK (`@backReference colorPalette`) + a row-order int
//    (Signum's PreserveOrder). It is NOT an EmbeddedEntity (altea can't persist an embedded array on a table).
//  - Signum's SpecificColorEmbedded `[ImplementedByAll, UniqueIndex] Lite<Entity> Entity` keeps both the
//    @implementedByAll polymorphic reference AND the unique index. Note what that index actually says: the
//    MList table has one owner FK, so uniqueness over the (type, id) discriminator columns alone is
//    GLOBAL — an entity may appear in AT MOST ONE palette, app-wide, not merely once within a palette.
//    That is what Signum's schema enforces (`uix_color_palette_specific_colors_entity_id_typ…`), and the
//    NoRepeatValidator / PropertyValidation is the narrower per-owner rule layered on top (deferred here).
//  - Signum's `[Format(FormatAttribute.Color)] string Color` — altea has no [Format(Color)] attribute; the
//    editor renders the color picker/scheme selector itself (see ColorPalette.tsx).
//  - Signum's `As.Expression` ToString (IsNew ? NewNiceName : NiceName + " " + Type) → a `@quoted` toString
//    that navigates the (required, non-null) Type reference — SQL-translatable for query projection.

// Signum's SpecificColorEmbedded (one color override: an entity/enum value → a color).
@part
export class ColorPaletteEntity_SpecificColor extends Entity {
    @backReference colorPalette: Lite<ColorPaletteEntity>;
    @rowOrder order: int;

    // Signum's `[ImplementedByAll, UniqueIndex] Lite<Entity> Entity` — the entity (or enum-entity row)
    // this color is for. The index comes out UNFILTERED because the discriminator is NOT NULL (Signum's
    // IndexWhereExpressionVisitor.IsNull returns null for a required @implementedByAll).
    @uniqueIndex @implementedByAll entity: Lite<Entity>;

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
