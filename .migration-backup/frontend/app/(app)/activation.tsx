import { Redirect } from "expo-router";

/** Keep existing activation bookmarks on the current payment flow. */
export default function ActivationRedirect() {
  return <Redirect href="/pay" />;
}
