import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as S3VirusScanner from '../lib/s3_virus_scanner-stack';

const iamPoliciesAsString = (template: Template) => JSON.stringify(template.findResources('AWS::IAM::Policy'));

describe('S3VirusScannerStack', () => {
  let app: cdk.App;
  let stack: S3VirusScanner.S3VirusScannerStack;
  let template: Template;

  beforeAll(() => {
    // Set required environment variables
    process.env.SOURCE_BUCKET_ARN = 'arn:aws:s3:::test-source-bucket';
    process.env.ENVIRONMENT = 'test';

    app = new cdk.App();
    stack = new S3VirusScanner.S3VirusScannerStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    template = Template.fromStack(stack);
  });

  afterAll(() => {
    // Clean up environment variables
    delete process.env.SOURCE_BUCKET_ARN;
    delete process.env.QUARANTINE_BUCKET_ARN;
    delete process.env.WEBHOOK_URL;
    delete process.env.ENVIRONMENT;
  });

  describe('SQS Resources', () => {
    test('Creates SQS Queue with correct configuration', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        VisibilityTimeout: 960, // 16 minutes (> Lambda timeout)
        MessageRetentionPeriod: 345600, // 4 days
      });
    });

    test('Creates Dead Letter Queue', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        MessageRetentionPeriod: 1209600, // 14 days
      });
    });

    test('Configures DLQ on main queue', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        RedrivePolicy: {
          maxReceiveCount: 5,
          deadLetterTargetArn: Match.anyValue(),
        },
      });
    });

    test('Queue has policy allowing S3 to send messages', () => {
      template.hasResourceProperties('AWS::SQS::QueuePolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Principal: { Service: 's3.amazonaws.com' },
              Action: 'sqs:SendMessage',
            }),
          ]),
        },
      });
    });
  });

  describe('Lambda Functions', () => {
    test('Creates Scanner Lambda with correct configuration', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 3072,
        Timeout: 900, // 15 minutes
        PackageType: 'Image',
      });
    });

    test('Scanner Lambda has required environment variables', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            DDB_TABLE_NAME: Match.anyValue(),
            DEFS_BUCKET_NAME: Match.anyValue(),
            DEFS_KEY: 'clamav/defs/db.tar.gz',
            ACCOUNT_ID: Match.anyValue(),
            REGION: Match.anyValue(),
            ENVIRONMENT: 'test',
          }),
        },
      });
    });

    test('Creates Definitions Updater Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 2048,
        Timeout: 900,
        PackageType: 'Image',
      });
    });

    test('Scanner Lambda has SQS event source', () => {
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        BatchSize: 1,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      });
    });
  });

  describe('DynamoDB Resources', () => {
    test('Creates Audit Table with correct configuration', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'id', KeyType: 'HASH' }
        ],
        AttributeDefinitions: [
          { AttributeName: 'id', AttributeType: 'S' }
        ],
      });
    });
  });

  describe('S3 Resources', () => {
    test('Creates Definitions Cache Bucket', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.anyValue(),
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    test('Definitions bucket enforces SSL', () => {
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Principal: { AWS: '*' },
              Action: 's3:*',
              Condition: {
                Bool: { 'aws:SecureTransport': 'false' }
              }
            })
          ])
        }
      });
    });
  });

  describe('EventBridge Resources', () => {
    test('Creates schedule for definitions updater', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        ScheduleExpression: 'rate(4 hours)',
        State: 'ENABLED',
      });
    });

    test('EventBridge rule targets updater Lambda', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: Match.anyValue(),
          })
        ])
      });
    });
  });

  describe('IAM Permissions', () => {
    test('Scanner Lambda policies include DynamoDB access', () => {
      expect(iamPoliciesAsString(template)).toContain('dynamodb:PutItem');
    });

    test('Scanner Lambda policies include S3 access', () => {
      expect(iamPoliciesAsString(template)).toMatch(/s3:(Get|Put|Delete)Object/);
    });

    test('Updater Lambda policies include S3 write access', () => {
      const policyStr = iamPoliciesAsString(template);
      expect(policyStr).toMatch(/s3:(Put|Delete)Object/);
    });
  });

  describe('Resource Naming', () => {
    test('Resources use environment-specific names', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: Match.stringLikeRegexp('.*test.*'),
      });

      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: Match.stringLikeRegexp('.*test.*'),
      });
    });
  });

  describe('Stack with Quarantine Bucket', () => {
    let stackWithQuarantine: S3VirusScanner.S3VirusScannerStack;
    let templateWithQuarantine: Template;

    beforeAll(() => {
      process.env.QUARANTINE_BUCKET_ARN = 'arn:aws:s3:::test-quarantine-bucket';
      
      const appWithQuarantine = new cdk.App();
      stackWithQuarantine = new S3VirusScanner.S3VirusScannerStack(
        appWithQuarantine, 
        'TestStackWithQuarantine',
        { env: { account: '123456789012', region: 'us-east-1' } }
      );
      templateWithQuarantine = Template.fromStack(stackWithQuarantine);
    });

    afterAll(() => {
      delete process.env.QUARANTINE_BUCKET_ARN;
    });

    test('Scanner Lambda has QUARANTINE_BUCKET_NAME environment variable', () => {
      templateWithQuarantine.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            QUARANTINE_BUCKET_NAME: 'test-quarantine-bucket',
          }),
        },
      });
    });

    test('Scanner Lambda has write permissions to quarantine bucket', () => {
      expect(iamPoliciesAsString(templateWithQuarantine)).toContain('test-quarantine-bucket');
    });
  });

  describe('Error Cases', () => {
    test('Throws error when SOURCE_BUCKET_ARN is missing', () => {
      delete process.env.SOURCE_BUCKET_ARN;
      
      expect(() => {
        const errorApp = new cdk.App();
        new S3VirusScanner.S3VirusScannerStack(errorApp, 'ErrorStack');
      }).toThrow('SOURCE_BUCKET_ARN environment variable is required');

      // Restore for other tests
      process.env.SOURCE_BUCKET_ARN = 'arn:aws:s3:::test-source-bucket';
    });
  });

  describe('Resource Count', () => {
    test('Creates expected number of Lambda functions', () => {
      const lambdas = template.findResources('AWS::Lambda::Function');
      // Scanner + Updater + Custom Resource handler(s)
      expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(2);
    });

    test('Creates expected number of SQS queues', () => {
      const queues = template.findResources('AWS::SQS::Queue');
      expect(Object.keys(queues).length).toBe(2); // Main queue + DLQ
    });

    test('Creates single DynamoDB table', () => {
      const tables = template.findResources('AWS::DynamoDB::Table');
      expect(Object.keys(tables).length).toBe(1);
    });
  });
});
