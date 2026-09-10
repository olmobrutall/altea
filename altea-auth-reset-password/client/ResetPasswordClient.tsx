import * as React from "react";
import type { RouteObject } from "react-router";
import { Link } from "react-router";
import { ImportComponent } from "@altea/altea/client/ImportComponent";
import { ajaxPost } from "@altea/altea/client/Services";
import { LoginAuthMessage } from "@altea/altea-auth/data/AuthMessages";
import { AuthClient } from "@altea/altea-auth/client/AuthClient";
import { LoginOptions } from "@altea/altea-auth/client/public/LoginPage";
import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import { ResetPasswordRequestEntity } from "../data/ResetPassword";

// The PUBLIC half of the module: two anonymous routes and the "I have forgotten my password" link under
// the login form.
//
// `LoginOptions` comes from altea-auth's LoginPage — that is where the React-typed login options live,
// since the AuthClient hub itself is React-free.

export namespace ResetPasswordClient {

    /** Called from MainPublic, so an anonymous visitor can reach it. */
    export function startPublic(routes: RouteObject[]): void {
        routes.push({ path: "/auth/forgotPasswordEmail", element: <ImportComponent onImport={() => import("./ForgotPasswordEmailPage")} /> });
        routes.push({ path: "/auth/resetPassword", element: <ImportComponent onImport={() => import("./ResetPassword")} /> });

        LoginOptions.resetPasswordControl = () => <span>
            &nbsp;&nbsp;
            <Link to="/auth/forgotPasswordEmail">{LoginAuthMessage.IHaveForgottenMyPassword.niceToString()}</Link>
        </span>;
    }

    /**
     * The ADMIN half: the request table's query settings. Those columns are declared here rather than
     * (`sb.Include<ResetPasswordRequestEntity>().WithQuery(() => e => new { e.Id, e.RequestDate, e.Code,
     * e.User, e.User.Email })`); in altea the default COLUMNS are a client concern, so they live here.
     *
     * Calling this is not optional cosmetics: `cb.configure` is also what REGISTERS the entity's client
     * TypeInfo, and without it `/find/ResetPasswordRequest` fails with "No TypeInfo". The two page modules
     * that do import the entity are lazily loaded, so they cannot cover for it at boot.
     */
    export function start(cb: ClientBuilder): void {
        cb.configure(ResetPasswordRequestEntity)
            .withQuerySettings(token => ({
                defaultColumns: [
                    token(r => r.id),
                    token(r => r.requestDate),
                    token(r => r.code),
                    token(r => r.user),
                    token(r => r.user.email),
                ],
            }));
    }

    export namespace API {

        export function forgotPasswordEmail(request: ForgotPasswordEmailRequest): Promise<ForgotPasswordEmailResponse> {
            return ajaxPost({ url: "/api/auth/forgotPasswordEmail", avoidAuthToken: true }, request);
        }

        export function resetPassword(request: ResetPasswordRequest): Promise<AuthClient.API.LoginResponse> {
            return ajaxPost({ url: "/api/auth/resetPassword", avoidAuthToken: true }, request);
        }

        export function requestNewLink(code: string): Promise<void> {
            return ajaxPost({ url: "/api/auth/requestNewLink", avoidAuthToken: true }, code);
        }

        export interface ResetPasswordRequest {
            code: string;
            newPassword: string;
        }

        export interface ForgotPasswordEmailRequest {
            email: string;
        }

        export interface ForgotPasswordEmailResponse {
            success: boolean;
            message: string;
            title?: string;
        }
    }
}
