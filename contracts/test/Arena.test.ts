import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { Signer } from "ethers";

/** Whole-token helper: units(1000) = 1000 * 1e18. */
const units = (n: number | string) => ethers.parseUnits(String(n), 18);

/**
 * deployer  owns the Arena and holds the mock supply
 * signer    the arena server's voucher key
 * alice/bob players
 */
async function deployFixture() {
  const [deployer, signer, alice, bob, stranger] = await ethers.getSigners();

  const token = await (await ethers.getContractFactory("MockToken")).deploy(units(1_000_000_000));
  const tokenAddress = await token.getAddress();

  const arena = await (await ethers.getContractFactory("Arena")).deploy(tokenAddress, signer.address, deployer.address);
  const arenaAddress = await arena.getAddress();

  await token.transfer(alice.address, units(100_000));
  await token.transfer(bob.address, units(100_000));
  await token.connect(alice).approve(arenaAddress, ethers.MaxUint256);
  await token.connect(bob).approve(arenaAddress, ethers.MaxUint256);
  await token.approve(arenaAddress, ethers.MaxUint256);

  return { deployer, signer, alice, bob, stranger, token, tokenAddress, arena, arenaAddress };
}

/** Signs a Claim voucher exactly as the arena server does. */
async function voucher(
  arenaAddress: string,
  signer: Signer,
  account: string,
  cumulative: bigint,
  deadline: number | bigint,
): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return signer.signTypedData(
    { name: "FlypitArena", version: "1", chainId, verifyingContract: arenaAddress },
    { Claim: [{ name: "account", type: "address" }, { name: "cumulative", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { account, cumulative, deadline },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
describe("Arena: deposits", () => {
  it("credits exactly what arrived and numbers deposits", async () => {
    const { arena, arenaAddress, token, alice } = await loadFixture(deployFixture);
    await expect(arena.connect(alice).deposit(units(10)))
      .to.emit(arena, "Deposited")
      .withArgs(alice.address, units(10), 1n);
    await expect(arena.connect(alice).deposit(units(5)))
      .to.emit(arena, "Deposited")
      .withArgs(alice.address, units(5), 2n);
    expect(await arena.totalDeposited()).to.equal(units(15));
    expect(await arena.depositCount()).to.equal(2n);
    expect(await token.balanceOf(arenaAddress)).to.equal(units(15));
    expect(await arena.available()).to.equal(units(15));
  });

  it("credits the received amount for a fee-on-transfer token", async () => {
    const { arena, token, alice } = await loadFixture(deployFixture);
    await token.setFeeBps(500); // 5 % burned on every transfer
    await expect(arena.connect(alice).deposit(units(100)))
      .to.emit(arena, "Deposited")
      .withArgs(alice.address, units(95), 1n);
    expect(await arena.totalDeposited()).to.equal(units(95));
  });

  it("rejects zero, below-minimum and paused deposits", async () => {
    const { arena, alice } = await loadFixture(deployFixture);
    await expect(arena.connect(alice).deposit(0)).to.be.revertedWith("Arena: amount is zero");
    await arena.setMinDeposit(units(10));
    await expect(arena.connect(alice).deposit(units(9))).to.be.revertedWith("Arena: below minimum");
    await arena.connect(alice).deposit(units(10));
    await arena.setPaused(true);
    await expect(arena.connect(alice).deposit(units(10))).to.be.revertedWith("Arena: paused");
  });

  it("rejects a deposit without allowance", async () => {
    const { arena, stranger, token } = await loadFixture(deployFixture);
    await token.transfer(stranger.address, units(10));
    await expect(arena.connect(stranger).deposit(units(10))).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
  });

  it("takes funding from anyone and counts it separately", async () => {
    const { arena, deployer, bob } = await loadFixture(deployFixture);
    await expect(arena.fund(units(1_000))).to.emit(arena, "Funded").withArgs(deployer.address, units(1_000));
    await expect(arena.connect(bob).fund(units(1))).to.emit(arena, "Funded").withArgs(bob.address, units(1));
    expect(await arena.totalFunded()).to.equal(units(1_001));
    expect(await arena.totalDeposited()).to.equal(0n);
    expect(await arena.available()).to.equal(units(1_001));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Arena: claims", () => {
  it("pays the difference between the voucher and what was already claimed", async () => {
    const { arena, arenaAddress, token, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit(units(1_000)); // somebody lost this in the pit
    const deadline = (await time.latest()) + 3600;

    const sig1 = await voucher(arenaAddress, signer, alice.address, units(300), deadline);
    const before = await token.balanceOf(alice.address);
    await expect(arena.connect(alice).claim(units(300), deadline, sig1))
      .to.emit(arena, "Claimed")
      .withArgs(alice.address, units(300), units(300));
    expect((await token.balanceOf(alice.address)) - before).to.equal(units(300));
    expect(await arena.claimed(alice.address)).to.equal(units(300));

    // The next voucher carries the running total, and only the delta is paid.
    const sig2 = await voucher(arenaAddress, signer, alice.address, units(450), deadline);
    await expect(arena.connect(alice).claim(units(450), deadline, sig2))
      .to.emit(arena, "Claimed")
      .withArgs(alice.address, units(150), units(450));
    expect(await arena.totalClaimed()).to.equal(units(450));
    expect(await arena.claimableFor(alice.address, units(450))).to.equal(0n);
    expect(await arena.claimableFor(alice.address, units(500))).to.equal(units(50));
  });

  it("is idempotent: a replayed or older voucher pays nothing", async () => {
    const { arena, arenaAddress, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit(units(1_000));
    const deadline = (await time.latest()) + 3600;
    const sig = await voucher(arenaAddress, signer, alice.address, units(300), deadline);
    await arena.connect(alice).claim(units(300), deadline, sig);
    await expect(arena.connect(alice).claim(units(300), deadline, sig)).to.be.revertedWith("Arena: nothing to claim");
    const older = await voucher(arenaAddress, signer, alice.address, units(200), deadline);
    await expect(arena.connect(alice).claim(units(200), deadline, older)).to.be.revertedWith("Arena: nothing to claim");
  });

  it("rejects an expired voucher, a wrong signer and a borrowed voucher", async () => {
    const { arena, arenaAddress, signer, stranger, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit(units(1_000));
    const past = (await time.latest()) - 1;
    const expired = await voucher(arenaAddress, signer, alice.address, units(10), past);
    await expect(arena.connect(alice).claim(units(10), past, expired)).to.be.revertedWith("Arena: voucher expired");

    const deadline = (await time.latest()) + 3600;
    const forged = await voucher(arenaAddress, stranger, alice.address, units(10), deadline);
    await expect(arena.connect(alice).claim(units(10), deadline, forged)).to.be.revertedWith("Arena: bad signature");

    const alices = await voucher(arenaAddress, signer, alice.address, units(10), deadline);
    await expect(arena.connect(bob).claim(units(10), deadline, alices)).to.be.revertedWith("Arena: bad signature");
  });

  it("refuses to pay more than the pit holds, and nothing while paused", async () => {
    const { arena, arenaAddress, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit(units(100));
    const deadline = (await time.latest()) + 3600;
    const tooMuch = await voucher(arenaAddress, signer, alice.address, units(101), deadline);
    await expect(arena.connect(alice).claim(units(101), deadline, tooMuch)).to.be.revertedWith("Arena: pit is short");

    await arena.setPaused(true);
    const fine = await voucher(arenaAddress, signer, alice.address, units(50), deadline);
    await expect(arena.connect(alice).claim(units(50), deadline, fine)).to.be.revertedWith("Arena: paused");
    await arena.setPaused(false);
    await arena.connect(alice).claim(units(50), deadline, fine);
    expect(await arena.available()).to.equal(units(50));
  });

  it("matches hashClaim to the off-chain typed data", async () => {
    const { arena, arenaAddress, signer, alice } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 3600;
    const sig = await voucher(arenaAddress, signer, alice.address, units(7), deadline);
    const digest = await arena.hashClaim(alice.address, units(7), deadline);
    expect(ethers.recoverAddress(digest, sig)).to.equal(signer.address);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Arena: admin", () => {
  it("rotates the signer and kills the old key's vouchers", async () => {
    const { arena, arenaAddress, signer, stranger, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit(units(100));
    const deadline = (await time.latest()) + 3600;
    const old = await voucher(arenaAddress, signer, alice.address, units(10), deadline);
    await expect(arena.setSigner(stranger.address)).to.emit(arena, "SignerChanged").withArgs(signer.address, stranger.address);
    await expect(arena.connect(alice).claim(units(10), deadline, old)).to.be.revertedWith("Arena: bad signature");
    const fresh = await voucher(arenaAddress, stranger, alice.address, units(10), deadline);
    await arena.connect(alice).claim(units(10), deadline, fresh);
  });

  it("only the owner can administer", async () => {
    const { arena, alice } = await loadFixture(deployFixture);
    await expect(arena.connect(alice).setSigner(alice.address)).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
    await expect(arena.connect(alice).setPaused(true)).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
    await expect(arena.connect(alice).setMinDeposit(1)).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
    await expect(arena.connect(alice).rescue(alice.address, 1)).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
  });

  it("rescue moves tokens out — the documented trust point", async () => {
    const { arena, token, deployer, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit(units(100));
    const before = await token.balanceOf(deployer.address);
    await expect(arena.rescue(deployer.address, units(40))).to.emit(arena, "Rescued").withArgs(deployer.address, units(40));
    expect((await token.balanceOf(deployer.address)) - before).to.equal(units(40));
    expect(await arena.available()).to.equal(units(60));
  });

  it("refuses a zero token or signer at deployment", async () => {
    const { deployer, signer, tokenAddress } = await loadFixture(deployFixture);
    const factory = await ethers.getContractFactory("Arena");
    await expect(factory.deploy(ethers.ZeroAddress, signer.address, deployer.address)).to.be.revertedWith("Arena: token is zero");
    await expect(factory.deploy(tokenAddress, ethers.ZeroAddress, deployer.address)).to.be.revertedWith("Arena: signer is zero");
  });
});
