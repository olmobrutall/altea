import * as React from "react";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { TypeContext } from "@altea/altea/client/TypeContext";
import QueryTokenBuilder from "@altea/altea/client/SearchControl/QueryTokenBuilder";
import { Finder } from "@altea/altea/client/Finder";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { QueryToken, SubTokensOptions } from "@altea/altea/client/QueryToken";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";

// Binds a QueryTokenEmbedded's stored token to QueryTokenBuilder, which resolves the query root itself
// (getQueryRoot) — so this is mostly a wrapper.
//
// It also RESOLVES the stored token, which nothing else does. `QueryTokenEmbedded.token` is
// `@serialize(false)` — the server only ever sees `tokenString` — so a definition loaded from the
// database arrives with a token string and no token, and the builder it feeds then renders its loading
// placeholder ("…") forever: every stored column / order / filter of every UserQuery, UserChart and
// template showed a permanent "…" and could not be edited without re-picking the token. Resolving it
// here fixes all of them at once, and it belongs here because this is the only component that knows
// both the query and the embedded.
//
// The resolved token is kept in local STATE rather than assigned onto the embedded: `token` is not a
// persisted field, but writing to the entity during a render pass would still make an untouched form
// look modified.

interface QueryTokenEmbeddedBuilderProps {
    ctx: TypeContext<QueryTokenEmbedded | null>;
    queryKey: string;
    subTokenOptions: SubTokensOptions;
    onTokenChanged?: (newToken: QueryToken | undefined) => void;
    helpText?: React.ReactNode;
}

export default function QueryTokenEmbeddedBuilder(p: QueryTokenEmbeddedBuilderProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();
    const qte = p.ctx.value;

    // The token as resolved from a STORED tokenString, and the message when it no longer resolves.
    const [resolved, setResolved] = React.useState<QueryToken | undefined>(undefined);
    const [parseError, setParseError] = React.useState<string | undefined>(undefined);

    const tokenString = qte?.token == null ? qte?.tokenString : undefined;

    React.useEffect(() => {
        if (tokenString == null || tokenString === "") {
            setResolved(undefined);
            setParseError(undefined);
            return;
        }

        let cancelled = false;
        void Finder.parseSingleToken(p.queryKey, tokenString, p.subTokenOptions)
            .then(t => { if (!cancelled) { setResolved(t); setParseError(undefined); } })
            .catch((e: unknown) => {
                if (cancelled)
                    return;
                // A token that no longer resolves is DATA, not a crash: the query was renamed or a field
                // removed, and the author needs to see which token broke.
                setResolved(undefined);
                setParseError(e instanceof Error ? e.message : String(e));
            });

        return () => { cancelled = true; };
    }, [tokenString, p.queryKey, p.subTokenOptions]);

    function handleTokenChanged(newToken: QueryToken | undefined): void {
        if (newToken == null) {
            p.ctx.value = null;
        } else {
            const embedded = new QueryTokenEmbedded();
            embedded.tokenString = newToken.fullKey();
            embedded.token = newToken;
            p.ctx.value = embedded;
        }
        setResolved(undefined);
        setParseError(undefined);
        p.onTokenChanged?.(newToken);
        forceUpdate();
    }

    const tokenBuilder = (
        <div className={p.ctx.rwWidgetClass}>
            <QueryTokenBuilder
                queryToken={qte?.token ?? resolved}
                onTokenChange={handleTokenChanged}
                queryKey={p.queryKey}
                subTokenOptions={p.subTokenOptions}
                readOnly={p.ctx.readOnly} />
        </div>
    );

    const error = parseError ?? qte?.parseException;

    return (
        <FormGroup ctx={p.ctx} helpText={p.helpText}>
            {() => !qte || !error ? tokenBuilder :
                <div>
                    <code>{qte.tokenString}</code>
                    <br />
                    {tokenBuilder}
                    <br />
                    <p className="alert alert-danger">{error}</p>
                </div>}
        </FormGroup>
    );
}
