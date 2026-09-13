import * as fs from "fs";
import * as path from "path";
import hre from "hardhat";
import { ethers, network } from "hardhat";
import { deploymentsDir, exportAbis, type DeploymentRecord } from "./lib/exportAbi";

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * Deploys the Arena for an existing token.
 *
 *   TOKEN_ADDRESS   the ERC-20 the pit is played with (the launchpad's CA).
 *                   Left unset on the hardhat network, a MockToken is deployed
 *                   so a local stack can be tried end to end.
 *   SIGNER_ADDRESS  the arena server's voucher key. Falls back to the deployer
 *                   with a loud warning: rotate it with arena.setSigner before
 *                   anyone plays for real.
 *   MIN_DEPOSIT     optional, in whole tokens (the server enforces the play floor anyway).
 *
 * The deployer owns the Arena.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log(`Network   : ${network.name} (chainId ${chainId})`);
  console.log(`Deployer  : ${deployer.address}`);

  let tokenAddress = env("TOKEN_ADDRESS");
  if (!tokenAddress) {
    if (network.name !== "hardhat" && network.name !== "localhost") {
      throw new Error("TOKEN_ADDRESS is required: the Arena is deployed for a token that already exists.");
    }
    const mock = await (await ethers.getContractFactory("MockToken")).deploy(ethers.parseUnits("1000000000", 18));
    await mock.waitForDeployment();
    tokenAddress = await mock.getAddress();
    console.log(`MockToken : ${tokenAddress} (local only)`);
  }

  const configuredSigner = env("SIGNER_ADDRESS");
  const signer = configuredSigner ?? deployer.address;
  if (!configuredSigner) {
    console.warn("WARNING   : SIGNER_ADDRESS not set — the deployer is the voucher signer. Call arena.setSigner(<server key>) before going live.");
  }
  console.log(`Signer    : ${signer}`);

  const arena = await (await ethers.getContractFactory("Arena")).deploy(tokenAddress, signer, deployer.address);
  await arena.waitForDeployment();
  const arenaAddress = await arena.getAddress();
  console.log(`Arena     : ${arenaAddress}`);

  const minDeposit = env("MIN_DEPOSIT");
  if (minDeposit) {
    await (await arena.setMinDeposit(ethers.parseUnits(minDeposit, 18))).wait();
    console.log(`MinDeposit: ${minDeposit} tokens`);
  }

  const record: DeploymentRecord = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: { Token: tokenAddress, Arena: arenaAddress },
  };
  const dir = deploymentsDir(hre);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`Saved     : ${path.relative(process.cwd(), file)}`);

  await exportAbis(hre);

  console.log("\nServer env:");
  console.log(`  ARENA_ADDRESS=${arenaAddress}`);
  console.log(`  TOKEN_ADDRESS=${tokenAddress}`);
  console.log("Web env:");
  console.log(`  NEXT_PUBLIC_FLYPIT_ARENA=${arenaAddress}`);
  console.log(`  NEXT_PUBLIC_FLYPIT_TOKEN=${tokenAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
