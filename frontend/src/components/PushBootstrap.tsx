/**
 * PushBootstrap — mounted once inside the authenticated app shell.
 * Waits until the user is logged in, then asks for notification permission
 * and registers a Firebase Cloud Messaging device token.
 * Foreground messages are shown as native browser notifications (OS toast).
 */
import { useEffect } from "react";

import { useAuth } from "@/src/auth";
import { setupWebPush, canUseWebPush } from "@/src/lib/firebase";

export function PushBootstrap() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      if (!(await canUseWebPush())) return;
      if (cancelled) return;
      await setupWebPush((title, body, data) => {
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            const n = new Notification(title, {
              body,
              icon: "/icon-192.png",
              tag: data?.tag || "spiloveure",
            });
            n.onclick = () => {
              try {
                if (data?.link) window.location.assign(data.link);
                window.focus();
                n.close();
              } catch {}
            };
          }
        } catch {
          /* foreground notification is optional — SW handles the offline case */
        }
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  return null;
}
