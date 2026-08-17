import * as React from "react";
import { FormGroup } from "@altea/altea/client/Lines/FormGroup";
import { TypeContext } from "@altea/altea/client/TypeContext";
import QueryTokenBuilder from "@altea/altea/client/SearchControl/QueryTokenBuilder";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { QueryToken, SubTokensOptions } from "@altea/altea/client/QueryToken";
import { QueryTokenEmbedded } from "@altea/altea-user-assets/data/Queries";

// Port of Signum's Signum.UserAssets/Templates/QueryTokenEmbeddedBuilder.tsx. Binds a QueryTokenEmbedded's
// stored token to altea's QueryTokenBuilder. altea divergence: no Finder.getQueryDescription gate — altea's
// QueryTokenBuilder resolves the query root internally (getQueryRoot), so this just wraps it.
interface QueryTokenEmbeddedBuilderProps {
    ctx: TypeContext<QueryTokenEmbedded | null>;
    queryKey: string;
    subTokenOptions: SubTokensOptions;
    onTokenChanged?: (newToken: QueryToken | undefined) => void;
    helpText?: React.ReactNode;
}

export default function QueryTokenEmbeddedBuilder(p: QueryTokenEmbeddedBuilderProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();

    function handleTokenChanged(newToken: QueryToken | undefined): void {
        if (newToken == null) {
            p.ctx.value = null;
        } else {
            const qte = new QueryTokenEmbedded();
            qte.tokenString = newToken.fullKey(); // altea QueryToken.fullKey() is a method (Signum: a property)
            qte.token = newToken;
            p.ctx.value = qte;
        }
        p.onTokenChanged?.(newToken);
        forceUpdate();
    }

    const qte = p.ctx.value;

    const tokenBuilder = (
        <div className={p.ctx.rwWidgetClass}>
            <QueryTokenBuilder
                queryToken={qte?.token}
                onTokenChange={handleTokenChanged}
                queryKey={p.queryKey}
                subTokenOptions={p.subTokenOptions}
                readOnly={p.ctx.readOnly} />
        </div>
    );

    return (
        <FormGroup ctx={p.ctx} helpText={p.helpText}>
            {() => !qte || !qte.parseException ? tokenBuilder :
                <div>
                    <code>{qte.tokenString}</code>
                    <br />
                    {tokenBuilder}
                    <br />
                    <p className="alert alert-danger">{qte.parseException}</p>
                </div>}
        </FormGroup>
    );
}
