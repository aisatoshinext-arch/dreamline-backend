// Dreamline Blockchain Module
// Reads events from DreamlineVerifier and DreamlineRegistry on BNB Chain
// The backend is now an INDEXER — it reads, not decides

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ============================================================
// ABIs
// ============================================================

const REGISTRY_ABI = [
  "function getPolicy(address agent) external view returns (tuple(uint256 dailyBudgetUsd, uint256 singleTxLimitUsd, uint256 approvalThresholdUsd, bool active, uint256 registeredAt, string erc8004TokenId, uint8 reputationTier))",
  "function isDestinationAllowed(string destination) external view returns (bool)",
  "function getDailySpend(address agent) external view returns (uint256)",
  "function getBlacklistedDestinations() external view returns (string[])",
  "function addToBlacklist(string destination, string reason) external",
  "function registerAgent(address agent, uint256 dailyBudgetUsd, uint256 singleTxLimitUsd, uint256 approvalThresholdUsd, string erc8004TokenId, uint8 reputationTier) external",
  "function getDreamlineSigner() external view returns (address)",
  "event AgentRegistered(address indexed agent, string erc8004TokenId, uint8 reputationTier)",
  "event DestinationBlacklisted(string destination, string reason)"
];

const VERIFIER_ABI = [
  "function requestApproval(string destination, uint256 amountUsd) external payable returns (bytes32)",
  "function executePayment(bytes32 approvalId) external",
  "function manualApprove(bytes32 approvalId) external",
  "function manualReject(bytes32 approvalId, string reason) external",
  "function isApproved(bytes32 approvalId) external view returns (bool)",
  "function getApprovalDetails(bytes32 approvalId) external view returns (tuple(address agent, string destination, uint256 amountUsd, uint256 timestamp, uint256 expiresAt, bool used))",
  "function getDailySpend(address agent) external view returns (uint256)",
  "function getFeeInfo() external view returns (bool enabled, uint256 feeBNB, address feesTreasury, uint256 totalCollected)",
  "function feeEnabled() external view returns (bool)",
  "function protocolFeeBNB() external view returns (uint256)",
  "function totalFeesCollected() external view returns (uint256)",
  "function getCircuitBreakerStatus(address agent) external view returns (bool paused, uint256 denialCount, uint256 windowStart, uint256 pausedAt, uint256 timeUntilUnpause, uint256 totalTriggeredCount)",
  "function resetCircuitBreaker(address agent) external",
  "event ApprovalGranted(bytes32 indexed approvalId, address indexed agent, string destination, uint256 amountUsd, uint256 expiresAt)",
  "event ApprovalDenied(address indexed agent, string destination, uint256 amountUsd, string reason)",
  "event ApprovalUsed(bytes32 indexed approvalId, address indexed agent, string destination, uint256 amountUsd)",
  "event ApprovalPending(bytes32 indexed approvalId, address indexed agent, string destination, uint256 amountUsd, string reason)",
  "event FeeCollected(address indexed agent, uint256 feeBNB)",
  "event CircuitBreakerTriggered(address indexed agent, uint256 denialCount, uint256 timestamp)",
  "event CircuitBreakerReset(address indexed agent, address indexed resetBy, uint256 timestamp)",
  "event AgentAutoUnpaused(address indexed agent, uint256 timestamp)"
];

const GOVERNANCE_ABI = [
  "function propose(string title, string description, address target, bytes data, uint256 value) external returns (uint256)",
  "function approve(uint256 proposalId) external",
  "function execute(uint256 proposalId) external",
  "function reject(uint256 proposalId, string reason) external",
  "function getProposal(uint256 proposalId) external view returns (tuple(uint256 id, address proposer, string title, string description, address target, bytes data, uint256 value, uint256 proposedAt, uint256 executableAt, uint256 approvalCount, uint8 status))",
  "function getSigners() external view returns (address[])",
  "function threshold() external view returns (uint256)",
  "function proposalCount() external view returns (uint256)",
  "event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string title, address target, uint256 executableAt)",
  "event ProposalApproved(uint256 indexed proposalId, address indexed signer, uint256 approvalCount, uint256 threshold)",
  "event ProposalExecuted(uint256 indexed proposalId, address indexed executor)"
];

// ============================================================
// PROVIDER & CONTRACTS
// ============================================================

