## S3 Virus Scanner (CDK + ClamAV)

Serverless, event-driven malware scanning for S3 using ClamAV. Files added or updated in a source S3 bucket are scanned asynchronously via SQS → Lambda. Clean objects are tagged; infected objects are deleted or quarantined (if a quarantine bucket is provided). Every scan is recorded in DynamoDB, and an optional webhook receives results.

### Architecture

- S3 (existing bucket) → S3 Event Notifications → SQS
- SQS → Lambda (Docker image with ClamAV)
- Lambda → DynamoDB (audit)
- Lambda → S3 tag clean objects; delete or move to quarantine for infected
- Lambda → optional webhook URL (POST JSON results)

Additional definitions cache path:
- EventBridge Schedule → Updater Lambda (Docker with freshclam) → S3 Definitions Cache
- Scanner Lambda downloads definitions tarball from cache (no freshclam on hot path)

```
S3 (ObjectCreated) ──▶ SQS ──▶ Lambda(ClamAV) ──▶ DynamoDB (audit)
                                 │
                                 ├─▶ Tag clean object
                                 ├─▶ Delete infected
                                 └─▶ Copy to Quarantine (if provided)
                                          │
                                          └─▶ Optional Webhook

EventBridge (rate) ──▶ Updater Lambda ──▶ S3 (ClamAV DB cache)
                                 ▲                 │
                                 └────── Scanner Lambda pulls db tar.gz
```

### Implementation Plan

1) Infrastructure (CDK)
- Import existing source bucket by ARN from environment
- Create SQS queue (+ DLQ) and route S3 ObjectCreated events to it (S3 Notification → SQS)
- Create DynamoDB table (on-demand) for audit records
- Build Scanner Lambda from Docker image containing clamscan; add SQS event source
- Create S3 Definitions Cache bucket
- Build Updater Lambda (Docker with freshclam) + EventBridge Schedule (e.g., rate(4 hours)) to publish `clamav/defs/db.tar.gz`
- Permissions: Scanner needs S3 read/write+tagging, DDB write, SQS consume, read from defs cache; Updater needs write to defs cache

2) Lambda runtime (Node.js in container)
- Scanner: On init, download definitions tarball from S3 cache into `/tmp/clamav` (extract); fallback to `freshclam` only if cache unavailable
- For each S3 object event: download object to `/tmp`, scan with `clamscan`
- Clean: merge+write object tags (scan-status=clean, scannedAt, engine)
- Infected: delete or copy to quarantine then delete original; add minimal tags to quarantined copy
- Emit audit record to DynamoDB; POST results to webhook if configured
- Return partial batch failures for SQS to avoid reprocessing successes

3) Documentation & Ops
- Document required env vars, deploy steps, limits, and operational tips (timeouts, memory, NAT for freshclam)

### Configuration (environment)

Required at deploy (CDK synth/deploy time):
- `SOURCE_BUCKET_ARN` (string): ARN of the S3 bucket to scan.

Optional at deploy:
- `QUARANTINE_BUCKET_ARN` (string): ARN of a bucket to receive infected objects.
- `WEBHOOK_URL` (string): HTTPS URL to receive POSTed scan results.
- `ENVIRONMENT` (string): Environment name for naming/tagging (e.g., dev, prod).

Provisioned environment (Lambda):
- `DDB_TABLE_NAME` (string): Name of the audit table (set by CDK).
- `QUARANTINE_BUCKET_NAME` (string, optional): Name of quarantine bucket.
- `WEBHOOK_URL` (string, optional): Passed through from deploy env.
- `ACCOUNT_ID`, `REGION`, `ENVIRONMENT`: Passed by CDK for naming/observability.

### Deploy

1. Install dependencies
```
npm ci
```

2. Create .env from example and fill values
```
cp .env.example .env
# edit .env and set SOURCE_BUCKET_ARN, optional QUARANTINE_BUCKET_ARN, WEBHOOK_URL
# Optionally set ENVIRONMENT, ACCOUNT_ID, REGION (otherwise CDK_DEFAULT_* are used)
```

3. Synthesize and deploy
```
npx cdk synth
npx cdk deploy
```

### Operations & Notes

- The Lambda container installs ClamAV and fetches virus definitions on cold start into `/tmp/clamav`. This requires outbound internet. Do not place the function in a private subnet without NAT.
- The function memory (≈3 GB), timeout (≈15 min), and ephemeral storage (≈2 GB) are configured to support large objects. Adjust if your files are small.
- Object tagging merges existing tags up to S3’s limit (10 tags). If you already use many tags, consider replacing or reducing tag keys.
- Quarantine: If provided, infected objects are copied to the quarantine bucket with the same key and then deleted from the source. If not provided, infected objects are deleted from the source.
- SQS DLQ is configured for repeated failures. Investigate DLQ messages (e.g., persistent freshclam or permission issues).

### Useful CDK commands

- `npm run build`   compile typescript to js
- `npm run watch`   watch for changes and compile
- `npm run test`    perform the jest unit tests
- `npx cdk deploy`  deploy this stack to your default AWS account/region
- `npx cdk diff`    compare deployed stack with current state
- `npx cdk synth`   emits the synthesized CloudFormation template
