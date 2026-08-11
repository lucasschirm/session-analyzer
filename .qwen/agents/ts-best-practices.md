
# TypeScript Best Practices

This guide outlines essential TypeScript best practices for maintaining scalable, type-safe, and performant codebases across both frontend components and backend services.

## 1. Strict Type Checking
Always enable strict mode in your `tsconfig.json`. This is the foundation of a robust TypeScript project.
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "exactOptionalPropertyTypes": true
  }
}
```
**Why:** It catches null reference errors and forces explicit type declarations, significantly reducing runtime crashes.

## 2. Avoid `any`, Prefer `unknown`
Never use `any` as an escape hatch. If a payload's structure is truly dynamic (e.g., parsing unknown JSON logs from different AI agents), use `unknown`.
```typescript
// ❌ Bad
function parseLog(payload: any) { ... }

// ✅ Good
function parseLog(payload: unknown) {
  if (typeof payload === 'object' && payload !== null && 'type' in payload) {
    // Narrow down the type safely
  }
}
```

## 3. Interfaces vs. Type Aliases
*   Use **`interface`** when defining the shape of objects, class contracts, or component properties (like Lit element properties or NestJS Data Transfer Objects). Interfaces are open for declaration merging and provide slightly better error messages.
*   Use **`type`** when defining unions, intersections, or mapping utility types.
```typescript
// Interface for an object structure
export interface DashboardSession {
  id: string;
  totalTokens: number;
}

// Type for a union
export type AgentType = 'claude' | 'pi' | 'antigravity';
```

## 4. Master Utility Types
Leverage built-in utility types to avoid duplicating type definitions.
*   `Partial<T>`: Makes all properties optional (great for update operations).
*   `Omit<T, K>`: Creates a type by omitting specific properties.
*   `Pick<T, K>`: Creates a type by picking specific properties.
*   `Record<K, T>`: Ideal for dictionaries or maps.

## 5. Decorator Usage and Type Safety
When using decorators heavily for dependency injection or reactive properties, ensure types align perfectly with the decorator's intent.
*   **Reactive Properties:** For UI state, bind the correct type to the decorator to prevent runtime mismatches (`@property({ type: String }) title: string;`).
*   **Service Injection:** When injecting services into controllers or establishing API routes, ensure the constructor injections rely on clearly defined class interfaces to keep logic decoupled and testable.

## 6. Enums vs. String Unions
While enums are native to TypeScript, they compile down to IIFEs (Immediately Invoked Function Expressions) which can increase bundle size and are harder to tree-shake. Prefer string union types unless you specifically need reverse mapping.
```typescript
// ❌ Compiles to extra JavaScript
enum Status {
  Active = 'ACTIVE',
  Inactive = 'INACTIVE'
}

// ✅ Compiles away completely
type Status = 'ACTIVE' | 'INACTIVE';
```

## 7. Exhaustive Switch Checking
When dealing with finite states or discriminated unions (like different types of parsed session logs), use a `never` assignment in the `default` case of a switch statement to ensure all cases are handled at compile time.
```typescript
function getIcon(agent: AgentType) {
  switch (agent) {
    case 'claude': return '🤖';
    case 'pi': return '🥧';
    case 'antigravity': return '🚀';
    default:
      // TypeScript will error here if a new AgentType is added but missing in the switch
      const _exhaustiveCheck: never = agent;
      return _exhaustiveCheck;
  }
}
```

## 8. Clean Asynchronous Code
Always type the resolution of Promises. Avoid floating promises by explicitly returning them or awaiting them.
```typescript
// ✅ Good
async function fetchSessions(): Promise<DashboardSession[]> {
  const response = await fetch('/api/sessions');
  return (await response.json()) as DashboardSession[];
}
```