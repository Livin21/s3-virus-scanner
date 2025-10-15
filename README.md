# S3 Virus Scanner

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Serverless, event-driven malware scanning for AWS S3 using [ClamAV](https://www.clamav.net/). Automatically scan files uploaded to S3 buckets, tag clean files, quarantine or delete infected files, and maintain an audit trail.

## 🚀 Features

- **Automated Scanning**: Automatically scan files when uploaded to S3 using event-driven architecture
- **ClamAV Integration**: Industry-standard open-source antivirus engine
- **Efficient Definitions Management**: ClamAV virus definitions cached in S3 and updated automatically
- **Flexible Handling**: Tag clean files, quarantine or delete infected files
- **Audit Trail**: All scan results stored in DynamoDB for compliance and tracking
- **Webhook Support**: Optional webhook notifications for scan results
- **Serverless**: No servers to manage, scales automatically
- **Cost Effective**: Pay only for what you use with Lambda and on-demand DynamoDB
- **Infrastructure as Code**: Complete AWS CDK deployment

## 📋 Table of Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Operations](#operations)
- [How It Works](#how-it-works)
- [Cost Considerations](#cost-considerations)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## 🏗️ Architecture

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
                                 └────── Scanner Lambda pulls definitions
```

### Components

1. **S3 Source Bucket**: Your existing S3 bucket to be scanned
2. **SQS Queue**: Receives S3 event notifications with dead-letter queue for failed messages
3. **Scanner Lambda**: Docker container with ClamAV that scans files
4. **Definitions Cache**: S3 bucket storing ClamAV virus definitions
5. **Updater Lambda**: Periodically updates virus definitions using freshclam
6. **DynamoDB Table**: Stores audit records of all scans
7. **Quarantine Bucket** (optional): Stores infected files for investigation
8. **Webhook** (optional): Receives POST notifications of scan results

## 📦 Prerequisites

- **AWS Account** with appropriate permissions
- **Node.js** 18.x or later
- **AWS CDK** 2.x (`npm install -g aws-cdk`)
- **Docker** installed and running (for building Lambda container images)
- **AWS CLI** configured with credentials

### IAM Permissions Required

The deploying user/role needs permissions to:
- Create/manage Lambda functions
- Create/manage S3 buckets and notifications
- Create/manage SQS queues
- Create/manage DynamoDB tables
- Create/manage IAM roles and policies
- Create/manage EventBridge rules

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/s3_virus_scanner.git
cd s3_virus_scanner
```

### 2. Install Dependencies

```bash
npm ci
```

### 3. Configure Environment

```bash
cp env.example .env
```

Edit `.env` and set your configuration:

```bash
# Required
SOURCE_BUCKET_ARN=arn:aws:s3:::your-bucket-name

# Optional
QUARANTINE_BUCKET_ARN=arn:aws:s3:::your-quarantine-bucket-name
WEBHOOK_URL=https://your-webhook-endpoint.com/scan-results
ENVIRONMENT=prod
```

### 4. Bootstrap CDK (First Time Only)

```bash
cdk bootstrap
```

### 5. Deploy

```bash
cdk deploy
```

Review the changes and confirm the deployment.

## ⚙️ Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SOURCE_BUCKET_ARN` | ARN of the S3 bucket to scan | `arn:aws:s3:::my-uploads-bucket` |

### Optional Environment Variables

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `QUARANTINE_BUCKET_ARN` | ARN of bucket for infected files | - | `arn:aws:s3:::my-quarantine-bucket` |
| `WEBHOOK_URL` | HTTPS URL for scan result notifications | - | `https://api.example.com/webhook` |
| `ENVIRONMENT` | Environment name for resource naming | `dev` | `prod`, `staging` |
| `ACCOUNT_ID` | AWS Account ID | CDK default | `123456789012` |
| `REGION` | AWS Region | CDK default | `us-east-1` |

### Webhook Payload Format

When configured, the webhook receives POST requests with the following JSON payload:

```json
{
  "id": "uuid",
  "bucket": "bucket-name",
  "key": "path/to/file.pdf",
  "scannedAt": "2025-10-15T12:34:56.789Z",
  "status": "clean|infected|error",
  "signature": "Win.Test.EICAR_HDB-1" // only if infected
}
```

## 🚢 Deployment

### CDK Commands

```bash
# Compile TypeScript
npm run build

# Watch for changes
npm run watch

# Run tests
npm run test

# Synthesize CloudFormation template
cdk synth

# Compare deployed stack with current state
cdk diff

# Deploy to AWS
cdk deploy

# Destroy the stack
cdk destroy
```

### Deployment Notes

- **First deployment** takes longer due to Docker image builds
- **Lambda containers** are automatically built and pushed to ECR
- **S3 notifications** are configured automatically using custom resources
- **Virus definitions** are downloaded on first scanner invocation

## 🔧 Operations

### Lambda Configuration

- **Scanner Memory**: 3 GB (supports large files)
- **Scanner Timeout**: 15 minutes
- **Scanner Ephemeral Storage**: 2 GB (for virus definitions)
- **Updater Memory**: 2 GB
- **Updater Timeout**: 15 minutes
- **Updater Schedule**: Every 4 hours

### Network Requirements

⚠️ **Important**: The Lambda functions require outbound internet access for:
- Scanner: Downloading virus definitions from S3 (or fallback to freshclam)
- Updater: Downloading virus definitions from ClamAV mirrors

**Options**:
1. Deploy Lambda in public subnet (not recommended for production)
2. Deploy Lambda in private subnet with NAT Gateway (recommended)
3. Use S3 definitions cache to minimize internet dependency

### Monitoring and Troubleshooting

#### CloudWatch Logs

Lambda functions log to CloudWatch Logs:
- Scanner: `/aws/lambda/clamav-scanner-{environment}-{account}-{region}`
- Updater: `/aws/lambda/clamav-defs-updater-{environment}-{account}-{region}`

#### Dead Letter Queue

Failed messages are sent to the DLQ after 5 retry attempts. Investigate DLQ messages for:
- Permission errors
- Timeout issues
- freshclam failures
- File size exceeding limits

#### DynamoDB Audit Table

Query the audit table to:
- View scan history
- Track infection rates
- Compliance reporting

### File Handling

#### Clean Files
- Original file remains in source bucket
- Tags added: `scan-status=clean`, `scannedAt`, `engine=ClamAV`

#### Infected Files
- **With quarantine bucket**: File copied to quarantine, then deleted from source
- **Without quarantine bucket**: File deleted from source
- Not tagged (file is removed)

#### Scan Errors
- File remains in source bucket
- Message retried (up to 5 times)
- Eventually moved to DLQ

### Limits

- **Max file size**: 2 GB (configurable in scanner code)
- **S3 tags limit**: 10 tags per object (ensure you have available tag slots)
- **Lambda ephemeral storage**: 2 GB (for virus definitions)
- **SQS message retention**: 4 days
- **DLQ retention**: 14 days

## 🔍 How It Works

### Scanning Flow

1. File uploaded to S3 bucket triggers S3 Event Notification
2. S3 sends message to SQS queue
3. Lambda function triggered by SQS message
4. Lambda downloads file to `/tmp`
5. Lambda scans file with ClamAV using local virus definitions
6. Based on scan result:
   - **Clean**: Add tags to S3 object
   - **Infected**: Quarantine/delete object
   - **Error**: Retry (or send to DLQ)
7. Write audit record to DynamoDB
8. Send webhook notification (if configured)

### Virus Definitions Management

1. **Updater Lambda** runs every 4 hours via EventBridge Schedule
2. Downloads latest virus definitions using `freshclam`
3. Uploads definitions (CVD files) to S3 definitions cache
4. **Scanner Lambda** downloads definitions from S3 cache on cold start
5. Falls back to `freshclam` if cache is unavailable (requires internet)

## 💰 Cost Considerations

Estimated monthly costs for scanning 10,000 files/month (average 5 MB each):

| Service | Cost | Notes |
|---------|------|-------|
| Lambda (Scanner) | ~$15 | 3 GB memory, ~30s per scan |
| Lambda (Updater) | <$1 | Runs every 4 hours |
| S3 (Definitions) | <$1 | ~150 MB storage |
| DynamoDB | ~$1.25 | On-demand, 10K writes/month |
| SQS | <$1 | 10K messages |
| Data Transfer | Variable | Depends on file downloads |

**Total**: ~$18-25/month for 10,000 file scans

💡 Tips to reduce costs:
- Use S3 definitions cache to avoid freshclam on every cold start
- Adjust Lambda memory based on your file sizes
- Use S3 Lifecycle policies on quarantine bucket
- Consider provisioned capacity for DynamoDB at higher volumes

## 🔒 Security

### Best Practices

1. **Use quarantine bucket** to investigate infected files safely
2. **Enable S3 bucket encryption** (enabled by default for definitions bucket)
3. **Restrict IAM permissions** to least privilege
4. **Enable AWS CloudTrail** for audit logging
5. **Review CloudWatch Logs** regularly
6. **Monitor DLQ** for persistent failures
7. **Update virus definitions** frequently (configured to run every 4 hours)
8. **Use VPC endpoints** for S3 access from Lambda (optional)
9. **Enable versioning** on source bucket for recovery

### Reporting Security Issues

Please see [SECURITY.md](SECURITY.md) for information on reporting security vulnerabilities.

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on:
- How to submit issues
- How to submit pull requests
- Code style guidelines
- Development setup

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [ClamAV](https://www.clamav.net/) - Open source antivirus engine
- [AWS CDK](https://aws.amazon.com/cdk/) - Infrastructure as Code framework

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/s3_virus_scanner/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/s3_virus_scanner/discussions)

---

Made with ❤️ by the open source community
