import { useEffect } from "react";
import { api } from "@/src/api";
import { useChat } from "@/src/chat/ChatContext";
import { canUseWebPush, setupWebPush } from "@/src/lib/firebase";

export default function ChatPushBootstrap() {
  const { user, loading } = useChat();

  useEffect(() => {
    if (loading || !user) return;
    let cancelled = false;
    const register = async () => {
      if (!(await canUseWebPush()) || cancelled) return;
      await setupWebPush((title, body, data) => {
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            const notification = new Notification(title, {
              body,
              icon: "/icon-192.png",
              tag: data?.tag || "spiloveure-chat",
            });
            notification.onclick = () => {
              try {
                if (data?.link) window.location.assign(data.link);
                window.focus();
                notification.close();
              } catch {}
            };
          }
        } catch {
          // Foreground notifications are optional; the service worker handles background delivery.
        }
      }, {
        registerToken: payload => {
          if (cancelled) return Promise.resolve();
          return api.post("/identity/chat/push-token", payload, {
            auth: false,
            credentials: "include",
          });
        },
      });
    };
    void register().catch(error => {
      console.warn("[FCM Chat] registration unavailable", error);
    });
    return () => { cancelled = true; };
  }, [loading, user?.id]);

  return null;
}
