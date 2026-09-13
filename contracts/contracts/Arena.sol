// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Arena
/// @notice The only thing FLYPIT keeps on chain: the token goes in through
///         `deposit`, comes back out through server-signed `claim`s, and
///         anyone can `fund` the pot that rains coins into the pit.
/// @dev What happens between a deposit and a claim — who cut whom, what was
///      picked up, who held a hatch for eight seconds — is decided by the
///      arena server, which is the referee. The chain does not know the game;
///      it knows balances. The server signs an EIP-712
///      `Claim(account, cumulative, deadline)` voucher where `cumulative` is
///      the running total of the token this account has ever been entitled
///      to take out. `claim` pays `cumulative - claimed[account]`, so:
///
///        * a voucher is idempotent: re-submitting it reverts with
///          "Arena: nothing to claim" — that is the whole replay defence,
///          there is no nonce;
///        * a lost voucher costs nothing, the next one supersedes it;
///        * an older (lower) voucher arriving late simply reverts.
///
///      Deposits are credited by what actually arrived, so a token with a
///      transfer tax still balances. The server watches `Deposited` events
///      and credits the player's lobby with exactly `amount`.
///
///      Trust, stated plainly: the owner can rotate the signer and can move
///      tokens out with `rescue`. Whoever holds the owner key can therefore
///      reach every token in here, players' deposits included. That is the
///      price of a referee that runs at twenty ticks a second.
///
///      Reverts are strings on purpose: the client and the server show them
///      verbatim.
contract Arena is Ownable, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────────────────────────── constants ─────────────────────────────

    /// @notice EIP-712 type hash for `Claim(address account,uint256 cumulative,uint256 deadline)`.
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address account,uint256 cumulative,uint256 deadline)");

    // ──────────────────────────────── state ──────────────────────────────

    /// @notice The token played with. One token, fixed at deployment.
    IERC20 public immutable token;
    /// @notice The arena server's voucher signer. Anything it signs is payable.
    address public signer;
    /// @notice While true, `deposit`, `fund` and `claim` are closed.
    bool public paused;
    /// @notice Smallest deposit accepted, in token wei. The server enforces the play floor on top.
    uint256 public minDeposit;

    /// @notice Cumulative token already paid to `account`.
    mapping(address account => uint256 cumulative) public claimed;

    uint256 public totalDeposited;
    uint256 public totalFunded;
    uint256 public totalClaimed;
    uint256 public depositCount;

    // ─────────────────────────────── events ──────────────────────────────

    event Deposited(address indexed player, uint256 amount, uint256 indexed id);
    event Funded(address indexed from, uint256 amount);
    event Claimed(address indexed account, uint256 paid, uint256 cumulative);
    event SignerChanged(address indexed previousSigner, address indexed newSigner);
    event PausedSet(bool paused);
    event MinDepositSet(uint256 minDeposit);
    event Rescued(address indexed to, uint256 amount);

    // ───────────────────────────── constructor ───────────────────────────

    /// @param token_ The ERC-20 the pit is played with.
    /// @param signer_ The arena server's voucher signer.
    /// @param initialOwner Owns the contract: rotates the signer, pauses, rescues.
    constructor(IERC20 token_, address signer_, address initialOwner)
        Ownable(initialOwner)
        EIP712("FlypitArena", "1")
    {
        require(address(token_) != address(0), "Arena: token is zero");
        require(signer_ != address(0), "Arena: signer is zero");
        token = token_;
        signer = signer_;
        emit SignerChanged(address(0), signer_);
    }

    // ─────────────────────────────── in ──────────────────────────────────

    /// @notice Puts `amount` of the token into the pit. The server credits
    ///         your lobby with what actually arrived and lets you stake it.
    /// @dev Approve this contract first. Credited by balance difference so a
    ///      fee-on-transfer token cannot make the ledger promise more than
    ///      the contract holds.
    function deposit(uint256 amount) external nonReentrant returns (uint256 received) {
        require(!paused, "Arena: paused");
        require(amount > 0, "Arena: amount is zero");
        received = _pull(amount);
        require(received >= minDeposit, "Arena: below minimum");
        totalDeposited += received;
        depositCount += 1;
        emit Deposited(msg.sender, received, depositCount);
    }

    /// @notice Adds to the pot the server rains into the arena as pellets
    ///         and stakes bots from. Anyone can fund it; the token's fee
    ///         wallet is the intended caller. Nothing funded is ever owed
    ///         back to the funder.
    function fund(uint256 amount) external nonReentrant returns (uint256 received) {
        require(!paused, "Arena: paused");
        require(amount > 0, "Arena: amount is zero");
        received = _pull(amount);
        totalFunded += received;
        emit Funded(msg.sender, received);
    }

    // ─────────────────────────────── out ─────────────────────────────────

    /// @notice Pays out everything owed to msg.sender up to `cumulative`.
    /// @dev The signature must come from `signer` over
    ///      `hashClaim(msg.sender, cumulative, deadline)`. The digest binds
    ///      `account`, so a voucher issued to one player is worthless in
    ///      anyone else's hands: it recovers a different address and fails
    ///      as "bad signature".
    /// @param cumulative Total token this account has ever been entitled to, in wei.
    /// @param deadline Unix timestamp after which the voucher is dead.
    /// @param signature 65-byte ECDSA signature from `signer`.
    /// @return paid The amount transferred by this call.
    function claim(uint256 cumulative, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 paid)
    {
        require(!paused, "Arena: paused");
        require(block.timestamp <= deadline, "Arena: voucher expired");

        bytes32 digest = hashClaim(msg.sender, cumulative, deadline);
        require(ECDSA.recover(digest, signature) == signer, "Arena: bad signature");

        uint256 already = claimed[msg.sender];
        require(cumulative > already, "Arena: nothing to claim");

        paid = cumulative - already;
        require(token.balanceOf(address(this)) >= paid, "Arena: pit is short");

        claimed[msg.sender] = cumulative;
        totalClaimed += paid;

        token.safeTransfer(msg.sender, paid);
        emit Claimed(msg.sender, paid, cumulative);
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice The full EIP-712 digest a voucher for these values must be signed over.
    /// @dev Domain: name "FlypitArena", version "1", this chain, this contract.
    function hashClaim(address account, uint256 cumulative, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, account, cumulative, deadline)));
    }

    /// @notice What `account` would receive from a voucher for `cumulative`.
    function claimableFor(address account, uint256 cumulative) external view returns (uint256) {
        uint256 already = claimed[account];
        return cumulative > already ? cumulative - already : 0;
    }

    /// @notice Token currently held: every deposit and fund not yet claimed or rescued.
    function available() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ─────────────────────────────── admin ───────────────────────────────

    /// @notice Rotates the voucher signer. Vouchers signed by the old key stop working immediately.
    function setSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "Arena: signer is zero");
        emit SignerChanged(signer, newSigner);
        signer = newSigner;
    }

    /// @notice Opens or closes the pit. Use it if the signer key ever leaks.
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    /// @notice Sets the smallest deposit accepted, in token wei.
    function setMinDeposit(uint256 value) external onlyOwner {
        minDeposit = value;
        emit MinDepositSet(value);
    }

    /// @notice Moves `amount` of the token out of the contract.
    /// @dev Trust point, stated plainly: the owner can withdraw the entire
    ///      balance at any time, including tokens players expect to claim.
    ///      It exists to recover a misconfigured deployment and to retire the
    ///      contract; players should treat the owner key as fully trusted.
    function rescue(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Arena: to is zero");
        token.safeTransfer(to, amount);
        emit Rescued(to, amount);
    }

    // ─────────────────────────────── internal ────────────────────────────

    function _pull(uint256 amount) private returns (uint256 received) {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        received = token.balanceOf(address(this)) - before;
        require(received > 0, "Arena: nothing received");
    }
}
