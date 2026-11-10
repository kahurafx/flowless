import { PolicySettingsPage } from "../policy-view";

export const metadata = { title: "Metering settings" };

// M-05, M-06, M-09, M-10, M-12: the Metering configuration, one new version per save.
export default function MeteringSettingsPage() {
  return <PolicySettingsPage area="metering" />;
}