let provider;
let walletSigner;

function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(
      process.env.BSC_TESTNET_RPC || 'https://bsc-testnet-rpc.publicnode.com'
    );
  }
  return provider;
}

function getRegistry(withSigner = false) {
  const p = getProvider();
  if (withSigner) {
    if (!walletSigner) walletSigner = new ethers.Wallet(process.env.PRIVATE_KEY, p);
    return new ethers.Contract(process.env.REGISTRY_ADDRESS, REGISTRY_ABI, walletSigner);
  }
  return new ethers.Contract(process.env.REGISTRY_ADDRESS, REGISTRY_ABI, p);
}

function getVerifier(withSigner = false) {
  const p = getProvider();
  if (withSigner) {
    if (!walletSigner) walletSigner = new ethers.Wallet(process.env.PRIVATE_KEY, p);
    return new ethers.Contract(process.env.VERIFIER_ADDRESS, VERIFIER_ABI, walletSigner);
  }
  return new ethers.Contract(process.env.VERIFIER_ADDRESS, VERIFIER_ABI, p);
}

function getGovernance(withSigner = false) {
  const p = getProvider();
  if (withSigner) {
    if (!walletSigner) walletSigner = new ethers.Wallet(process.env.PRIVATE_KEY, p);
    return new ethers.Contract(process.env.GOVERNANCE_ADDRESS, GOVERNANCE_ABI, walletSigner);
  }
  return new ethers.Contract(process.env.GOVERNANCE_ADDRESS, GOVERNANCE_ABI, p);
}

// ============================================================
// REGISTRY FUNCTIONS
// ============================================================

async function isDestinationAllowed(destination) {
  try {
    const c = getRegistry();
    return await c.isDestinationAllowed(destination);
  } catch (err) {
    console.error('[Blockchain] isDestinationAllowed error:', err.message);
    return true;
  }
}

async function getBlacklistedDestinations() {
  try {
    const c = getRegistry();
    return await c.getBlacklistedDestinations();
  } catch (err) {
    console.error('[Blockchain] getBlacklistedDestinations error:', err.message);
    return [];
  }
}

async function getAgentPolicy(agentAddress) {
  try {
    const c = getRegistry();
    const policy = await c.getPolicy(agentAddress);
    return {
      dailyBudgetUsd: Number(policy.dailyBudgetUsd),
      singleTxLimitUsd: Number(policy.singleTxLimitUsd),
      approvalThresholdUsd: Number(policy.approvalThresholdUsd),
      active: policy.active,
      registeredAt: Number(policy.registeredAt),
      erc8004TokenId: policy.erc8004TokenId,
      reputationTier: Number(policy.reputationTier)
    };
  } catch (err) {
    console.error('[Blockchain] getAgentPolicy error:', err.message);
    return null;
  }
}

async function registerAgentOnChain(agentAddress, policy, erc8004TokenId, reputationTier) {
  try {
    const c = getRegistry(true);
    const tx = await c.registerAgent(
      agentAddress,
      Math.round(policy.daily_budget_usd * 100),
      Math.round(policy.single_tx_limit_usd * 100),
      Math.round(policy.require_approval_above_usd * 100),
      erc8004TokenId || '',
      reputationTier || 0,
      { gasLimit: 500000 }
    );
    console.log('[Blockchain] registerAgent tx:', tx.hash);
    const receipt = await tx.wait();
    return { txHash: tx.hash, blockNumber: receipt.blockNumber };
  } catch (err) {
    console.error('[Blockchain] registerAgent error:', err.message);
    return null;
  }
}

async function addToOnChainBlacklist(destination, reason) {
  try {
    const c = getRegistry(true);
    const tx = await c.addToBlacklist(destination, reason, { gasLimit: 200000 });
    await tx.wait();
    return tx.hash;
  } catch (err) {
    console.error('[Blockchain] addToBlacklist error:', err.message);
    return null;
  }
}

// ============================================================
// VERIFIER FUNCTIONS
// ============================================================

