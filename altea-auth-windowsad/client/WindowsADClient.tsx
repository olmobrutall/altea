import type { ClientBuilder } from "@altea/altea/client/ClientBuilder";
import * as AppContext from "@altea/altea/client/AppContext";
import * as ProfilePhoto from "@altea/altea-auth/client/public/ProfilePhoto";
import { WindowsADConfigurationEmbedded } from "../data/WindowsAD";

// The ADMIN-side registrations: the configuration editor and the AD thumbnail-photo provider.
//
// The photo provider works for a Lite too, unlike the Azure one: `/api/adThumbnailphoto/:username` is keyed
// on the USER NAME, and a `Lite<UserEntity>`'s toString IS the user name (see altea-auth's ProfilePhoto).
//
// See docs/port/AuthDirectory.md.

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
