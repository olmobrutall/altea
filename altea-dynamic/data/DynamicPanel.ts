import { init } from "@altea/altea/data/reflection";
import type { PermissionSymbol } from "@altea/altea/data/permissionSymbol";
import { msg } from "@altea/altea/data/utils/localization";

// Port of Signum.Dynamic's Dynamic.cs (DynamicPanelPermission) plus the panel's wire DTOs.
//
// `ViewDynamicPanel` lives in @altea/altea-eval (EvalPanelPermission), as in Signum. `RestartApplication`
// gates the restart button, which exists only when the host can come back up (DynamicLogic.restartApplication).
export namespace DynamicPanelPermission {
    export const RestartApplication: PermissionSymbol = init();
}

/** One diagnostic from compiling the generated code. */
export interface CompileError {
    /** The generated file, relative to the code-gen directory. */
    fileName: string;
    /** 1-based, as an author reads it. */
    line: number;
    message: string;
    /** The offending source line, quoted, as under each Roslyn diagnostic. */
    sourceLine: string;
}

/** A generated file whose content differs from what the running process loaded. */
export interface DynamicPendingChange {
    fileName: string;
    change: "Added" | "Modified" | "Removed";
}

/** What `/api/dynamic/compilationStatus` answers. */
/** A dynamic DATA module as the browser loads it: CommonJS, its imports answered by the client. */
export interface DynamicClientModule {
    /** Relative to the code-gen directory, with the `.ts` extension — what a relative import names. */
    fileName: string;
    code: string;
}

export interface DynamicCompilationStatus {
    /** The compile failure, if the server came up WITHOUT its dynamic types. */
    error?: string;
    /** The generated files, relative to the code-gen directory. */
    written: string[];
    /** Where those files are, so a diagnostic naming one can be found. Null when the app did not opt in. */
    codeGenDirectory: string | null;
    /** What a restart would load that this process did not: the definitions saved since it started. */
    pending: DynamicPendingChange[];
    /** The database mismatches tolerated at startup (StartParameters.ignoredDatabaseMismatches). */
    databaseMismatches: string[];
    /** Whether the host can restart itself (see DynamicLogic.restartApplication). */
    canRestart: boolean;
    /** When this process started, ISO — so the page can tell a restarted server from the old one. */
    startedAt: string;
}

/** What `/api/dynamic/compile` answers: the CURRENT definitions, compiled but neither written nor loaded. */
export interface DynamicCompileResult {
    errors: CompileError[];
    /** The source of every file an error names, so the page can show it. */
    files: { fileName: string; content: string }[];
}

export const DynamicPanelMessage = {
    DynamicPanel: msg("Dynamic panel"),
    Search: msg("Search"),
    EditAndCompile: msg("1. Edit and compile"),
    RestartServer: msg("2. Restart server"),
    SqlMigrations: msg("3. SQL migrations"),
    CheckEvals: msg("4. Check evals"),
    RefreshClients: msg("5. Refresh clients"),
    TheServerIsRunningWithoutItsDynamicTypes: msg("The server is running WITHOUT its dynamic types"),
    FixTheDefinitionAndRestart: msg("Fix the definition and restart. Until then a schema synchronization would script the missing types as DROPs — check any generated script."),
    DynamicCodeCompiledAndLoaded: msg("Dynamic code compiled and loaded."),
    NotConfigured: msg("This application has not configured the compiled half, so no dynamic types are generated (an app opts in by calling DynamicCodeCompiler.configure from its Starter)."),
    _0GeneratedFiles: msg("{0} generated file(s)"),
    NoChangesSinceTheServerStarted: msg("No changes since the server started."),
    ARestartIsNeededToLoadTheseChanges: msg("A restart is needed to load these changes:"),
    Compile: msg("Compile"),
    _0Errors: msg("{0} error(s)"),
    TheDynamicCodeCompiledSuccessfully: msg("The dynamic code compiled successfully."),
    FixTheseErrorsInTheDynamicDefinitions: msg("Fix these errors in the dynamic definitions."),
    File: msg("File"),
    Line: msg("Line"),
    Error: msg("Error"),
    RestartServerApplication: msg("Restart server application"),
    Restarting0s: msg("Restarting… ({0}s)"),
    RestartNotAvailable: msg("This host cannot restart itself. Restart the server process the way it was started; a new table also needs a schema synchronization."),
    AfterRestartSynchronize: msg("After a restart, a NEW type's table exists only once the schema is synchronized (terminal 'sync', or a SQL migration below)."),
    RefreshAll: msg("Refresh all"),
    NoErrorsFound: msg("No errors found"),
    YouNeedToRefreshManually: msg("Open browsers keep the old client until they reload (i.e. pressing F5)."),
    RefreshThisClient: msg("Refresh this client"),
    TheDatabaseDoesNotMatchTheCode: msg("The database does not match the code"),
    GenerateASqlMigrationAndExecuteIt: msg("Generate a SQL migration (step 3) and execute it."),
};
