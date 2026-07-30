import { reflect } from './reflection';
import { ModelEntity } from './entity';

// Ported from Signum.Basics ClientErrorModel — the client-side error report the ErrorModal unhandled-
// error logger POSTs to /api/registerClientError. A table-less ModelEntity (no schema impact).
// Signum's `ClientErrorModel.New({...})` → altea's `ClientErrorModel.create({...})`.
@reflect
export class ClientErrorModel extends ModelEntity {
    url: string | null = null;
    errorType: string = "";
    message: string = "";
    stack: string | null = null;
    name: string | null = null;
}
