import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import type { IQuery } from "@altea/altea/data/iquery";
import { backReference, entity, implementedBy, quoted, rowOrder } from "@altea/altea/data/decorators";
import { ComparisonType, countIsValidator, stringLengthValidator } from "@altea/altea/data/validators";
import { registerEnum } from "@altea/altea/data/registration";
import { Temporal, type int } from "@altea/altea/data/basics";
import { Clock } from "@altea/altea/data/utils/clock";
import { msg } from "@altea/altea/data/utils/localization";
import { CultureInfoEntity } from "@altea/altea/data/cultureInfoEntity";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import type { DeleteSymbol, ExecuteSymbol } from "@altea/altea/data/operations";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { FilePathEmbedded, FileTypeSymbol } from "@altea/altea-files/data/Files";
import { UserEntity } from "@altea/altea-auth/data/User";

// Port of Signum.WhatsNew's WhatsNew.cs + WhatsNewLog.cs — in-app RELEASE NOTES. An administrator writes a
// news item (one message per culture, a preview picture, attachments), publishes it, and every user sees it
// once in the navbar bullhorn; opening it records that they have read it.
//
// altea divergences:
//  - **the two `MList`s become `@part` ROWS**: `Messages` and `Attachment`. The message row keeps Signum's
//    `WhatsNewMessageEmbedded` NAME (the call the AD configurations made), while the attachment row has no
//    Signum name of its own — its element is a bare `FilePathEmbedded`, so it becomes
//    `WhatsNewEntity_Attachment` holding one.
//  - `Attachment` is renamed `attachments`: it is a COLLECTION, and every other one in the port is plural
//    (`messages`). The ported translation XMLs carry the renamed member.
//  - `[DefaultFileType(...)]` has no counterpart: altea has no reflected default file type, so the two
//    FileLines name the file type directly (see WhatsNew.tsx) — the same accommodation
//    @altea/altea-help's image handler documents.
//  - `[CountIsValidator(GreaterThan, 0)]` → `@countIsValidator(ComparisonType.GreaterThan, 0)`, which altea reads
//    as "this collection is mandatory" in the UI.

@reflect
@entity("Main", "Master")
export class WhatsNewEntity extends Entity {
    @stringLengthValidator({ max: 30 })
    name: string;

    @countIsValidator(ComparisonType.GreaterThan, 0)
    messages: WhatsNewMessageEmbedded[];

    previewPicture: FilePathEmbedded | null;

    attachments: WhatsNewEntity_Attachment[];

    creationDate: Temporal.PlainDateTime = Clock.now;

    status: WhatsNewState = WhatsNewState.Draft;

    /** What this news item is ABOUT — a query the reader can open, or a permission it is relevant to. */
    @implementedBy(() => [QueryEntity, PermissionSymbol])
    related: Lite<Entity> | null;

    @quoted toString(): string { return this.name; }

    /**
     * Signum's `wn.WhatsNewLogs()` / `wn.IsRead()` — two `[AutoExpressionField]` extension methods in its
     * logic layer. Here they are `withQuoted` PROTOTYPE members the SERVER assigns (both bodies are
     * queries), which is why they are optional on this isomorphic declaration.
     */
    whatsNewLogs?(): IQuery<WhatsNewLogEntity>;
    isRead?(): Promise<boolean>;
}

/** Signum's `WhatsNewMessageEmbedded`, as this owner's `@part` row: the news item in ONE culture. */
@reflect
@entity("Part", "Master")
export class WhatsNewMessageEmbedded extends Entity {
    @backReference whatsNew: Lite<WhatsNewEntity>;
    @rowOrder order: int;

    culture: CultureInfoEntity;

    title: string;

    @stringLengthValidator({ multiLine: true })
    description: string;

    @quoted toString(): string { return this.title; }
}

/** Signum's `MList<FilePathEmbedded> Attachment`, as this owner's `@part` row. */
@reflect
@entity("Part", "Master")
export class WhatsNewEntity_Attachment extends Entity {
    @backReference whatsNew: Lite<WhatsNewEntity>;
    @rowOrder order: int;

    file: FilePathEmbedded;

    @quoted toString(): string { return this.file.fileName; }
}

export enum WhatsNewState {
    Draft,
    Publish,
}
registerEnum(WhatsNewState);

export namespace WhatsNewOperation {
    export const Save: ExecuteSymbol<WhatsNewEntity> = init();
    export const Delete: DeleteSymbol<WhatsNewEntity> = init();
    export const Publish: ExecuteSymbol<WhatsNewEntity> = init();
    export const Unpublish: ExecuteSymbol<WhatsNewEntity> = init();
}

export namespace WhatsNewFileType {
    export const WhatsNewAttachmentFileType: FileTypeSymbol = init();
    export const WhatsNewPreviewFileType: FileTypeSymbol = init();
}

/** Signum's `WhatsNewLogEntity` — who has read which news item, and when. */
@reflect
@entity("System", "Transactional")
export class WhatsNewLogEntity extends Entity {
    whatsNew: Lite<WhatsNewEntity>;

    user: Lite<UserEntity>;

    readOn: Temporal.PlainDateTime;

    @quoted toString(): string { return `${this.whatsNew.toString()}: ${this.user.toString()}`; }
}

export namespace WhatsNewLogOperation {
    export const Delete: DeleteSymbol<WhatsNewLogEntity> = init();
}

export const WhatsNewMessage = {
    News: msg("News"),
    NewNews: msg("New news"),
    YourNews: msg("Your news"),
    MyActiveNews: msg("My active news"),
    YouDoNotHaveAnyUnreadNews: msg("You do not have any unread news"),
    ViewMore: msg("View more"),
    CloseAll: msg("Close all"),
    AllMyNews: msg("All my news"),
    NewUnreadNews: msg("New unread news"),
    ReadFurther: msg("Read further"),
    Downloads: msg("Downloads"),
    _0ContiansNoVersionForCulture1: msg("{0} contains no version for culture '{1}'"),
    Language: msg("Language"),
    ThisNewIsNoLongerAvailable: msg("This new is no longer available"),
    BackToOverview: msg("Back to overview"),
    NewsPage: msg("News page"),
    Preview: msg("Preview"),
    IsRead: msg("Is read"),
    Close0WhatsNew: msg("Close {0} WhatsNew"),
    New: msg("NEW"),
};

// ---- the wire DTOs -------------------------------------------------------------------------------
//
// ALTEA: declared HERE, in the data layer, so the routes and the client agree on one definition — the call
// @altea/altea-omnibox made. Signum's live as nested classes on its controller and are duplicated by hand in
// its client namespace.

/** Signum's `WhatsNewController.MyNewsCountResult`. */
export interface NumWhatsNews {
    numWhatsNews: number;
}

// NOTE both DTOs type their date as an ISO STRING, exactly as Signum's generated `string /*DateTime*/` does,
// and for the same reason: a DTO is not an entity, so nothing revives a Temporal value inside it — the
// serializer only does that for reflected fields. Typing it `Temporal.PlainDateTime` compiles and then fails
// at runtime on the first `.since(…)`.

/** Signum's `WhatsNewShort` — what one toast in the navbar dropdown needs. */
export interface WhatsNewShort {
    whatsNew: Lite<WhatsNewEntity>;
    creationDate: string;
    title: string;
    description: string;
    status: string;
}

/** Signum's `WhatsNewFull` — what the overview and the news page need. */
export interface WhatsNewFull {
    whatsNew: Lite<WhatsNewEntity>;
    creationDate: string | null;
    title: string;
    description: string;
    attachments: number;
    previewPicture: boolean;
    status: string;
    read: boolean;
}

