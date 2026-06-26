import { Connector } from '../connection/connector';

// A composable tree of SQL statements produced by schema generation (and, later,
// synchronization / save). Mirrors Signum's SqlPreCommand, trimmed to what the
// generation milestone needs: no GO-splitting, no no-transaction modes, no
// history/versioning. A command is either a single statement (with optional
// parameters) or a spaced concatenation of sub-commands.

// Visual gap inserted between concatenated commands when rendered to plain SQL.
export enum Spacing {
    Simple = 'Simple',
    Double = 'Double',
    Triple = 'Triple',
}

function separatorFor(spacing: Spacing): string {
    switch (spacing) {
        case Spacing.Simple: return '\n';
        case Spacing.Double: return '\n\n';
        case Spacing.Triple: return '\n\n\n';
    }
}

// A named SQL parameter. Generation DDL is parameterless, but the type is shared
// with the save/query layers that follow.
export interface SqlParameter {
    readonly name: string;
    readonly value: unknown;
}

export abstract class SqlPreCommand {
    // Flattened list of the leaf (simple) statements, in execution order.
    abstract leaves(): SqlPreCommandSimple[];

    // Human-readable SQL for debugging / saving to a .sql file. Parameters are
    // inlined by the caller if needed (generation DDL has none).
    abstract plainSql(): string;

    toString(): string {
        return this.plainSql();
    }

    // ---- Convenience execution ----------------------------------------------
    //
    // Run against the *current* connector (Connector.current()). Set
    // Connector.default or wrap in Connector.withConnector before calling.

    // Executes every leaf statement in order, returning the total affected rows.
    async executeNonQuery(): Promise<number> {
        const connector = Connector.current();
        let total = 0;
        for (const leaf of this.leaves())
            total += await connector.executeNonQuery(leaf.sql, leaf.paramValues());
        return total;
    }

    // Executes a single statement and returns its rows. Throws if this command is
    // a concatenation of several statements (use a SqlPreCommandSimple).
    async executeQuery(): Promise<unknown[]> {
        const leaves = this.leaves();
        if (leaves.length !== 1)
            throw new Error('executeQuery expects a single statement; got ' + leaves.length);
        const leaf = leaves[0];
        return Connector.current().executeQuery(leaf.sql, leaf.paramValues());
    }

    // Combines several (possibly undefined) commands into one, dropping nulls.
    // Returns undefined when nothing remains, the single command when only one
    // survives, otherwise a SqlPreCommandConcat.
    static combine(spacing: Spacing, ...sentences: (SqlPreCommand | undefined)[]): SqlPreCommand | undefined {
        const real = sentences.filter((s): s is SqlPreCommand => s != null);
        if (real.length === 0)
            return undefined;
        if (real.length === 1)
            return real[0];
        return new SqlPreCommandConcat(spacing, real);
    }
}

export class SqlPreCommandSimple extends SqlPreCommand {
    constructor(
        public readonly sql: string,
        public readonly parameters?: SqlParameter[],
    ) {
        super();
    }

    leaves(): SqlPreCommandSimple[] {
        return [this];
    }

    plainSql(): string {
        return this.sql;
    }

    // Positional parameter values, in declaration order (or undefined when none),
    // as expected by Connector.executeNonQuery / executeQuery.
    paramValues(): unknown[] | undefined {
        return this.parameters?.map(p => p.value);
    }
}

export class SqlPreCommandConcat extends SqlPreCommand {
    constructor(
        public readonly spacing: Spacing,
        public readonly commands: SqlPreCommand[],
    ) {
        super();
    }

    leaves(): SqlPreCommandSimple[] {
        return this.commands.flatMap(c => c.leaves());
    }

    plainSql(): string {
        return this.commands.map(c => c.plainSql()).join(separatorFor(this.spacing));
    }
}

// Convenience: combine an array of (possibly undefined) commands with a spacing.
export function combineCommands(spacing: Spacing, commands: (SqlPreCommand | undefined)[]): SqlPreCommand | undefined {
    return SqlPreCommand.combine(spacing, ...commands);
}
