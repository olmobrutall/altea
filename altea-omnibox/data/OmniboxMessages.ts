import { init, setDefaultDatabaseSchema } from "@altea/altea/data/reflection";
import { msg } from "@altea/altea/data/utils/localization";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";

// Port of Signum.Omnibox's OmniboxMessage enum (OmniboxUtils.cs) — see docs/port/Omnibox.md.
export const OmniboxMessage = {
    No: msg("no"),
    NotFound: msg("[Not found]"),
    Omnibox_DatabaseAccess: msg("Searching between 'apostrophe' will make queries to the database"),
    Omnibox_Disambiguate: msg("With [Tab] you disambiguate you query"),
    Omnibox_Field: msg("Field"),
    Omnibox_Help: msg("Help"),
    Omnibox_OmniboxSyntaxGuide: msg("Omnibox Syntax Guide:"),
    Omnibox_MatchingOptions: msg("You can match results by (st)art, mid(dle) or (U)pper(C)ase"),
    Omnibox_Query: msg("Query"),
    Omnibox_Type: msg("Type"),
    Omnibox_UserChart: msg("UserChart"),
    Omnibox_UserQuery: msg("UserQuery"),
    Omnibox_Dashboard: msg("Dashboard"),
    Omnibox_Value: msg("Value"),
    Unknown: msg(),
    Yes: msg("yes"),
    Search: msg("Search..."),
};

// Reuses altea-auth's ONE PermissionSymbol class / table. IMPORTING this module — OmniboxLogic does — is
// enough for the symbol to be seeded and authorizable: the transformer rewrites `init()` into
// `init(PermissionSymbol, "OmniboxPermission.ViewOmnibox", …)`, registering it in the declared-symbols
// set `SymbolLogic.start(sb, PermissionSymbol)` — already called by the auth module — reads.
export namespace OmniboxPermission {
    export const ViewOmnibox: PermissionSymbol = init();
}

// The database schema this package's tables live in. FOLDER-scoped, so it covers every type declared
// beside it; the name is logical and gets dialect-mapped (schemaForType), so Postgres sees it snaked.
setDefaultDatabaseSchema("omnibox");
