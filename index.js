const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const agent = require('./agent');
const erc8004 = require('./erc8004');
const ai = require('./ai');
const crypto = require('crypto');
const signing = require('./signing');
const blockchain = require('./blockchain');
const monitor = require('./monitor');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ['https://dreamline-jade.vercel.app', 'https://dreamline-backend.onrender.com', 'http://localhost:3000', 'http://localhost:3001'], methods: ['GET', 'POST'] }
});

agent.setIO(io);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

monitor.init(io, supabase);

app.use(cors({
  origin: ['https://dreamline-jade.vercel.app', 'https://dreamline-backend.onrender.com', 'http://localhost:3000', 'http://localhost:3001'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Dreamline-Key']
}));
app.use(express.json());

// Auth middleware - sets req.org_id from API key
app.use(async (req, res, next) => {
  const apiKey = req.headers['x-dreamline-key'];
  if (apiKey) {
    const { data } = await supabase
      .from('agent_api_keys')
      .select('organization_id')
      .eq('api_key', apiKey)
      .single();
    if (data) req.org_id = data.organization_id;
  }
  if (!req.org_id) req.org_id = null;
  next();
});


io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected:', socket.id);
  });
});

// ============================================================
// MONITOR ENDPOINTS
// ============================================================

app.post('/monitor/start', async (req, res) => {
  const result = await monitor.startMonitoring();
  res.json(result);
});

app.post('/monitor/stop', (req, res) => {
  const result = monitor.stopMonitoring();
  res.json(result);
});

app.get('/monitor/status', async (req, res) => {
  const status = await monitor.getStatus();
  res.json(status);
});

// ============================================================
// BLOCKCHAIN ENDPOINTS — On-chain registry + event indexer
// ============================================================

app.get('/blockchain/info', async (req, res) => {
  const info = await blockchain.getContractInfo();
  if (!info) return res.status(500).json({ error: 'Could not connect to blockchain' });
  res.json(info);
});

app.get('/blockchain/blacklist', async (req, res) => {
  const destinations = await blockchain.getBlacklistedDestinations();
  res.json({ destinations, count: destinations.length });
});

app.get('/blockchain/policy/:address', async (req, res) => {
  const policy = await blockchain.getAgentPolicy(req.params.address);
  if (!policy) return res.status(404).json({ error: 'Agent not found on-chain' });
  res.json(policy);
});

app.get('/blockchain/events', async (req, res) => {
  const blocksBack = parseInt(req.query.blocks) || 50000;
  const events = await blockchain.getRecentApprovalEvents(blocksBack);
  res.json({ events, count: events.length });
});

app.get('/blockchain/stats', async (req, res) => {
  const blocksBack = parseInt(req.query.blocks) || 5000;
  const stats = await blockchain.getOnChainStats(blocksBack);
  if (!stats) return res.status(500).json({ error: 'Could not fetch stats from The Graph' });
  res.json(stats);
});

app.get('/blockchain/fee', async (req, res) => {
  const fee = await blockchain.getVerifierFeeInfo();
  if (!fee) return res.status(500).json({ error: 'Could not fetch fee info' });
  res.json(fee);
});

app.post('/blockchain/manual-approve', async (req, res) => {
  const { approvalId } = req.body;
  if (!approvalId) return res.status(400).json({ error: 'approvalId required' });
  const result = await blockchain.manualApproveOnChain(approvalId);
  res.json(result);
});

app.post('/blockchain/manual-reject', async (req, res) => {
  const { approvalId, reason } = req.body;
  if (!approvalId) return res.status(400).json({ error: 'approvalId required' });
  const result = await blockchain.manualRejectOnChain(approvalId, reason || 'Rejected by operator');
  res.json(result);
});

app.get('/blockchain/circuit-breaker/:address', async (req, res) => {
  const status = await blockchain.getCircuitBreakerStatus(req.params.address);
  if (!status) return res.status(500).json({ error: 'Could not fetch circuit breaker status' });
  res.json(status);
});

app.post('/blockchain/circuit-breaker/:address/reset', async (req, res) => {
  const result = await blockchain.resetCircuitBreakerOnChain(req.params.address);
  res.json(result);
});

// ============================================================
// SIGNING ENDPOINTS
// ============================================================

app.get('/signing/address', (req, res) => {
  res.json({
    signer_address: signing.getSignerAddress(),
    network: 'All EVM chains',
    description: 'Dreamline public key — use this in your smart contract to verify signatures'
  });
});

app.get('/signing/contract', (req, res) => {
  const signerAddress = signing.getSignerAddress();
  const contract = signing.getSolidityContract(signerAddress);
  res.json({ contract, signer_address: signerAddress });
});

