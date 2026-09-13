// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockToken
/// @notice Test-only ERC-20. `feeBps` burns a slice of every transfer so the
///         Arena's fee-on-transfer accounting can be proven; it is 0 unless a
///         test sets it. Never deploy this: the real token is whatever the
///         launchpad minted, and the Arena takes its address at deployment.
contract MockToken is ERC20 {
    uint256 public feeBps;

    constructor(uint256 supply) ERC20("Mock FLYPIT", "mFLY") {
        _mint(msg.sender, supply);
    }

    function setFeeBps(uint256 bps) external {
        require(bps <= 10_000, "fee > 100%");
        feeBps = bps;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (feeBps > 0 && from != address(0) && to != address(0)) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
