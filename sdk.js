// Dreamline Protocol SDK
// Agents use this to interact directly with DreamlineVerifier on BNB Chain
// NO server needed — pure on-chain interaction

const { ethers } = require('ethers');

const VERIFIER_ABI = [
  "function requestApproval(string destination, uint256 amountUsd) external payable returns (bytes32)",
  "function executePayment(bytes32 approvalId) external",
  "function isApproved(bytes32 approvalId) external view returns (bool)",
  "function getApprovalDetails(bytes32 approvalId) external view returns (tuple(address agent, string destination, uint256 amountUsd, uint256 timestamp, uint256 expiresAt, bool used))",
  "function getDailySpend(address agent) external view returns (uint256)",
  "function getFeeInfo() external view returns (bool enabled, uint256 feeBNB, address feesTreasury, uint256 totalCollected)",
  "event ApprovalGranted(bytes32 indexed approvalId, address indexed agent, string destination, uint256 amountUsd, uint256 expiresAt)",
  "event ApprovalDenied(address indexed agent, string destination, uint256 amountUsd, string reason)",
  "event ApprovalPending(bytes32 indexed approvalId, address indexed agent, string destination, uint256 amountUsd, string reason)"
];

const REGISTRY_ABI = [
  "function getPolicy(address agent) external view returns (tuple(uint256 dailyBudgetUsd, uint256 singleTxLimitUsd, uint256 approvalThresholdUsd, bool active, uint256 registeredAt, string erc8004TokenId, uint8 reputationTier))",
  "function isDestinationAllowed(string destination) external view returns (bool)",
  "function getDailySpend(address agent) external view returns (uint256)"
];

const DEFAULT_CONFIG = {
  rpc: 'https://bsc-testnet-rpc.publicnode.com',
  chainId: 97,
  verifierAddress: process.env.VERIFIER_ADDRESS || '0xd1ab68019566253773B9edf739939b7b8806Edb7',
  registryAddress: process.env.REGISTRY_ADDRESS || '0x71dA6F5b106E3Fb0B908C7e0720aa4452338B8BE'
};

/**
 * DreamlineSDK — interact directly with Dreamline Protocol on BNB Chain
 *
 * Usage:
 *   const sdk = new DreamlineSDK({ privateKey: '0x...' });
 *   const result = await sdk.requestApproval('api.coingecko.com', 100); // $1.00
 *   if (result.approved) {
 *     await sdk.executePayment(result.approvalId);
 *   }
 */
class DreamlineSDK {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = new ethers.JsonRpcProvider(this.config.rpc);

