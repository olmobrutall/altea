import "@altea/altea/server"; // installs Entity.save()/delete()
import type { Lite } from "@altea/altea/data/lite";
import type { Entity } from "@altea/altea/data/entity";
import { cleanTypeName } from "@altea/altea/data/registration";
import "@altea/altea/server/operationFluentInclude"; // FluentInclude.withSave / withDelete
import "@altea/altea/server/dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "@altea/altea/server/schema";
import { table } from "@altea/altea/server/table";
import type { ResetLazy } from "@altea/altea/data/resetLazy";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { ColorPaletteEntity, ColorPaletteOperation } from "../data/ColorPalette";
import { ColorPaletteServer } from "./ColorPaletteServer.server";

// Port of Signum's ColorPaletteLogic.Start (Signum.Chart/ColorPalette/ColorPaletteLogic.cs). Registers the
// ColorPalette entity + its Save/Delete operations + query, the in-memory cache (Signum's ColorPaletteCache
// ResetLazy GlobalLazy), and — when a web host is present — the HTTP surface. Mirrors UserChartLogic.
//
// altea divergences, documented inline:
//  - Signum's `ColorPaletteCache` is `ResetLazy<FrozenDictionary<Type, ColorPaletteEntity>>` keyed by the
//    .NET Type. altea has no synchronous Type facade at cache-build time; the cache is simply the array of
//    every ColorPaletteEntity (invalidated on any change), and `getColorPaletteByTypeName` resolves the
//    TypeEntity by clean name (via the ORM) and finds the palette by its `type` FK id — mirroring
//    UserChartLogic.getUserChartsForEntityType.

export namespace ColorPaletteLogic {

    // Signum's `ResetLazy<FrozenDictionary<Type, ColorPaletteEntity>> ColorPaletteCache`.
    export let colorPaletteLazy: ResetLazy<ColorPaletteEntity[]> = null!;

    export function start(sb: SchemaBuilder): void {
        if (sb.alreadyDefined(start))
            return;

        sb.include(ColorPaletteEntity)
            .withSave(ColorPaletteOperation.Save)
            .withDelete(ColorPaletteOperation.Delete)
            .withQuery();

        // Signum's GlobalLazy over all color palettes, invalidated on any ColorPaletteEntity change.
        colorPaletteLazy = sb.globalLazy(() => table(ColorPaletteEntity).toArray() as Promise<ColorPaletteEntity[]>,
            { invalidateWith: [ColorPaletteEntity] });

        if (sb.webBuilder)
            ColorPaletteServer.start(sb.webBuilder);
    }

    // Signum's `ColorPaletteCache.Value.TryGetC(type)`: the palette registered for a type (by its clean
    // name). altea resolves the TypeEntity id from the name, then finds the palette whose `type` FK matches.
    export async function getColorPaletteByTypeName(typeCleanName: string): Promise<ColorPaletteEntity | undefined> {
        const typeRows = await table(TypeEntity).filter(t => t.cleanName == typeCleanName).toArray() as TypeEntity[];
        const typeId = typeRows[0]?.id;
        if (typeId == null)
            return undefined;

        const all = await colorPaletteLazy.value();
        return all.find(cp => cp.type != null && String(cp.type.id) === String(typeId));
    }

    /**
     * Signum's `ChartColorLogic.ColorFor(lite)` — the colour the palette assigns to one specific entity,
     * or undefined when its type has no palette or the palette names no colour for it.
     *
     * Used by anything that has to COLOUR a chart outside the browser (the chart script does this
     * client-side normally): @altea/altea-office-template binds these onto the series and data points of a
     * chart drawn in a Word/PowerPoint template.
     */
    export async function colorFor(lite: Lite<Entity>): Promise<string | undefined> {
        const palette = await getColorPaletteByTypeName(cleanTypeName(lite.entityType));
        if (palette == null)
            return undefined;

        return palette.specificColors.find(sc => sc.entity != null && liteEquals(sc.entity, lite))?.color;
    }
}

/** Two lites are the same row when their type and id match (altea has no Lite.Is). */
function liteEquals(a: Lite<Entity>, b: Lite<Entity>): boolean {
    return a.entityType === b.entityType && String(a.id) === String(b.id);
}