app.post('/proxy/approve', async (req, res) => {
  const apiKey = req.headers['x-dreamline-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Dreamline-Key header' });

  const { data: keyData } = await supabase
    .from('agent_api_keys')
    .select('*, agents(*)')
    .eq('api_key', apiKey)
    .single();

  if (!keyData) return res.status(401).json({ error: 'Invalid API key' });

  const agent_id = keyData.agent_id;
  const { amount_usd, destination, task_description, payment_rail, chain_id } = req.body;

  if (!amount_usd || !destination) {
    return res.status(400).json({ error: 'amount_usd and destination are required' });
  }

  const onChainAllowed = await blockchain.isDestinationAllowed(destination);
  if (!onChainAllowed) {
    return res.status(403).json({
      approved: false, blocked: true,
      block_reason: 'On-chain blacklist: destination blocked by DreamlineRegistry on BNB Chain',
      signature: null, onchain: true
    });
  }

  const blacklistCheck = await ai.checkGlobalBlacklist(destination);
  if (blacklistCheck.blacklisted) {
    return res.status(403).json({
      approved: false, blocked: true,
      block_reason: `Global blacklist: ${blacklistCheck.reason}`,
      signature: null
    });
  }

  const { data: policy } = await supabase.from('policies').select('*').eq('agent_id', agent_id).single();
  if (!policy) return res.status(404).json({ error: 'Policy not found' });

  const today = new Date().toISOString().split('T')[0];
  const { data: todayTxs } = await supabase.from('transactions').select('amount_usd').eq('agent_id', agent_id).eq('status', 'approved').gte('created_at', today);
  const spentToday = todayTxs?.reduce((sum, t) => sum + parseFloat(t.amount_usd), 0) || 0;

  let blocked = false;
  let block_reason = null;

  if (policy.whitelist_destinations?.length > 0 && !policy.whitelist_destinations.includes(destination)) {
    blocked = true;
    block_reason = `Unauthorized destination: ${destination}`;
  }
  if (!blocked && parseFloat(amount_usd) > policy.single_tx_limit_usd) {
    blocked = true;
    block_reason = `Amount $${amount_usd} exceeds single tx limit of $${policy.single_tx_limit_usd}`;
  }
  if (!blocked && (spentToday + parseFloat(amount_usd)) > policy.daily_budget_usd) {
    blocked = true;
    block_reason = `Daily budget exceeded`;
  }

  if (blocked) {
    await supabase.from('audit_log').insert({
      organization_id: req.org_id,
      user_email: 'dreamline-signer',
      action: 'signature_denied',
      entity_type: 'transaction',
      entity_id: agent_id,
      new_value: { destination, amount_usd, block_reason }
    });
    return res.status(403).json({
      approved: false, blocked: true, block_reason,
      signature: null, message: 'Dreamline refused to sign this transaction'
    });
  }

  const signatureData = await signing.signPaymentApproval({
    agent_id, destination, amount_usd,
    payment_rail: payment_rail || 'x402',
    chain_id: chain_id || 97
  });

  await supabase.from('audit_log').insert({
    organization_id: req.org_id,
    user_email: 'dreamline-signer',
    action: 'signature_issued',
    entity_type: 'transaction',
    entity_id: agent_id,
    new_value: {
      destination, amount_usd,
      signature: signatureData.signature.slice(0, 20) + '...',
      expires_at: signatureData.expires_at, chain_id
    }
  });

  res.json({
    approved: true,
    signature: signatureData.signature,
    signer: signatureData.signer,
    message: signatureData.message,
    domain: signatureData.domain,
    expires_at: signatureData.expires_at,
    chain_id: signatureData.chain_id,
    instructions: 'Include this signature in your smart contract call to executePayment()'
  });
});

app.post('/signing/verify', (req, res) => {
  const { signature, message, domain } = req.body;
  const result = signing.verifySignature({ signature, message, domain });
  res.json(result);
});

// ============================================================
// PROXY ENDPOINTS
// ============================================================

app.post('/proxy/register', async (req, res) => {
  const { name, description, owner_email, erc8004_token_id, daily_budget_usd, single_tx_limit_usd, require_approval_above_usd, whitelist_destinations } = req.body;

  if (!name || !owner_email) {
    return res.status(400).json({ error: 'name and owner_email are required' });
  }

  let erc8004_data = { verified: false, reputation_score: 0, chain: null, owner: null };
  if (erc8004_token_id) {
    const verification = await erc8004.verifyToken(erc8004_token_id);
    if (verification.verified) {
      erc8004_data = { verified: true, reputation_score: verification.reputation_score, chain: verification.chain, owner: verification.owner };
    }
  }

  const { data: agentData, error: agentError } = await supabase
    .from('agents')
    .insert({
      organization_id: req.org_id,
      name, description, owner_email, status: 'active',
      erc8004_token_id: erc8004_token_id || null,
      erc8004_chain: erc8004_data.chain,
      erc8004_verified: erc8004_data.verified,
      reputation_score: erc8004_data.reputation_score,
      erc8004_owner: erc8004_data.owner
    })
    .select()
    .single();

  if (agentError) return res.status(500).json({ error: agentError });

  const destinations = typeof whitelist_destinations === 'string'
    ? whitelist_destinations.split('\n').map(s => s.trim()).filter(Boolean)
    : (whitelist_destinations || []);

  const reputationPolicy = erc8004.getPolicyFromReputation(erc8004_data.reputation_score);

  await supabase.from('policies').insert({
    agent_id: agentData.id,
    daily_budget_usd: parseFloat(daily_budget_usd || 100) * reputationPolicy.daily_budget_multiplier,
    single_tx_limit_usd: parseFloat(single_tx_limit_usd || 10),
    require_approval_above_usd: Math.min(parseFloat(require_approval_above_usd || 25), reputationPolicy.require_approval_threshold),
    whitelist_destinations: destinations
  });

  const api_key = `dlk_live_${crypto.randomBytes(16).toString('hex')}`;

  await supabase.from('agent_api_keys').insert({
    agent_id: agentData.id,
    organization_id: req.org_id,
    api_key,
    name: `${name} API Key`
  });

  res.json({
    success: true,
    agent_id: agentData.id,
    api_key,
    policy_tier: reputationPolicy.tier,
    message: 'Agent registered. Use this API key in your agent X-Dreamline-Key header.'
  });
});

