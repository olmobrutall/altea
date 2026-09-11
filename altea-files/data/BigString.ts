import { reflect } from "@altea/altea/data/reflection";
import { MixinEntity } from "@altea/altea/data/entity";
import type { Type } from "@altea/altea/data/entity";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { FilePathEmbedded } from "./Files";

// Port of Signum.Files' BigStringMixin.cs — see port/Files.md.
//
// The extension point BigStringEmbedded was written for (see @altea/altea/data/bigString.ts): a mixin that
// hangs a FilePathEmbedded off EVERY BigStringEmbedded, so a configured property can keep its (possibly
// huge) text in file/blob storage instead of in the row, without any of its readers or writers knowing.
// Which routes do that is BigStringLogic's business.
//
// The mixin is pure DATA — the lifecycle handlers live on each OWNING type, since altea's events are per
// entity type. It must be DECLARED for the field to exist at all, and `BigStringMixin.declare()` MUST run
// on BOTH TIERS: it is what tells the serializer the field is there. Put it in a module the client and the
// server both load, next to the app's other entity overrides.

@reflect
export class BigStringMixin extends MixinEntity {
    /** The stored text, when this route keeps it in a file. Null while the
     *  text lives in the row — and always null for a route configured `Database`, whose column is ignored. */
    file: FilePathEmbedded | null = null;
}

export namespace BigStringMixin {
    let declared = false;

    /** Declare the mixin on BigStringEmbedded (`MixinDeclarations.register<BigStringEmbedded,
     *  BigStringMixin>()`). Idempotent, and must be called on BOTH tiers before anything is (de)serialized or
     *  the schema is built. Declaring it is not free: every BigStringEmbedded route in the schema then grows
     *  the file columns unless BigStringLogic ignores them — which it does for `Database` mode, so a route
     *  that stays in the row costs nothing after registration. */
    export function declare(): void {
        if (declared)
            return;
        declared = true;

        MixinDeclarations.register(BigStringEmbedded, BigStringMixin);
    }

    export function isDeclared(): boolean {
        return declared;
    }
}
