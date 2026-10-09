import type { UserEntity } from "./User";

// Every `authenticationType` a login route can answer with. Three are not in Signum's TS union:
// "relogin" (/api/auth/relogin), "openID" (@altea/altea-auth-openid) and "adRegistry" (a Windows AD
// LDAP bind — its WindowsADAuthorizer returns that one too, it just never reached the union there).
export type AuthenticationType = "database" | "resetPassword" | "changePassword" | "api-key"
    | "azureAD" | "cookie" | "windows" | "relogin" | "openID" | "adRegistry";

export interface LoginRequest { userName: string; password: string; rememberMe?: boolean; }
export interface LoginResponse { authenticationType: AuthenticationType; message?: string; token: string; userEntity: UserEntity; }
export interface ChangePasswordRequest { oldPassword: string; newPassword: string; }

/** One hit from a directory search. */
export interface ExternalUser {
    displayName: string;
    /** userPrincipalName / the directory's login name. */
    upn: string;
    jobTitle: string;
    /** The directory's stable identifier — an Entra object id, a Windows SID, an OIDC "sub". */
    externalId: string | null;
}