app.post('/proxy/pay', async (req, res) => {
  const apiKey = req.headers['x-dreamline-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Dreamline-Key header' });

  const { data: keyData, error: keyError } = await supabase
    .from('agent_api_keys')
    .select('*, agents(*)')
    .eq('api_key', apiKey)
    .single();

  if (keyError || !keyData) return res.status(401).json({ error: 'Invalid or inactive API key' });

  await supabase.from('agent_api_keys').update({ last_used_at: new Date().toISOString() }).eq('api_key', apiKey);

  const agent_id = keyData.agent_id;
  const { amount_usd, destination, task_description, payment_rail } = req.body;

  if (!amount_usd || !destination) return res.status(400).json({ error: 'amount_usd and destination are required' });

  const onChainAllowed = await blockchain.isDestinationAllowed(destination);
  if (!onChainAllowed) {
    const { data: tx } = await supabase.from('transactions').insert({
      agent_id,
      organization_id: req.org_id,
      amount_usd: parseFloat(amount_usd),
      destination, payment_rail: payment_rail || 'x402',
      task_description: task_description || 'Payment request',
      status: 'blocked',
      block_reason: 'On-chain blacklist: blocked by DreamlineRegistry on BNB Chain'
    }).select().single();

    io.emit('agent_event', {
      timestamp: new Date().toISOString(),
      agent_name: keyData.agents.name,
      task: task_description || 'Payment request',
      destination, amount: parseFloat(amount_usd),
      payment_rail: payment_rail || 'x402',
      status: 'blocked', blocked: true,
      block_reason: 'On-chain blacklist'
    });

    return res.status(403).json({
      approved: false, blocked: true,
      block_reason: 'On-chain blacklist: blocked by DreamlineRegistry on BNB Chain',
      transaction_id: tx?.id, onchain: true
    });
  }

  const blacklistCheck = await ai.checkGlobalBlacklist(destination);
  if (blacklistCheck.blacklisted) {
    const { data: tx } = await supabase.from('transactions').insert({
      agent_id,
      organization_id: req.org_id,
      amount_usd: parseFloat(amount_usd),
      destination, payment_rail: payment_rail || 'x402',
      task_description: task_description || 'Payment request',
      status: 'blocked',
      block_reason: `Global blacklist: ${blacklistCheck.reason}`
    }).select().single();

    await supabase.from('alerts').insert({
      organization_id: req.org_id,
      agent_id, type: 'policy_violation',
      message: `Global blacklist hit: ${destination}`, resolved: false
    });

    io.emit('agent_event', {
      timestamp: new Date().toISOString(),
      agent_name: keyData.agents.name,
      task: task_description || 'Payment request',
      destination, amount: parseFloat(amount_usd),
      payment_rail: payment_rail || 'x402',
      status: 'blocked', blocked: true,
      block_reason: 'Global blacklist hit'
    });

    return res.status(403).json({
      approved: false, blocked: true,
      block_reason: `Global blacklist: ${blacklistCheck.reason}`,
      transaction_id: tx?.id
    });
  }

  const anomalyResult = await ai.detectAnomalies(agent_id, amount_usd, destination);
  if (anomalyResult.risk_score >= 50) {
    io.emit('anomaly_detected', {
      type: 'behavioral',
      severity: anomalyResult.risk_score >= 75 ? 'critical' : 'warning',
      agent_id, destination,
      risk_score: anomalyResult.risk_score,
      anomalies: anomalyResult.anomalies,
      message: anomalyResult.anomalies[0]?.message
    });
  }

  const { data: policy } = await supabase.from('policies').select('*').eq('agent_id', agent_id).single();
  // policy can be null - will use defaults

  const today = new Date().toISOString().split('T')[0];
  const { data: todayTxs } = await supabase.from('transactions').select('amount_usd').eq('agent_id', agent_id).eq('status', 'approved').gte('created_at', today);
  const spentToday = todayTxs?.reduce((sum, t) => sum + parseFloat(t.amount_usd), 0) || 0;

  let blocked = false;
  let block_reason = null;

  if (policy?.whitelist_destinations?.length > 0 && !policy.whitelist_destinations.includes(destination)) {
    blocked = true;
    block_reason = `Unauthorized destination: ${destination}`;
    await ai.addToGlobalBlacklist(destination, 'Policy violation');
  }
  if (!blocked && policy && parseFloat(amount_usd) > policy.single_tx_limit_usd) {
    blocked = true;
    block_reason = `Amount $${amount_usd} exceeds single tx limit of $${policy.single_tx_limit_usd}`;
  }
  if (!blocked && policy && (spentToday + parseFloat(amount_usd)) > policy.daily_budget_usd) {
    blocked = true;
    block_reason = `Daily budget exceeded: $${spentToday} already spent of $${policy.daily_budget_usd}`;
  }

  const status = blocked ? 'blocked' : (policy && parseFloat(amount_usd) > policy.require_approval_above_usd ? 'pending_approval' : 'approved');

  const { data: tx } = await supabase.from('transactions').insert({
    agent_id,
    organization_id: req.org_id,
    amount_usd: parseFloat(amount_usd),
    destination, payment_rail: payment_rail || 'x402',
    task_description: task_description || 'Payment request',
    status, block_reason
  }).select().single();

  if (blocked) {
    await supabase.from('alerts').insert({
      organization_id: req.org_id,
      agent_id, type: 'policy_violation',
      message: block_reason, resolved: false
    });
  }

  io.emit('agent_event', {
    timestamp: new Date().toISOString(),
    agent_name: keyData.agents.name,
    task: task_description || 'Payment request',
    destination, amount: parseFloat(amount_usd),
    payment_rail: payment_rail || 'x402',
    status, blocked, block_reason
  });

  if (blocked) return res.status(403).json({ approved: false, blocked: true, block_reason, transaction_id: tx?.id, anomalies: anomalyResult.anomalies });
  if (status === 'pending_approval') return res.status(202).json({ approved: false, pending: true, transaction_id: tx?.id, message: 'Transaction requires manual approval' });

  res.json({ approved: true, transaction_id: tx?.id, amount_usd: parseFloat(amount_usd), destination, message: 'Payment authorized by Dreamline' });
});

