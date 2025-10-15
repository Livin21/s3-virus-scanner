import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';

export class S3VirusScannerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const accountId = this.account;
    const region = this.region;
    const environment = process.env.ENVIRONMENT || 'dev';

    const sourceBucketArn = process.env.SOURCE_BUCKET_ARN;
    if (!sourceBucketArn) {
      throw new Error('SOURCE_BUCKET_ARN environment variable is required at synth time');
    }
    const quarantineBucketArn = process.env.QUARANTINE_BUCKET_ARN;
    const webhookUrl = process.env.WEBHOOK_URL ?? '';

    // S3 Buckets (import source, optionally import quarantine)
    const sourceBucket = s3.Bucket.fromBucketArn(this, 'SourceBucket', sourceBucketArn);
    const sourceBucketName = sourceBucketArn.split(':::')[1];
    // S3 Notification -> SQS for imported bucket using custom resource + queue policy
    const quarantineBucket = quarantineBucketArn
      ? s3.Bucket.fromBucketArn(this, 'QuarantineBucket', quarantineBucketArn)
      : undefined;

    // Definitions cache bucket
    const defsBucket = new s3.Bucket(this, 'ClamAvDefinitionsBucket', {
      bucketName: `clamav-defs-${environment}-${accountId}-${region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const defsKey = 'clamav/defs/db.tar.gz';

    // SQS Queue + DLQ for S3 notifications
    const dlq = new sqs.Queue(this, 'ScannerDLQ', {
      queueName: `clamav-scanner-dlq-${environment}-${accountId}-${region}`,
      retentionPeriod: cdk.Duration.days(14),
    });
    const queue = new sqs.Queue(this, 'ScannerQueue', {
      queueName: `clamav-scanner-queue-${environment}-${accountId}-${region}`,
      visibilityTimeout: cdk.Duration.minutes(16), // > lambda timeout
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: dlq,
      },
    });

    // Allow S3 to send messages to the queue
    queue.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal('s3.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [queue.queueArn],
      conditions: {
        ArnLike: { 'aws:SourceArn': `arn:aws:s3:::${sourceBucketName}` },
      },
    }));

    // Configure S3 bucket notification to SQS for OBJECT_CREATED events via Custom Resource
    new cr.AwsCustomResource(this, 'ConfigureS3ToSqsNotification', {
      onCreate: {
        service: 'S3',
        action: 'putBucketNotificationConfiguration',
        parameters: {
          Bucket: sourceBucketName,
          NotificationConfiguration: {
            QueueConfigurations: [
              {
                Events: [
                  's3:ObjectCreated:Put',
                  's3:ObjectCreated:Post',
                  's3:ObjectCreated:Copy',
                  's3:ObjectCreated:CompleteMultipartUpload',
                ],
                QueueArn: queue.queueArn,
              },
            ],
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`S3ToSqs-${sourceBucketName}-${queue.queueArn}`),
      },
      onUpdate: {
        service: 'S3',
        action: 'putBucketNotificationConfiguration',
        parameters: {
          Bucket: sourceBucketName,
          NotificationConfiguration: {
            QueueConfigurations: [
              {
                Events: [
                  's3:ObjectCreated:Put',
                  's3:ObjectCreated:Post',
                  's3:ObjectCreated:Copy',
                  's3:ObjectCreated:CompleteMultipartUpload',
                ],
                QueueArn: queue.queueArn,
              },
            ],
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`S3ToSqs-${sourceBucketName}-${queue.queueArn}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            's3:PutBucketNotification',
            's3:GetBucketNotification',
          ],
          resources: [`arn:aws:s3:::${sourceBucketName}`],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['sqs:GetQueueAttributes', 'sqs:SetQueueAttributes'],
          resources: [queue.queueArn],
        }),
      ]),
    });

    // Audit table
    const auditTable = new dynamodb.Table(this, 'ScanAuditTable', {
      tableName: `clamav-scan-audit-${environment}-${accountId}-${region}`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Scanner Lambda (Docker image)
    const scannerFn = new lambda.DockerImageFunction(this, 'ScannerFunction', {
      functionName: `clamav-scanner-${environment}-${accountId}-${region}`,
      code: lambda.DockerImageCode.fromImageAsset('lambda/scanner'),
      architecture: lambda.Architecture.X86_64,
      memorySize: 3072,
      ephemeralStorageSize: cdk.Size.gibibytes(2),
      timeout: cdk.Duration.minutes(15),
      environment: {
        DDB_TABLE_NAME: auditTable.tableName,
        DEFS_BUCKET_NAME: defsBucket.bucketName,
        DEFS_KEY: defsKey,
        QUARANTINE_BUCKET_NAME: quarantineBucket?.bucketName ?? '',
        WEBHOOK_URL: webhookUrl,
        ACCOUNT_ID: accountId,
        REGION: region,
        ENVIRONMENT: environment,
      },
    });

    // SQS event source for scanner
    scannerFn.addEventSource(new lambdaEventSources.SqsEventSource(queue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    // Permissions for scanner
    auditTable.grantWriteData(scannerFn);
    defsBucket.grantRead(scannerFn);
    // Read/Write (get/put/copy/delete) on source bucket
    sourceBucket.grantReadWrite(scannerFn);
    // Tagging permissions on source bucket
    scannerFn.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        's3:GetObjectTagging',
        's3:PutObjectTagging',
      ],
      resources: [
        `${sourceBucket.bucketArn}/*`,
      ],
    }));
    if (quarantineBucket) {
      quarantineBucket.grantWrite(scannerFn);
      scannerFn.addToRolePolicy(new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          's3:PutObjectTagging',
        ],
        resources: [
          `${quarantineBucket.bucketArn}/*`,
        ],
      }));
    }

    // Updater Lambda (Docker image) to refresh definitions into S3
    const updaterFn = new lambda.DockerImageFunction(this, 'DefsUpdaterFunction', {
      functionName: `clamav-defs-updater-${environment}-${accountId}-${region}`,
      code: lambda.DockerImageCode.fromImageAsset('lambda/defs-updater'),
      architecture: lambda.Architecture.X86_64,
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.gibibytes(3),
      timeout: cdk.Duration.minutes(15),
      environment: {
        DEFS_BUCKET_NAME: defsBucket.bucketName,
        DEFS_KEY: defsKey,
        ACCOUNT_ID: accountId,
        REGION: region,
        ENVIRONMENT: environment,
      },
    });
    defsBucket.grantWrite(updaterFn);

    // Schedule the updater
    const schedule = new events.Rule(this, 'DefsUpdaterSchedule', {
      ruleName: `clamav-defs-updater-schedule-${environment}-${accountId}-${region}`,
      schedule: events.Schedule.rate(cdk.Duration.hours(4)),
      targets: [new targets.LambdaFunction(updaterFn)],
    });
  }
}
