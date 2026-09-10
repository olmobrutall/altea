import { SafeConsole, Color } from "@altea/altea/server/safeConsole";
import type { StringDistance } from "@altea/altea/server/sync/stringDistance";
import { SubTokensOptions } from "@altea/altea/data/dynamicQuery/tokens/queryToken";
import type { QueryName } from "@altea/altea/data/dynamicQuery/queryUtils";
import { tryGetTypeInfo, type TypeInfo } from "@altea/altea/data/reflection";
import { cleanTypeName } from "@altea/altea/data/registration";
import { MixinDeclarations } from "@altea/altea/data/mixinDeclarations";
import type { BaseEntity, Type } from "@altea/altea/data/entity";
import type { TokenSyncContext } from "@altea/altea-user-assets/server/TokenSyncContext";
import type { FixTokenResult } from "@altea/altea-user-assets/server/QueryTokenSynchronizer";
import { QueryTokenSynchronizer } from "@altea/altea-user-assets/server/QueryTokenSynchronizer";
import { ScopedDictionary } from "./TemplateUtils";
import { MemberWithArguments, ParsedToken, TokenValueProvider, type ValueProviderBase } from "./ValueProviders";

// Port of Signum.Templating's `TemplateSynchronizationContext` (CommonTemplate.cs) — the BODY-TEXT half of
// the token migration, and the consumer @altea/altea-user-assets' `Member` / `Global` rename buckets were
// waiting for.
//
// What it repairs: a template's stored query tokens are its filters and orders, and a subscriber already
// walks those (see @altea/altea-email's EmailTemplateTokenSync). But a template's BODY carries tokens too —
// `@[Customer.Name]`, `@foreach[Details] as $d`, `@if[TotalPrice]` — and a renamed field breaks each of
// them with nothing to notice until the template is rendered. This is the pass that rewrites them, from the
// same recorded decisions.
//
// The shape is Signum's: the walk lives on the NODES and the value PROVIDERS (each gained a `synchronize`),
// and this class is the state they thread through — the variable scope, the rename buckets, and the one
// `hasChanges` flag that tells the caller whether to write the text back.
//
// altea divergences:
//  - **there is no QueryDescription**, so a token is fixed against the QUERY NAME (`fixToken` takes one).
//    `queryName` being undefined is what "model-only template" means here, rather than a null QD.
//  - **no `forceChange`.** Signum threads that flag down to `FixToken` for "it resolves, but change it
//    anyway"; altea DISCOVERS staleness by whether the token resolves, so `fixToken` has no such option —
//    and every call site in Signum's own text-template walk passes `false`.
//  - **the MEMBER bucket can only offer candidates for a REFLECTED type.** Signum asks
//    `type.GetFields()/GetProperties()` of any CLR type, so `@[m:SomeModel.Whatever]` gets a rename prompt
//    whatever the model is. altea has a member table only where the transformer wrote one — a reflected
//    entity / embedded / model, plus its mixins — so a step whose owner is not reflected is ACCEPTED
//    unchanged rather than offered for rename. Inventing candidates would be worse: a rename recorded
//    against a guess misfires later, against every template that shares the bucket.

/** Signum's `TemplateSyncException` — a decision the CALLER has to act on, thrown out of the walk. */
export class TemplateSyncException extends Error {
    constructor(public readonly result: FixTokenResult) {
        super("Template synchronization: " + result);
    }
}

export class TemplateSynchronizationContext {

    /** The `$name` providers in scope, pushed/popped by `newScope` around a block. */
    variables: ScopedDictionary<ValueProviderBase>;

    /** True once anything in the body was rewritten — what tells the caller to save the new text. */
    hasChanges = false;

    constructor(
        /** The template being synchronized, for the console report. */
        readonly template: BaseEntity,
        readonly tokenSync: TokenSyncContext,
        readonly stringDistance: StringDistance,
        /** The template's query, or undefined for a model-only template (no query tokens to fix). */
        readonly queryName: QueryName | undefined,
        /** The template's model type, when it has one — what `@[m:…]` members are read off. */
        readonly modelType: Function | undefined,
    ) {
        this.variables = new ScopedDictionary<ValueProviderBase>(undefined);
    }

