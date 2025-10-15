# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

We take the security of S3 Virus Scanner seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### Please Do Not

- **Open a public GitHub issue** for security vulnerabilities
- **Disclose the vulnerability publicly** before it has been addressed

### Please Do

1. **Email the maintainers** with details of the vulnerability
2. **Include the following information** in your report:
   - Type of vulnerability (e.g., authentication bypass, injection, etc.)
   - Full paths of source file(s) related to the vulnerability
   - Location of the affected source code (tag/branch/commit or direct URL)
   - Step-by-step instructions to reproduce the issue
   - Proof-of-concept or exploit code (if possible)
   - Impact of the vulnerability and potential attack scenarios

3. **Allow time for a fix** - We aim to respond within 48 hours and provide a fix within 7 days for critical issues

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your vulnerability report within 48 hours
- **Communication**: We will keep you informed about the progress of addressing the vulnerability
- **Credit**: We will credit you in the security advisory (unless you prefer to remain anonymous)
- **Disclosure**: Once a fix is available, we will coordinate public disclosure with you

## Security Best Practices for Users

When deploying S3 Virus Scanner, follow these security best practices:

### AWS Infrastructure

1. **Use Private Subnets with NAT Gateway**
   - Deploy Lambda functions in private subnets
   - Use NAT Gateway for outbound internet access (for freshclam)
   - Never expose Lambda functions directly to the internet

2. **Enable Encryption**
   - Enable encryption at rest for all S3 buckets
   - Use AWS KMS for encryption keys
   - Enable encryption in transit (HTTPS/TLS)

3. **IAM Permissions**
   - Follow principle of least privilege
   - Use IAM roles, not access keys
   - Regularly audit IAM permissions
   - Enable MFA for sensitive operations

4. **Network Security**
   - Use VPC endpoints for AWS services when possible
   - Restrict security group rules to minimum required
   - Enable VPC Flow Logs for network monitoring

### Application Security

1. **Quarantine Bucket**
   - Always configure a quarantine bucket in production
   - Block all public access to quarantine bucket
   - Enable versioning for forensic investigation
   - Implement lifecycle policies to automatically delete old files

2. **Monitoring and Logging**
   - Enable CloudTrail for all API calls
   - Monitor CloudWatch Logs for suspicious activity
   - Set up CloudWatch Alarms for:
     - High infection rates
     - Lambda errors
     - DLQ message count
   - Regularly review DynamoDB audit logs

3. **Virus Definitions**
   - Keep definitions updated (default: every 4 hours)
   - Monitor updater Lambda for failures
   - Implement alerting if definitions become stale

4. **File Size Limits**
   - Set appropriate max file size limits
   - Consider Lambda timeout and memory constraints
   - Implement file type validation if needed

5. **Webhook Security**
   - Use HTTPS endpoints only
   - Implement authentication/authorization on webhook endpoint
   - Validate webhook payloads
   - Rate limit webhook requests

### Operational Security

1. **Secrets Management**
   - Never commit `.env` files or secrets to version control
   - Use AWS Secrets Manager or Parameter Store for sensitive data
   - Rotate credentials regularly

2. **Access Control**
   - Limit who can deploy infrastructure changes
   - Require code review for all changes
   - Use branch protection rules
   - Enable audit logging for deployments

3. **Updates and Patching**
   - Keep dependencies up to date
   - Monitor for security advisories
   - Test updates in staging before production
   - Subscribe to AWS security bulletins

4. **Incident Response**
   - Have a plan for security incidents
   - Know how to quickly quarantine/delete infected files
   - Document escalation procedures
   - Regularly backup audit logs

### Data Privacy

1. **Sensitive Data**
   - Be aware that file metadata is logged to DynamoDB
   - Sanitize logs before sharing
   - Consider data residency requirements
   - Implement data retention policies

2. **Compliance**
   - Ensure deployment meets your compliance requirements (HIPAA, GDPR, etc.)
   - Document security controls
   - Conduct regular security assessments

## Known Security Considerations

### ClamAV Limitations

- ClamAV is signature-based and may not detect zero-day threats
- Encrypted/password-protected files cannot be scanned
- Very large files may timeout or exceed memory limits
- Consider using ClamAV as one layer in a defense-in-depth strategy

### Lambda Execution

- Lambda functions have access to files during scanning
- Ensure proper IAM boundaries to prevent privilege escalation
- Monitor for unusual Lambda execution patterns

### S3 Event Processing

- There is a small window between file upload and scan completion
- Consider using S3 Object Lock for critical files
- Implement additional controls for immediate access requirements

## Security Updates

Security updates will be released as soon as possible after a vulnerability is confirmed. Updates will be announced via:

- GitHub Security Advisories
- Release notes with `[SECURITY]` tag
- GitHub repository security tab

## Compliance

This project aims to follow:

- OWASP Top 10 best practices
- AWS Security Best Practices
- CIS AWS Foundations Benchmark (where applicable)

## Questions?

If you have questions about security that are not sensitive in nature, feel free to:

- Open a GitHub issue with the `security` label
- Start a discussion in GitHub Discussions

For sensitive security matters, please follow the vulnerability reporting process above.

---

**Thank you for helping keep S3 Virus Scanner and its users safe!**

