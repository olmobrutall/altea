import { WebBuilder, CustomType } from "@altea/altea/server/webApi";
import { AuthServer } from "@altea/altea-auth/server/AuthServer";
import { AuthTokenServer } from "@altea/altea-auth/server/AuthTokenServer";
import { LoginAuthMessage } from "@altea/altea-auth/data/AuthMessages";
import type { UserEntity } from "@altea/altea-auth/data/User";
import { ResetPasswordMessage } from "../data/ResetPassword";
import { ResetPasswordRequestLogic } from "./ResetPasswordRequestLogic";

// Port of Signum's ResetPasswordController (Signum.Authorization.ResetPassword/ResetPasswordController.cs) —
// three ANONYMOUS endpoints: ask for a link, consume a link, ask for a fresh link. All three must be
// `allowAnonymous`: the whole point is that the caller cannot log in.
//
// altea divergences:
//  - `[Required, FromBody] string code` (a bare JSON string body) is kept as a bare string body, so the
//    client's `ajaxPost(url, code)` needs no wrapper object — matching Signum's client.
//  - `ModelError(field, msg)` → `res.status(400).json({ field: msg })`, altea's flat ModelState (see
//    AuthServer's `modelError`).

interface ForgotPasswordRequest { email?: string }
interface ForgotPasswordResponse { success: boolean; message: string; title?: string }
interface ResetPasswordRequestBody { code?: string; newPassword?: string }
interface LoginResponse { authenticationType: string; token: string; userEntity: UserEntity }

interface ResLike { status(code: number): { json(body: unknown): void } }

export namespace ResetPasswordServer {

    export function start(ws: WebBuilder): void {

        // POST /api/auth/forgotPasswordEmail — "mail me a reset link".
        ws.post("/api/auth/forgotPasswordEmail",
            { req: CustomType<ForgotPasswordRequest>(), res: CustomType<ForgotPasswordResponse>(), allowAnonymous: true },
            async (req, res) => {
                try {
                    const request = (await req.jsonTyped()) as ForgotPasswordRequest | undefined;
                    const email = request?.email;
                    if (email == null || email === "")
                        throw new Error(LoginAuthMessage.EnterYourUserEmail.niceToString());

                    await ResetPasswordRequestLogic.sendResetPasswordRequestEmail(email);

                    res.jsonTyped({
                        success: true,
                        title: LoginAuthMessage.RequestAccepted.niceToString(),
                        message: AuthServer.avoidExplicitErrorMessages
                            ? ResetPasswordMessage.IfEmailIsValidWeWillSendYouAnEmailToResetYourPassword.niceToString()
                            : LoginAuthMessage.WeHaveSentYouAnEmailToResetYourPassword.niceToString(),
                    });
                } catch (e) {
                    // Signum answers 200 with success:false so the page can show the reason inline.
                    res.jsonTyped({ success: false, message: e instanceof Error ? e.message : String(e) });
                }
            });

        // POST /api/auth/resetPassword — consume a code and log the user in.
        ws.post("/api/auth/resetPassword",
            { req: CustomType<ResetPasswordRequestBody>(), res: CustomType<LoginResponse>(), allowAnonymous: true },
            async (req, res) => {
                const request = (await req.jsonTyped()) as ResetPasswordRequestBody | undefined;

                if (request?.newPassword == null || request.newPassword === "")
                    return modelError(res, "newPassword", LoginAuthMessage.PasswordMustHaveAValue.niceToString());

                const { request: rpr, passwordError } =
                    await ResetPasswordRequestLogic.resetPasswordRequestExecute(request.code ?? "", request.newPassword);

                if (rpr == null)
                    return modelError(res, "newPassword", passwordError!);

                res.jsonTyped({
                    authenticationType: "resetPassword",
                    token: AuthTokenServer.createToken(rpr.user),
                    userEntity: rpr.user,
                });
            });

        // POST /api/auth/requestNewLink — the body is the bare code STRING (Signum's `[FromBody] string`).
        ws.post("/api/auth/requestNewLink",
            { req: CustomType<string>(), allowAnonymous: true },
            async (req, res) => {
                const code = (await req.jsonTyped()) as string | undefined;
                if (code == null || code.trim() === "")
                    throw new Error(ResetPasswordMessage.TheCodeOfYourLinkIsIncorrect.niceToString());

                await ResetPasswordRequestLogic.requestNewLink(code);
                (res as unknown as { status(c: number): { end(): void } }).status(200).end();
            });
    }
}

function modelError(res: unknown, field: string, message: string): void {
    (res as ResLike).status(400).json({ [field]: message });
}
