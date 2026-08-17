// The `reflect` import must be PRESENT even where no class is decorated with it: the quote-transformer
// augments THIS import with the `field()` / `registerType()` helpers it injects for every entity field, and
// without it the emitted module throws "field is not defined" at load time.
import { reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { entity, backReference, rowOrder, stringLengthValidator } from "@altea/altea/data/decorators";
import { type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import type { IPartEntity } from "./Dashboard";

// Port of the dashboard part entities Signum defines in Signum.Dashboard/PanelPart.cs + CustomPart.cs — the
// parts that need no other extension: free text, an image, a section separator, a health-check board and the
// app-supplied custom part. The parts that live in OTHER modules stay there, exactly as in Signum:
// UserQueryPart / BigValuePart / ValueUserQueryListPart in @altea/altea-user-queries and UserChartPart /
// CombinedUserChartPart in @altea/altea-chart.
//
// altea divergences: Signum's `IPartEntity.Clone()` / `ToXml` / `FromXml` are not entity members here — the
// XML lives in the server part registry (server/DashboardXml.server.ts) and cloning in the same registry
// (used by the Clone operation). `RequiresTitle` IS kept on the entity (the title validation is isomorphic).
// ToolbarMenuPartEntity is deferred with Signum.Toolbar.

// Signum's TextPartType (PanelPart.cs) — how `textContent` is rendered.
export enum TextPartTypeEnum {
    Text,
    Markdown,
    HTML,
}

// Signum's TextPartEntity (PanelPart.cs). Free text / markdown / HTML, with `$Variable$` placeholders
// resolved client-side from DashboardClient.GlobalVariables.
@entity("Part", "Master")
export class TextPartEntity extends Entity implements IPartEntity {
    // Signum's [StringLengthValidator(Min = 1, MultiLine = true), Translatable] — unbounded text column.
    @stringLengthValidator({ min: 1 })
    textContent: string | null = null;

    textPartType: TextPartTypeEnum = TextPartTypeEnum.Text;

    requiresTitle(): boolean {
        return false;
    }

    toString(): string {
        return this.textContent ?? "";
    }
}

// Signum's ImagePartEntity (PanelPart.cs). An image (a URL or a data: URI in `imageSrcContent`), optionally
// clickable.
@entity("Part", "Master")
export class ImagePartEntity extends Entity implements IPartEntity {
    imageSrcContent: string = "";

    clickActionURL: string | null = null;

    altText: string | null = null;

    requiresTitle(): boolean {
        return false;
    }

    toString(): string {
        return this.altText ?? this.imageSrcContent;
    }
}

// Signum's SeparatorPartEntity (PanelPart.cs). A full-width heading between rows of parts.
@entity("Part", "Master")
export class SeparatorPartEntity extends Entity implements IPartEntity {
    title: string | null = null;

    // Signum's `RequiresTitle => Title != null` (kept verbatim).
    requiresTitle(): boolean {
        return this.title != null;
    }

    toString(): string {
        return this.title ?? "";
    }
}

// Signum's HealthCheckElementEmbedded (PanelPart.cs) — ONE tile: a label, the health endpoint to poll and
// where to navigate on click. altea: a `@part` row of the HealthCheck part (Signum's MList element).
@entity("Part")
export class HealthCheckElementEmbedded extends Entity {
    @backReference healthCheckPart: Lite<HealthCheckPartEntity>;
    @rowOrder order: int = toInt(0);

    @stringLengthValidator({ max: 100 })
    title: string = "";

    @stringLengthValidator({ max: 400 })
    checkURL: string = "";

    @stringLengthValidator({ max: 400 })
    navigateURL: string = "";

    toString(): string {
        return this.title;
    }
}

// Signum's HealthCheckPartEntity (PanelPart.cs). A board of health-check tiles, each polling its own
// ASP.NET-health-style endpoint (`{ status, description }`).
@entity("Part", "Master")
export class HealthCheckPartEntity extends Entity implements IPartEntity {
    // Signum's [PreserveOrder] MList<HealthCheckElementEmbedded>.
    items: HealthCheckElementEmbedded[];

    requiresTitle(): boolean {
        return true;
    }

    toString(): string {
        return `${this.items?.length ?? 0} ${DashboardPartsMessage.HealthCheckElements.niceToString()}`;
    }
}

// Signum's CustomPartEntity (CustomPart.cs). Escape hatch: the app registers a React component under a name
// (DashboardClient.Options.registerCustomPartRenderer) and this part selects it.
@entity("Part", "Master")
export class CustomPartEntity extends Entity implements IPartEntity {
    @stringLengthValidator({ max: 100 })
    customPartName: string = "";

    requiresTitle(): boolean {
        return false;
    }

    toString(): string {
        return this.customPartName;
    }
}

// altea-only message container for the part toStrings / editors that Signum expressed with NicePluralName.
// (Signum's LinkElementEmbedded is not ported: no live part references it since LinkListPart was removed.)
export const DashboardPartsMessage = {
    HealthCheckElements: msg("Health Check Elements"),
    PasteHealthCheckLink: msg("Paste Health Check Link"),
    ClipboardDataIsNotCompatibleWithHealthCheckData: msg("Clipboard data is not compatible with health check data!"),
};
