import "./index"; // installs Entity.save()/delete()
import "./fluentOperations"; // FluentInclude.withSave / withExecute / withStateMachine / … (the operation methods)
import "./dynamicQuery/fluentIncludeQuery"; // FluentInclude.withQuery
import type { SchemaBuilder } from "./schema/schemaBuilder";
import type { ResetLazy } from "./resetLazy";
import { table } from "./table";
import { CultureInfoEntity, CultureInfoOperation, cultureDisplayNames } from "../data/cultureInfoEntity";
import { Metadata } from "../data/metadata";
import { setCultureNameResolver } from "../data/cultureInfoEntity";
import type { Lite } from "../data/lite";

// Port of Signum's CultureInfoLogic (Signum/Basics/CultureInfoLogic.cs): the table of cultures the
// APPLICATION supports, plus the caches that map a locale tag to its row and back.
//
// This is what makes a culture a first-class thing rather than a loose string: the culture PICKER offers
// these rows, and an email / Office template REFERENCES one (`Lite<CultureInfoEntity>`), so renaming or
// removing a supported culture is a data change with referential integrity behind it, not a silent
// mismatch between a template's stored text and whatever the UI happens to send.
//
// altea divergences from Signum:
//  - `CultureInfo.GetCultureInfo(name)` → `Intl.DisplayNames` (see data/cultureInfoEntity). Same CLDR
//    data, no .NET dependency.
//  - Signum derives nativeName/englishName in the entity's `PreSaving`; altea has no such hook, so the
//    Save operation does it. That keeps them in step with `name` however the row is edited.
//  - Signum's `Schema_Synchronizing` re-writes the derived names on every sync. altea does the equivalent
//    on save + seed; a sync-time refresh can be added when a translation of Intl's data actually drifts.
export namespace CultureInfoLogic {

    let started = false;
    /** Whether the culture TABLE is in play — the reflection layer asks, to decide where its catalogue comes from. */
    export function isStarted(): boolean { return started; }

    /** name → row, for the whole application (Signum's CultureInfoToEntity). */
    export let cultures: ResetLazy<Map<string, CultureInfoEntity>> = null!;

    export function start(sb: SchemaBuilder): void {
        if (started)
            return;
        started = true;

        sb.include(CultureInfoEntity)
            // Signum's PreSaving on Save: keep the two derived names in step with the tag, whoever edited it.
            .withSave(CultureInfoOperation.Save, { execute: c => { Object.assign(c, cultureDisplayNames(c.name)); } })
            .withDelete(CultureInfoOperation.Delete)
            .withQuery();

        cultures = sb.globalLazy(
            async () => new Map((await table(CultureInfoEntity).toArray() as CultureInfoEntity[]).map(c => [c.name, c])),
            { invalidateWith: [CultureInfoEntity] });

        // A stored `Lite<CultureInfoEntity>` has to be resolvable back to its locale TAG wherever a
        // template decides which message to use, and that code is isomorphic. So the data layer asks
        // through a resolver, and this is the server's answer (the client installs its own).
        setCultureNameResolver(lite => toCultureName(lite as Lite<CultureInfoEntity>));

        // LOADED at startup, and again after a row changes — not because anything depends on it being warm
        // (every reader awaits), but because the catalogue seam below is a PEEK: cold, it answers with the
        // loaded translation files, which is a different list (a culture can ship a translation without a
        // row, and have a row without a translation). Being warm from the first request is what makes the
        // client boot see what the application actually supports.
        sb.schema.initializing.push(() => cultures.load());
        sb.schema.entityEvents(CultureInfoEntity).saved.push(async () => { await cultures.load(); });

        // The reflection layer's culture catalogue now has a real source of truth: what the APPLICATION
        // supports, rather than what happens to have a translation file. (Before this it could only infer
        // the list from the loaded translations — a decent guess, but it could neither offer an untranslated
        // supported culture nor withhold one the app does not actually support.)
        // The ONE synchronous reader left, and it is a seam rather than a cache of its own: it peeks at the
        // lazy's loaded value and answers `undefined` when it is cold, so `Metadata.cultures()` falls back
        // to the loaded translations instead of to a stale list. It is synchronous because per-request
        // culture negotiation (webApi) is, and it can never disagree with the lazy — there is nothing else
        // to keep in step.
        Metadata.setCultureCatalogue(() => {
            const loaded = cultures?.valueOrUndefined;
            return loaded == null ? undefined : [...loaded.keys()];
        });
    }

