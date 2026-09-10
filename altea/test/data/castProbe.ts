import { part, backReference, implementedBy } from "@altea/altea/data/decorators";
import { Entity } from "@altea/altea/data/entity";
import { reflect } from "@altea/altea/data/reflection";
import type { Lite } from "@altea/altea/data/lite";
import { LabelEntity } from "./label";

// Signum's `PanelPartEmbedded.Content` in miniature, and the fixture for the CAST step (PropertyRoute's
// `addCast` / the token layer's `AsTypeToken`). A `@part` ROW in a collection holding a POLYMORPHIC
// reference whose implementations are themselves `@part`s — the one shape where a member of the model
// had no PropertyRoute at all, because a part content may not be a route ROOT and the route stopped
// dead at the reference.
//
// `LabelEntity` is in the implementations list as the NON-part control: casting to it must RE-ROOT,
// exactly as Signum's `AddImp` does, and contribute nothing to the stored path.
//
// Declared in the test tree and included by NO schema, so no suite's database gains a table and none
// needs regenerating. Reflection is all a route or a token needs.
export interface ICastProbePart extends Entity { }

@part
export class CastProbeEntity_Panel extends Entity {
    @backReference
    owner: Lite<CastProbeEntity>;
    title: string | null;
    @implementedBy(() => [CastProbeTextPartEntity, CastProbeImagePartEntity, LabelEntity])
    content: ICastProbePart;
}

// No `@backReference`: a part CONTENT is reached through the owner's reference, exactly as Signum's
// TextPartEntity is.
@part
export class CastProbeTextPartEntity extends Entity {
    textContent: string | null;
}

@part
export class CastProbeImagePartEntity extends Entity {
    imageUrl: string | null;
}

@reflect
export class CastProbeEntity extends Entity {
    panels: CastProbeEntity_Panel[];
}