async function requestApprovalOnChain(agentWallet, destination, amountUsd) {
  try {
    const p = getProvider();
    const signer = new ethers.Wallet(agentWallet.privateKey, p);
    const verifier = new ethers.Contract(process.env.VERIFIER_ADDRESS, VERIFIER_ABI, signer);
    const tx = await verifier.requestApproval(destination, amountUsd, { gasLimit: 300000 });
    const receipt = await tx.wait();
    const event = receipt.logs.find(log => {
      try {
        const parsed = verifier.interface.parseLog(log);
        return parsed.name === 'ApprovalGranted' || parsed.name === 'ApprovalPending';
      } catch { return false; }
    });
    if (event) {
      const parsed = verifier.interface.parseLog(event);
      return {
        approved: parsed.name === 'ApprovalGranted',
        pending: parsed.name === 'ApprovalPending',
        approvalId: parsed.args[0],
        txHash: tx.hash
      };
    }
    return { approved: false, txHash: tx.hash };
  } catch (err) {
    console.error('[Blockchain] requestApproval error:', err.message);
    return { approved: false, error: err.message };
  }
}

async function manualApproveOnChain(approvalId) {
  try {
    const c = getVerifier(true);
    const tx = await c.manualApprove(approvalId, { gasLimit: 200000 });
    await tx.wait();
    return { success: true, txHash: tx.hash };
  } catch (err) {
    console.error('[Blockchain] manualApprove error:', err.message);
    return { success: false, error: err.message };
  }
}

async function manualRejectOnChain(approvalId, reason) {
  try {
    const c = getVerifier(true);
    const tx = await c.manualReject(approvalId, reason, { gasLimit: 200000 });
    await tx.wait();
    return { success: true, txHash: tx.hash };
  } catch (err) {
    console.error('[Blockchain] manualReject error:', err.message);
    return { success: false, error: err.message };
  }
}

async function getVerifierFeeInfo() {
  try {
    const c = getVerifier();
    const info = await c.getFeeInfo();
    return {
      enabled: info.enabled,
      feeBNB: info.feeBNB.toString(),
      feeUSD: (Number(info.feeBNB) / 1e18 * 300).toFixed(6),
      treasury: info.feesTreasury,
      totalCollected: info.totalCollected.toString()
    };
  } catch (err) {
    console.error('[Blockchain] getFeeInfo error:', err.message);
    return null;
  }
}

// ============================================================
// CIRCUIT BREAKER
// ============================================================

async function getCircuitBreakerStatus(agentAddress) {
  try {
    const verifier = getVerifier();
    const status = await verifier.getCircuitBreakerStatus(agentAddress);
    return {
      paused: status.paused,
      denialCount: Number(status.denialCount),
      pausedAt: Number(status.pausedAt),
      timeUntilUnpause: Number(status.timeUntilUnpause),
      totalTriggeredCount: Number(status.totalTriggeredCount),
      minutesUntilUnpause: Math.ceil(Number(status.timeUntilUnpause) / 60)
    };
  } catch (err) {
    console.error('[Blockchain] getCircuitBreakerStatus error:', err.message);
    return null;
  }
}

