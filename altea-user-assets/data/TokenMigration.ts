import { reflect } from "@altea/altea/data/reflection";
import { Entity } from "@altea/altea/data/entity";
import { entity, quoted, stringLengthValidator, ticksColumn, uniqueIndex } from "@altea/altea/data/decorators";

// Port of Signum.UserAssets' TokenMigrations/TokenMigrationEntity.cs — one row per APPLIED token
// migration, the same shape a SQL migration row has: the version, and the comment from its file name.
//
// The problem the whole subsystem exists for: a user asset (a UserQuery, a UserChart, an email or office
// template) stores its query tokens as STRINGS. Rename a field or a query and every stored token that
// walked through it stops resolving — and nothing in the schema sync notices, because the tokens are
// data, not schema. So the renames are captured into versioned `.tokens.json` files beside the SQL
// migrations, and replayed against the stored assets; this table records which of those files have run.

@reflect
@entity("System", "Transactional")
// Signum's `[TicksColumn(false)]`: written once by the runner, never edited by a person.
@ticksColumn(false)
export class TokenMigrationEntity extends Entity {
    @uniqueIndex
    @stringLengthValidator({ max: 200 })
    versionNumber: string;

    @stringLengthValidator({ min: 0, max: 400 })
    comment: string | null;

    /** Signum's `[AutoExpressionField] ToString() => VersionNumber`. */
    @quoted
    override toString(): string {
        return this.versionNumber;
    }
}
