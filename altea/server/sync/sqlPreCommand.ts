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

// True when `sql` has no executable content — only line/block comments and whitespace.
function isCommentOnly(sql: string): boolean {
    const stripped = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    return stripped.length === 0;
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

    // Executes every leaf statement in order, returning the total affected rows. A comment-only leaf
    // (e.g. a `commentedError` emitted when a sync step failed) is skipped — it carries no executable
    // SQL, and some drivers reject an all-comment batch.
    async executeNonQuery(): Promise<number> {
        const connector = Connector.current();
        let total = 0;
        for (const leaf of this.leaves()) {
            if (isCommentOnly(leaf.sql))
                continue;
            total += await connector.executeNonQuery(leaf.sql, leaf.paramValues());
        }
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

// Port of Signum's SqlPreCommand_WithHistory (Engine/Sync/SqlPreCommand.cs). A single node
// carrying BOTH a `normal` command (targeting the main table) and its `history` counterpart
// (the same change retargeted at the system-versioned history table). The synchronizer builds a
// column diff whose commands are these pairs, then splits the tree into two streams with the
// static `forNormal` / `forHistory` — the main-table script and the (delayed) history-table
// script. On SQL Server the history table follows the main automatically, so the diff is never
// built with-history and these never appear; they are Postgres-only (altea's history table is an
// explicit `(LIKE main)` copy that must be maintained by hand). A WithHistory node must be split
// before rendering — leaves()/plainSql() throw if one survives into the final tree.
export class SqlPreCommandWithHistory extends SqlPreCommand {
    constructor(
        public readonly normal: SqlPreCommand | undefined,
        public readonly history: SqlPreCommand | undefined,
    ) {
        super();
    }

    leaves(): SqlPreCommandSimple[] {
        throw new Error("SqlPreCommandWithHistory must be resolved via forNormal/forHistory before execution");
    }

    plainSql(): string {
        throw new Error("SqlPreCommandWithHistory must be resolved via forNormal/forHistory before rendering");
    }

    // The main-table stream: plain commands pass through, concats recurse, a WithHistory node
    // yields its `normal` half (Signum's ForNormal).
    static forNormal(command: SqlPreCommand | undefined): SqlPreCommand | undefined {
        if (command == null)
            return undefined;
        if (command instanceof SqlPreCommandWithHistory)
            return command.normal;
        if (command instanceof SqlPreCommandConcat)
            return SqlPreCommand.combine(command.spacing, ...command.commands.map(c => SqlPreCommandWithHistory.forNormal(c)));
        return command; // SqlPreCommandSimple
    }

    // The history-table stream: plain commands pass through, concats recurse, a WithHistory node
    // yields its `history` half (Signum's ForHistory).
    static forHistory(command: SqlPreCommand | undefined): SqlPreCommand | undefined {
        if (command == null)
            return undefined;
        if (command instanceof SqlPreCommandWithHistory)
            return command.history;
        if (command instanceof SqlPreCommandConcat)
            return SqlPreCommand.combine(command.spacing, ...command.commands.map(c => SqlPreCommandWithHistory.forHistory(c)));
        return command; // SqlPreCommandSimple
    }
}

/**
 * Signum's `ExecuteSqlScriptException` (Signum/Engine/Sync/SqlPreCommand.cs): the marker a migration
 * runner throws once it has ALREADY REPORTED a failure to the console. Its callers catch this type and
 * only this type — interactively they swallow it and redraw their menu (the dev has seen the error and
 * can fix the script / the step and retry), while an autoRun deploy rethrows so the process exits.
 * Without it a reported error is printed a second time by the terminal's top-level handler.
 */
export class ExecuteSqlScriptException extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "ExecuteSqlScriptException";
    }
}
