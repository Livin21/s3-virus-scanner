#!/usr/bin/env node
import 'dotenv/config';
import * as cdk from 'aws-cdk-lib';
import { S3VirusScannerStack } from '../lib/s3_virus_scanner-stack';

const app = new cdk.App();
new S3VirusScannerStack(app, 'S3VirusScannerStack', {
  env: {
    account: process.env.ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.REGION || process.env.CDK_DEFAULT_REGION,
  },
});