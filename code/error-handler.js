/**
 * Error Handling & Retry Logic
 *
 * Implements:
 *   - Exponential backoff retry
 *   - Dead Letter Queue (DLQ) management
 *   - CRM downtime fallback with periodic sync
 *   - Admin alerting with escalation
 *
 * Used in: n8n Function Nodes and scheduled workflows
 */

// --- Retry Configuration ---

const RETRY_CONFIG = {
  crm: { maxRetries: 3, baseDelay: 5000, maxDelay: 120000 },
  airtable: { maxRetries: 3, baseDelay: 3000, maxDelay: 60000 },
  slack: { maxRetries: 2, baseDelay: 2000, maxDelay: 30000 },
  sms: { maxRetries: 3, baseDelay: 10000, maxDelay: 180000 },
};

// --- Exponential Backoff with Jitter ---

function calculateDelay(attempt, config) {
  const exponentialDelay = config.baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * config.baseDelay;
  return Math.min(exponentialDelay + jitter, config.maxDelay);
}

async function retryWithBackoff(fn, serviceName, context = {}) {
  const config = RETRY_CONFIG[serviceName] || RETRY_CONFIG.crm;
  let lastError;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        console.log(`[${serviceName}] Succeeded on attempt ${attempt + 1}`);
      }
      return { success: true, result, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      console.error(
        `[${serviceName}] Attempt ${attempt + 1}/${config.maxRetries + 1} failed:`,
        error.message
      );

      if (attempt < config.maxRetries) {
        const delay = calculateDelay(attempt, config);
        console.log(`[${serviceName}] Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  return {
    success: false,
    error: lastError,
    attempts: config.maxRetries + 1,
    context,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Dead Letter Queue (DLQ) Management ---

async function addToDeadLetterQueue(airtableClient, failedJob) {
  return airtableClient.create('Failed Jobs', {
    workflow: failedJob.workflow || 'AI Legal Intake',
    service: failedJob.service,
    error_message: failedJob.error?.message || 'Unknown error',
    error_code: failedJob.error?.statusCode || null,
    failed_node: failedJob.node || 'unknown',
    input_data: JSON.stringify(failedJob.inputData || {}),
    attempt_count: failedJob.attempts || 0,
    timestamp: new Date().toISOString(),
    status: 'pending_retry',
    priority: failedJob.priority || 'normal',
    next_retry_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
}

async function processDeadLetterQueue(airtableClient, handlers) {
  const pendingJobs = await airtableClient.search('Failed Jobs', {
    filterByFormula: `AND(
      {status} = 'pending_retry',
      {next_retry_at} <= '${new Date().toISOString()}',
      {attempt_count} < 10
    )`,
    sort: [{ field: 'priority', direction: 'desc' }],
    maxRecords: 20,
  });

  const results = [];

  for (const job of pendingJobs) {
    const handler = handlers[job.fields.service];
    if (!handler) {
      console.error(`No handler for service: ${job.fields.service}`);
      continue;
    }

    try {
      const inputData = JSON.parse(job.fields.input_data);
      await handler(inputData);

      // Success — mark as resolved
      await airtableClient.update('Failed Jobs', job.id, {
        status: 'resolved',
        resolved_at: new Date().toISOString(),
      });

      results.push({ id: job.id, status: 'resolved' });
    } catch (error) {
      const newAttemptCount = (job.fields.attempt_count || 0) + 1;
      const nextRetry = new Date(
        Date.now() + calculateDelay(newAttemptCount, RETRY_CONFIG.crm)
      );

      await airtableClient.update('Failed Jobs', job.id, {
        attempt_count: newAttemptCount,
        last_error: error.message,
        next_retry_at: nextRetry.toISOString(),
        status: newAttemptCount >= 5 ? 'escalated' : 'pending_retry',
      });

      if (newAttemptCount >= 5) {
        results.push({ id: job.id, status: 'escalated', error: error.message });
      } else {
        results.push({ id: job.id, status: 'retry_scheduled', nextRetry });
      }
    }
  }

  return results;
}

// --- CRM Downtime Fallback ---

/**
 * Attempts to write to CRM. If CRM is down, stores in Airtable
 * with crm_sync = "pending" for later retry.
 */
async function writeToGHLWithFallback(ghlClient, airtableClient, leadData) {
  const crmResult = await retryWithBackoff(
    () => ghlClient.createContact(leadData),
    'crm',
    { leadPhone: leadData.phone }
  );

  if (crmResult.success) {
    return {
      crm_sync: 'complete',
      crm_contact_id: crmResult.result.id,
    };
  }

  // CRM is down — fallback to Airtable with pending sync
  console.warn('[CRM Fallback] GHL unreachable. Storing for later sync.');

  await airtableClient.update('Lead Intake Log', leadData.airtable_record_id, {
    crm_sync: 'pending',
    crm_error: crmResult.error?.message || 'CRM unreachable',
    crm_retry_count: 0,
  });

  return {
    crm_sync: 'pending',
    crm_error: crmResult.error?.message,
    fallback: true,
  };
}

// --- CRM Sync Cron Job ---
// Run this as a separate n8n workflow every 15 minutes

async function syncPendingCRMRecords(ghlClient, airtableClient, slackClient) {
  const pending = await airtableClient.search('Lead Intake Log', {
    filterByFormula: "{crm_sync} = 'pending'",
    maxRecords: 50,
  });

  if (pending.length === 0) return { synced: 0 };

  let synced = 0;
  let failed = 0;

  for (const record of pending) {
    try {
      const contact = await ghlClient.createContact({
        firstName: record.fields.caller_name?.split(' ')[0],
        lastName: record.fields.caller_name?.split(' ').slice(1).join(' '),
        phone: record.fields.phone,
        email: record.fields.email,
        source: 'AI Phone Intake (delayed sync)',
        tags: ['ai-intake', 'delayed-sync', record.fields.case_type],
        customField: {
          case_type: record.fields.case_type,
          urgency: record.fields.urgency,
          qualification_status: record.fields.qualified ? 'qualified' : 'not_qualified',
        },
      });

      await airtableClient.update('Lead Intake Log', record.id, {
        crm_sync: 'complete',
        crm_contact_id: contact.id,
        crm_synced_at: new Date().toISOString(),
      });

      synced++;
    } catch (error) {
      const retryCount = (record.fields.crm_retry_count || 0) + 1;

      await airtableClient.update('Lead Intake Log', record.id, {
        crm_retry_count: retryCount,
        crm_error: error.message,
      });

      if (retryCount >= 5) {
        await slackClient.postMessage('#system-alerts', {
          text: `CRM sync failed after 5 attempts for ${record.fields.caller_name} (${record.fields.phone}). Manual intervention required.`,
        });
      }

      failed++;
    }
  }

  return { synced, failed, total: pending.length };
}

// --- Admin Alert with Escalation ---

async function alertAdmin(slackClient, emailClient, alert) {
  const severity = alert.severity || 'warning';

  // Always send Slack alert
  try {
    await slackClient.postMessage('#system-alerts', {
      text: severity === 'critical'
        ? `<!channel> :rotating_light: *CRITICAL: ${alert.title}*`
        : `:warning: *${alert.title}*`,
      attachments: [
        {
          color: severity === 'critical' ? '#e74c3c' : '#f39c12',
          fields: [
            { title: 'Service', value: alert.service, short: true },
            { title: 'Error', value: alert.error, short: true },
            { title: 'Impact', value: alert.impact || 'Unknown', short: true },
            { title: 'Action Required', value: alert.action || 'Review logs', short: true },
          ],
          footer: `AI Intake System | ${new Date().toISOString()}`,
        },
      ],
    });
  } catch (slackError) {
    console.error('Slack alert failed, falling back to email:', slackError.message);

    // Fallback to email if Slack fails
    await emailClient.send({
      to: 'admin@firm.com',
      subject: `[${severity.toUpperCase()}] AI Intake System: ${alert.title}`,
      body: `Service: ${alert.service}\nError: ${alert.error}\nImpact: ${alert.impact}\nAction: ${alert.action}`,
    });
  }
}

// --- Circuit Breaker ---

class CircuitBreaker {
  constructor(serviceName, options = {}) {
    this.serviceName = serviceName;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000; // 1 minute
    this.failureCount = 0;
    this.state = 'CLOSED'; // CLOSED = normal, OPEN = blocking, HALF_OPEN = testing
    this.lastFailureTime = null;
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error(
          `Circuit breaker OPEN for ${this.serviceName}. ` +
          `Resets in ${Math.ceil((this.resetTimeout - (Date.now() - this.lastFailureTime)) / 1000)}s`
        );
      }
    }

    try {
      const result = await fn();
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';
        this.failureCount = 0;
      }
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.failureThreshold) {
        this.state = 'OPEN';
        console.error(
          `[CircuitBreaker] ${this.serviceName} circuit OPEN after ${this.failureCount} failures`
        );
      }

      throw error;
    }
  }

  getState() {
    return {
      service: this.serviceName,
      state: this.state,
      failureCount: this.failureCount,
      lastFailure: this.lastFailureTime,
    };
  }
}

module.exports = {
  retryWithBackoff,
  addToDeadLetterQueue,
  processDeadLetterQueue,
  writeToGHLWithFallback,
  syncPendingCRMRecords,
  alertAdmin,
  CircuitBreaker,
  RETRY_CONFIG,
};
