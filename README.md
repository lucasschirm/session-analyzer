# session-analyzer

## Husky Pre-commit Hook

This project uses [Husky](https://typicode.github.io/husky/) to enforce code quality before commits.

### How it works

- A pre-commit hook is configured to run `npm run build` before every commit
- If the build fails (TypeScript errors or Vite build issues), the commit is blocked
- If the build succeeds, the commit proceeds normally

### Setup

Husky is automatically installed when you run `npm install` thanks to the `prepare` script in `package.json`.

### Commands

```bash
# Install dependencies (includes husky setup)
npm install

# Run build manually
npm run build

# Commit changes (build runs automatically)
git commit -m "your message"
```