    /**
     * Signum's `SynchronizeToken` — fix ONE token found in the body.
     *
     * A token that already resolved is left alone: `parsedToken.queryToken != undefined` IS the staleness
     * test here, which is how the rest of altea's token sync works too.
     *
     * A `$variable` prefix is resolved first. `@[$d.Product]` names a token relative to whatever `$d` was
     * declared as, so what reaches the fixer is that provider's own token plus the remainder — and a
     * variable that is missing, is not a token, or is not itself fixed yet is REPORTED rather than
     * silently treated as absent, because each produces a different wrong answer downstream.
     */
    async synchronizeToken(parsedToken: ParsedToken, remainingText: string, canAny: boolean): Promise<void> {
        if (parsedToken.queryToken != undefined)
            return;

        if (this.queryName == undefined)
            throw new Error("Unable to synchronize a token without a query: " + parsedToken.tokenString);

        let tokenString = parsedToken.tokenString;

        if (tokenString.startsWith("$")) {
            const dot = tokenString.indexOf(".");
            const v = dot < 0 ? tokenString : tokenString.substring(0, dot);
            const prov = this.variables.tryGet(v);

            if (prov == undefined)
                SafeConsole.writeLineColor(Color.magenta, `  Variable '${v}' not found!`);
            else if (!(prov instanceof TokenValueProvider))
                SafeConsole.writeLineColor(Color.magenta, `  Variable '${v}' is not a query token`);

            const part = prov instanceof TokenValueProvider ? prov.parsedToken : undefined;

            if (part != undefined && part.queryToken == undefined)
                SafeConsole.writeLineColor(Color.magenta,
                    `  Variable '${v}' is not fixed yet! currently: '${part.tokenString}'`);

            const head = part == undefined ? "Unknown"
                : part.queryToken == undefined ? part.tokenString
                    : part.queryToken.fullKey();

            tokenString = head + (dot < 0 ? "" : "." + tokenString.substring(dot + 1));
        }

        SafeConsole.writeLine(`${cleanTypeName(this.template.constructor)}: ${this.template.toString()}`);
        SafeConsole.writeColor(Color.red, "  " + tokenString);
        SafeConsole.writeLine(" " + remainingText);

        const options = SubTokensOptions.CanElement
            | (canAny ? SubTokensOptions.CanAnyAll : 0)
            | SubTokensOptions.CanNested
            | SubTokensOptions.CanToArray;

        const fixed = await QueryTokenSynchronizer.fixToken(this.tokenSync, tokenString, this.queryName, options, {
            remainingText,
            allowRemoveToken: false,
            allowReGenerate: this.modelType != undefined,
        });

        switch (fixed.result) {
            case "Nothing":
            case "Fix":
                this.hasChanges = true;
                parsedToken.queryToken = fixed.token ?? undefined;
                if (fixed.token != null)
                    parsedToken.tokenString = fixed.token.fullKey();
                break;
            default:
                // SkipEntity / RemoveToken / RegenerateEntity are the caller's to act on.
                throw new TemplateSyncException(fixed.result);
        }
    }

    /**
     * Signum's `GetMembers` — fix a `.`-separated MEMBER chain (`@[m:Order.Customer.Name]`) against the
     * MEMBER rename bucket, one step at a time, carrying the type forward so each step is asked of the
     * right owner.
     *
     * Answers undefined when a step could not be resolved, which the provider treats as "leave the chain
     * as written"; `hasChanges` is set either way, so a chain that CHANGED is written back and one that
     * could not be resolved is still reported.
     *
     * See the header on why a step whose owner is not a REFLECTED type is accepted unchanged.
     */
    async getMembers(fieldOrPropertyChain: string, initialType: Function | undefined): Promise<MemberWithArguments[] | undefined> {
        const members: MemberWithArguments[] = [];
        let ti = initialType == undefined ? undefined : tryGetTypeInfo(initialType);

        for (const field of fieldOrPropertyChain.split(".").filter(f => f.length > 0)) {
            if (ti == undefined) {
                // Not reflected — accept the step as written (see the header).
                members.push(new MemberWithArguments(field, undefined));
                continue;
            }

            const owner = ti.ctor == undefined ? undefined : cleanTypeName(ti.ctor);
            const chosen = await this.tokenSync.askRename(
                "Member", owner ?? null, field, memberNames(ti), this.stringDistance);

            if (chosen == null) {
                this.hasChanges = true;
                return undefined;
            }

            if (chosen !== field)
                this.hasChanges = true;

            members.push(new MemberWithArguments(chosen, undefined));
            ti = nextTypeInfo(ti, chosen);
        }

        return members;
    }

    /** Signum's `NewScope()` — push a variable scope, and pop it when the block ends. */
    newScope(): { dispose: () => void } {
        this.variables = new ScopedDictionary<ValueProviderBase>(this.variables);
        return { dispose: () => { this.variables = this.variables.previous!; } };
    }
}

/** Every member a rename could land on: the type's own fields plus each declared mixin's. */
function memberNames(ti: TypeInfo): string[] {
    const names = Object.keys(ti.fields);

    if (ti.ctor != undefined)
        for (const mixin of MixinDeclarations.getMixins(ti.ctor as Type<BaseEntity>)) {
            const mti = tryGetTypeInfo(mixin);
            if (mti != undefined)
                names.push(...Object.keys(mti.fields));
        }

    return names;
}

/**
 * The TypeInfo one member step lands on, or undefined once the chain leaves reflected ground.
 *
 * Through `FieldInfo.getFunction()` — the transformer-stamped constructor — not through `typeName`, which
 * is the COARSE name (`"Entity"` for a reference) and would resolve to the wrong type or to nothing.
 */
function nextTypeInfo(ti: TypeInfo, member: string): TypeInfo | undefined {
    const ctor = ti.fields[member]?.getFunction();
    return ctor == undefined ? undefined : tryGetTypeInfo(ctor);
}
