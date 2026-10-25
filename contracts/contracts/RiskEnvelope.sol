// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IUniswapV2Pair, IERC20Minimal} from "./interfaces/IUniswapV2.sol";

/**
 * @title RiskEnvelope
 * @notice A signed, on-chain risk mandate for an autonomous trading agent.
 *
 * The owner signs a mandate off-chain (EIP-712). The agent can only trade inside it.
 * Every limit is checked against live pool reserves and live balances at execution
 * time, so the envelope cannot be edited by the agent, by prompt injection, or by
 * an operator mistake. A breach is a reverted transaction, not a log line.
 *
 * Enforced limits:
 *   - target pair and therefore target asset (changing it needs a new signature)
 *   - maximum notional per trade
 *   - maximum position as a share of equity
 *   - maximum daily loss as a share of the day's opening equity
 *   - maximum trades per hour
 *   - hard expiry
 *   - single authorised executor address
 */
contract RiskEnvelope is EIP712 {
    using ECDSA for bytes32;

    struct Mandate {
        address account; // the trader contract holding funds
        address executor; // the agent key allowed to trade
        address pair; // HSKSwap pair
        address baseToken; // asset the agent trades into
        address quoteToken; // asset it prices and settles in
        uint16 maxPositionBps; // position ceiling, basis points of equity
        uint16 maxDailyLossBps; // daily loss ceiling, basis points of opening equity
        uint16 maxSlippageBps; // per-trade slippage ceiling
        uint16 maxTradesPerHour; // rate limit
        uint256 maxNotionalQuote; // per-trade notional ceiling, quote units
        uint64 expiry; // unix seconds
        uint64 nonce; // replay protection, strictly increasing
    }

    bytes32 private constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address account,address executor,address pair,address baseToken,address quoteToken,uint16 maxPositionBps,uint16 maxDailyLossBps,uint16 maxSlippageBps,uint16 maxTradesPerHour,uint256 maxNotionalQuote,uint64 expiry,uint64 nonce)"
    );

    error NotOwner();
    error InvalidSigner(address recovered, address expected);
    error StaleNonce(uint64 provided, uint64 current);
    error EnvelopeInactive();
    error EnvelopeExpired(uint64 expiry);
    error NotExecutor(address caller);
    error NotAccount(address caller);
    error BadParams();
    error NoLiquidity();
    error NoEquity();
    error NotionalExceeded(uint256 notional, uint256 maxNotional);
    error PositionExceeded(uint256 projectedBps, uint16 maxBps);
    error DailyLossBreached(uint256 lossBps, uint16 maxBps);
    error RateLimited(uint256 tradesThisHour, uint16 maxTradesPerHour);

    event MandateSet(uint64 indexed nonce, bytes32 mandateHash, address indexed executor, address indexed pair);
    event Consumed(bool isBuy, uint256 notionalQuote, uint256 tradesThisHour);
    event Settled(uint256 equity, uint256 dayStartEquity);
    event OwnershipTransferred(address indexed from, address indexed to);

    address public owner;

    Mandate private _mandate;
    bool public active;

    uint64 public dayId;
    uint256 public dayStartEquity;
    uint64 public tradesHour;
    uint16 public tradesInHour;

    constructor() EIP712("Envelope", "1") {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /**
     * @notice Hand the envelope to a human wallet. After this, only that wallet's signature
     *         can install a mandate; the deployer and the agent key are locked out.
     */
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert BadParams();
        owner = newOwner;
        active = false;
        emit OwnershipTransferred(msg.sender, newOwner);
    }

    // ---------------------------------------------------------------------
    // Mandate lifecycle
    // ---------------------------------------------------------------------

    function mandateHash(Mandate calldata m) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MANDATE_TYPEHASH,
                m.account,
                m.executor,
                m.pair,
                m.baseToken,
                m.quoteToken,
                m.maxPositionBps,
                m.maxDailyLossBps,
                m.maxSlippageBps,
                m.maxTradesPerHour,
                m.maxNotionalQuote,
                m.expiry,
                m.nonce
            )
        );
    }

    /**
     * @notice Install a mandate. Anyone may submit it; only the owner's signature makes it valid.
     */
    function setMandate(Mandate calldata m, bytes calldata signature) external {
        if (m.account == address(0) || m.executor == address(0) || m.pair == address(0)) revert BadParams();
        if (m.baseToken == address(0) || m.quoteToken == address(0)) revert BadParams();
        if (m.maxPositionBps == 0 || m.maxPositionBps > 10_000) revert BadParams();
        if (m.maxDailyLossBps > 10_000) revert BadParams();
        if (m.maxSlippageBps > 2_000) revert BadParams();
        if (m.maxTradesPerHour == 0) revert BadParams();
        if (m.expiry <= block.timestamp) revert BadParams();
        if (m.nonce <= _mandate.nonce) revert StaleNonce(m.nonce, _mandate.nonce);

        bytes32 digest = _hashTypedDataV4(mandateHash(m));
        address recovered = digest.recover(signature);
        if (recovered != owner) revert InvalidSigner(recovered, owner);

        _mandate = m;
        active = true;

        dayId = uint64(block.timestamp / 1 days);
        dayStartEquity = _equity();
        tradesHour = uint64(block.timestamp / 1 hours);
        tradesInHour = 0;

        emit MandateSet(m.nonce, digest, m.executor, m.pair);
    }

    function revoke() external {
        if (msg.sender != owner) revert NotOwner();
        active = false;
    }

    // ---------------------------------------------------------------------
    // Execution gate
    // ---------------------------------------------------------------------

    /**
     * @notice Authorise one trade and consume rate-limit budget. Reverts on any breach.
     * @dev Called by the trader account (the only address that can move funds), not by the
     *      agent key. The agent key is authorised one level up, in EnvelopeTrader.trade.
     * @return notionalQuote the notional of this trade, denominated in quote units
     */
    function consume(bool isBuy, uint256 amountIn) external returns (uint256 notionalQuote) {
        Mandate storage m = _mandate;
        if (!active) revert EnvelopeInactive();
        if (msg.sender != m.account) revert NotAccount(msg.sender);
        if (block.timestamp > m.expiry) revert EnvelopeExpired(m.expiry);

        (uint256 quoteReserve, uint256 baseReserve) = _reserves(m);
        if (quoteReserve == 0 || baseReserve == 0) revert NoLiquidity();

        uint64 hour = uint64(block.timestamp / 1 hours);
        if (hour != tradesHour) {
            tradesHour = hour;
            tradesInHour = 0;
        }
        if (tradesInHour + 1 > m.maxTradesPerHour) revert RateLimited(tradesInHour, m.maxTradesPerHour);

        uint256 equityNow = _equityWith(m, quoteReserve, baseReserve);
        if (equityNow == 0) revert NoEquity();

        uint256 baseBalance = IERC20Minimal(m.baseToken).balanceOf(m.account);
        uint256 baseValue = (baseBalance * quoteReserve) / baseReserve;

        uint256 projectedBaseValue;
        if (isBuy) {
            notionalQuote = amountIn;
            projectedBaseValue = baseValue + amountIn;
        } else {
            notionalQuote = (amountIn * quoteReserve) / baseReserve;
            projectedBaseValue = baseValue > notionalQuote ? baseValue - notionalQuote : 0;
        }

        if (notionalQuote > m.maxNotionalQuote) revert NotionalExceeded(notionalQuote, m.maxNotionalQuote);

        uint256 projectedBps = (projectedBaseValue * 10_000) / equityNow;
        if (projectedBps > m.maxPositionBps) revert PositionExceeded(projectedBps, m.maxPositionBps);

        _rollDay(equityNow);
        if (equityNow < dayStartEquity && dayStartEquity > 0) {
            uint256 lossBps = ((dayStartEquity - equityNow) * 10_000) / dayStartEquity;
            if (lossBps >= m.maxDailyLossBps) revert DailyLossBreached(lossBps, m.maxDailyLossBps);
        }

        tradesInHour += 1;
        emit Consumed(isBuy, notionalQuote, tradesInHour);
    }

    /// @notice Re-baseline equity after a fill so the daily loss limit tracks reality.
    function settle() external {
        if (msg.sender != _mandate.account) revert NotAccount(msg.sender);
        uint256 equityNow = _equity();
        _rollDay(equityNow);
        emit Settled(equityNow, dayStartEquity);
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    function mandate() external view returns (Mandate memory) {
        return _mandate;
    }

    function equity() external view returns (uint256) {
        return _equity();
    }

    function position() external view returns (uint256 baseBalance, uint256 baseValueQuote, uint256 equityQuote, uint256 positionBps) {
        Mandate storage m = _mandate;
        (uint256 quoteReserve, uint256 baseReserve) = _reserves(m);
        baseBalance = IERC20Minimal(m.baseToken).balanceOf(m.account);
        if (baseReserve == 0) return (baseBalance, 0, _equity(), 0);
        baseValueQuote = (baseBalance * quoteReserve) / baseReserve;
        equityQuote = _equityWith(m, quoteReserve, baseReserve);
        positionBps = equityQuote == 0 ? 0 : (baseValueQuote * 10_000) / equityQuote;
    }

    function price() external view returns (uint256 quoteReserve, uint256 baseReserve) {
        return _reserves(_mandate);
    }

    function state()
        external
        view
        returns (bool isActive, uint64 nonce, uint64 expiry, uint64 hour, uint16 tradesThisHour, uint256 equityNow, uint256 dayEquity)
    {
        return (active, _mandate.nonce, _mandate.expiry, tradesHour, tradesInHour, _equity(), dayStartEquity);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _reserves(Mandate storage m) internal view returns (uint256 quoteReserve, uint256 baseReserve) {
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(m.pair).getReserves();
        address t0 = IUniswapV2Pair(m.pair).token0();
        if (t0 == m.quoteToken) return (uint256(r0), uint256(r1));
        return (uint256(r1), uint256(r0));
    }

    function _equity() internal view returns (uint256) {
        Mandate storage m = _mandate;
        if (m.pair == address(0)) return 0;
        (uint256 quoteReserve, uint256 baseReserve) = _reserves(m);
        return _equityWith(m, quoteReserve, baseReserve);
    }

    function _equityWith(Mandate storage m, uint256 quoteReserve, uint256 baseReserve) internal view returns (uint256) {
        uint256 quoteBalance = IERC20Minimal(m.quoteToken).balanceOf(m.account);
        if (baseReserve == 0) return quoteBalance;
        uint256 baseBalance = IERC20Minimal(m.baseToken).balanceOf(m.account);
        return quoteBalance + (baseBalance * quoteReserve) / baseReserve;
    }

    function _rollDay(uint256 equityNow) internal {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today != dayId) {
            dayId = today;
            dayStartEquity = equityNow;
        }
    }
}
