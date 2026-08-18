import { reflect } from "@altea/altea/data/reflection";
import { MixinEntity } from "@altea/altea/data/entity";
import type { Type } from "@altea/altea/data/entity";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import { BigStringEmbedded } from "@altea/altea/data/bigString";
import { FilePathEmbedded } from "./Files";

// Port of Signum.Files' BigStringMixin.cs — the extension point altea's BigStringEmbedded was written for
// (see @altea/altea/data/bigString.ts): a mixin that hangs a FilePathEmbedded off EVERY BigStringEmbedded, so
// a configured property can keep its (possibly huge) text in file/blob storage instead of in the row, without
// any of its readers or writers knowing. Which routes do that, and in which direction they are migrating, is
// BigStringLogic's business (server/BigStringLogic.server.ts).
//
// altea divergences, documented inline:
//  - Signum's mixin overrides `PreSaving` / `PostRetrieving` and forwards to two static Actions that
//    BigStringLogic fills. altea has no per-embedded lifecycle hooks — its events are per ENTITY TYPE — so
//    BigStringLogic registers handlers on each OWNING type instead (the same shape FilePathEmbeddedLogic
//    already uses), and the mixin is pure data.
//  - The mixin has to be DECLARED for the field to exist at all, and the declaration is what makes the
//    `file` column appear. Signum declares it in the app's Starter (`MixinDeclarations.Register`) and
//    BigStringLogic merely asserts it; altea keeps the same split, with `BigStringMixin.declare()` as the
//    single call — which MUST run on BOTH TIERS (it is what tells the serializer the field exists), so put it
//    in a module the client and the server both load, next to the app's other entity overrides.

@reflect
export class BigStringMixin extends MixinEntity {
    /** The stored text, when this route keeps it in a file (Signum's `BigStringMixin.File`). Null while the
     *  text lives in the row — and always null for a route configured `Database`, whose column is ignored. */
    file: FilePathEmbedded | null = null;
}

export namespace BigStringMixin {
    let declared = false;

    /** Declare the mixin on BigStringEmbedded (Signum's `MixinDeclarations.Register<BigStringEmbedded,
     *  BigStringMixin>()`). Idempotent, and must be called on BOTH tiers before anything is (de)serialized or
     *  the schema is built. Declaring it is not free: every BigStringEmbedded route in the schema then grows
     *  the file columns unless BigStringLogic ignores them — which it does for `Database` mode, so a route
     *  that stays in the row costs nothing after registration. */
    export function declare(): void {
        if (declared)
            return;
        declared = true;

        MixinDeclarations.register(
            BigStringEmbedded as unknown as Type<BigStringEmbedded>,
            BigStringMixin as unknown as Type<BigStringMixin>);
    }

    export function isDeclared(): boolean {
        return declared;
    }
}
