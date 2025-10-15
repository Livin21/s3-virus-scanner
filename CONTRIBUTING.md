# Contributing to S3 Virus Scanner

First off, thank you for considering contributing to S3 Virus Scanner! It's people like you that make this tool better for everyone.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Commit Message Guidelines](#commit-message-guidelines)

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples** (sample files, configuration, etc.)
- **Describe the behavior you observed and what you expected**
- **Include logs and error messages** (sanitize any sensitive information)
- **Specify your environment** (AWS region, Lambda memory, Node.js version, etc.)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion:

- **Use a clear and descriptive title**
- **Provide a detailed description of the proposed enhancement**
- **Explain why this enhancement would be useful** to most users
- **List any alternatives you've considered**
- **Include mockups or examples** if applicable

### Your First Code Contribution

Unsure where to begin? You can start by looking through these issues:

- `good-first-issue` - Issues that should only require a few lines of code
- `help-wanted` - Issues that may be more involved but are good for contributors

### Pull Requests

- Fill in the pull request template
- Follow the coding standards
- Include tests when adding new features
- Update documentation for any changed functionality
- End all files with a newline

## Development Setup

### Prerequisites

- Node.js 18.x or later
- AWS CLI configured with credentials
- Docker Desktop installed and running
- AWS CDK CLI (`npm install -g aws-cdk`)
- An AWS account for testing

### Local Setup

1. **Fork and clone the repository**

```bash
git clone https://github.com/yourusername/s3_virus_scanner.git
cd s3_virus_scanner
```

2. **Install dependencies**

```bash
npm ci
```

3. **Set up environment variables**

```bash
cp env.example .env
# Edit .env with your test AWS resources
```

4. **Build the project**

```bash
npm run build
```

5. **Run tests**

```bash
npm test
```

### Project Structure

```
.
├── bin/                    # CDK app entry point
├── lib/                    # CDK stack definitions
├── lambda/                 # Lambda function code
│   ├── scanner/           # Virus scanner Lambda
│   │   ├── index.js       # Scanner handler
│   │   ├── Dockerfile     # Scanner container
│   │   └── package.json   # Scanner dependencies
│   └── defs-updater/      # Definitions updater Lambda
│       ├── index.js       # Updater handler
│       ├── Dockerfile     # Updater container
│       └── package.json   # Updater dependencies
├── test/                   # CDK tests
├── cdk.json               # CDK configuration
├── package.json           # Project dependencies
└── tsconfig.json          # TypeScript configuration
```

### Testing Locally

#### Unit Tests

```bash
npm test
```

#### Testing Lambda Functions Locally

You can test Lambda functions locally using Docker:

```bash
# Build scanner image
cd lambda/scanner
docker build -t s3-scanner-test .

# Run scanner locally (requires AWS credentials)
docker run --rm \
  -e AWS_ACCESS_KEY_ID=xxx \
  -e AWS_SECRET_ACCESS_KEY=xxx \
  -e AWS_REGION=us-east-1 \
  -e DDB_TABLE_NAME=test-table \
  -e DEFS_BUCKET_NAME=test-defs \
  s3-scanner-test
```

#### Testing CDK Stack

```bash
# Synthesize CloudFormation template
npx cdk synth

# Deploy to a test AWS account
npx cdk deploy --profile test-profile
```

## Pull Request Process

1. **Create a branch** from `main` with a descriptive name:
   - `feature/add-custom-scan-rules`
   - `fix/memory-leak-in-scanner`
   - `docs/update-deployment-guide`

2. **Make your changes** following the coding standards

3. **Write or update tests** to cover your changes

4. **Update documentation**:
   - Update README.md if adding features or changing configuration
   - Add JSDoc comments to new functions
   - Update CHANGELOG.md (if exists)

5. **Run tests and linting**:
```bash
npm test
npm run build
```

6. **Commit your changes** following commit message guidelines

7. **Push to your fork** and create a pull request

8. **Fill out the PR template** completely

9. **Wait for review**:
   - Address any feedback from maintainers
   - Keep your branch up to date with main
   - Be patient and responsive to comments

10. **Merge**: Once approved, a maintainer will merge your PR

## Coding Standards

### JavaScript/Node.js

- Use **ES6+ features** (arrow functions, async/await, destructuring)
- Follow **strict mode** (`'use strict';`)
- Use **camelCase** for variables and functions
- Use **PascalCase** for classes and constructors
- Use **UPPER_SNAKE_CASE** for constants
- **No semicolons** are optional, but be consistent
- Add **JSDoc comments** for exported functions

Example:
```javascript
/**
 * Scans a file for malware using ClamAV
 * @param {string} filePath - Path to the file to scan
 * @returns {Object} Scan result with infected, signature, and exitCode
 */
function scanFile(filePath) {
  // implementation
}
```

### TypeScript (CDK)

- Use **explicit types** where possible
- Avoid `any` type unless absolutely necessary
- Use **interfaces** for object shapes
- Follow the existing CDK patterns in the codebase

### Docker

- Use **official base images**
- Minimize **layer count** and image size
- **Don't run as root** in production images
- **Pin versions** for reproducibility

### General

- **Keep functions small** and focused (single responsibility)
- **Avoid magic numbers** - use named constants
- **Handle errors gracefully** with proper logging
- **Log important events** using structured logging
- **Don't commit secrets** or sensitive data
- **Remove console.log** for debugging (use proper logging)

## Testing Guidelines

### Test Coverage

- Aim for **>80% code coverage** for new features
- Write **unit tests** for business logic
- Write **integration tests** for CDK stacks
- Include **edge cases** and error scenarios

### Test Structure

```javascript
describe('scanFile', () => {
  it('should detect infected files', () => {
    // test implementation
  });

  it('should mark clean files as clean', () => {
    // test implementation
  });

  it('should handle scan errors gracefully', () => {
    // test implementation
  });
});
```

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- scanner.test.js

# Watch mode
npm test -- --watch
```

## Commit Message Guidelines

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- **feat**: A new feature
- **fix**: A bug fix
- **docs**: Documentation only changes
- **style**: Code style changes (formatting, missing semicolons, etc.)
- **refactor**: Code change that neither fixes a bug nor adds a feature
- **perf**: Performance improvement
- **test**: Adding or updating tests
- **chore**: Changes to build process or auxiliary tools

### Examples

```
feat(scanner): add support for custom scan rules

Add ability to define custom ClamAV scan rules via environment variable.
This allows users to customize scanning behavior for specific use cases.

Closes #123
```

```
fix(updater): handle freshclam timeout gracefully

Previously the updater would crash if freshclam took too long.
Now it logs the error and continues with cached definitions.

Fixes #456
```

```
docs(readme): update deployment instructions

Add missing step for Docker login to ECR before deployment.
```

## Questions?

Don't hesitate to ask questions! You can:

- Open an issue with the `question` label
- Start a discussion in GitHub Discussions
- Reach out to maintainers

## Recognition

Contributors will be recognized in:
- GitHub contributors page
- Release notes (for significant contributions)
- Special thanks in documentation (for major features)

---

Thank you for contributing to S3 Virus Scanner! 🎉