    /**
     * The application's cultures, RESOLVED — what a synchronous per-culture loop takes: an XML import
     * mapping a list of per-culture messages, a template seeder building one message per culture inside
     * `CultureInfo.withCultures`. One await, then read it as often as you like.
     */
    export async function lookup(): Promise<CultureLookup> {
        return new CultureLookup(await cultures.value());
    }

    /**
     * The row for a locale tag (Signum's TryGetCultureInfoEntity), falling back to the tag's LANGUAGE when
     * the specific culture is not supported: an app that ships "en" should answer a request for "en-US"
     * with English rather than nothing. This is the same exact-then-language fallback the template message
     * lookup uses, applied one level lower.
     */
    export async function tryGetCulture(name: string): Promise<CultureInfoEntity | undefined> {
        return (await lookup()).tryGet(name);
    }

    /** As {@link tryGetCulture}, throwing when neither the culture nor its language is supported. */
    export async function getCulture(name: string): Promise<CultureInfoEntity> {
        return (await lookup()).get(name);
    }

    /** Every supported culture's tag (Signum's ApplicationCultures); `isNeutral` filters "es" from "es-AR". */
    export async function applicationCultures(isNeutral?: boolean): Promise<string[]> {
        return (await lookup()).names(isNeutral);
    }

    /** The locale tag behind a stored `Lite<CultureInfoEntity>` — what a renderer needs (it formats with a tag). */
    export function toCultureName(lite: Lite<CultureInfoEntity> | null | undefined): string | undefined {
        if (lite == null)
            return undefined;
        // SYNCHRONOUS, like the resolver seam it answers (a template resolves a stored culture while
        // rendering). Reads the lazy's loaded value — cold or unknown both mean "no tag", which is what the
        // caller already falls back on.
        const byId = [...(cultures?.valueOrUndefined?.values() ?? [])].find(c => String(c.id) === String(lite.id));
        // The lite's own toStr is the ENGLISH name, not the tag, so it is no fallback — an unknown id means
        // the row was deleted, and the caller should fall back to its own default culture.
        return byId?.name;
    }

    /**
     * Ensure a row exists for each tag (a seeder / migration helper — Signum seeds from
     * `CultureInfo.GetCultures`). Idempotent: an existing row is left alone apart from refreshing its
     * derived names.
     */
    export async function ensureCultures(names: string[]): Promise<void> {
        const existing = new Map((await table(CultureInfoEntity).toArray() as CultureInfoEntity[]).map(c => [c.name, c]));
        for (const name of names) {
            const row = existing.get(name) ?? CultureInfoEntity.create({ name });
            Object.assign(row, cultureDisplayNames(name));
            await row.save();
        }
        cultures?.reset();
    }
}

/**
 * The application's cultures as a resolved snapshot — see {@link CultureInfoLogic.lookup}. Everything here
 * is synchronous, so a caller that has awaited once can loop, filter and fall back without another hop.
 */
export class CultureLookup {
    constructor(private readonly byName: ReadonlyMap<string, CultureInfoEntity>) { }

    /** The row for a locale tag, falling back to the tag's LANGUAGE ("en-US" → "en") — an app that ships
     *  "en" answers a request for "en-US" with English rather than with nothing. */
    tryGet(name: string): CultureInfoEntity | undefined {
        const dash = name.indexOf("-");
        return this.byName.get(name) ?? (dash > 0 ? this.byName.get(name.slice(0, dash)) : undefined);
    }

    /** As {@link tryGet}, throwing when neither the culture nor its language is supported. */
    get(name: string): CultureInfoEntity {
        const c = this.tryGet(name);
        if (c == null)
            throw new Error(`Culture '${name}' is not one of the application's cultures (${[...this.byName.keys()].join(", ")})`);
        return c;
    }

    all(): CultureInfoEntity[] {
        return [...this.byName.values()];
    }

    /** Every supported culture's tag (Signum's ApplicationCultures); `isNeutral` filters "es" from "es-AR". */
    names(isNeutral?: boolean): string[] {
        return this.all()
            .filter(c => isNeutral == null || c.isNeutral() === isNeutral)
            .map(c => c.name)
            .sort();
    }

    /** Every culture as (tag, lite) — what a per-culture BUILDER needs, since its own loop stays
     *  synchronous inside `CultureInfo.withCultures`. */
    lites(isNeutral?: boolean): { name: string; lite: Lite<CultureInfoEntity> }[] {
        return this.names(isNeutral).map(name => ({ name, lite: this.get(name).toLite() }));
    }
}
