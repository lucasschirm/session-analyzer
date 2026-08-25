/**
 * Disclosure copy shown before the analytics database cutover is activated.
 *
 * This is a typed constant object so the UI can render it directly while
 * keeping the copy centralized.
 */

export interface AnalyticsActivationDisclosure {
  title: string;
  body: string;
  resetNotice: string;
  sourceRetention: string;
  resyncPath: string;
  rollbackWindow: string;
}

export const ANALYTICS_ACTIVATION_DISCLOSURE = {
  title: 'Activate the new analytics database?',
  body: 'The next generation of the dashboard stores analytics (projects, sessions, metrics) in a dedicated database that is separate from your connection settings, S3 credentials, and passkey vault.',
  resetNotice:
    'Activating the new analytics database will reset your local analytics data. Projects and sessions currently stored in the old format will no longer be visible until they are re-imported or re-synced.',
  sourceRetention:
    'Your connection names, encrypted S3 credentials, passkey state, source checkpoints, and UI preferences are kept in the control database and will not be reset.',
  resyncPath:
    'After activation, use the existing Sync connection to download sessions again, or drag-and-drop session files back into a project.',
  rollbackWindow:
    'Your old database is kept read-only for a limited rollback window. If you change your mind, you can export it from the legacy view before the rollback window closes.',
} as const satisfies AnalyticsActivationDisclosure;
