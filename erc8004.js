// ERC-8004 Identity Verification Module
// Phase 3 — Simulated on-chain verification
// Phase 4 — Replace with real blockchain calls

const SUPPORTED_CHAINS = {
  'bnb': 'BNB Smart Chain',
  'base': 'Base',
  'ethereum': 'Ethereum',
  'polygon': 'Polygon'
};

// Simulated ERC-8004 registry
// In Phase 4, this will be replaced with actual blockchain calls
// using ethers.js or viem to read from the ERC-8004 smart contract
const MOCK_REGISTRY = {
  '0x1a2b3c4d5e6f7890abcdef1234567890abcdef12': {
    token_id: '0x1a2b3c4d5e6f7890abcdef1234567890abcdef12',
    chain: 'BNB Smart Chain',
    owner: '0x9f8e7d6c5b4a3921fedcba0987654321fedcba09',
    name: 'Research Agent',
    registered_at: '2026-01-15T10:00:00Z',
    reputation_score: 847,
    verified: true
  },
  '0x2b3c4d5e6f7890abcdef1234567890abcdef1234': {
    token_id: '0x2b3c4d5e6f7890abcdef1234567890abcdef1234',
    chain: 'Base',
    owner: '0x8e7d6c5b4a392130fedcba0987654321fedcba08',
    name: 'Trading Agent',
    registered_at: '2026-02-01T14:30:00Z',
    reputation_score: 612,
    verified: true
  }
};

// Verify an ERC-8004 token ID
// Phase 4: replace mock lookup with actual contract call:
// const contract = new ethers.Contract(ERC8004_ADDRESS, ERC8004_ABI, provider);
// const identity = await contract.getIdentity(tokenId);
async function verifyToken(tokenId) {
  if (!tokenId || typeof tokenId !== 'string') {
    return { verified: false, error: 'Invalid token ID format' };
  }

  const normalized = tokenId.toLowerCase().trim();
  
  if (!normalized.startsWith('0x') || normalized.length !== 42) {
    return { verified: false, error: 'Token ID must be a valid Ethereum address (0x...)' };
  }

  // Simulate network latency
  await new Promise(resolve => setTimeout(resolve, 500));

  const identity = MOCK_REGISTRY[normalized];
  
  if (!identity) {
    return {
      verified: false,
      error: 'Token ID not found in ERC-8004 registry',
      token_id: normalized
    };
  }

  return {
    verified: true,
    token_id: identity.token_id,
    chain: identity.chain,
    owner: identity.owner,
    name: identity.name,
    registered_at: identity.registered_at,
    reputation_score: identity.reputation_score
  };
}

// Calculate policy restrictions based on reputation score
// Higher reputation = more autonomy = less friction
function getPolicyFromReputation(reputation_score) {
  if (reputation_score >= 800) {
    return {
      tier: 'trusted',
      label: 'Trusted Agent',
      daily_budget_multiplier: 2.0,
      require_approval_threshold: 500,
      description: 'High reputation — expanded limits and reduced approval requirements'
    };
  } else if (reputation_score >= 500) {
    return {
      tier: 'standard',
      label: 'Standard Agent',
      daily_budget_multiplier: 1.0,
      require_approval_threshold: 100,
      description: 'Standard reputation — default limits apply'
    };
  } else if (reputation_score >= 100) {
    return {
      tier: 'restricted',
      label: 'Restricted Agent',
      daily_budget_multiplier: 0.5,
      require_approval_threshold: 25,
      description: 'Low reputation — reduced limits and increased oversight'
    };
  } else {
    return {
      tier: 'unverified',
      label: 'Unverified Agent',
      daily_budget_multiplier: 0.1,
      require_approval_threshold: 10,
      description: 'No on-chain identity — strict limits, all transactions require approval'
    };
  }
}

function shortenAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

module.exports = { verifyToken, getPolicyFromReputation, shortenAddress, SUPPORTED_CHAINS };