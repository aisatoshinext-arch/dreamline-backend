// Dreamline Graph Module
// Replaces slow blockchain queries with fast GraphQL queries via The Graph
// Response time: <100ms instead of 5-30 seconds

const GRAPH_ENDPOINT = 'https://api.studio.thegraph.com/query/1744630/dreamline-protocol/v0.0.1';

async function query(graphqlQuery, variables = {}) {
  try {
    const res = await fetch(GRAPH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: graphqlQuery, variables })
    });
    const data = await res.json();
    if (data.errors) {
      console.error('[Graph] Query errors:', data.errors);
      return null;
    }
    return data.data;
  } catch (err) {
    console.error('[Graph] Query failed:', err.message);
    return null;
  }
}

async function getRecentApprovals(limit = 20) {
  const data = await query(`{
    approvalGranteds(first: ${limit}, orderBy: blockTimestamp, orderDirection: desc) {
      id
      approvalId
      agent
      destination
      amountUsd
      expiresAt
      blockNumber
      blockTimestamp
      transactionHash
    }
  }`);
  return data?.approvalGranteds || [];
}

async function getRecentDenials(limit = 20) {
  const data = await query(`{
    approvalDenieds(first: ${limit}, orderBy: blockTimestamp, orderDirection: desc) {
      id
      agent
      destination
      amountUsd
      reason
      blockNumber
      blockTimestamp
      transactionHash
    }
  }`);
  return data?.approvalDenieds || [];
}

async function getRecentPending(limit = 20) {
  const data = await query(`{
    approvalPendings(first: ${limit}, orderBy: blockTimestamp, orderDirection: desc) {
      id
      approvalId
      agent
      destination
      amountUsd
      reason
      blockNumber
      blockTimestamp
      transactionHash
    }
  }`);
  return data?.approvalPendings || [];
}

async function getRecentUsed(limit = 20) {
  const data = await query(`{
    approvalUseds(first: ${limit}, orderBy: blockTimestamp, orderDirection: desc) {
      id
      approvalId
      agent
      destination
      amountUsd
      blockNumber
      blockTimestamp
      transactionHash
    }
  }`);
  return data?.approvalUseds || [];
}

async function getStats() {
  const data = await query(`{
    approvalGranteds(first: 1000, orderBy: blockTimestamp, orderDirection: desc) {
      approvalId
      agent
      destination
      amountUsd
      blockNumber
      blockTimestamp
      transactionHash
    }
    approvalDenieds(first: 1000, orderBy: blockTimestamp, orderDirection: desc) {
      agent
      destination
      amountUsd
      reason
      blockNumber
      blockTimestamp
      transactionHash
    }
    approvalUseds(first: 1000) {
      amountUsd
    }
    approvalPendings(first: 1000) {
      amountUsd
    }
  }`);

  if (!data) return null;

  const granted = data.approvalGranteds || [];
  const denied = data.approvalDenieds || [];
  const used = data.approvalUseds || [];
  const pending = data.approvalPendings || [];

  const totalVolumeUsd = granted.reduce((sum, e) => sum + Number(e.amountUsd) / 100, 0);
  const blockedVolumeUsd = denied.reduce((sum, e) => sum + Number(e.amountUsd) / 100, 0);

  const recentEvents = [
    ...granted.slice(0, 10).map(e => ({
      type: 'ApprovalGranted',
      agent: e.agent,
      destination: e.destination,
      amountUsd: Number(e.amountUsd) / 100,
      blockNumber: Number(e.blockNumber),
      blockTimestamp: Number(e.blockTimestamp),
      txHash: e.transactionHash
    })),
    ...denied.slice(0, 10).map(e => ({
      type: 'ApprovalDenied',
      agent: e.agent,
      destination: e.destination,
      amountUsd: Number(e.amountUsd) / 100,
      reason: e.reason,
      blockNumber: Number(e.blockNumber),
      blockTimestamp: Number(e.blockTimestamp),
      txHash: e.transactionHash
    }))
  ].sort((a, b) => b.blockTimestamp - a.blockTimestamp).slice(0, 20);

  return {
    totalApprovals: granted.length,
    totalDenied: denied.length,
    totalUsed: used.length,
    totalPending: pending.length,
    totalVolumeUsd: totalVolumeUsd.toFixed(2),
    blockedVolumeUsd: blockedVolumeUsd.toFixed(2),
    savedByDreamline: blockedVolumeUsd.toFixed(2),
    recentEvents
  };
}

async function getAgentHistory(agentAddress, limit = 50) {
  const addr = agentAddress.toLowerCase();
  const data = await query(`{
    approvalGranteds(
      first: ${limit}
      where: { agent: "${addr}" }
      orderBy: blockTimestamp
      orderDirection: desc
    ) {
      approvalId
      destination
      amountUsd
      blockNumber
      blockTimestamp
      transactionHash
    }
    approvalDenieds(
      first: ${limit}
      where: { agent: "${addr}" }
      orderBy: blockTimestamp
      orderDirection: desc
    ) {
      destination
      amountUsd
      reason
      blockNumber
      blockTimestamp
      transactionHash
    }
  }`);

  if (!data) return [];

  return [
    ...(data.approvalGranteds || []).map(e => ({
      type: 'ApprovalGranted',
      destination: e.destination,
      amountUsd: Number(e.amountUsd) / 100,
      blockNumber: Number(e.blockNumber),
      timestamp: Number(e.blockTimestamp),
      txHash: e.transactionHash
    })),
    ...(data.approvalDenieds || []).map(e => ({
      type: 'ApprovalDenied',
      destination: e.destination,
      amountUsd: Number(e.amountUsd) / 100,
      reason: e.reason,
      blockNumber: Number(e.blockNumber),
      timestamp: Number(e.blockTimestamp),
      txHash: e.transactionHash
    }))
  ].sort((a, b) => b.timestamp - a.timestamp);
}

module.exports = {
  getRecentApprovals,
  getRecentDenials,
  getRecentPending,
  getRecentUsed,
  getStats,
  getAgentHistory,
  GRAPH_ENDPOINT
};