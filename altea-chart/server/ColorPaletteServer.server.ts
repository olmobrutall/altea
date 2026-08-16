import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import type { Lite } from "@altea/altea/data/lite";
import { UnauthorizedAccessException } from "@altea/altea/server/exceptions";
import { TypeLogic } from "@altea/altea/server/typeLogic";
import { isEnumEntityType, getBoundEnum, enumEntityMembers } from "@altea/altea/data/enumEntity";
import { PermissionAuthLogic } from "@altea/altea-auth/server/PermissionAuthLogic";
import { ChartPermission } from "../data/ChartPermissions";
import type { ColorPaletteEntity } from "../data/ColorPalette";
import { ColorPaletteLogic } from "./ColorPaletteLogic.server";

// Port of Signum's ColorPaletteController (Signum.Chart/ColorPalette/ColorPaletteController.cs) — the
// `GET /api/colorPalette/{typeName}` endpoint the client's ColorPaletteClient cache calls. Gated by
// ViewCharting (Signum gates with Schema.AssertAllowed(type); altea gates the whole charting surface with
// ChartPermission.ViewCharting, matching UserChartServer). Returns the palette DTO, or JSON null when the
// type has no palette.

// Signum's `ColorPaletteTS` DTO. SpecificColors is a map keyed by the enum MEMBER NAME (for an enum type)
// or the entity ID string (for an entity type) — see the controller's `EnumEntity.Extract` branch.
export interface ColorPaletteTS {
    lite: Lite<ColorPaletteEntity>;
    typeName: string;
    categoryName: string;
    seed: number;
    specificColors: { [key: string]: string };
}

export namespace ColorPaletteServer {
    export function start(ws: WebBuilder): void {
        ws.get("/api/colorPalette/:typeName",
            { params: CustomType<{ typeName: string }>(), res: CustomType<ColorPaletteTS | null>() },
            async (req, res) => {
                await assertAuthorized();

                const palette = await ColorPaletteLogic.getColorPaletteByTypeName(req.params.typeName);
                if (palette == null) {
                    res.jsonTyped(null);
                    return;
                }

                // Signum's `EnumEntity.Extract(type) != null` branch: if the palette's type is an enum type,
                // key SpecificColors by the enum member NAME (Signum's `EnumEntity.ToEnum(a.Entity).ToString()`);
                // otherwise by the entity id string. altea detects the enum from the resolved type ctor
                // (TypeLogic.getType → isEnumEntityType) and maps the enum-entity row id → member name.
                let nameById: Map<string, string> | null = null;
                try {
                    const ctor = TypeLogic.getType(palette.type.id);
                    if (isEnumEntityType(ctor)) {
                        const enumObject = getBoundEnum(ctor);
                        if (enumObject != null)
                            nameById = new Map(enumEntityMembers(enumObject).map(m => [String(m.id), m.name]));
                    }
                } catch {
                    // type not resolvable (e.g. a stale palette) — fall back to id-string keying.
                }

                const specificColors: { [key: string]: string } = {};
                for (const sc of palette.specificColors ?? []) {
                    if (sc.entity == null || sc.color == null)
                        continue;
                    const idStr = String(sc.entity.id);
                    const key = nameById ? (nameById.get(idStr) ?? idStr) : idStr;
                    specificColors[key] = sc.color;
                }

                res.jsonTyped({
                    lite: palette.toLite() as Lite<ColorPaletteEntity>,
                    typeName: req.params.typeName,
                    categoryName: palette.categoryName,
                    seed: Number(palette.seed),
                    specificColors,
                });
            });
    }
}

async function assertAuthorized(): Promise<void> {
    if (!(await PermissionAuthLogic.isAuthorized(ChartPermission.ViewCharting)))
        throw new UnauthorizedAccessException(`Not authorized for '${ChartPermission.ViewCharting.key}'`);
}
