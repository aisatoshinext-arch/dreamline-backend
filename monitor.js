// Dreamline On-Chain Monitor
// Monitors agent wallets on BNB Chain for unauthorized transactions

const { ethers } = require('ethers');
require('dotenv').config();

let provider;
let io;
let supabase;
let monitoringIntervals = {};
let isRunning = false;
let agentState = {}; // tracks txCount and balance per agent

function init(socketIO, supabaseClient) {
  io = socketIO;
  supabase = supabaseClient;
  provider = new ethers.JsonRpcProvider(
    process.env.BSC_TESTNET_RPC || 'https://bsc-testnet-rpc.publicnode.com'
  );
  console.log('[Monitor] On-chain monitor initialized');
}

async function getMonitoredAgents() {
  const { data, error } = await supabase
    .from('agents')
    .select('id, name, wallet_address, status, policies(*)')
    .eq('organization_id', '11111111-1111-1111-1111-111111111111')
    .not('wallet_address', 'is', null)
    .eq('status', 'active');

  if (error) {
    console.error('[Monitor] Error fetching agents:', error);
    return [];
  }
  return data || [];
}

async function monitorWallet(agent) {
  const walletAddress = agent.wallet_address;
  const policy = agent.policies?.[0];

  try {
    const txCount = await provider.getTransactionCount(walletAddress);
    const balance = await provider.getBalance(walletAddress);
    const balanceBNB = parseFloat(ethers.formatEther(balance));

    const prevState = agentState[agent.id];

    // Initialize state on first run
    if (!prevState) {
      agentState[agent.id] = { txCount, balanceBNB };
      console.log(`[Monitor] ${agent.name} — wallet: ${walletAddress} — balance: ${balanceBNB} BNB — txCount: ${txCount}`);
      return;
    }

    console.log(`[Monitor] ${agent.name} — wallet: ${walletAddress} — balance: ${balanceBNB} BNB — txCount: ${txCount}`);

    // Detect new outgoing transaction
    if (txCount > prevState.txCount && balanceBNB < prevState.balanceBNB) {
      const amountBNB = prevState.balanceBNB - balanceBNB;
      const amountUSD = amountBNB * 300;
      const newTxCount = txCount - prevState.txCount;

      console.log(`[Monitor] 🔍 Detected ${newTxCount} new tx(s) from ${agent.name}: ~${amountBNB.toFixed(6)} BNB (~$${amountUSD.toFixed(2)})`);

      // Get the actual transaction details
      let destination = 'unknown';
      let txHash = 'unknown';

      try {
        // Get latest transaction
        const latestBlock = await provider.getBlockNumber();
        for (let i = 0; i <= 20; i++) {
          const block = await provider.getBlock(latestBlock - i, true);
          if (!block?.transactions) continue;

          for (const tx of block.transactions) {
            if (typeof tx === 'string') continue;
            if (tx.from?.toLowerCase() !== walletAddress.toLowerCase()) continue;
            if (tx.value === 0n) continue;

            destination = tx.to || 'unknown';
            txHash = tx.hash;
            break;
          }
          if (txHash !== 'unknown') break;
        }
      } catch (err) {
        console.error('[Monitor] Error getting tx details:', err.message);
      }

      console.log(`[Monitor] 🚨 UNAUTHORIZED TX DETECTED: ${agent.name} sent ${amountBNB.toFixed(6)} BNB to ${destination} WITHOUT Dreamline approval`);

      // Record unauthorized transaction
      await supabase.from('transactions').insert({
        agent_id: agent.id,
        organization_id: '11111111-1111-1111-1111-111111111111',
        amount_usd: amountUSD,
        destination,
        payment_rail: 'onchain-direct',
        task_description: `🚨 BYPASS DETECTED — on-chain tx without Dreamline approval. TX: ${txHash}`,
        status: 'blocked',
        block_reason: `On-chain bypass: agent sent ${amountBNB.toFixed(6)} BNB directly without Dreamline`
      });

      // Generate critical alert
      await supabase.from('alerts').insert({
        organization_id: '11111111-1111-1111-1111-111111111111',
        agent_id: agent.id,
        type: 'policy_violation',
        message: `🚨 BYPASS DETECTED: ${agent.name} sent $${amountUSD.toFixed(2)} on-chain WITHOUT Dreamline approval. TX: ${txHash}`,
        resolved: false
      });

      // Suspend agent immediately
      await supabase.from('agents').update({ status: 'suspended' }).eq('id', agent.id);
      console.log(`[Monitor] ⛔ Agent ${agent.name} SUSPENDED`);

      // Emit real-time events
      if (io) {
        io.emit('onchain_bypass_detected', {
          timestamp: new Date().toISOString(),
          agent_name: agent.name,
          agent_id: agent.id,
          wallet: walletAddress,
          amount_bnb: amountBNB,
          amount_usd: amountUSD,
          destination,
          tx_hash: txHash,
          message: `BYPASS: ${agent.name} sent ${amountBNB.toFixed(6)} BNB directly on-chain without Dreamline`
        });

        io.emit('anomaly_detected', {
          type: 'onchain_bypass',
          severity: 'critical',
          agent_id: agent.id,
          destination,
          message: `🚨 BYPASS DETECTED: ${agent.name} sent $${amountUSD.toFixed(2)} without Dreamline — agent SUSPENDED`,
          risk_score: 100
        });

        io.emit('agent_event', {
          timestamp: new Date().toISOString(),
          agent_name: agent.name,
          task: 'UNAUTHORIZED on-chain payment',
          destination,
          amount: amountUSD,
          payment_rail: 'onchain-direct',
          status: 'blocked',
          blocked: true,
          block_reason: 'On-chain bypass detected — agent suspended'
        });
      }
    }

    // Update state
    agentState[agent.id] = { txCount, balanceBNB };

  } catch (err) {
    console.error(`[Monitor] Error monitoring ${agent.name}:`, err.message);
  }
}

async function startMonitoring() {
  if (isRunning) return { running: true, message: 'Monitor already running' };

  isRunning = true;
  agentState = {}; // reset state
  console.log('[Monitor] Starting on-chain monitoring...');

  // Initial check to set baseline state
  const agents = await getMonitoredAgents();
  console.log(`[Monitor] Initial check of ${agents.length} agent wallets`);
  for (const agent of agents) {
    await monitorWallet(agent);
  }

  // Monitor every 15 seconds
  const interval = setInterval(async () => {
    const agents = await getMonitoredAgents();
    console.log(`[Monitor] Checking ${agents.length} agent wallets...`);
    for (const agent of agents) {
      await monitorWallet(agent);
    }
  }, 15000);

  monitoringIntervals['main'] = interval;

  return {
    running: true,
    message: `Monitoring ${agents.length} agent wallets on BNB Chain`,
    agents: agents.map(a => ({ name: a.name, wallet: a.wallet_address }))
  };
}

function stopMonitoring() {
  if (monitoringIntervals['main']) {
    clearInterval(monitoringIntervals['main']);
    delete monitoringIntervals['main'];
  }
  isRunning = false;
  agentState = {};
  console.log('[Monitor] On-chain monitoring stopped');
  return { running: false, message: 'Monitor stopped' };
}

async function getStatus() {
  const agents = await getMonitoredAgents();
  return {
    running: isRunning,
    monitored_agents: agents.map(a => ({
      name: a.name,
      wallet: a.wallet_address,
      status: a.status,
      current_state: agentState[a.id] || null
    })),
    network: 'BNB Chain Testnet',
    check_interval: '15 seconds'
  };
}

module.exports = {
  init,
  startMonitoring,
  stopMonitoring,
  getStatus,
  monitorWallet
};