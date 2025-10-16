'use strict';

import { S3Client, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectTaggingCommand, PutObjectTaggingCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, DeleteMessageBatchCommand } from '@aws-sdk/client-sqs';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { createHmac } from 'crypto';

const pipelineAsync = promisify(pipeline);

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

const DDB_TABLE_NAME = process.env.DDB_TABLE_NAME;
const QUARANTINE_BUCKET_NAME = process.env.QUARANTINE_BUCKET_NAME || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const WEBHOOK_SOURCE = process.env.WEBHOOK_SOURCE || 's3-virus-scanner';
const STANDARD_WEBHOOK_VERSION = '1';
const DEFS_BUCKET_NAME = process.env.DEFS_BUCKET_NAME || '';
const DEFS_KEY = process.env.DEFS_KEY || 'clamav/defs/db.tar.gz';

const defsDir = path.join(os.tmpdir(), 'clamav');

function log(message, context = {}) {
  try {
    console.log(JSON.stringify({ message, ...context }));
  } catch {
    console.log(message);
  }
}

async function ensureDefinitions() {
  try {
    fs.mkdirSync(defsDir, { recursive: true });
    const marker = path.join(defsDir, '.ready');
    if (fs.existsSync(marker)) return; // already prepared in this container instance

    // Try download individual CVD files from S3 cache (more reliable than tarball)
    if (DEFS_BUCKET_NAME) {
      log('Downloading ClamAV definitions from S3', { bucket: DEFS_BUCKET_NAME });
      const defFiles = ['main.cvd', 'daily.cvd', 'bytecode.cvd'];
      let downloadCount = 0;
      
      for (const file of defFiles) {
        try {
          const resp = await s3.send(new GetObjectCommand({ Bucket: DEFS_BUCKET_NAME, Key: file }));
          const dest = path.join(defsDir, file);
          
          if (resp.Body?.transformToByteArray) {
            const bytes = await resp.Body.transformToByteArray();
            fs.writeFileSync(dest, Buffer.from(bytes));
          } else if (resp.Body && typeof resp.Body.pipe === 'function') {
            await pipelineAsync(resp.Body, fs.createWriteStream(dest));
          }
          
          const size = fs.statSync(dest).size;
          log(`Downloaded ${file}`, { sizeBytes: size });
          downloadCount++;
        } catch (e) {
          log(`Failed to download ${file}`, { error: e.message });
        }
      }
      
      if (downloadCount > 0) {
        log('Definitions initialized from S3 cache', { defsDir, filesDownloaded: downloadCount });
        fs.writeFileSync(marker, 'ok');
        return;
      }
      log('No definitions downloaded from S3, will attempt freshclam', { defsDir });
    }
  } catch (e) {
    console.warn('Failed to use S3 defs cache, will fallback to freshclam:', e);
  }

  // Fallback: run freshclam (avoid on hot path). This requires internet egress.
  try {
    log('Running freshclam to update definitions', { defsDir });
    // Use explicit config file to avoid system config issues
    const confPath = path.join(os.tmpdir(), 'freshclam.conf');
    if (!fs.existsSync(confPath)) {
      fs.writeFileSync(confPath, 'DatabaseMirror database.clamav.net\n');
    }
    const fc = spawnSync('freshclam', ['--config-file=' + confPath, '--datadir=' + defsDir, '--foreground', '--stdout', '--quiet'], { encoding: 'utf-8' });
    if (fc.status !== 0) log('freshclam non-zero status', { status: fc.status, stderr: fc.stderr });
    const hasDefs = fs.readdirSync(defsDir).some(f => f.endsWith('.cvd') || f.endsWith('.cld'));
    if (!hasDefs) throw new Error('No definitions present after freshclam');
    log('Definitions initialized from freshclam', { defsDir });
    fs.writeFileSync(path.join(defsDir, '.ready'), 'ok');
  } catch (e) {
    console.error('freshclam failed:', e);
    throw e;
  }
}

async function downloadObjectToTemp(bucket, key) {
  const tmpFile = path.join(os.tmpdir(), uuidv4());
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(tmpFile);
    resp.Body.pipe(w);
    resp.Body.on('error', reject);
    w.on('finish', resolve);
    w.on('error', reject);
  });
  return tmpFile;
}

