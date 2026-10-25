export const envelopeAbi = [
  {
    type: 'function',
    name: 'mandate',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'account', type: 'address' },
          { name: 'executor', type: 'address' },
          { name: 'pair', type: 'address' },
          { name: 'baseToken', type: 'address' },
          { name: 'quoteToken', type: 'address' },
          { name: 'maxPositionBps', type: 'uint16' },
          { name: 'maxDailyLossBps', type: 'uint16' },
          { name: 'maxSlippageBps', type: 'uint16' },
          { name: 'maxTradesPerHour', type: 'uint16' },
          { name: 'maxNotionalQuote', type: 'uint256' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'position',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'baseBalance', type: 'uint256' },
      { name: 'baseValueQuote', type: 'uint256' },
      { name: 'equityQuote', type: 'uint256' },
      { name: 'positionBps', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'price',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'quoteReserve', type: 'uint256' },
      { name: 'baseReserve', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'state',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'isActive', type: 'bool' },
      { name: 'nonce', type: 'uint64' },
      { name: 'expiry', type: 'uint64' },
      { name: 'hour', type: 'uint64' },
      { name: 'tradesThisHour', type: 'uint16' },
      { name: 'equityNow', type: 'uint256' },
      { name: 'dayEquity', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'equity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setMandate',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'm',
        type: 'tuple',
        components: [
          { name: 'account', type: 'address' },
          { name: 'executor', type: 'address' },
          { name: 'pair', type: 'address' },
          { name: 'baseToken', type: 'address' },
          { name: 'quoteToken', type: 'address' },
          { name: 'maxPositionBps', type: 'uint16' },
          { name: 'maxDailyLossBps', type: 'uint16' },
          { name: 'maxSlippageBps', type: 'uint16' },
          { name: 'maxTradesPerHour', type: 'uint16' },
          { name: 'maxNotionalQuote', type: 'uint256' },
          { name: 'expiry', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'MandateSet',
    inputs: [
      { name: 'nonce', type: 'uint64', indexed: true },
      { name: 'mandateHash', type: 'bytes32', indexed: false },
      { name: 'executor', type: 'address', indexed: true },
      { name: 'pair', type: 'address', indexed: true },
    ],
  },
  {
    type: 'error',
    name: 'NotOwner',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidSigner',
    inputs: [
      { name: 'recovered', type: 'address' },
      { name: 'expected', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'StaleNonce',
    inputs: [
      { name: 'provided', type: 'uint64' },
      { name: 'current', type: 'uint64' },
    ],
  },
  {
    type: 'error',
    name: 'EnvelopeInactive',
    inputs: [],
  },
  {
    type: 'error',
    name: 'EnvelopeExpired',
    inputs: [{ name: 'expiry', type: 'uint64' }],
  },
  {
    type: 'error',
    name: 'NotExecutor',
    inputs: [{ name: 'caller', type: 'address' }],
  },
  {
    type: 'error',
    name: 'NotionalExceeded',
    inputs: [
      { name: 'notional', type: 'uint256' },
      { name: 'maxNotional', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'PositionExceeded',
    inputs: [
      { name: 'projectedBps', type: 'uint256' },
      { name: 'maxBps', type: 'uint16' },
    ],
  },
  {
    type: 'error',
    name: 'DailyLossBreached',
    inputs: [
      { name: 'lossBps', type: 'uint256' },
      { name: 'maxBps', type: 'uint16' },
    ],
  },
  {
    type: 'error',
    name: 'RateLimited',
    inputs: [
      { name: 'tradesThisHour', type: 'uint256' },
      { name: 'maxTradesPerHour', type: 'uint16' },
    ],
  },
  { type: 'error', name: 'NoLiquidity', inputs: [] },
  { type: 'error', name: 'NoEquity', inputs: [] },
] as const;

export const traderAbi = [
  {
    type: 'function',
    name: 'trade',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'intent',
        type: 'tuple',
        components: [
          { name: 'isBuy', type: 'bool' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'minAmountOut', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { name: 'decisionHash', type: 'bytes32' },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'head', type: 'bytes32' },
    ],
  },
  {
    type: 'function',
    name: 'refuse',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'decisionHash', type: 'bytes32' },
      { name: 'reasonCode', type: 'bytes32' },
    ],
    outputs: [{ name: 'head', type: 'bytes32' }],
  },
  {
    type: 'event',
    name: 'Trade',
    inputs: [
      { name: 'seq', type: 'uint32', indexed: true },
      { name: 'isBuy', type: 'bool', indexed: false },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'equityAfter', type: 'uint256', indexed: false },
      { name: 'decisionHash', type: 'bytes32', indexed: false },
      { name: 'head', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Refused',
    inputs: [
      { name: 'decisionHash', type: 'bytes32', indexed: true },
      { name: 'reasonCode', type: 'bytes32', indexed: false },
      { name: 'head', type: 'bytes32', indexed: false },
    ],
  },
  { type: 'error', name: 'NotExecutor', inputs: [{ name: 'caller', type: 'address' }] },
  {
    type: 'error',
    name: 'SlippageTooHigh',
    inputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
    ],
  },
] as const;

export const ledgerAbi = [
  {
    type: 'function',
    name: 'head',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'count',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'entry',
    stateMutability: 'view',
    inputs: [{ name: 'entryHash', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'prev', type: 'bytes32' },
          { name: 'decision', type: 'bytes32' },
          { name: 'outcome', type: 'bytes32' },
          { name: 'ts', type: 'uint64' },
          { name: 'seq', type: 'uint32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'recompute',
    stateMutability: 'pure',
    inputs: [
      { name: 'prev', type: 'bytes32' },
      { name: 'decisionHash', type: 'bytes32' },
      { name: 'outcomeHash', type: 'bytes32' },
      { name: 'ts', type: 'uint64' },
      { name: 'seq', type: 'uint32' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

export const pairAbi = [
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'reserve0', type: 'uint112' },
      { name: 'reserve1', type: 'uint112' },
      { name: 'blockTimestampLast', type: 'uint32' },
    ],
  },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'amount0In', type: 'uint256', indexed: false },
      { name: 'amount1In', type: 'uint256', indexed: false },
      { name: 'amount0Out', type: 'uint256', indexed: false },
      { name: 'amount1Out', type: 'uint256', indexed: false },
      { name: 'to', type: 'address', indexed: true },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;
