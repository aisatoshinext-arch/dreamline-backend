// Dreamline AI Module
// 1. Anomaly Detection
// 2. Collaborative Blacklist
// 3. Policy Optimization

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://onequsxyjqpcsvmwxrgs.supabase.co',
  process.env.SUPABASE_KEY
);

// ============================================================
// 1. ANOMALY DETECTION
// ============================================================

async function detectAnomalies(agent_id, amount_usd, destination) {
  try {
    const now = new Date();
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const fiveMinutesAgo = new Date(now - 5 * 60 * 1000);

    const { data: lastHourTxs } = await supabase
      .from('transactions')
      .select('amount_usd, created_at, destination')
      .eq('agent_id', agent_id)
      .gte('created_at', oneHourAgo.toISOString());

    const { data: last5MinTxs } = await supabase
      .from('transactions')
      .select('amount_usd, created_at, destination')
      .eq('agent_id', agent_id)
      .gte('created_at', fiveMinutesAgo.toISOString());

    const anomalies = [];

    if (!lastHourTxs || lastHourTxs.length === 0) return { anomalies: [], risk_score: 0 };

    if (last5MinTxs && last5MinTxs.length > 10) {
      anomalies.push({
        type: 'high_frequency',
        severity: 'critical',
        message: `Unusual activity: ${last5MinTxs.length} transactions in 5 minutes — possible agent compromise`,
        value: last5MinTxs.length
      });
    }

    const avgAmount = lastHourTxs.reduce((sum, t) => sum + parseFloat(t.amount_usd), 0) / lastHourTxs.length;
    if (parseFloat(amount_usd) > avgAmount * 5 && parseFloat(amount_usd) > 50) {
      anomalies.push({
        type: 'unusual_amount',
        severity: 'warning',
        message: `Amount $${amount_usd} is ${Math.round(parseFloat(amount_usd) / avgAmount)}x above agent average ($${avgAmount.toFixed(2)})`,
        value: parseFloat(amount_usd)
      });
    }

    const knownDestinations = [...new Set(lastHourTxs.map(t => t.destination))];
    if (!knownDestinations.includes(destination) && lastHourTxs.length > 5) {
      anomalies.push({
        type: 'new_destination',
        severity: 'info',
        message: `New destination never seen before for this agent: ${destination}`,
        value: destination
      });
    }

    const sameAmountCount = lastHourTxs.filter(t =>
      Math.abs(parseFloat(t.amount_usd) - parseFloat(amount_usd)) < 0.01
    ).length;
    if (sameAmountCount > 8) {
      anomalies.push({
        type: 'repeated_amount',
        severity: 'warning',
        message: `Same amount $${amount_usd} repeated ${sameAmountCount} times — possible infinite loop`,
        value: sameAmountCount
      });
    }

    const risk_score = Math.min(100, anomalies.reduce((score, a) => {
      if (a.severity === 'critical') return score + 50;
      if (a.severity === 'warning') return score + 25;
      return score + 10;
    }, 0));

    return { anomalies, risk_score };

  } catch (err) {
    console.error('[AI] Anomaly detection error:', err.message);
    return { anomalies: [], risk_score: 0 };
  }
}

// ============================================================
// 2. COLLABORATIVE BLACKLIST
// ============================================================

async function checkGlobalBlacklist(destination) {
  try {
    const { data } = await supabase
      .from('global_blacklist')
      .select('*')
      .eq('destination', destination)
      .single();

    if (data) {
      await supabase
        .from('global_blacklist')
        .update({
          blocked_count: data.blocked_count + 1,
          last_seen: new Date().toISOString()
        })
        .eq('destination', destination);

      return {
        blacklisted: true,
        blocked_count: data.blocked_count + 1,
        reason: data.reason,
        first_seen: data.first_seen
      };
    }

    return { blacklisted: false };
  } catch {
    return { blacklisted: false };
  }
}

async function addToGlobalBlacklist(destination, reason) {
  try {
    const { data: existing } = await supabase
      .from('global_blacklist')
      .select('id, blocked_count')
      .eq('destination', destination)
      .single();

    if (existing) {
      await supabase
        .from('global_blacklist')
        .update({
          blocked_count: existing.blocked_count + 1,
          last_seen: new Date().toISOString()
        })
        .eq('destination', destination);
    } else {
      await supabase
        .from('global_blacklist')
        .insert({
          destination,
          blocked_count: 1,
          reason: reason || 'Auto-flagged by Dreamline — unauthorized destination',
          auto_added: true
        });
      console.log('[AI] Added to global blacklist:', destination);
    }
  } catch (err) {
    console.error('[AI] Blacklist update error:', err.message);
  }
}

