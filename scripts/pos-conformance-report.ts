import { POS_LOCAL_CONFORMANCE_CAPABILITIES } from "../lib/erp/pos-conformance-simulators";

process.stdout.write(`${JSON.stringify({
  report: "POS local simulator capabilities",
  ...POS_LOCAL_CONFORMANCE_CAPABILITIES,
}, null, 2)}\n`);
