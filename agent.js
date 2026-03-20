const behaviors = [
  {
    agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    agent_name: 'Research Agent',
    amount_usd: 0.01,
    destination: 'api.coingecko.com',
    task_description: 'Fetch real-time BTC/USD price data',
    payment_rail: 'x402'
  },
  {
    agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    agent_name: 'Research Agent',
    amount_usd: 1.50,
    destination: 'api.openai.com',
    task_description: 'Generate market analysis report',
    payment_rail: 'openai'
  },
  {
    agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    agent_name: 'Research Agent',
    amount_usd: 500,
    destination: 'api.openai.com',
    task_description: 'Massive deep research request',
    payment_rail: 'openai'
  },
  {
    agent_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    agent_name: 'Trading Agent',
    amount_usd: 250,
    destination: 'uniswap.org',
    task_description: 'Execute ETH/USDC swap',
    payment_rail: 'x402'
  },
  {
    agent_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    agent_name: 'Trading Agent',
    amount_usd: 50,
    destination: 'suspicious-exchange.io',
    task_description: 'Execute arbitrage on unknown exchange',
    payment_rail: 'x402'
  },
  {
    agent_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    agent_name: 'Trading Agent',
    amount_usd: 180,
    destination: 'aave.com',
    task_description: 'Provide liquidity to AAVE pool',
    payment_rail: 'x402'
  },
  {
    agent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    agent_name: 'Research Agent',
    amount_usd: 0.01,
    destination: 'api.coingecko.com',
    task_description: 'Fetch ETH/USDC price for arbitrage calculation',
    payment_rail: 'x402'
  },
  {
    agent_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    agent_name: 'Trading Agent',
    amount_usd: 350,
    destination: 'unknown-exchange.io',
    task_description: 'High frequency trade opportunity detected',
    payment_rail: 'x402'
  }
];

let isRunning = false;
let intervalId = null;
let io = null;

function setIO(socketIO) {
  io = socketIO;
}

function getRandomBehavior() {
  return behaviors[Math.floor(Math.random() * behaviors.length)];
}

async function runAgentCycle() {
  const behavior = getRandomBehavior();
  
  try {
    const response = await fetch('http://localhost:3001/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: behavior.agent_id,
        amount_usd: behavior.amount_usd,
        destination: behavior.destination,
        task_description: behavior.task_description,
        payment_rail: behavior.payment_rail
      })
    });
    
    const result = await response.json();
    
    const event = {
      timestamp: new Date().toISOString(),
      agent_name: behavior.agent_name,
      task: behavior.task_description,
      destination: behavior.destination,
      amount: behavior.amount_usd,
      payment_rail: behavior.payment_rail,
      status: result.status,
      blocked: result.blocked,
      block_reason: result.block_reason
    };
    
    console.log(`[Agent] ${behavior.agent_name}: ${behavior.task_description} → ${result.status}`);
    
    if (io) {
      io.emit('agent_event', event);
    }
    
  } catch (err) {
    console.error('[Agent] Error:', err.message);
  }
}

function start() {
  if (isRunning) return { success: false, message: 'Agent already running' };
  isRunning = true;
  runAgentCycle();
  intervalId = setInterval(runAgentCycle, 3000);
  console.log('[Agent] Live demo started — running every 8 seconds');
  return { success: true, message: 'Live demo started' };
}

function stop() {
  if (!isRunning) return { success: false, message: 'Agent not running' };
  isRunning = false;
  clearInterval(intervalId);
  intervalId = null;
  console.log('[Agent] Live demo stopped');
  return { success: true, message: 'Live demo stopped' };
}

function getStatus() {
  return { running: isRunning };
}

module.exports = { start, stop, getStatus, setIO };