async function resetCircuitBreakerOnChain(agentAddress) {
  try {
    const verifier = getVerifier(true);
    const tx = await verifier.resetCircuitBreaker(agentAddress, { gasLimit: 100000 });
    await tx.wait();
    return { success: true, txHash: tx.hash };
  } catch (err) {
    console.error('[Blockchain] resetCircuitBreaker error:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================
// EVENT INDEXER
// ============================================================

async function getRecentApprovalEvents(blocksBack = 50000) {
  try {
    const verifier = getVerifier();
    const p = getProvider();
    const latestBlock = await p.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - blocksBack);

    const [granted, denied, used, pending, cbTriggered] = await Promise.all([
      verifier.queryFilter(verifier.filters.ApprovalGranted(), fromBlock, latestBlock),
      verifier.queryFilter(verifier.filters.ApprovalDenied(), fromBlock, latestBlock),
      verifier.queryFilter(verifier.filters.ApprovalUsed(), fromBlock, latestBlock),
      verifier.queryFilter(verifier.filters.ApprovalPending(), fromBlock, latestBlock),
      verifier.queryFilter(verifier.filters.CircuitBreakerTriggered(), fromBlock, latestBlock)
    ]);

    const events = [
      ...granted.map(e => ({
        type: 'ApprovalGranted',
        approvalId: e.args[0],
        agent: e.args[1],
        destination: e.args[2],
        amountUsd: Number(e.args[3]) / 100,
        blockNumber: e.blockNumber,
        txHash: e.transactionHash
      })),
      ...denied.map(e => ({
        type: 'ApprovalDenied',
        agent: e.args[0],
        destination: e.args[1],
        amountUsd: Number(e.args[2]) / 100,
        reason: e.args[3],
        blockNumber: e.blockNumber,
        txHash: e.transactionHash
      })),
      ...used.map(e => ({
        type: 'ApprovalUsed',
        approvalId: e.args[0],
        agent: e.args[1],
        destination: e.args[2],
        amountUsd: Number(e.args[3]) / 100,
        blockNumber: e.blockNumber,
        txHash: e.transactionHash
      })),
      ...pending.map(e => ({
        type: 'ApprovalPending',
        approvalId: e.args[0],
        agent: e.args[1],
        destination: e.args[2],
        amountUsd: Number(e.args[3]) / 100,
        reason: e.args[4],
        blockNumber: e.blockNumber,
        txHash: e.transactionHash
      })),
      ...cbTriggered.map(e => ({
        type: 'CircuitBreakerTriggered',
        agent: e.args[0],
        denialCount: Number(e.args[1]),
        blockNumber: e.blockNumber,
        txHash: e.transactionHash
      }))
    ].sort((a, b) => b.blockNumber - a.blockNumber);

    return events;
  } catch (err) {
    console.error('[Blockchain] getRecentApprovalEvents error:', err.message);
    return [];
  }
}

async function getOnChainStats(blocksBack = 5000) {
  try {
    const events = await getRecentApprovalEvents(blocksBack);
    const granted = events.filter(e => e.type === 'ApprovalGranted');
    const denied = events.filter(e => e.type === 'ApprovalDenied');
    const used = events.filter(e => e.type === 'ApprovalUsed');
    const pending = events.filter(e => e.type === 'ApprovalPending');
    const cbTriggered = events.filter(e => e.type === 'CircuitBreakerTriggered');

    const totalVolumeUsd = granted.reduce((sum, e) => sum + e.amountUsd, 0);
    const blockedVolumeUsd = denied.reduce((sum, e) => sum + e.amountUsd, 0);

    return {
      totalApprovals: granted.length,
      totalDenied: denied.length,
      totalUsed: used.length,
      totalPending: pending.length,
      totalCircuitBreakerTriggered: cbTriggered.length,
      totalVolumeUsd: totalVolumeUsd.toFixed(2),
      blockedVolumeUsd: blockedVolumeUsd.toFixed(2),
      savedByDreamline: blockedVolumeUsd.toFixed(2),
      recentEvents: events.slice(0, 20)
    };
  } catch (err) {
    console.error('[Blockchain] getOnChainStats error:', err.message);
    return null;
  }
}

// ============================================================
// CONTRACT INFO
// ============================================================

async function getContractInfo() {
  try {
    const c = getRegistry();
    const p = getProvider();
    const signer = await c.getDreamlineSigner();
    const blacklisted = await c.getBlacklistedDestinations();
    const network = await p.getNetwork();
    const feeInfo = await getVerifierFeeInfo();

    return {
      address: process.env.REGISTRY_ADDRESS,
      verifierAddress: process.env.VERIFIER_ADDRESS,
      governanceAddress: process.env.GOVERNANCE_ADDRESS,
      chainId: Number(network.chainId),
      chainName: Number(network.chainId) === 97 ? 'BNB Chain Testnet' : 'BNB Chain Mainnet',
      dreamlineSigner: signer,
      blacklistedCount: blacklisted.length,
      blacklistedDestinations: blacklisted,
      bscscanUrl: `https://testnet.bscscan.com/address/${process.env.REGISTRY_ADDRESS}`,
      feeInfo
    };
  } catch (err) {
    console.error('[Blockchain] getContractInfo error:', err.message);
    return null;
  }
}

module.exports = {
  isDestinationAllowed,
  getBlacklistedDestinations,
  getAgentPolicy,
  registerAgentOnChain,
  addToOnChainBlacklist,
  requestApprovalOnChain,
  manualApproveOnChain,
  manualRejectOnChain,
  getVerifierFeeInfo,
  getRecentApprovalEvents,
  getOnChainStats,
  getContractInfo,
  getCircuitBreakerStatus,
  resetCircuitBreakerOnChain
};