    if (this.config.privateKey) {
      this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);
    }

    this.verifier = new ethers.Contract(
      this.config.verifierAddress,
      VERIFIER_ABI,
      this.wallet || this.provider
    );

    this.registry = new ethers.Contract(
      this.config.registryAddress,
      REGISTRY_ABI,
      this.provider
    );
  }

  /**
   * Request approval for a payment — fully on-chain
   * @param {string} destination - Payment destination
   * @param {number} amountUsd - Amount in USD cents (e.g. 100 = $1.00)
   * @returns {object} { approved, pending, approvalId, txHash, error }
   */
  async requestApproval(destination, amountUsd) {
    if (!this.wallet) throw new Error('Private key required to request approval');

    try {
      // Check fee
      const feeInfo = await this.verifier.getFeeInfo();
      const value = feeInfo.enabled ? feeInfo.feeBNB : 0n;

      console.log(`[DreamlineSDK] Requesting approval: ${destination} $${amountUsd / 100}`);

      const tx = await this.verifier.requestApproval(destination, amountUsd, {
        value,
        gasLimit: 300000
      });

      console.log(`[DreamlineSDK] TX submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[DreamlineSDK] Confirmed in block: ${receipt.blockNumber}`);

      // Parse events
      for (const log of receipt.logs) {
        try {
          const parsed = this.verifier.interface.parseLog(log);

          if (parsed.name === 'ApprovalGranted') {
            const approvalId = parsed.args[0];
            console.log(`[DreamlineSDK] ✅ ApprovalGranted: ${approvalId}`);
            return {
              approved: true,
              pending: false,
              approvalId,
              destination: parsed.args[2],
              amountUsd: Number(parsed.args[3]),
              expiresAt: Number(parsed.args[4]),
              txHash: tx.hash,
              blockNumber: receipt.blockNumber
            };
          }

          if (parsed.name === 'ApprovalPending') {
            const approvalId = parsed.args[0];
            console.log(`[DreamlineSDK] ⏳ ApprovalPending: requires manual approval`);
            return {
              approved: false,
              pending: true,
              approvalId,
              reason: parsed.args[4],
              txHash: tx.hash
            };
          }

          if (parsed.name === 'ApprovalDenied') {
            console.log(`[DreamlineSDK] 🚫 ApprovalDenied: ${parsed.args[3]}`);
            return {
              approved: false,
              pending: false,
              denied: true,
              reason: parsed.args[3],
              txHash: tx.hash
            };
          }
        } catch { continue; }
      }

      return { approved: false, error: 'No approval event found', txHash: tx.hash };

    } catch (err) {
      console.error('[DreamlineSDK] requestApproval error:', err.message);

      // Parse revert reason
      const reason = err.message.includes('Exceeds single tx limit') ? 'Exceeds single tx limit' :
                     err.message.includes('Daily budget exceeded') ? 'Daily budget exceeded' :
                     err.message.includes('blacklisted') ? 'Destination blacklisted on-chain' :
                     err.message.includes('not registered') ? 'Agent not registered' :
                     err.message;

      return { approved: false, error: reason };
    }
  }

  /**
   * Execute a payment using an approvalId
   * @param {string} approvalId - The approvalId from requestApproval
   */
  async executePayment(approvalId) {
    if (!this.wallet) throw new Error('Private key required to execute payment');

    try {
      const isValid = await this.verifier.isApproved(approvalId);
      if (!isValid) return { success: false, error: 'Approval invalid or expired' };

      const tx = await this.verifier.executePayment(approvalId, { gasLimit: 200000 });
      const receipt = await tx.wait();

      console.log(`[DreamlineSDK] ✅ Payment executed: ${tx.hash}`);
      return { success: true, txHash: tx.hash, blockNumber: receipt.blockNumber };

    } catch (err) {
      console.error('[DreamlineSDK] executePayment error:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Check if an approvalId is still valid
   */
  async isApproved(approvalId) {
    try {
      return await this.verifier.isApproved(approvalId);
    } catch {
      return false;
    }
  }

  /**
   * Get agent policy from Registry
   */
  async getPolicy(agentAddress) {
    try {
      const policy = await this.registry.getPolicy(agentAddress);
      return {
        dailyBudgetUsd: Number(policy.dailyBudgetUsd) / 100,
        singleTxLimitUsd: Number(policy.singleTxLimitUsd) / 100,
        approvalThresholdUsd: Number(policy.approvalThresholdUsd) / 100,
        active: policy.active,
        reputationTier: Number(policy.reputationTier)
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * Check if destination is allowed
   */
  async isDestinationAllowed(destination) {
    try {
      return await this.registry.isDestinationAllowed(destination);
    } catch {
      return true;
    }
  }

  /**
   * Get daily spend for an agent
   */
  async getDailySpend(agentAddress) {
    try {
      const spend = await this.verifier.getDailySpend(agentAddress);
      return Number(spend) / 100;
    } catch {
      return 0;
    }
  }

  /**
   * Get protocol fee info
   */
  async getFeeInfo() {
    try {
      const info = await this.verifier.getFeeInfo();
      return {
        enabled: info.enabled,
        feeBNB: info.feeBNB.toString(),
        feeUSD: (Number(info.feeBNB) / 1e18 * 300).toFixed(6),
        treasury: info.feesTreasury,
        totalCollected: info.totalCollected.toString()
      };
    } catch {
      return null;
    }
  }
}

module.exports = { DreamlineSDK, DEFAULT_CONFIG };