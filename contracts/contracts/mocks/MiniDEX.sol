// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Minimal} from "../interfaces/IUniswapV2.sol";

/// @notice Minimal constant-product pair, ABI compatible with Uniswap V2 for the
///         three calls this project makes: token0/token1 and getReserves.
contract MiniPair {
    address public immutable token0;
    address public immutable token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Sync(uint112 reserve0, uint112 reserve1);
    event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Mint(address indexed sender, uint256 amount0, uint256 amount1);

    error Locked();
    error InsufficientLiquidity();
    error InsufficientOutput();
    error Forbidden();

    uint256 private unlocked = 1;
    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function sync() public {
        reserve0 = uint112(IERC20Minimal(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20Minimal(token1).balanceOf(address(this)));
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }

    /// @dev liquidity must already be transferred in before calling
    function mint(address to) external lock returns (uint256 liquidity) {
        uint256 b0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 b1 = IERC20Minimal(token1).balanceOf(address(this));
        uint256 amount0 = b0 - reserve0;
        uint256 amount1 = b1 - reserve1;

        uint256 supply = totalSupply;
        if (supply == 0) {
            liquidity = _sqrt(amount0 * amount1);
        } else {
            liquidity = _min((amount0 * supply) / reserve0, (amount1 * supply) / reserve1);
        }
        if (liquidity == 0) revert InsufficientLiquidity();

        totalSupply = supply + liquidity;
        balanceOf[to] += liquidity;

        sync();
        emit Mint(to, amount0, amount1);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to) external lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutput();
        (uint112 r0, uint112 r1) = (reserve0, reserve1);
        if (amount0Out >= r0 || amount1Out >= r1) revert InsufficientLiquidity();

        if (amount0Out > 0) IERC20Minimal(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20Minimal(token1).transfer(to, amount1Out);

        uint256 b0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 b1 = IERC20Minimal(token1).balanceOf(address(this));

        uint256 amount0In = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 amount1In = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientOutput();

        uint256 b0Adjusted = b0 * 1000 - amount0In * 3;
        uint256 b1Adjusted = b1 * 1000 - amount1In * 3;
        if (b0Adjusted * b1Adjusted < uint256(r0) * uint256(r1) * 1000 ** 2) revert InsufficientOutput();

        sync();
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

/// @notice Factory + router in one contract with the exact ABI surface EnvelopeTrader uses.
///         Used for the self-contained local demo. Production deployments point at HSKSwap.
contract MiniDEX {
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair);

    function createPair(address a, address b) external returns (address pair) {
        require(a != b && a != address(0) && b != address(0), 'bad tokens');
        require(getPair[a][b] == address(0), 'pair exists');
        pair = address(new MiniPair(a, b));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
        allPairs.push(pair);
        emit PairCreated(a, b, pair);
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function addLiquidity(address a, address b, uint256 amountA, uint256 amountB, address to) external returns (uint256) {
        address pair = getPair[a][b];
        require(pair != address(0), 'no pair');
        require(IERC20Minimal(a).transferFrom(msg.sender, pair, amountA), 'pull a failed');
        require(IERC20Minimal(b).transferFrom(msg.sender, pair, amountB), 'pull b failed');
        return MiniPair(pair).mint(to);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, 'expired');
        require(path.length == 2, 'path');
        address pair = getPair[path[0]][path[1]];
        require(pair != address(0), 'no pair');

        require(IERC20Minimal(path[0]).transferFrom(msg.sender, pair, amountIn), 'pull failed');

        (uint112 r0, uint112 r1, ) = MiniPair(pair).getReserves();
        bool zeroForOne = MiniPair(pair).token0() == path[0];
        (uint256 rIn, uint256 rOut) = zeroForOne ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        uint256 inWithFee = amountIn * 997;
        uint256 amountOut = (inWithFee * rOut) / (rIn * 1000 + inWithFee);
        require(amountOut >= amountOutMin, 'insufficient output');
        require(amountOut < rOut, 'insufficient liquidity');

        MiniPair(pair).swap(zeroForOne ? 0 : amountOut, zeroForOne ? amountOut : 0, to);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}
