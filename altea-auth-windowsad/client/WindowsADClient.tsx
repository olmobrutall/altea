import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import * as AppContext from "@altea/altea/client/AppContext";
import * as ProfilePhoto from "@altea/altea-auth/client/public/ProfilePhoto";
import { WindowsADConfigurationEmbedded } from "../data/WindowsAD";

// Port of Signum.Authorization.WindowsAD's WindowsADClient.tsx — the ADMIN-side registrations: the
// configuration editor and the AD thumbnail-photo provider.
//
// altea divergences, documented inline:
//  - `Navigator.addSettings(new EntitySettings(T, view))` → `cb.configure(T).withView(…)`.
//  - the photo provider works for a Lite too (unlike the Azure one): the `/api/adThumbnailphoto/:username`
//    route is keyed on the USER NAME, and a `Lite<UserEntity>`'s toString IS the user name (see
//    altea-auth's ProfilePhoto header). Signum reads it off a `UserLiteModel`, which altea does not have.
//  - `ChangeLogClient.registerChangeLogModule` has no altea counterpart.

export namespace WindowsADClient {

    export function start(cb: ClientBuilder, options: { profilePhotos?: boolean } = {}): void {

        cb.configure(WindowsADConfigurationEmbedded).withView(() => import("./WindowsADConfiguration"));

        if (options.profilePhotos) {
            ProfilePhoto.urlProviders().push(u => {
                const userName = u.toString();
                return userName ? AppContext.toAbsoluteUrl("/api/adThumbnailphoto/" + encodeURIComponent(userName)) : null;
            });
        }
    }
}