function scanFile(filePath) {
  // Match Python example: use -v for verbose, --max-filesize, --max-scansize
  const MAX_BYTES = 2147483647; // 2GB max as per Python example
  const args = [
    '-v',
    '--stdout',
    `--max-filesize=${MAX_BYTES}`,
    `--max-scansize=${MAX_BYTES}`,
    `--database=${defsDir}`,
    filePath
  ];
  const result = spawnSync('clamscan', args, { encoding: 'utf-8' });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const exitCode = (typeof result.status === 'number') ? result.status : 2;
  
  // Exit codes: 0 = clean, 1 = infected, other = error
  const infected = exitCode === 1;
  const clean = exitCode === 0;
  const match = stdout.match(/: (.+) FOUND/);
  const signature = match ? match[1] : '';
  
  log('Clamscan result', { exitCode, infected, clean, signature, stdoutPreview: stdout.slice(0, 200) });
  
  return { infected, clean, exitCode, signature, raw: stdout, stderr };
}

async function tagObject(bucket, key, newTags) {
  const maxRetries = 3;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      // Get existing tags
      let existing;
      try {
        existing = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
      } catch (e) {
        // Object doesn't exist - it may have been deleted (e.g., infected and quarantined)
        if (e.name === 'NoSuchKey') {
          log('Object no longer exists, skipping tagging', { bucket, key });
          return; // Not an error - object was deleted
        }
        // For other errors, assume no existing tags
        log('Failed to get existing tags, assuming empty', { bucket, key, error: e.message });
        existing = { TagSet: [] };
      }
      
      // Merge tags
      const tagMap = new Map((existing.TagSet || []).map(t => [t.Key, t.Value]));
      for (const [k, v] of Object.entries(newTags)) tagMap.set(k, String(v));
      const TagSet = Array.from(tagMap.entries()).map(([Key, Value]) => ({ Key, Value }));
      
      // Put tags with retry
      await s3.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: key, Tagging: { TagSet } }));
      log('Successfully tagged object', { bucket, key, tags: newTags });
      return; // Success
      
    } catch (e) {
      attempt++;
      
      // Check if error is retryable
      const isRetryable = e.name !== 'NoSuchKey' && 
                          e.name !== 'AccessDenied' && 
                          e.name !== 'InvalidArgument';
      
      if (!isRetryable || attempt >= maxRetries) {
        if (e.name === 'NoSuchKey') {
          log('Object deleted before tagging, skipping', { bucket, key });
          return; // Not a failure - object was deleted
        }
        log('Failed to tag object after retries', { 
          bucket, 
          key, 
          error: e.message, 
          errorType: e.name,
          attempts: attempt 
        });
        throw e; // Re-throw for non-retryable errors
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const backoffMs = 1000 * Math.pow(2, attempt - 1);
      log('Retrying tag operation', { 
        bucket, 
        key, 
        attempt, 
        maxRetries, 
        backoffMs,
        error: e.message 
      });
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

async function quarantineOrDelete(srcBucket, key) {
  const maxRetries = 3;
  
  // Copy to quarantine if configured
  if (QUARANTINE_BUCKET_NAME) {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        await s3.send(new CopyObjectCommand({ 
          Bucket: QUARANTINE_BUCKET_NAME, 
          Key: key, 
          CopySource: `${srcBucket}/${encodedKey}` 
        }));
        log('Copied to quarantine', { srcBucket, key, quarantineBucket: QUARANTINE_BUCKET_NAME });
        break; // Success
      } catch (e) {
        attempt++;
        if (attempt >= maxRetries) {
          log('Failed to copy to quarantine, will still delete from source', { 
            srcBucket, 
            key, 
            error: e.message,
            attempts: attempt 
          });
          // Continue to delete even if quarantine copy fails
          break;
        }
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        log('Retrying quarantine copy', { attempt, maxRetries, backoffMs, error: e.message });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  
  // Delete from source with retry
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: srcBucket, Key: key }));
      log('Deleted infected object from source', { srcBucket, key });
      return; // Success
    } catch (e) {
      attempt++;
      
      // NoSuchKey means already deleted - not an error
      if (e.name === 'NoSuchKey') {
        log('Object already deleted', { srcBucket, key });
        return;
      }
      
      if (attempt >= maxRetries) {
        log('Failed to delete infected object after retries', { 
          srcBucket, 
          key, 
          error: e.message,
          attempts: attempt 
        });
        throw e; // Critical - infected file remains in source bucket
      }
      
      const backoffMs = 1000 * Math.pow(2, attempt - 1);
      log('Retrying delete operation', { attempt, maxRetries, backoffMs, error: e.message });
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

async function auditWrite(record) {
  const maxRetries = 3;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      await ddb.send(new PutCommand({ TableName: DDB_TABLE_NAME, Item: record }));
      return; // Success
    } catch (e) {
      attempt++;
      
      // Check if error is retryable (throttling, network issues)
      const isRetryable = e.name === 'ProvisionedThroughputExceededException' ||
                          e.name === 'RequestLimitExceeded' ||
                          e.name === 'ServiceUnavailable' ||
                          e.name === 'InternalServerError' ||
                          e.$metadata?.httpStatusCode >= 500;
      
      if (!isRetryable || attempt >= maxRetries) {
        log('Failed to write audit record after retries', { 
          recordId: record.id,
          error: e.message,
          errorType: e.name,
          attempts: attempt 
        });
        throw e; // Re-throw to trigger SQS retry
      }
      
      const backoffMs = 1000 * Math.pow(2, attempt - 1);
      log('Retrying audit write', { 
        recordId: record.id,
        attempt, 
        maxRetries, 
        backoffMs,
        error: e.message 
      });
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

export function buildStandardWebhookMessage(audit) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const event = `clamav.scan.${audit.status}`;
  const body = {
    id: audit.id,
    source: WEBHOOK_SOURCE,
    event,
    created_at: audit.scannedAt,
    data: audit,
  };
  const bodyString = JSON.stringify(body);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${timestamp}.${bodyString}`)
    .digest('hex');

  return {
    bodyString,
    headers: {
      'Content-Type': 'application/json',
      'Webhook-Id': audit.id,
      'Webhook-Source': WEBHOOK_SOURCE,
      'Webhook-Timestamp': timestamp,
      'Webhook-Event': event,
      'Webhook-Version': STANDARD_WEBHOOK_VERSION,
      'Webhook-Signature': `v1=${signature}`,
    },
  };
}

export async function postWebhook(audit, axiosClient = axios) {
  if (!WEBHOOK_URL) return;
  if (!WEBHOOK_SECRET) {
    console.warn('WEBHOOK_SECRET not configured; skipping webhook dispatch to remain spec-compliant');
    return;
  }

  try {
    const { bodyString, headers } = buildStandardWebhookMessage(audit);
    await axiosClient.post(WEBHOOK_URL, bodyString, { timeout: 2000, headers });
  } catch (e) {
    console.warn('Webhook failed:', e?.message || e);
  }
}

export const handler = async (event) => {
  await ensureDefinitions();
  log('SQS batch received', { records: (event.Records || []).length });
  const failures = [];
  for (const record of event.Records || []) {
    try {
      const body = JSON.parse(record.body);
      // Support both S3 Notification and EventBridge S3 detail wrapped in SQS
      let bucket, key;
      if (body.Records && body.Records[0]?.s3) {
        const s3rec = body.Records[0].s3;
        bucket = s3rec.bucket.name;
        key = decodeURIComponent(s3rec.object.key.replace(/\+/g, ' '));
      } else if (body.detail?.bucket?.name && body.detail?.object?.key) {
        bucket = body.detail.bucket.name;
        key = decodeURIComponent(body.detail.object.key.replace(/\+/g, ' '));
      } else {
        continue;
      }

      log('Processing object', { messageId: record.messageId, bucket, key });
      const tmpFile = await downloadObjectToTemp(bucket, key);
      const scan = scanFile(tmpFile);
      log('Scan complete', { exitCode: scan.exitCode, infected: scan.infected, signature: scan.signature });
      const now = new Date().toISOString();
      const audit = {
        id: uuidv4(),
        bucket,
        key,
        scannedAt: now,
        status: scan.clean ? 'clean' : (scan.infected ? 'infected' : 'error'),
        signature: scan.signature,
      };

      if (scan.clean) {
        await tagObject(bucket, key, { 'scan-status': 'clean', 'scannedAt': now, 'engine': 'ClamAV' });
        log('Tagged object as clean', { bucket, key });
      } else if (scan.infected) {
        await quarantineOrDelete(bucket, key);
        log('Object quarantined/deleted due to infection', { bucket, key });
      } else {
        // error during scan; do not delete/quarantine
        throw new Error('Scan error (exitCode=' + scan.exitCode + ')');
      }

      await auditWrite(audit);
      log('Audit record written', { id: audit.id, status: audit.status });
      await postWebhook(audit);
    } catch (e) {
      console.error('Failed processing record:', e);
      if (record?.messageId) failures.push({ itemIdentifier: record.messageId });
    }
  }

  const failedCount = failures.length;
  if (failedCount > 0) log('Batch completed with failures', { failedCount });
  else log('Batch completed successfully');
  return { batchItemFailures: failures };
};


