
import type { BaseEntity } from './entity';
import { forEachField } from './changes';

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
export function entityIntegrityCheck(m: BaseEntity): IntegrityCheck | null {
    let errors: { [field: string]: string } | undefined;

    forEachField(m, fi => {
        const error = fi.validate(m);
        if (error != null)
            (errors ??= {})[fi.name] = error;
    });

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

    private static format(checks: IntegrityCheck[]): string {
        return checks
            .map(c => {
                const lines = Object.entries(c.errors).map(([field, msg]) => `  ${field}: ${msg}`);
                return `${c.entity.constructor.name}:\n${lines.join('\n')}`;
            })
            .join('\n\n');
    }
}