app.get('/proxy/status', async (req, res) => {
  const apiKey = req.headers['x-dreamline-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-Dreamline-Key header' });

  const { data: keyData } = await supabase
    .from('agent_api_keys')
    .select('*, agents(*, policies(*))')
    .eq('api_key', apiKey)
    .single();

  if (!keyData) return res.status(401).json({ error: 'Invalid API key' });

  const policy = keyData.agents?.policies?.[0];
  res.json({
    agent: keyData.agents.name,
    status: keyData.agents.status,
    policy: {
      daily_budget_usd: policy?.daily_budget_usd,
      single_tx_limit_usd: policy?.single_tx_limit_usd,
      require_approval_above_usd: policy?.require_approval_above_usd,
      whitelist_destinations: policy?.whitelist_destinations
    },
    erc8004_verified: keyData.agents.erc8004_verified,
    reputation_score: keyData.agents.reputation_score
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Dreamline backend running' });
});

app.post('/verify-erc8004', async (req, res) => {
  const { token_id } = req.body;
  const result = await erc8004.verifyToken(token_id);
  if (result.verified) {
    const policy = erc8004.getPolicyFromReputation(result.reputation_score);
    res.json({ ...result, policy });
  } else {
    res.json(result);
  }
});

app.get('/ai/blacklist', async (req, res) => {
  const blacklist = await ai.getGlobalBlacklist();
  res.json(blacklist);
});

app.get('/ai/suggestions/:agent_id', async (req, res) => {
  const suggestions = await ai.getPolicySuggestions(req.params.agent_id);
  res.json(suggestions);
});

app.post('/ai/suggestions/:agent_id/generate', async (req, res) => {
  const { current_policy } = req.body;
  const suggestions = await ai.generatePolicySuggestions(
    req.params.agent_id,
    req.org_id,
    current_policy
  );
  res.json(suggestions);
});

app.put('/ai/suggestions/:suggestion_id/accept', async (req, res) => {
  const result = await ai.acceptSuggestion(req.params.suggestion_id);
  res.json(result);
});


// Helper: get organization_id from API key
async function getOrgFromKey(req) {
  const apiKey = req.headers['x-dreamline-key'];
  if (!apiKey) return null;
  const { data } = await supabase
    .from('agent_api_keys')
    .select('organization_id')
    .eq('api_key', apiKey)
    .single();
  return data?.organization_id || null;
}

app.get('/agents', async (req, res) => {
  if (!req.org_id) return res.json([]);
  const { data, error } = await supabase
    .from('agents')
    .select('*, policies (*), transactions (*)')
    .eq('organization_id', req.org_id);
  if (error) return res.status(500).json({ error });
  res.json(data || []);
});

app.get('/agents/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('agents')
    .select('*, policies (*)')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(500).json({ error });
  res.json(data || []);
});

app.post('/agents', async (req, res) => {
  const { name, description, owner_email, daily_budget_usd, single_tx_limit_usd, require_approval_above_usd, whitelist_destinations, erc8004_token_id } = req.body;
  let erc8004_data = { verified: false, reputation_score: 0, chain: null, owner: null };
  if (erc8004_token_id) {
    const verification = await erc8004.verifyToken(erc8004_token_id);
    if (verification.verified) {
      erc8004_data = { verified: true, reputation_score: verification.reputation_score, chain: verification.chain, owner: verification.owner };
    }
  }
  const { data: agentData, error: agentError } = await supabase
    .from('agents')
    .insert({
      organization_id: req.org_id,
      name, description, owner_email, status: 'active',
      erc8004_token_id: erc8004_token_id || null,
      erc8004_chain: erc8004_data.chain,
      erc8004_verified: erc8004_data.verified,
      reputation_score: erc8004_data.reputation_score,
      erc8004_owner: erc8004_data.owner
    })
    .select()
    .single();
  if (agentError) return res.status(500).json({ error: agentError });
  const destinations = typeof whitelist_destinations === 'string'
    ? whitelist_destinations.split('\n').map(s => s.trim()).filter(Boolean)
    : whitelist_destinations;
  const reputationPolicy = erc8004.getPolicyFromReputation(erc8004_data.reputation_score);
  await supabase.from('policies').insert({
    agent_id: agentData.id,
    daily_budget_usd: parseFloat(daily_budget_usd) * reputationPolicy.daily_budget_multiplier,
    single_tx_limit_usd: parseFloat(single_tx_limit_usd),
    require_approval_above_usd: Math.min(parseFloat(require_approval_above_usd), reputationPolicy.require_approval_threshold),
    whitelist_destinations: destinations
  });
  res.json({ success: true, agent: agentData, erc8004: erc8004_data, policy_tier: reputationPolicy.tier });
});

app.put('/agents/:id/policy', async (req, res) => {
  const { daily_budget_usd, single_tx_limit_usd, require_approval_above_usd, whitelist_destinations, status } = req.body;
  if (status) {
    await supabase.from('agents').update({ status }).eq('id', req.params.id);
  }
  const { data, error } = await supabase
    .from('policies')
    .update({
      daily_budget_usd: parseFloat(daily_budget_usd),
      single_tx_limit_usd: parseFloat(single_tx_limit_usd),
      require_approval_above_usd: parseFloat(require_approval_above_usd),
      whitelist_destinations,
      updated_at: new Date().toISOString()
    })
    .eq('agent_id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  await supabase.from('audit_log').insert({
    organization_id: req.org_id,
    user_email: 'admin@acme.com',
    action: 'policy_updated',
    entity_type: 'policy',
    entity_id: req.params.id,
    new_value: req.body
  });
  res.json({ success: true, policy: data });
});

app.get('/transactions', async (req, res) => {
  const { agent_id, status } = req.query;
  let query = supabase
    .from('transactions')
    .select('*, agents(name)')
    .eq('organization_id', req.org_id)
    .order('created_at', { ascending: false });
  if (agent_id) query = query.eq('agent_id', agent_id);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error });
  res.json(data || []);
});

