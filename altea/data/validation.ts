
import type { BaseEntity } from './entity';
import type { FieldInfo, IntegrityCheckEnvironment } from './reflection';
import { forEachField } from './changes';
// Side-effect import: validators.ts registers the implicit-NotNull factory the reflection layer needs
// (registerImplicitNotNullValidator). Loading it here guarantees the factory is present on every
// validation path — including server saves through entities that declare no explicit validators.
import './validators';

// Re-exported for callers that pick the phase (server Saver, webApi, client Operations).
export type { IntegrityCheckEnvironment } from './reflection';

// Reflection-driven validation — the port of Signum's ModifiableEntity.IntegrityCheck().
// Like change tracking, it reads only reflection metadata (the validators a field
// declared, plus any custom field validation), so it runs on the client and the
// server alike. The graph-wide check lives server-side in logic/graphExplorer.

// The per-entity result: a map of field name → error message. Mirrors Signum's
// IntegrityCheck (one entry per failing property).
export interface IntegrityCheck {
    readonly entity: BaseEntity;
    readonly errors: { readonly [field: string]: string };
}

/**
 * Runs every validator (and any custom field validation) declared on this
 * modifiable's fields. Returns an {@link IntegrityCheck} with the failing fields,
 * or `null` when everything is valid — matching Signum's `IntegrityCheck()` return.
 */
export function entityIntegrityCheck(m: BaseEntity, env: IntegrityCheckEnvironment): IntegrityCheck | null {
    let errors: { [field: string]: string } | undefined;

    forEachField(m, fi => {
        const error = fi.validate(m, env);
        if (error != null)
            (errors ??= {})[fi.name] = error;
    });

    return errors == null ? null : { entity: m, errors };
}

/**
 * The same check, awaiting any ASYNC customValidation (see FieldInfo.customValidation). Every SERVER path
 * uses this one; the sync twin above stays for the client's live per-field validation, which cannot await.
 *
 * Fields are validated SEQUENTIALLY rather than with Promise.all: an async validator may open a package or
 * query the database, and a wide entity would otherwise fan out a burst of concurrent work for a result
 * that is reported field-by-field anyway.
 */
export async function entityIntegrityCheckAsync(m: BaseEntity, env: IntegrityCheckEnvironment): Promise<IntegrityCheck | null> {
    let errors: { [field: string]: string } | undefined;

    const fields: FieldInfo[] = [];
    forEachField(m, fi => { fields.push(fi); });

    for (const fi of fields) {
        const error = await fi.validateAsync(m, env);
        if (error != null)
            (errors ??= {})[fi.name] = error;
    }

    return errors == null ? null : { entity: m, errors };
}

// The property-path -> error map the server returns in a 400 ModelState (Signum's ModelState;
// see api-controller-approach). Same shape as IntegrityCheck.errors, one entry per failing field.
export interface ModelState { [prefixError: string]: string; }

// Thrown by the Saver when one or more modifiables fail their integrity check —
// the port of Signum's IntegrityCheckException.
export class IntegrityCheckException extends Error {
    constructor(public readonly checks: IntegrityCheck[]) {
        super(IntegrityCheckException.format(checks));
        this.name = 'IntegrityCheckException';
    }

    // The failing fields flattened to one ModelState (field name → message) — the wire shape the client
    // parses into a ValidationError. The exceptionFilter emits this (no `exceptionType`) so a save that
    // fails integrity in the Saver reaches the client as field errors + summary, not a crash modal.
    get modelState(): ModelState {
        const ms: ModelState = {};
        for (const check of this.checks)
            for (const [field, message] of Object.entries(check.errors))
                ms[field] = message;
        return ms;
    }

    private static format(checks: IntegrityCheck[]): string {
        return checks
            .map(c => {
                const lines = Object.entries(c.errors).map(([field, msg]) => `  ${field}: ${msg}`);
                return `${c.entity.constructor.name}:\n${lines.join('\n')}`;
            })
            .join('\n\n');
    }
}