async function getGlobalBlacklist() {
  try {
    const { data } = await supabase
      .from('global_blacklist')
      .select('*')
      .order('blocked_count', { ascending: false });
    return data || [];
  } catch {
    return [];
  }
}

// ============================================================
// 3. POLICY OPTIMIZATION AI
// ============================================================

async function generatePolicySuggestions(agent_id, organization_id, current_policy) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: txs } = await supabase
      .from('transactions')
      .select('amount_usd, status, destination, created_at')
      .eq('agent_id', agent_id)
      .gte('created_at', thirtyDaysAgo);

    if (!txs || txs.length < 5) return [];

    const suggestions = [];
    const approvedTxs = txs.filter(t => t.status === 'approved');
    const blockedTxs = txs.filter(t => t.status === 'blocked');

    if (approvedTxs.length > 0) {
      const dailySpend = {};
      approvedTxs.forEach(t => {
        const day = t.created_at.split('T')[0];
        dailySpend[day] = (dailySpend[day] || 0) + parseFloat(t.amount_usd);
      });
      const dailyValues = Object.values(dailySpend);
      const maxDailySpend = Math.max(...dailyValues);

      if (current_policy.daily_budget_usd > maxDailySpend * 2) {
        suggestions.push({
          agent_id,
          organization_id,
          suggestion_type: 'reduce_daily_budget',
          current_value: current_policy.daily_budget_usd,
          suggested_value: Math.ceil(maxDailySpend * 1.3),
          reason: `Agent never spent more than $${maxDailySpend.toFixed(2)}/day in 30 days. Current budget ($${current_policy.daily_budget_usd}) is ${Math.round(current_policy.daily_budget_usd / maxDailySpend)}x higher than needed.`
        });
      }

      const maxSingleTx = Math.max(...approvedTxs.map(t => parseFloat(t.amount_usd)));
      if (current_policy.single_tx_limit_usd > maxSingleTx * 3) {
        suggestions.push({
          agent_id,
          organization_id,
          suggestion_type: 'reduce_single_tx_limit',
          current_value: current_policy.single_tx_limit_usd,
          suggested_value: Math.ceil(maxSingleTx * 1.5),
          reason: `Largest approved transaction was $${maxSingleTx.toFixed(2)}. Current limit ($${current_policy.single_tx_limit_usd}) creates unnecessary exposure.`
        });
      }

      const approvedDestinations = [...new Set(approvedTxs.map(t => t.destination))];
      const unusedWhitelist = current_policy.whitelist_destinations
        ? current_policy.whitelist_destinations.filter(d => !approvedDestinations.includes(d))
        : [];

      if (unusedWhitelist.length > 0) {
        suggestions.push({
          agent_id,
          organization_id,
          suggestion_type: 'clean_whitelist',
          current_value: current_policy.whitelist_destinations ? current_policy.whitelist_destinations.length : 0,
          suggested_value: approvedDestinations.length,
          reason: `${unusedWhitelist.length} whitelisted destinations never used in 30 days: ${unusedWhitelist.join(', ')}. Removing reduces attack surface.`
        });
      }

      const blockedDestinations = [...new Set(blockedTxs.map(t => t.destination))];
      if (blockedDestinations.length > 0) {
        suggestions.push({
          agent_id,
          organization_id,
          suggestion_type: 'add_to_blacklist',
          current_value: 0,
          suggested_value: blockedDestinations.length,
          reason: `Agent attempted ${blockedTxs.length} blocked transactions to: ${blockedDestinations.slice(0, 3).join(', ')}. Auto-adding to global blacklist.`
        });

        for (const dest of blockedDestinations) {
          await addToGlobalBlacklist(dest, `Flagged by policy — attempted ${blockedTxs.filter(t => t.destination === dest).length} unauthorized transactions`);
        }
      }
    }

    if (suggestions.length > 0) {
      await supabase.from('policy_suggestions').insert(suggestions);
    }

    return suggestions;

  } catch (err) {
    console.error('[AI] Policy optimization error:', err.message);
    return [];
  }
}

async function getPolicySuggestions(agent_id) {
  try {
    const { data } = await supabase
      .from('policy_suggestions')
      .select('*')
      .eq('agent_id', agent_id)
      .eq('accepted', false)
      .order('created_at', { ascending: false })
      .limit(5);
    return data || [];
  } catch {
    return [];
  }
}

async function acceptSuggestion(suggestion_id) {
  try {
    await supabase
      .from('policy_suggestions')
      .update({ accepted: true })
      .eq('id', suggestion_id);
    return { success: true };
  } catch {
    return { success: false };
  }
}

module.exports = {
  detectAnomalies,
  checkGlobalBlacklist,
  addToGlobalBlacklist,
  getGlobalBlacklist,
  generatePolicySuggestions,
  getPolicySuggestions,
  acceptSuggestion
};