app.put('/transactions/:id/approve', async (req, res) => {
  const { data, error } = await supabase
    .from('transactions')
    .update({ status: 'approved' })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  await supabase.from('audit_log').insert({
    organization_id: req.org_id,
    user_email: 'admin@acme.com',
    action: 'transaction_approved',
    entity_type: 'transaction',
    entity_id: req.params.id,
    new_value: { status: 'approved' }
  });
  res.json({ success: true, transaction: data });
});

app.put('/transactions/:id/reject', async (req, res) => {
  const { data, error } = await supabase
    .from('transactions')
    .update({ status: 'blocked', block_reason: 'Rejected manually by operator' })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  await supabase.from('audit_log').insert({
    organization_id: req.org_id,
    user_email: 'admin@acme.com',
    action: 'transaction_rejected',
    entity_type: 'transaction',
    entity_id: req.params.id,
    new_value: { status: 'blocked' }
  });
  res.json({ success: true, transaction: data });
});

app.get('/alerts', async (req, res) => {
  if (!req.org_id) return res.json([]);
  const { data, error } = await supabase
    .from('alerts')
    .select('*, agents(name)')
    .eq('organization_id', req.org_id)
    .eq('resolved', false)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data || []);
});

app.put('/alerts/:id/resolve', async (req, res) => {
  const { error } = await supabase
    .from('alerts')
    .update({ resolved: true })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error });
  res.json({ success: true });
});

app.get('/overview', async (req, res) => {
  const { data: transactions, error } = await supabase
    .from('transactions')
    .select('id, amount_usd, status, agent_id, created_at, agents(name)')
    .eq('organization_id', req.org_id);
  if (error) return res.status(500).json({ error });
  const total = transactions.reduce((sum, t) => sum + parseFloat(t.amount_usd), 0);
  res.json({
    total_spent: total.toFixed(2),
    total_transactions: transactions.length,
    approved_count: transactions.filter(t => t.status === 'approved').length,
    blocked_count: transactions.filter(t => t.status === 'blocked').length,
    pending_count: transactions.filter(t => t.status === 'pending_approval').length,
    transactions
  });
});

app.get('/chart', async (req, res) => {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    days.push(date.toISOString().split('T')[0]);
  }
  const { data: transactions, error } = await supabase
    .from('transactions')
    .select('amount_usd, status, created_at')
    .eq('organization_id', req.org_id)
    .gte('created_at', days[0]);
  if (error) return res.status(500).json({ error });
  const chartData = days.map(day => {
    const dayTxs = transactions.filter(t => t.created_at.startsWith(day));
    const approved = dayTxs.filter(t => t.status === 'approved').reduce((sum, t) => sum + parseFloat(t.amount_usd), 0);
    const blocked = dayTxs.filter(t => t.status === 'blocked').reduce((sum, t) => sum + parseFloat(t.amount_usd), 0);
    const label = new Date(day).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
    return { day: label, approvate: parseFloat(approved.toFixed(2)), bloccate: parseFloat(blocked.toFixed(2)) };
  });
  res.json(chartData);
});

app.get('/audit', async (req, res) => {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .eq('organization_id', req.org_id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error });
  res.json(data || []);
});

app.post('/agent/start', (req, res) => {
  const result = agent.start();
  res.json(result);
});

app.post('/agent/stop', (req, res) => {
  const result = agent.stop();
  res.json(result);
});

app.get('/agent/status', (req, res) => {
  res.json(agent.getStatus());
});

