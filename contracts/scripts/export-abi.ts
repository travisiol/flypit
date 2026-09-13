import hre from "hardhat";
import { exportAbis } from "./lib/exportAbi";

/**
 * Manual ABI export. `hardhat compile` already runs this automatically;
 * use `npm run export-abi` to regenerate ../web/src/lib/abi without recompiling.
 */
async function main() {
  await exportAbis(hre);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
