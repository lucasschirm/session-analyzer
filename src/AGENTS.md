# AGENTS.md - Source Directory Overview

This document describes all files in the `src` directory for AI agents and developers.

## Directory Structure

```
src/
├── main.ts                      # Application entry point
├── components/
│   └── dashboard-components.ts  # Dashboard UI components
├── db/
│   └── database.ts              # Database configuration and operations
├── pages/
│   └── app-root.ts              # Root page component
├── types/
│   └── index.ts                 # TypeScript type definitions
└── workers/
    └── session-parser.worker.ts # Web worker for session parsing
```

## File Descriptions

### Root Level

- **main.ts**: The main entry point of the application. Initializes and bootstraps the app.

### components/

- **dashboard-components.ts**: Contains React/Vue components related to the dashboard UI. Exports reusable dashboard components.

### db/

- **database.ts**: Handles database connections, queries, and data access logic. Contains the database schema and CRUD operations.

### pages/

- **app-root.ts**: The root page component that serves as the main container for the application's routing and layout.

### types/

- **index.ts**: Centralized TypeScript type definitions and interfaces used throughout the application. Exports all shared types.

### workers/

- **session-parser.worker.ts**: A Web Worker that handles session parsing operations in a separate thread to avoid blocking the main thread. Used for heavy computational tasks related to session data processing.

## Notes for Agents

- All TypeScript files should follow the project's coding standards
- Type definitions in `types/index.ts` should be used instead of inline types when possible
- Web workers should be used for CPU-intensive operations to maintain UI responsiveness
- Database operations should be performed through the `db/database.ts` module only
