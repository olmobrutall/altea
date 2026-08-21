import { reflect, init } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, stringLengthValidator, quoted, uniqueIndex } from "@altea/altea/data/decorators";
import type { ExecuteSymbol, DeleteSymbol } from "@altea/altea/data/operations";

// Port of Signum.Dynamic's CSS/DynamicCSSOverride.cs — a named stylesheet stored in the database and
// injected into the page. Nothing is compiled: the client appends a <style> element, which is why this
// sub-module ports at all (see DynamicLogic.server.ts's header for the half that does not).
//
// altea divergences:
//  - Signum declares `[Mixin(typeof(DisabledMixin))]` and filters on `Mixin<DisabledMixin>().IsDisabled`.
//    altea core has no DisabledMixin — in Signum it is a framework-wide concept with its own Disable /
//    Enable operations and query filters, none of which altea has — so this is a plain field. One column
//    either way; what is lost is the shared operations, which nothing here used.
//  - Signum serves the stylesheet by interpolating it into `Index.cshtml`. altea has no server-rendered
//    page, so DynamicCSSOverrideServer exposes it as an endpoint the client fetches at boot (the same call
//    the AzureAD / OpenID configuration endpoints made).
@reflect
@entity("Main", "Master")
export class DynamicCSSOverrideEntity extends Entity {

    @uniqueIndex
    @stringLengthValidator({ min: 3, max: 100 })
    name: string;

    @stringLengthValidator({ min: 3, multiLine: true })
    script: string;

    /** Signum's `DisabledMixin.IsDisabled` — a disabled override stays stored but is not served. */
    isDisabled: boolean = false;

    @quoted
    override toString(): string {
        return this.name;
    }
}

export namespace DynamicCSSOverrideOperation {
    export const Save: ExecuteSymbol<DynamicCSSOverrideEntity> = init();
    export const Delete: DeleteSymbol<DynamicCSSOverrideEntity> = init();
}
