'use strict';

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const s3 = new S3Client({});
const DEFS_BUCKET_NAME = process.env.DEFS_BUCKET_NAME;
const DEFS_KEY = process.env.DEFS_KEY || 'clamav/defs/db.tar.gz';

async function downloadS3Defs(downloadPath, bucket) {
  // Download existing freshclam.conf from S3 if it exists
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'freshclam.conf' }));
    if (resp.Body?.transformToByteArray) {
      const bytes = await resp.Body.transformToByteArray();
      fs.writeFileSync(path.join(downloadPath, 'freshclam.conf'), Buffer.from(bytes));
      console.log('Downloaded existing freshclam.conf from S3');
    }
  } catch (e) {
    console.log('No existing freshclam.conf in S3, will create new one');
  }
}

async function uploadS3Defs(downloadPath, bucket) {
  // Upload all CVD/CLD and conf files to S3
  for (const file of fs.readdirSync(downloadPath)) {
    if (file.match(/\w+\.(cvd|cld|conf)$/)) {
      const filePath = path.join(downloadPath, file);
      const fileSize = fs.statSync(filePath).size;
      console.log(`Uploading ${file} (${fileSize} bytes) to S3...`);
      
      const body = fs.readFileSync(filePath); // Read entire file for reliability
      await s3.send(new PutObjectCommand({ 
        Bucket: bucket, 
        Key: file, 
        Body: body,
        ContentType: file.endsWith('.conf') ? 'text/plain' : 'application/octet-stream'
      }));
      console.log(`Successfully uploaded ${file} to S3`);
    }
  }
}

function freshclamUpdate(downloadPath) {
  const conf = path.join(downloadPath, 'freshclam.conf');
  
  // Create freshclam.conf if it doesn't exist
  if (!fs.existsSync(conf)) {
    const config = [
      'DNSDatabaseInfo current.cvd.clamav.net',
      'DatabaseMirror database.clamav.net',
      'ReceiveTimeout 0',
      'CompressLocalDatabase true'
    ].join('\n');
    fs.writeFileSync(conf, config);
  }

  const username = process.env.USER || 'sbx_user1051';
  const command = [
    'freshclam',
    `--config-file=${conf}`,
    '--stdout',
    '-u', username,
    `--datadir=${downloadPath}`
  ];
  
  console.log('Running freshclam with command:', command.join(' '));
  const result = spawnSync('freshclam', command.slice(1), { encoding: 'utf-8' });
  
  console.log('freshclam result', { 
    status: result.status, 
    stdout: result.stdout?.slice(0, 1000), 
    stderr: result.stderr?.slice(0, 1000) 
  });
  
  if (result.status !== 0) {
    throw new Error(`FreshClam exited with code: ${result.status}\nOutput: ${result.stdout}`);
  }
}

export const handler = async () => {
  if (!DEFS_BUCKET_NAME) throw new Error('Missing DEFS_BUCKET_NAME');

  console.log('Starting ClamAV definitions update', { bucket: DEFS_BUCKET_NAME, key: DEFS_KEY });

  const downloadPath = '/tmp';
  
  // Download existing definitions from S3 (if any)
  await downloadS3Defs(downloadPath, DEFS_BUCKET_NAME);
  
  // Run freshclam to update definitions
  freshclamUpdate(downloadPath);
  
  // Upload updated definitions back to S3
  await uploadS3Defs(downloadPath, DEFS_BUCKET_NAME);
  
  // Also create a tarball for backward compatibility
  const files = fs.readdirSync(downloadPath).filter(f => f.match(/\.(cvd|cld)$/));
  console.log('Definition files to package', { count: files.length, files });
  
  if (files.length > 0) {
    const tarPath = path.join(downloadPath, 'db.tar.gz');
    const tar = spawnSync('tar', ['-czf', tarPath, '-C', downloadPath, ...files], { encoding: 'utf-8' });
    
    const tarSize = fs.statSync(tarPath).size;
    console.log('Tarball created', { path: tarPath, sizeBytes: tarSize });
    
    // Read tarball into memory for reliable upload
    const tarBody = fs.readFileSync(tarPath);
    await s3.send(new PutObjectCommand({ 
      Bucket: DEFS_BUCKET_NAME, 
      Key: DEFS_KEY, 
      Body: tarBody, 
      ContentType: 'application/gzip' 
    }));
    console.log('Uploaded tarball to S3', { key: DEFS_KEY, sizeBytes: tarSize });
  }

  return { ok: true, bucket: DEFS_BUCKET_NAME, filesCount: files.length };
};


