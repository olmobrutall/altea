// The `reflect` import must be PRESENT even where no class is decorated with it: the quote-transformer
// augments THIS import with the `field()` / `registerType()` helpers it injects for every entity field, and
// without it the emitted module throws "field is not defined" at load time.
import { reflect, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { Lite } from "@altea/altea/data/lite";
import { part, backReference, rowOrder } from "@altea/altea/data/decorators";
import { stringLengthValidator } from "@altea/altea/data/validators";
import { type int, toInt } from "@altea/altea/data/basics";
import { msg } from "@altea/altea/data/utils/localization";
import { ToolbarMenuEntity } from "@altea/altea-toolbar/data/Toolbar";
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
// ToolbarMenuPartEntity lives here too, exactly as in Signum: it is declared in Signum.Dashboard (hence
// the `dashboard` schema, not `toolbar`) and reaches ToolbarMenuEntity through the reference
// Signum.Dashboard.csproj already has on Signum.Toolbar — which altea-dashboard's package.json also has,
// so the dependency runs the same way and there is no cycle.

// Signum's TextPartType (PanelPart.cs) — how `textContent` is rendered.
export enum TextPartType {
    Text,
    Markdown,
    HTML,
}

// Signum's TextPartEntity (PanelPart.cs). Free text / markdown / HTML, with `$Variable$` placeholders
// resolved client-side from DashboardClient.GlobalVariables.
@part("Master")
export class TextPartEntity extends Entity implements IPartEntity {
    // Signum's [StringLengthValidator(Min = 1, MultiLine = true), Translatable] — unbounded text column.
    @stringLengthValidator({ min: 1 })
    textContent: string | null;

    textPartType: TextPartType = TextPartType.Text;

    requiresTitle(): boolean {
        return false;
    }

    toString(): string {
        return this.textContent ?? "";
    }
}

// Signum's ImagePartEntity (PanelPart.cs). An image (a URL or a data: URI in `imageSrcContent`), optionally
// clickable.
@part("Master")
export class ImagePartEntity extends Entity implements IPartEntity {
    imageSrcContent: string;

    clickActionURL: string | null;

    altText: string | null;

    requiresTitle(): boolean {
        return false;
    }

    toString(): string {
        return this.altText ?? this.imageSrcContent;
    }
}

// Signum's SeparatorPartEntity (PanelPart.cs). A full-width heading between rows of parts.
@part("Master")
export class SeparatorPartEntity extends Entity implements IPartEntity {
    title: string | null;

    // Signum's `RequiresTitle => Title != null` (kept verbatim).
    requiresTitle(): boolean {
        return this.title != null;
    }

    toString(): string {
        return this.title ?? "";
    }
}

// Signum's ToolbarMenuPartEntity (PanelPart.cs). Renders one toolbar MENU as a dashboard part, so a
// dashboard can carry the same navigation block the sidebar does. Signum declares it in Signum.Dashboard
// rather than Signum.Toolbar, which is why its table is `dashboard.toolbar_menu_part`.
@part("Master")
export class ToolbarMenuPartEntity extends Entity implements IPartEntity {
    toolbarMenu: Lite<ToolbarMenuEntity>;

    // Signum's `RequiresTitle => false` — the menu supplies its own heading.
    requiresTitle(): boolean {
        return false;
    }

    toString(): string {
        return this.toolbarMenu?.toString() ?? ToolbarMenuEntity.niceName();
    }
}

// Signum's HealthCheckElementEmbedded (PanelPart.cs) — ONE tile: a label, the health endpoint to poll and
// where to navigate on click. altea: a `@part` row of the HealthCheck part (Signum's MList element).
@part
export class HealthCheckPartEntity_Item extends Entity {
    @backReference healthCheckPart: Lite<HealthCheckPartEntity>;
    @rowOrder order: int;

    @stringLengthValidator({ max: 100 })
    title: string;

    @stringLengthValidator({ max: 400 })
    checkURL: string;

    @stringLengthValidator({ max: 400 })
    navigateURL: string;

    toString(): string {
        return this.title;
    }
}

// Signum's HealthCheckPartEntity (PanelPart.cs). A board of health-check tiles, each polling its own
// ASP.NET-health-style endpoint (`{ status, description }`).
@part("Master")
export class HealthCheckPartEntity extends Entity implements IPartEntity {
    // Signum's [PreserveOrder] MList<HealthCheckElementEmbedded>.
    items: HealthCheckPartEntity_Item[];

    requiresTitle(): boolean {
        return true;
    }

    toString(): string {
        return `${this.items?.length ?? 0} ${DashboardPartsMessage.HealthCheckElements.niceToString()}`;
    }
}

// Signum's CustomPartEntity (CustomPart.cs). Escape hatch: the app registers a React component under a name
// (DashboardClient.Options.registerCustomPartRenderer) and this part selects it.
@part("Master")
export class CustomPartEntity extends Entity implements IPartEntity {
    @stringLengthValidator({ max: 100 })
    customPartName: string;

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

// The database schema this package's tables live in — altea's counterpart of Signum's
// `[assembly: AssemblySchemaName("dashboard")]`. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("dashboard");
