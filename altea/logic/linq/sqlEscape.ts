// Port of Signum's SqlUtils.SqlEscape + reserved-word lists (Engine/Sync/SqlUtils.cs).
// An identifier is quoted ONLY when it must be: a reserved word, a non-simple name, or
// (Postgres) not already all-lowercase. Otherwise it is emitted bare — so altea's SQL
// reads like Signum's ("a.sex_id", not "\"a\".\"sex_id\"").

const KEYWORDS_POSTGRES = new Set<string>([
    "ALL", "ANALYSE", "AND", "ANY", "ARRAY", "AS", "ASC", "ASYMMETRIC", "BOTH", "CASE", "CAST", 
    "CHECK", "COLLATE", "COLUMN", "CONSTRAINT", "CREATE", "CURRENT_CATALOG", "CURRENT_DATE", 
    "CURRENT_ROLE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURRENT_USER", "DEFAULT", "DEFERRABLE", 
    "DESC", "DISTINCT", "DO", "ELSE", "END", "EXCEPT", "FALSE", "FETCH", "FOR", "FOREIGN", "FROM", 
    "GRANT", "GROUP", "HAVING", "IN", "INITIALLY", "INTERSECT", "INTO", "IS", "LATERAL", "LEADING", 
    "LIMIT", "LOCALTIME", "LOCALTIMESTAMP", "NOT", "NULL", "OFFSET", "ON", "ONLY", "OR", "ORDER", 
    "PLACING", "PRIMARY", "REFERENCES", "RETURNING", "SELECT", "SESSION_USER", "SOME", "SYMMETRIC", 
    "TABLE", "THEN", "TO", "TRAILING", "TRUE", "UNION", "UNIQUE", "USER", "USING", "VARIADIC", "WHEN", 
    "WHERE", "WINDOW", "WITH", 
]);

const KEYWORDS_SQLSERVER = new Set<string>([
    "ADD", "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "AUTHORIZATION", "AVG", "BACKUP", "BEGIN", 
    "BETWEEN", "BREAK", "BROWSE", "BULK", "BY", "CASCADE", "CASE", "CHECK", "CHECKPOINT", "CLOSE", 
    "CLUSTERED", "COALESCE", "COLUMN", "COMMIT", "COMMITTED", "COMPUTE", "CONFIRM", "CONSTRAINT", 
    "CONTAINS", "CONTAINSTABLE", "CONTINUE", "CONTROLROW", "CONVERT", "COUNT", "CREATE", "CROSS", 
    "CURRENT", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURRENT_USER", "CURSOR", 
    "DATABASE", "DBCC", "DEALLOCATE", "DECLARE", "DEFAULT", "DELETE", "DENY", "DESC", "DISK", 
    "DISTINCT", "DISTRIBUTED", "DOUBLE", "DROP", "DUMMY", "DUMP", "ELSE", "END", "ERRLVL", "ERROREXIT", 
    "ESCAPE", "EXCEPT", "EXEC", "EXECUTE", "EXISTS", "EXIT", "FETCH", "FILE", "FILLFACTOR", "FLOPPY", 
    "FOR", "FOREIGN", "FREETEXT", "FREETEXTTABLE", "FROM", "FULL", "GOTO", "GRANT", "GROUP", "HAVING", 
    "HOLDLOCK", "IDENTITY", "IDENTITYCOL", "IDENTITY_INSERT", "IF", "IN", "INDEX", "INNER", "INSERT", 
    "INTERSECT", "INTO", "IS", "ISOLATION", "JOIN", "KEY", "KILL", "LEFT", "LEVEL", "LIKE", "LINENO", 
    "LOAD", "MAX", "MIN", "MIRROREXIT", "NATIONAL", "NOCHECK", "NONCLUSTERED", "NOT", "NULL", "NULLIF", 
    "OF", "OFF", "OFFSETS", "ON", "ONCE", "ONLY", "OPEN", "OPENDATASOURCE", "OPENQUERY", "OPENROWSET", 
    "OPTION", "OR", "ORDER", "OUTER", "OVER", "PERCENT", "PERM", "PERMANENT", "PIPE", "PLAN", 
    "PRECISION", "PREPARE", "PRIMARY", "PRINT", "PRIVILEGES", "PROC", "PROCEDURE", "PROCESSEXIT", 
    "PUBLIC", "RAISERROR", "READ", "READTEXT", "RECONFIGURE", "REFERENCES", "REPEATABLE", 
    "REPLICATION", "RESTORE", "RESTRICT", "RETURN", "REVOKE", "RIGHT", "ROLLBACK", "ROWCOUNT", 
    "ROWGUIDCOL", "RULE", "SAVE", "SCHEMA", "SELECT", "SERIALIZABLE", "SESSION_USER", "SET", "SETUSER", 
    "SHUTDOWN", "SOME", "STATISTICS", "SUM", "SYSTEM_USER", "TABLE", "TAPE", "TEMP", "TEMPORARY", 
    "TEXTSIZE", "THEN", "TO", "TOP", "TRAN", "TRANSACTION", "TRIGGER", "TRUNCATE", "TSEQUAL", 
    "UNCOMMITTED", "UNION", "UNIQUE", "UPDATE", "UPDATETEXT", "USE", "USER", "VALUES", "VARYING", 
    "VIEW", "WAITFOR", "WHEN", "WHERE", "WHILE", "WITH", "WORK", "WRITETEXT", 
]);

export function sqlEscape(ident: string, isPostgres: boolean): string {
    if (isPostgres) {
        if (ident.toLowerCase() !== ident || KEYWORDS_POSTGRES.has(ident.toUpperCase()) || !/^[a-z_][a-z0-9_]{0,62}$/.test(ident))
            return `"${ident}"`;
        return ident;
    }
    if (KEYWORDS_SQLSERVER.has(ident.toUpperCase()) || !/^[a-zA-Z_][a-zA-Z0-9_@#]{0,127}$/.test(ident))
        return `[${ident}]`;
    return ident;
}
