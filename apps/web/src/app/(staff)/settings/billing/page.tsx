import { PolicySettingsPage } from "../policy-view";

export const metadata = { title: "Billing settings" };

// B-01, B-05, B-08, B-13, B-14, B-16, B-19: the Billing configuration, one new version per save.
export default function BillingSettingsPage() {
  return <PolicySettingsPage area="billing" />;
}
