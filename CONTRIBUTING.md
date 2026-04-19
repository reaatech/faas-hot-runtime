# Contributing to faas-hot-runtime

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Getting Started

### Prerequisites

- Node.js 22+
- npm or pnpm
- Docker (for local testing)

### Development Setup

```bash
# Fork and clone the repository
git clone https://github.com/reaatech/faas-hot-runtime.git
cd faas-hot-runtime

# Install dependencies
npm install

# Set up environment
cp .env.example .env

# Start development mode
npm run dev
```

## Development Workflow

### Code Quality

```bash
# Run linter
npm run lint

# Check formatting
npm run format:check

# Format code
npm run format

# Type check
npm run typecheck
```

### Testing

```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

### Adding New Features

1. Create a feature branch from `main`
2. Write tests for your changes
3. Ensure all tests pass and coverage meets thresholds
4. Update documentation as needed
5. Submit a pull request

### Adding New Triggers

To add a new trigger type:

1. Create a new file in `src/triggers/` (e.g., `kafka-trigger.ts`)
2. Implement the trigger interface:
   ```typescript
   export interface TriggerHandler {
     start(): Promise<void>;
     stop(): Promise<void>;
     handleEvent(event: unknown): Promise<void>;
   }
   ```
3. Add the trigger type to the `TriggerConfig` schema in `src/types/schemas.ts`
4. Register the trigger in the trigger router
5. Add tests in `tests/unit/triggers/`

### Adding New Skills

Skills are defined in the `skills/` directory. Each skill should:

1. Have a `skill.md` file describing the capability
2. Include usage examples
3. Reference relevant source code files

## Code Style

- Use TypeScript strict mode
- Follow ESLint rules (no console.log in production code)
- Use single quotes for strings
- Include trailing commas in multi-line objects
- Use 2-space indentation

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation changes
- `refactor:` — code refactoring
- `test:` — test additions/changes
- `chore:` — build/config changes

## Pull Request Process

1. Ensure all CI checks pass
2. Request review from maintainers
3. Address review feedback
4. Squash commits if needed
5. Merge after approval

## Reporting Issues

- Use the GitHub issue template
- Include steps to reproduce
- Provide relevant logs and environment details

## Security

- Report security vulnerabilities privately
- Do not commit secrets or API keys
- Use `.env.example` for environment variable documentation

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
