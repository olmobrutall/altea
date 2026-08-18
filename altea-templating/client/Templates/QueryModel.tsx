import * as React from "react";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import type { SearchControlHandler } from "@altea/altea/client/SearchControl/SearchControl";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { QueryModel, QueryModelMessage } from "../../data/Templating";

// Port of Signum.Templating's Templates/QueryModel.tsx — the picker behind "send this report for the
// RESULT of a query": the user configures filters/orders/pagination in a SearchControl and the model
// records the QueryRequest it produced.

export default function QueryModelComponent(p: { ctx: TypeContext<QueryModel> }): React.JSX.Element {

    const searchControl = React.useRef<SearchControlHandler>(null);

    function handleOnSearch(): void {
        const qr = searchControl.current!.searchControlLoaded!.getQueryRequest();
        const model = p.ctx.value;
        model.filters = qr.filters ?? [];
        model.orders = qr.orders ?? [];
        model.pagination = qr.pagination!;
    }

    const ctx = p.ctx;
    return (
        <div>
            <p>{QueryModelMessage.ConfigureYourQueryAndPressSearchBeforeOk.niceToString()}</p>
            <SearchControl ref={searchControl}
                hideButtonBar={true}
                showContextMenu={() => "Basic"}
                allowSelection={false}
                findOptions={{ queryName: ctx.value.queryKey }}
                onSearch={handleOnSearch} />
        </div>
    );
}