app.post('/reset', async (req, res) => {
  agent.stop();
  await supabase.from('transactions').delete().eq('organization_id', req.org_id);
  await supabase.from('alerts').delete().eq('organization_id', req.org_id);
  await supabase.from('audit_log').delete().eq('organization_id', req.org_id);
  await supabase.from('policy_suggestions').delete().eq('organization_id', req.org_id);
  await supabase.from('policies').update({
    daily_budget_usd: 500,
    single_tx_limit_usd: 20,
    require_approval_above_usd: 50,
    whitelist_destinations: ['api.coingecko.com', 'api.openai.com', 'api.anthropic.com']
  }).eq('agent_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  await supabase.from('policies').update({
    daily_budget_usd: 2000,
    single_tx_limit_usd: 100,
    require_approval_above_usd: 200,
    whitelist_destinations: ['uniswap.org', 'aave.com', 'api.coingecko.com']
  }).eq('agent_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  await supabase.from('agents').update({ status: 'active' }).in('id', [
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  ]);
  await supabase.from('transactions').insert([
    { agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', organization_id: req.org_id, amount_usd: 0.01, destination: 'api.coingecko.com', payment_rail: 'x402', task_description: 'Fetch BTC/USD price', status: 'approved' },
    { agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', organization_id: req.org_id, amount_usd: 1.50, destination: 'api.openai.com', payment_rail: 'openai', task_description: 'Generate market summary report', status: 'approved' },
    { agent_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', organization_id: req.org_id, amount_usd: 250.00, destination: 'uniswap.org', payment_rail: 'x402', task_description: 'Execute ETH/USDC swap', status: 'approved' },
    { agent_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', organization_id: req.org_id, amount_usd: 350.00, destination: 'unknown-exchange.io', payment_rail: 'x402', task_description: 'Execute arbitrage trade', status: 'blocked', block_reason: 'Unauthorized destination: unknown-exchange.io' },
    { agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', organization_id: req.org_id, amount_usd: 75.00, destination: 'api.anthropic.com', payment_rail: 'anthropic', task_description: 'Deep research analysis', status: 'pending_approval' }
  ]);
  res.json({ success: true, message: 'Demo reset successfully' });
});

app.post('/simulate', async (req, res) => {
  const { agent_id, amount_usd, destination, task_description, payment_rail } = req.body;

  const blacklistCheck = await ai.checkGlobalBlacklist(destination);
  if (blacklistCheck.blacklisted) {
    const { data: tx } = await supabase.from('transactions').insert({
      agent_id,
      organization_id: req.org_id,
      amount_usd: parseFloat(amount_usd),
      destination, payment_rail: payment_rail || 'x402',
      task_description, status: 'blocked',
      block_reason: `Global blacklist: ${blacklistCheck.reason} (blocked ${blacklistCheck.blocked_count} times globally)`
    }).select().single();

    await supabase.from('alerts').insert({
      organization_id: req.org_id,
      agent_id, type: 'policy_violation',
      message: `Global blacklist hit: ${destination} — ${blacklistCheck.reason}`,
      resolved: false
    });

    if (io) {
      io.emit('anomaly_detected', {
        type: 'global_blacklist', severity: 'critical',
        agent_id, destination,
        message: `Global threat detected: ${destination} is blacklisted across ${blacklistCheck.blocked_count} Dreamline instances`
      });
    }

    return res.json({ transaction: tx, blocked: true, block_reason: 'Global blacklist hit', status: 'blocked', blacklist: blacklistCheck });
  }

  const anomalyResult = await ai.detectAnomalies(agent_id, amount_usd, destination);
  if (anomalyResult.risk_score >= 50) {
    if (io) {
      io.emit('anomaly_detected', {
        type: 'behavioral',
        severity: anomalyResult.risk_score >= 75 ? 'critical' : 'warning',
        agent_id, destination,
        risk_score: anomalyResult.risk_score,
        anomalies: anomalyResult.anomalies,
        message: anomalyResult.anomalies[0]?.message
      });
    }
  }

  const { data: policy } = await supabase.from('policies').select('*').eq('agent_id', agent_id).single();
  if (!policy) return res.status(404).json({ error: 'Policy not found' });

  const today = new Date().toISOString().split('T')[0];
  const { data: todayTxs } = await supabase.from('transactions').select('amount_usd').eq('agent_id', agent_id).eq('status', 'approved').gte('created_at', today);
  const spentToday = todayTxs?.reduce((sum, t) => sum + parseFloat(t.amount_usd), 0) || 0;

  let blocked = false;
  let block_reason = null;

  if (policy?.whitelist_destinations?.length > 0 && !policy.whitelist_destinations.includes(destination)) {
    blocked = true;
    block_reason = `Unauthorized destination: ${destination}`;
    await ai.addToGlobalBlacklist(destination, 'Policy violation');
  }
  if (!blocked && policy && parseFloat(amount_usd) > policy.single_tx_limit_usd) {
    blocked = true;
    block_reason = `Amount $${amount_usd} exceeds single tx limit of $${policy.single_tx_limit_usd}`;
  }
  if (!blocked && policy && (spentToday + parseFloat(amount_usd)) > policy.daily_budget_usd) {
    blocked = true;
    block_reason = `Daily budget exceeded: $${spentToday} already spent of $${policy.daily_budget_usd}`;
  }

  const status = blocked ? 'blocked' : (policy && parseFloat(amount_usd) > policy.require_approval_above_usd ? 'pending_approval' : 'approved');

  const { data: tx, error } = await supabase.from('transactions').insert({
    agent_id,
    organization_id: req.org_id,
    amount_usd: parseFloat(amount_usd),
    destination, payment_rail: payment_rail || 'x402',
    task_description, status, block_reason
  }).select().single();

  if (error) return res.status(500).json({ error });

  if (blocked) {
    await supabase.from('alerts').insert({
      organization_id: req.org_id,
      agent_id, type: 'policy_violation',
      message: block_reason, resolved: false
    });
  }

  res.json({ transaction: tx, blocked, block_reason, status, anomalies: anomalyResult });
});

const PORT = process.env.PORT || 3001;


// ============================================================
// DREAMLINE POLICY FACILITATOR — x402 compatible
// ============================================================

// POST /facilitator/verify
// Called by x402 clients before creating a payment payload
// Checks on-chain blacklist + agent policy
// Returns { isValid: true/false, invalidReason? }

app.post('/facilitator/verify', async (req, res) => {
  try {
    const { payload, paymentRequirements } = req.body;
    if (!payload || !paymentRequirements) {
      return res.json({ isValid: false, invalidReason: 'Missing payload or paymentRequirements' });
    }

    const destination = paymentRequirements.payTo || payload.to || '';
    const amount_usd = parseFloat(paymentRequirements.maxAmountRequired || payload.value || 0) / 1e6; // USDC has 6 decimals

    // 1. Check on-chain blacklist via DreamlineRegistry
    const { ethers } = require('ethers');
    const provider = new ethers.JsonRpcProvider('https://bsc-testnet-rpc.publicnode.com');
    const registryABI = ['function isDestinationAllowed(string memory destination) external view returns (bool)'];
    const registry = new ethers.Contract('0x71dA6F5b106E3Fb0B908C7e0720aa4452338B8BE', registryABI, provider);

    try {
      const onchainAllowed = await registry.isDestinationAllowed(destination);
      if (!onchainAllowed) {
        return res.json({
          isValid: false,
          invalidReason: `On-chain blacklist: ${destination} blocked by DreamlineRegistry on BNB Chain`,
          onchain: true
        });
      }
    } catch (e) {
      // On-chain check failed — fail closed for security
      console.error('[Facilitator/verify] On-chain check failed:', e.message);
      return res.json({
        isValid: false,
        invalidReason: `On-chain check unavailable: ${e.message}`,
        onchain: false
      });
    }

    // NOTE: Supabase blacklist removed — on-chain is the only trust layer
    // Supabase is used only for audit log and dashboard (not in critical path)

    // 2. Check agent policy if X-Dreamline-Key provided
    const apiKey = req.headers['x-dreamline-key'];
    if (apiKey) {
      const { data: keyData } = await supabase
        .from('agent_api_keys')
        .select('agent_id, organization_id')
        .eq('api_key', apiKey)
        .single();

      if (keyData) {
        const { data: policy } = await supabase
          .from('policies')
          .select('*')
          .eq('agent_id', keyData.agent_id)
          .single();

        if (policy) {
          if (amount_usd > policy.single_tx_limit_usd) {
            return res.json({
              isValid: false,
              invalidReason: `Policy: amount $${amount_usd} exceeds limit of $${policy.single_tx_limit_usd}`
            });
          }

          if (policy.whitelist_destinations?.length > 0 && !policy.whitelist_destinations.includes(destination)) {
            return res.json({
              isValid: false,
              invalidReason: `Policy: destination ${destination} not in whitelist`
            });
          }
        }
      }
    }

    // All checks passed
    res.json({ isValid: true });

  } catch (err) {
    console.error('[Facilitator/verify]', err);
    res.json({ isValid: false, invalidReason: err.message });
  }
});

// POST /facilitator/settle
// Called after verification to settle on-chain
// Proxies to Coinbase x402 facilitator after Dreamline approval

app.post('/facilitator/settle', async (req, res) => {
  try {
    const { payload, paymentRequirements } = req.body;
    if (!payload || !paymentRequirements) {
      return res.status(400).json({ error: 'Missing payload or paymentRequirements' });
    }

    // Route to AEON for BNB Chain, Coinbase for Base
    const network = req.body?.paymentRequirements?.network || req.body?.payload?.network || '';
    const isBNB = network === '56' || network === 'bsc' || network === 'eip155:56';
    const facilitatorUrl = isBNB ? 'https://facilitator.aeon.xyz/settle' : 'https://x402.org/facilitator/settle';
    console.log('[Facilitator/settle] Routing to:', facilitatorUrl, '(network:', network, ')');
    const response = await fetch(facilitatorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, paymentRequirements })
    });

    const result = await response.json();

    // Log settlement in Supabase (audit trail only — not in critical path)
    const apiKey = req.headers['x-dreamline-key'];
    if (apiKey && result.success) {
      const { data: keyData } = await supabase
        .from('agent_api_keys')
        .select('agent_id, organization_id')
        .eq('api_key', apiKey)
        .single();

      if (keyData) {
        await supabase.from('transactions').insert({
          agent_id: keyData.agent_id,
          organization_id: keyData.organization_id,
          amount_usd: parseFloat(paymentRequirements.maxAmountRequired || 0) / 1e6,
          destination: paymentRequirements.payTo || '',
          payment_rail: 'x402',
          status: 'approved',
          task_description: 'x402 settlement'
        });
      }
    }

    res.json(result);

  } catch (err) {
    console.error('[Facilitator/settle]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /facilitator/supported
// Returns supported networks and schemes — x402 ecosystem compatibility

app.get('/facilitator/supported', (req, res) => {
  res.json({
    facilitator: 'Dreamline Policy Facilitator',
    version: '1.0.0',
    description: 'x402-compatible facilitator with on-chain spend governance',
    supported: [
      { network: 'base', scheme: 'exact', token: 'USDC' },
      { network: 'base-sepolia', scheme: 'exact', token: 'USDC' },
    ],
    governance: {
      blacklist_contract: '0x71dA6F5b106E3Fb0B908C7e0720aa4452338B8BE',
      blacklist_chain: 'BNB Chain Testnet',
      signer: '0x527da185dF7F4888E1cA1d8dA0031c80e4074472'
    }
  });
});



// ============================================================
// COINGECKO PROXY — Dreamline governed CoinGecko access
// ============================================================
// Any agent can call /proxy/coingecko/* to get CoinGecko data
// with Dreamline policy enforcement before each request

app.get(/^\/proxy\/coingecko(\/.*)?$/, async (req, res) => {
  try {
    const path = (req.params[0] || '').replace(/^\//, '');
    const query = new URLSearchParams(req.query).toString();
    const destination = 'api.coingecko.com';

    // 1. Check on-chain blacklist
    const { ethers } = require('ethers');
    const provider = new ethers.JsonRpcProvider('https://bsc-testnet-rpc.publicnode.com');
    const registryABI = ['function isDestinationAllowed(string memory destination) external view returns (bool)'];
    const registry = new ethers.Contract('0x71dA6F5b106E3Fb0B908C7e0720aa4452338B8BE', registryABI, provider);

    try {
      const allowed = await registry.isDestinationAllowed(destination);
      if (!allowed) {
        return res.status(403).json({
          blocked: true,
          block_reason: 'On-chain blacklist: api.coingecko.com blocked by DreamlineRegistry',
          onchain: true
        });
      }
    } catch (e) {
      console.error('[CoinGecko Proxy] On-chain check failed:', e.message);
    }

    // 2. Check agent policy if API key provided
    const apiKey = req.headers['x-dreamline-key'];
    if (apiKey) {
      const { data: keyData } = await supabase
        .from('agent_api_keys')
        .select('agent_id, organization_id')
        .eq('api_key', apiKey)
        .single();

      if (keyData) {
        const { data: policy } = await supabase
          .from('policies')
          .select('*')
          .eq('agent_id', keyData.agent_id)
          .single();

        if (policy && policy.whitelist_destinations?.length > 0 &&
            !policy.whitelist_destinations.includes(destination)) {
          return res.status(403).json({
            blocked: true,
            block_reason: `Policy: ${destination} not in whitelist`
          });
        }

        // Log access in audit trail
        await supabase.from('transactions').insert({
          agent_id: keyData.agent_id,
          organization_id: keyData.organization_id,
          amount_usd: 0,
          destination,
          payment_rail: 'proxy',
          status: 'approved',
          task_description: `CoinGecko proxy: /${path}`
        }).catch(() => {});
      }
    }

    // 3. Forward to CoinGecko
    const url = `https://api.coingecko.com/api/v3/${path}${query ? '?' + query : ''}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Dreamline-Protocol/1.0'
      }
    });

    const data = await response.json();

    // Add Dreamline governance headers
    res.set({
      'X-Dreamline-Governed': 'true',
      'X-Dreamline-Onchain': 'true',
      'X-Dreamline-Chain': 'BNB Chain Testnet',
      'X-Dreamline-Contract': '0x71dA6F5b106E3Fb0B908C7e0720aa4452338B8BE'
    });

    res.json(data);

  } catch (err) {
    console.error('[CoinGecko Proxy]', err);
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Dreamline backend running on port ${PORT}`);
});

// ============================================================
// ONBOARDING ENDPOINT
// ============================================================

app.post('/onboard', async (req, res) => {
  try {
    const { user_id, email, name } = req.body;
    if (!user_id || !email) return res.status(400).json({ error: 'user_id and email required' });

    // Check if already onboarded
    const { data: existing } = await supabase
      .from('organizations')
      .select('id')
      .eq('owner_user_id', user_id)
      .single();

    if (existing) {
      let { data: apiKey } = await supabase
        .from('agent_api_keys')
        .select('api_key, agent_id')
        .eq('organization_id', existing.id)
        .single();
      if (!apiKey) {
        const { data: agent } = await supabase
          .from('agents')
          .insert({ name: 'My First Agent', description: 'Default agent', owner_email: email, organization_id: existing.id, status: 'active' })
          .select().single();
        const newKey = 'dlk_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
        await supabase.from('agent_api_keys').insert({ agent_id: agent.id, organization_id: existing.id, api_key: newKey });
        apiKey = { api_key: newKey, agent_id: agent.id };
      }
      return res.json({ organization_id: existing.id, api_key: apiKey.api_key, agent_id: apiKey.agent_id });
    }

    // Create organization
    const { data: org } = await supabase
      .from('organizations')
      .insert({ name: name || email, owner_user_id: user_id, owner_email: email })
      .select()
      .single();

    // Create default agent
    const { data: agent } = await supabase
      .from('agents')
      .insert({
        name: 'My First Agent',
        description: 'Default agent',
        owner_email: email,
        organization_id: org.id,
        status: 'active'
      })
      .select()
      .single();

    // Generate API key
    const apiKey = 'dlk_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

    await supabase
      .from('agent_api_keys')
      .insert({ agent_id: agent.id, organization_id: org.id, api_key: apiKey });

    res.json({ organization_id: org.id, agent_id: agent.id, api_key: apiKey });
  } catch (err) {
    console.error('[Onboard]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PROXY PAY — Core endpoint for agent payments
// ============================================================

app.post('/proxy/pay', async (req, res) => {
  try {
    const apiKey = req.headers['x-dreamline-key'];
    if (!apiKey) return res.status(401).json({ error: 'API key required' });

    const { data: keyData } = await supabase
      .from('agent_api_keys')
      .select('agent_id, organization_id')
      .eq('api_key', apiKey)
      .single();

    if (!keyData) return res.status(401).json({ error: 'Invalid API key' });

    const { amount_usd, destination, task_description, payment_rail } = req.body;
    if (!amount_usd || !destination) return res.status(400).json({ error: 'amount_usd and destination required' });

    const { data: policy } = await supabase
      .from('policies')
      .select('*')
      .eq('agent_id', keyData.agent_id)
      .single();

    const { data: blacklist } = await supabase
      .from('global_blacklist')
      .select('destination')
      .eq('destination', destination)
      .single();

    if (blacklist) {
      await supabase.from('transactions').insert({
        agent_id: keyData.agent_id,
        organization_id: keyData.organization_id,
        amount_usd, destination, task_description,
        payment_rail: payment_rail || 'unknown',
        status: 'blocked',
        block_reason: `Blacklisted destination: ${destination}`
      });
      return res.json({ approved: false, block_reason: `Destination ${destination} is blacklisted` });
    }

    if (policy) {
      if (amount_usd > policy.single_tx_limit_usd) {
        await supabase.from('transactions').insert({
          agent_id: keyData.agent_id,
          organization_id: keyData.organization_id,
          amount_usd, destination, task_description,
          payment_rail: payment_rail || 'unknown',
          status: 'blocked',
          block_reason: `Exceeds single tx limit of $${policy.single_tx_limit_usd}`
        });
        return res.json({ approved: false, block_reason: `Amount exceeds limit of $${policy.single_tx_limit_usd}` });
      }

      if (policy.whitelist_destinations?.length > 0 && !policy.whitelist_destinations.includes(destination)) {
        await supabase.from('transactions').insert({
          agent_id: keyData.agent_id,
          organization_id: keyData.organization_id,
          amount_usd, destination, task_description,
          payment_rail: payment_rail || 'unknown',
          status: 'blocked',
          block_reason: `Unauthorized destination: ${destination}`
        });
        return res.json({ approved: false, block_reason: `Destination ${destination} not in whitelist` });
      }
    }

    const { data: tx } = await supabase.from('transactions').insert({
      agent_id: keyData.agent_id,
      organization_id: keyData.organization_id,
      amount_usd, destination, task_description,
      payment_rail: payment_rail || 'unknown',
      status: 'approved'
    }).select().single();

    res.json({ approved: true, transaction_id: tx.id, message: 'Payment authorized by Dreamline' });
  } catch (err) {
    console.error('[proxy/pay]', err);
    res.status(500).json({ error: err.message });
  }
});
