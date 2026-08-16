import * as React from 'react'
import { ajaxGet } from '@altea/altea/client/Services'
import type { ClientBuilder } from '@altea/altea/client/ClientBuilder'
import { Navigator } from '@altea/altea/client/Navigator'
import { Constructor } from '@altea/altea/client/Constructor'
import { Finder } from '@altea/altea/client/Finder'
import { Dic } from '@altea/altea/data/globals'
import { PropertyRoute } from '@altea/altea/data/propertyRoute'
import { cleanTypeName } from '@altea/altea/data/registration'
import type { TypeInfo } from '@altea/altea/data/reflection'
import type { Lite } from '@altea/altea/data/lite'
import { toInt } from '@altea/altea/data/basics'
import * as ColorUtils from './ColorUtils'
import { getColorInterpolation } from './ColorUtils'
import { ColorPaletteEntity } from '../../data/ColorPalette'
import '@altea/altea/data/globals/arrayExtensions'

// Port of Signum.Chart/ColorPalette/ColorPaletteClient.tsx. The two swatch components (ColorScheme /
// ColorInterpolate) were already here (they back the chart builder's color-parameter dropdowns); this file
// now ALSO adds the ColorPaletteClient namespace — the per-type palette cache + color-calculation the chart
// renderer colours category axes from (threaded through ChartClient.getColor / getPalletes).
//
// altea divergences, documented inline:
//  - Signum registers the editor via `Navigator.addSettings(new EntitySettings(...))`; altea uses the
//    ClientBuilder fluent surface `cb.configure(...).withView(...)`, consistent with the sibling
//    UserChartClient / how eastwind wires every other client.
//  - Signum clears the cache on both `Navigator.registerEntityChanged` AND `AppContext.clearSettingsActions`.
//    altea has no clearSettingsActions registry (per-user client state is reset wholesale via
//    AppContext.newClientState); the module-level cache is invalidated on any ColorPaletteEntity change via
//    registerEntityChanged, which is the meaningful trigger.
//  - Signum keys the cache/API by `TypeInfo.name`; altea keys by the type's CLEAN name (cleanTypeName),
//    which is what the server route resolves the TypeEntity by (matching ChartClient.getColor's entity key).

export namespace ColorPaletteClient {

    export function start(cb: ClientBuilder): void {
        // The ColorPalette editor.
        cb.configure(ColorPaletteEntity)
            .withView(() => import('./ColorPalette'));

        // Show the base color scheme as a swatch in the CategoryName search-result cell.
        Finder.registerPropertyFormatter(PropertyRoute.root(ColorPaletteEntity).addLambda(a => a.categoryName),
            new Finder.CellFormatter((cat: string) => cat ? <span><ColorScheme colorScheme={cat} />{cat}</span> : undefined, true));

        // Default a new palette to seed 0 + the first color scheme (Signum's registerConstructor).
        Constructor.registerConstructor(ColorPaletteEntity, props => {
            const e = new ColorPaletteEntity();
            e.seed = toInt(0);
            e.categoryName = Dic.getKeys(ColorUtils.colorSchemes).first();
            return Object.assign(e, props);
        });

        // Any palette change invalidates the client cache.
        Navigator.registerEntityChanged(ColorPaletteEntity, () => Dic.clear(colorPalette));
    }

    export interface ColorPalette {
        lite: Lite<ColorPaletteEntity>;
        typeName: string;
        categoryName: string;
        seed: number;
        specificColors: { [key: string]: string };

        cachedColors: { [key: string]: string };
        palette: ReadonlyArray<string>;
        getColor(key: string): string;
    }

    // The per-type palette cache (module-global, keyed by clean type name). A `null` value is cached for a
    // type that has NO palette (so the renderer falls back to its own category scale — uncolored charts
    // stay unchanged).
    export const colorPalette: { [typeName: string]: Promise<ColorPalette | null> } = {};

    // Accepts a TypeInfo (getPalletes' entity types) OR a clean type-name string (the chart column editor's
    // palette link, which also covers enum columns that have no client TypeInfo.ctor).
    export function getColorPalette(type: TypeInfo | string): Promise<ColorPalette | null> {
        const name = typeof type === "string" ? type : cleanTypeName(type.ctor!);

        if (colorPalette[name] !== undefined)
            return colorPalette[name];

        return colorPalette[name] = API.colorPalette(name).then(pal => {
            if (pal == null)
                return pal;

            pal.cachedColors = {};
            pal.palette = ColorUtils.colorSchemes[pal.categoryName];

            if (pal.palette == null)
                throw new Error("Invalid ColorPalette categoryName: " + pal.categoryName);

            pal.getColor = paletteGetColor;
            return pal;
        }).catch((e: unknown) => {
            // Never cache a REJECTED promise: a transient failure (e.g. a request that raced the API host's
            // warmup and 404'd before the route was mounted) would otherwise permanently disable this type's
            // palette. Evict so the next call retries, and treat the failure as "no palette" (null) — a chart
            // must never fail to render just because a palette lookup hiccuped.
            delete colorPalette[name];
            console.warn(`ColorPalette lookup for '${name}' failed; treating as no palette.`, e);
            return null;
        });
    }

    function paletteGetColor(this: ColorPalette, key: string): string {
        let color = this.cachedColors[key];
        if (color != null)
            return color;

        color = this.specificColors[key];
        if (color != null)
            return this.cachedColors[key] = color;

        color = calculateColor(key, this.palette, this.seed);
        return this.cachedColors[key] = color;
    }

    export function calculateColor(key: string, palette: readonly string[], seed: number): string {
        let hc = hashCode(key);
        if (hc < 0)
            hc = -hc;

        return palette[(hc + seed) % palette.length];
    }

    export function hashCode(s: string): number {
        let h = 0;
        for (let i = 0; i < s.length; i++)
            h = Math.imul(31, h) + s.charCodeAt(i) | 0;

        return h;
    }

    export namespace API {
        export function colorPalette(typeName: string): Promise<ColorPalette | null> {
            return ajaxGet({ url: `/api/colorPalette/${typeName}` });
        }
    }
}

export function ColorScheme(p: { colorScheme: string }): React.JSX.Element {
    return (<div style={{ height: "20px", width: "150px", display: "inline-flex", verticalAlign: "text-bottom" }} className="me-2">
        {ColorUtils.colorSchemes[p.colorScheme]?.map(c => <div key={c} style={{ flex: "1", backgroundColor: c }} />)}
    </div>);
}

export function ColorInterpolate(p: { colorInterpolator: string }): React.JSX.Element {

    const inter = getColorInterpolation(p.colorInterpolator);

    return (<div style={{ height: "20px", width: "150px", display: "inline-flex", verticalAlign: "text-bottom" }} className="me-2">
        {inter && Array.range(0, 10).map(i => <div key={i} style={{ flex: "1", background: `linear-gradient(90deg, ${inter(i / 10)} 0%, ${inter((i + 1) / 10)} 100%)` }} />)}
    </div>);
}
