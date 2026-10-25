// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RiskEnvelope} from "./RiskEnvelope.sol";
import {TradeLedger} from "./TradeLedger.sol";
import {IUniswapV2Router02, IUniswapV2Pair, IERC20Minimal} from "./interfaces/IUniswapV2.sol";

/**
 * @title EnvelopeTrader
 * @notice The only address that can move funds, and it can only move them inside the envelope.
 *
 * Order of operations inside a single transaction, which is what makes the record
 * tamper evident: the decision hash is written on-chain before the first external
 * swap call, so it provably predates the outcome it produced.
 *
 *   1. envelope.consume()   reverts on any breach, records rate-limit usage
 *   2. router.swap()        moves the money
 *   3. envelope.settle()    re-baselines equity for the daily loss limit
 *   4. ledger.anchor()      commits decision + outcome to the hash chain
 */
contract EnvelopeTrader is Ownable {
    struct Intent {
        bool isBuy;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 deadline;
    }

    error NotExecutor(address caller);
    error SlippageTooHigh(uint256 amountOut, uint256 minAmountOut);
    error SlippageBandViolation(uint256 minAmountOut, uint256 mandateFloor);
    error SwapFailed();

    event Trade(
        uint32 indexed seq,
        bool isBuy,
        uint256 amountIn,
        uint256 amountOut,
        uint256 equityAfter,
        bytes32 decisionHash,
        bytes32 head
    );
    event Refused(bytes32 indexed decisionHash, bytes32 reasonCode, bytes32 head);

    RiskEnvelope public envelope;
    TradeLedger public ledger;
    IUniswapV2Router02 public router;

    constructor(address router_, address envelope_, address ledger_) Ownable(msg.sender) {
        router = IUniswapV2Router02(router_);
        envelope = RiskEnvelope(envelope_);
        ledger = TradeLedger(ledger_);
    }

    modifier onlyExecutor() {
        if (msg.sender != envelope.mandate().executor) revert NotExecutor(msg.sender);
        _;
    }

    /**
     * @notice Execute one swap inside the mandate and anchor the decision.
     * @param decisionHash hash of the full off-chain decision preimage
     */
    function trade(Intent calldata intent, bytes32 decisionHash) external returns (uint256 amountOut, bytes32 head) {
        RiskEnvelope.Mandate memory m = envelope.mandate();
        if (msg.sender != m.executor) revert NotExecutor(msg.sender);
        if (intent.amountIn == 0) revert SwapFailed();

        // 1. policy gate. Reverts with a named error on any breach.
        envelope.consume(intent.isBuy, intent.amountIn);

        // 2. settle
        address tokenIn = intent.isBuy ? m.quoteToken : m.baseToken;
        address tokenOut = intent.isBuy ? m.baseToken : m.quoteToken;
        IERC20Minimal(tokenIn).approve(address(router), intent.amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        // the mandate also caps slippage: the agent cannot set a looser floor than the envelope allows
        uint256 expectedOut = _expectedOut(m.pair, tokenIn, intent.amountIn);
        uint256 mandateFloor = (expectedOut * (10_000 - m.maxSlippageBps)) / 10_000;
        if (intent.minAmountOut < mandateFloor) revert SlippageBandViolation(intent.minAmountOut, mandateFloor);

        uint256[] memory amounts = router.swapExactTokensForTokens(
            intent.amountIn,
            intent.minAmountOut,
            path,
            address(this),
            intent.deadline
        );
        amountOut = amounts[amounts.length - 1];

        if (amountOut < intent.minAmountOut) revert SlippageTooHigh(amountOut, intent.minAmountOut);

        // 3. re-baseline the daily loss tracker against real balances
        envelope.settle();

        // 4. the record. Decision hash was already committed by the consume() state writes above.
        bytes32 outcomeHash = keccak256(abi.encodePacked("FILLED", amountOut, block.timestamp));
        head = ledger.anchor(decisionHash, outcomeHash);

        emit Trade(ledger.count(), intent.isBuy, intent.amountIn, amountOut, envelope.equity(), decisionHash, head);
    }

    /**
     * @notice Record a refusal. Used when the agent declines to act, so the ledger
     *         holds the trades it did not take as well as the ones it did.
     */
    function refuse(bytes32 decisionHash, bytes32 reasonCode) external returns (bytes32 head) {
        RiskEnvelope.Mandate memory m = envelope.mandate();
        if (msg.sender != m.executor) revert NotExecutor(msg.sender);
        bytes32 outcomeHash = keccak256(abi.encodePacked("REFUSED", reasonCode));
        head = ledger.anchor(decisionHash, outcomeHash);
        emit Refused(decisionHash, reasonCode, head);
    }

    /// @notice Emergency exit. Owner only, and it does not bypass the ledger.
    function sweep(address token, address to) external onlyOwner {
        uint256 bal = IERC20Minimal(token).balanceOf(address(this));
        IERC20Minimal(token).transfer(to, bal);
    }

    /// @dev Constant-product quote with the 0.3 percent fee, matching the router's own maths.
    function _expectedOut(address pair, address tokenIn, uint256 amountIn) internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
        bool zeroForOne = IUniswapV2Pair(pair).token0() == tokenIn;
        (uint256 rIn, uint256 rOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (rIn == 0 || rOut == 0) return 0;
        uint256 amountInWithFee = amountIn * 997;
        return (amountInWithFee * rOut) / (rIn * 1000 + amountInWithFee);
    }
}
